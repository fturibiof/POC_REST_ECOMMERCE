/**
 * Payment Service — port 3001
 *
 * Authorizes the payment of an order (simulated provider: 200 ms).
 * Cards ending in "0000" are declined. A payment is refunded when the order
 * cannot be completed (compensation, keeps the business invariant).
 *
 * Options A and C (REST: on the critical path in both)
 *   POST /payments         { orderId, amount, paymentInformation } -> 201 | 402 | 503
 *   POST /payments/refund  { orderId }                             -> 201 | 503
 *
 * Option B (events)
 *   OrderCreated    -> PaymentAuthorized | PaymentFailed
 *   InventoryFailed -> refund
 *
 * Fault injection (S3, S4): POST /admin/fault — see common/runtime.js.
 * "Down" means 503 when called by REST (A, C) and "stop consuming" in B.
 */

const { randomUUID } = require('node:crypto');
const { isEventDriven, createApp, tagOrder, Work, mountFaultInjector, Ledger, listen } = require('../common/runtime');

const SERVICE = 'payment';
const PORT = Number(process.env.PORT || 3001);

const app = createApp(SERVICE);
const work = new Work(Number(process.env.WORK_DELAY_MS || 200));
const ledger = new Ledger('authorized', 'declined', 'refunded');

async function authorize({ orderId, amount, paymentInformation }) {
  await work.run();
  const cardNumber = String(paymentInformation?.cardNumber || '');
  if (!cardNumber || cardNumber.endsWith('0000')) {
    ledger.add('declined', orderId);
    return { approved: false, reason: 'Card declined (simulated: card number ends in 0000)' };
  }
  ledger.add('authorized', orderId);
  return { approved: true, transactionId: `TXN-${randomUUID()}`, amount };
}

function refund(orderId) {
  ledger.add('refunded', orderId);
}

async function startSync() {
  const fault = mountFaultInjector(app, work);
  const unavailable = (res) =>
    res.status(503).json({ approved: false, reason: 'Payment service unavailable (injected fault)' });

  app.post('/payments', async (req, res) => {
    tagOrder(req.body.orderId);
    if (fault.down) return unavailable(res);
    const result = await authorize(req.body);
    res.status(result.approved ? 201 : 402).json(result);
  });

  app.post('/payments/refund', (req, res) => {
    tagOrder(req.body.orderId);
    if (fault.down) return unavailable(res);
    refund(req.body.orderId);
    res.status(201).json({ refunded: true });
  });
}

async function startEvents() {
  const { createBus } = require('../common/bus');
  const bus = await createBus(SERVICE);
  mountFaultInjector(app, work, { onDown: bus.pause, onUp: bus.resume });

  await bus.subscribe({
    OrderCreated: async (event) => {
      const result = await authorize(event);
      if (result.approved) {
        // The card data stops here: downstream events only carry the order.
        await bus.publish('PaymentAuthorized', {
          orderId: event.orderId,
          transactionId: result.transactionId,
          order: event.order,
        });
      } else {
        await bus.publish('PaymentFailed', { orderId: event.orderId, reason: result.reason });
      }
    },
    InventoryFailed: async (event) => refund(event.orderId),
  });
}

app.get('/audit', (_req, res) => res.json(ledger));

(isEventDriven(SERVICE) ? startEvents() : startSync()).then(() => listen(app, PORT, SERVICE));
