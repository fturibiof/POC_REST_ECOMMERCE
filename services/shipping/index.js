/**
 * Shipping Service — port 3003
 *
 * Creates a shipment request and returns a tracking number (simulated: 100 ms).
 *
 * Option A (REST)
 *   POST /shipments  { orderId, customerId, shippingAddress, items } -> 201 | 503
 *
 * Option B (events)  InventoryReserved -> ShipmentRequested
 * Option C (events)  OrderConfirmed    -> ShipmentRequested
 *   (in C, payment and stock are settled synchronously; shipping follows)
 *
 * Fault injection (optional scenario S4b): POST /admin/fault — see common/runtime.js.
 */

const { randomUUID } = require('node:crypto');
const { OPTION, isEventDriven, createApp, tagOrder, Work, mountFaultInjector, Ledger, listen } = require('../common/runtime');

const SERVICE = 'shipping';
const PORT = Number(process.env.PORT || 3003);

const app = createApp(SERVICE);
const work = new Work(Number(process.env.WORK_DELAY_MS || 100));
const ledger = new Ledger('shipments');

const CARRIERS = ['FedEx', 'UPS', 'DHL', 'USPS'];

async function createShipment(orderId) {
  await work.run();
  ledger.add('shipments', orderId);
  const deliveryDays = Math.floor(Math.random() * 5) + 3;
  return {
    shipmentId: `SHIP-${randomUUID()}`,
    trackingNumber: `TRK${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    carrier: CARRIERS[Math.floor(Math.random() * CARRIERS.length)],
    estimatedDelivery: new Date(Date.now() + deliveryDays * 86_400_000).toISOString().split('T')[0],
  };
}

async function startSync() {
  const fault = mountFaultInjector(app, work);
  app.post('/shipments', async (req, res) => {
    tagOrder(req.body.orderId);
    if (fault.down) return res.status(503).json({ reason: 'Shipping service unavailable (injected fault)' });
    res.status(201).json(await createShipment(req.body.orderId));
  });
}

async function startEvents() {
  const { createBus } = require('../common/bus');
  const bus = await createBus(SERVICE);
  mountFaultInjector(app, work, { onDown: bus.pause, onUp: bus.resume });

  const requestShipment = async (event) => {
    const shipment = await createShipment(event.orderId);
    await bus.publish('ShipmentRequested', { orderId: event.orderId, ...shipment });
  };
  await bus.subscribe(OPTION === 'B' ? { InventoryReserved: requestShipment } : { OrderConfirmed: requestShipment });
}

app.get('/audit', (_req, res) => res.json(ledger));

(isEventDriven(SERVICE) ? startEvents() : startSync()).then(() => listen(app, PORT, SERVICE));
