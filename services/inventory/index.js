/**
 * Inventory Service — port 3002
 *
 * Reserves stock for an order (simulated database: 100 ms). If any item is
 * unknown or out of stock, the whole reservation is refused.
 *
 * Options A and C (REST: on the critical path in both)
 *   POST /inventory/reserve  { orderId, items: [{ itemId, quantity }] } -> 201 | 409
 *   POST /inventory/release  { orderId, items }                         -> 201
 *
 * Option B (events)
 *   PaymentAuthorized -> InventoryReserved | InventoryFailed
 */

const { isEventDriven, createApp, tagOrder, Work, Ledger, listen } = require('../common/runtime');

const SERVICE = 'inventory';
const PORT = Number(process.env.PORT || 3002);

const app = createApp(SERVICE);
const work = new Work(Number(process.env.WORK_DELAY_MS || 100));
const ledger = new Ledger('reserved', 'refused', 'released');

// Quantities high enough for a full campaign (stock management is out of
// scope). ITEM-006 is always out of stock: the "insufficient stock" case.
const stock = {
  'ITEM-001': { name: 'Laptop', quantity: 999_999_999 },
  'ITEM-002': { name: 'Mouse', quantity: 999_999_999 },
  'ITEM-003': { name: 'Keyboard', quantity: 999_999_999 },
  'ITEM-004': { name: 'Monitor', quantity: 999_999_999 },
  'ITEM-005': { name: 'Headphones', quantity: 999_999_999 },
  'ITEM-006': { name: 'Discontinued camera', quantity: 0 },
};

async function reserve(orderId, items) {
  await work.run();
  // Check then deduct without any await in between: no concurrent
  // reservation can slip in (Node runs this block atomically).
  for (const { itemId, quantity } of items) {
    const available = stock[itemId]?.quantity ?? 0;
    if (available < quantity) {
      ledger.add('refused', orderId);
      return { reserved: false, reason: `Insufficient stock for ${itemId}: requested ${quantity}, available ${available}` };
    }
  }
  for (const { itemId, quantity } of items) stock[itemId].quantity -= quantity;
  ledger.add('reserved', orderId);
  return { reserved: true, items: items.map(({ itemId, quantity }) => ({ itemId, name: stock[itemId].name, quantity })) };
}

function release(orderId, items) {
  for (const { itemId, quantity } of items) if (stock[itemId]) stock[itemId].quantity += quantity;
  ledger.add('released', orderId);
}

async function startSync() {
  app.post('/inventory/reserve', async (req, res) => {
    tagOrder(req.body.orderId);
    const result = await reserve(req.body.orderId, req.body.items);
    res.status(result.reserved ? 201 : 409).json(result);
  });

  app.post('/inventory/release', (req, res) => {
    tagOrder(req.body.orderId);
    release(req.body.orderId, req.body.items);
    res.status(201).json({ released: true });
  });
}

async function startEvents() {
  const { createBus } = require('../common/bus');
  const bus = await createBus(SERVICE);

  await bus.subscribe({
    PaymentAuthorized: async (event) => {
      const result = await reserve(event.orderId, event.order.items);
      if (result.reserved) {
        await bus.publish('InventoryReserved', { orderId: event.orderId, order: event.order });
      } else {
        await bus.publish('InventoryFailed', { orderId: event.orderId, reason: result.reason });
      }
    },
  });
}

app.get('/audit', (_req, res) => res.json(ledger));
app.get('/inventory/stock', (_req, res) => res.json(stock));

(isEventDriven(SERVICE) ? startEvents() : startSync()).then(() => listen(app, PORT, SERVICE));
