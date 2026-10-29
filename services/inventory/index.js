/**
 * Inventory Service — port 3002
 *
 * Simulates a stock database. Items start with a fixed quantity.
 * A reservation deducts from stock; if any item is out of stock the
 * whole request is rejected.
 *
 * POST /inventory/reserve
 *   Body: { orderId, items: [{ itemId, quantity }] }
 *   Response (success): { reserved: true, reservationId, items }
 *   Response (failure): 409 { reserved: false, reason }
 */

const express = require('express');
const app = express();
app.use(express.json());

const PORT = 3002;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SIMULATED_DELAY_MS = 100;

// Simulated stock — keyed by itemId.
// Quantities are set high enough to survive a full 5-min load test at
// 500 req/s without exhaustion (real stock management is out of scope for POC).
const stock = {
  'ITEM-001': { name: 'Laptop',     quantity: 999_999 },
  'ITEM-002': { name: 'Mouse',      quantity: 999_999 },
  'ITEM-003': { name: 'Keyboard',   quantity: 999_999 },
  'ITEM-004': { name: 'Monitor',    quantity: 999_999 },
  'ITEM-005': { name: 'Headphones', quantity: 999_999 },
};

// In-memory list of active reservations
const reservations = [];

app.post('/inventory/reserve', async (req, res) => {
  await sleep(SIMULATED_DELAY_MS);
  const { orderId, items } = req.body;

  // Validate every item exists and has enough stock
  for (const { itemId, quantity } of items) {
    if (!stock[itemId]) {
      return res.status(409).json({
        reserved: false,
        reason: `Item ${itemId} does not exist in inventory`,
      });
    }
    if (stock[itemId].quantity < quantity) {
      return res.status(409).json({
        reserved: false,
        reason: `Insufficient stock for ${itemId}: requested ${quantity}, available ${stock[itemId].quantity}`,
      });
    }
  }

  // Deduct stock
  const reservedItems = items.map(({ itemId, quantity }) => {
    stock[itemId].quantity -= quantity;
    return { itemId, name: stock[itemId].name, quantity, remainingStock: stock[itemId].quantity };
  });

  const reservation = {
    reservationId: `RES-${Date.now()}`,
    orderId,
    items: reservedItems,
    reservedAt: new Date().toISOString(),
  };
  reservations.push(reservation);

  console.log(`[Inventory] Reserved items for order ${orderId}:`, reservedItems);

  res.status(201).json({
    reserved: true,
    reservationId: reservation.reservationId,
    items: reservedItems,
  });
});

// Health / debug
app.get('/inventory/stock', (_req, res) => res.json(stock));
app.get('/inventory/reservations', (_req, res) => res.json(reservations));

app.listen(PORT, () =>
  console.log(`[Inventory Service] Listening on port ${PORT}`)
);
