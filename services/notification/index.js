/**
 * Notification Service — port 3004
 *
 * Sends the order outcome to the customer (simulated email: 100 ms).
 *
 * Option A (REST)
 *   POST /notifications  { orderId, customerId, status, message } -> 201
 *   Only confirmations: a rejection is already in the HTTP response.
 *
 * Option B (events)  OrderConfirmed, OrderRejected -> notification
 *   Rejections must be notified too: the client only received "202 PENDING".
 *
 * Option C (events)  OrderConfirmed -> notification
 *   Like A, a rejection is already in the synchronous response.
 */

const { randomUUID } = require('node:crypto');
const { OPTION, isEventDriven, createApp, tagOrder, Work, Ledger, listen } = require('../common/runtime');

const SERVICE = 'notification';
const PORT = Number(process.env.PORT || 3004);

const app = createApp(SERVICE);
const work = new Work(Number(process.env.WORK_DELAY_MS || 100));
const ledger = new Ledger('sent');

async function notify(orderId) {
  await work.run();
  ledger.add('sent', orderId);
  return { notificationId: `NOTIF-${randomUUID()}`, sent: true, channel: 'email' };
}

async function startSync() {
  app.post('/notifications', async (req, res) => {
    tagOrder(req.body.orderId);
    res.status(201).json(await notify(req.body.orderId));
  });
}

async function startEvents() {
  const { createBus } = require('../common/bus');
  const bus = await createBus(SERVICE);

  const handlers = { OrderConfirmed: async (event) => notify(event.orderId) };
  if (OPTION === 'B') handlers.OrderRejected = async (event) => notify(event.orderId);
  await bus.subscribe(handlers);
}

app.get('/audit', (_req, res) => res.json(ledger));

(isEventDriven(SERVICE) ? startEvents() : startSync()).then(() => listen(app, PORT, SERVICE));
