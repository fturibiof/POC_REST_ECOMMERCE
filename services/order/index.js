/**
 * Order Service — port 3000
 *
 * Entry point for the client. Orchestrates the full purchase flow by
 * calling downstream services synchronously in this order:
 *   1. Payment Service  → POST http://localhost:3001/payments
 *   2. Inventory Service → POST http://localhost:3002/inventory/reserve
 *   3. Shipping Service  → POST http://localhost:3003/shipments
 *   4. Notification Service → POST http://localhost:3004/notifications
 *
 * POST /orders
 *   Body: {
 *     customerId:         string,
 *     items:              [{ itemId, quantity }],
 *     paymentInformation: { cardNumber, cardHolder, expiryDate, cvv },
 *     shippingAddress:    { street, city, state, zipCode, country }
 *   }
 *
 *   Response (201): full order summary with downstream results
 *   Response (4xx): error from whichever step failed
 */

const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PORT = 3000;

// Service URLs
const PAYMENT_URL      = 'http://localhost:3001';
const INVENTORY_URL    = 'http://localhost:3002';
const SHIPPING_URL     = 'http://localhost:3003';
const NOTIFICATION_URL = 'http://localhost:3004';

// In-memory order store
const orders = [];

// ---------------------------------------------------------------------------
// Helper: compute total amount from items
// (In a real system you'd look up prices from a catalog service)
// ---------------------------------------------------------------------------
const ITEM_PRICES = {
  'ITEM-001': 999.99,
  'ITEM-002': 29.99,
  'ITEM-003': 79.99,
  'ITEM-004': 349.99,
  'ITEM-005': 149.99,
};

function computeAmount(items) {
  return items.reduce((sum, { itemId, quantity }) => {
    const price = ITEM_PRICES[itemId] ?? 0;
    return sum + price * quantity;
  }, 0);
}

// ---------------------------------------------------------------------------
// POST /orders — the single client-facing endpoint
// ---------------------------------------------------------------------------
app.post('/orders', async (req, res) => {
  const { customerId, items, paymentInformation, shippingAddress } = req.body;

  // --- Basic validation ---
  if (!customerId || !items?.length || !paymentInformation || !shippingAddress) {
    return res.status(400).json({
      error: 'Missing required fields: customerId, items, paymentInformation, shippingAddress',
    });
  }

  const orderId = `ORD-${Date.now()}`;
  const amount  = parseFloat(computeAmount(items).toFixed(2));
  const startedAt = Date.now();

  console.log(`\n[Order] New order ${orderId} from customer ${customerId}, amount: $${amount}`);

  try {
    // -----------------------------------------------------------------------
    // Step 1 — Payment
    // -----------------------------------------------------------------------
    console.log(`[Order] → Calling Payment Service...`);
    let paymentResult;
    try {
      const paymentRes = await axios.post(`${PAYMENT_URL}/payments`, {
        orderId,
        amount,
        paymentInformation,
      });
      paymentResult = paymentRes.data;
    } catch (err) {
      const status = err.response?.status ?? 500;
      const reason = err.response?.data?.reason ?? err.message;
      console.error(`[Order] Payment FAILED: ${reason}`);
      return res.status(status).json({ orderId, error: 'Payment failed', reason });
    }
    console.log(`[Order] ✓ Payment approved — txn: ${paymentResult.transactionId}`);

    // -----------------------------------------------------------------------
    // Step 2 — Inventory reservation
    // -----------------------------------------------------------------------
    console.log(`[Order] → Calling Inventory Service...`);
    let inventoryResult;
    try {
      const inventoryRes = await axios.post(`${INVENTORY_URL}/inventory/reserve`, {
        orderId,
        items,
      });
      inventoryResult = inventoryRes.data;
    } catch (err) {
      const status = err.response?.status ?? 500;
      const reason = err.response?.data?.reason ?? err.message;
      console.error(`[Order] Inventory reservation FAILED: ${reason}`);
      // TODO: in production, refund the payment here (compensating transaction)
      return res.status(status).json({ orderId, error: 'Inventory reservation failed', reason });
    }
    console.log(`[Order] ✓ Inventory reserved — res: ${inventoryResult.reservationId}`);

    // -----------------------------------------------------------------------
    // Step 3 — Shipping
    // -----------------------------------------------------------------------
    console.log(`[Order] → Calling Shipping Service...`);
    let shippingResult;
    try {
      const shippingRes = await axios.post(`${SHIPPING_URL}/shipments`, {
        orderId,
        customerId,
        shippingAddress,
        items: inventoryResult.items,
      });
      shippingResult = shippingRes.data;
    } catch (err) {
      const status = err.response?.status ?? 500;
      const reason = err.response?.data?.reason ?? err.message;
      console.error(`[Order] Shipping FAILED: ${reason}`);
      return res.status(status).json({ orderId, error: 'Shipping creation failed', reason });
    }
    console.log(`[Order] ✓ Shipment created — tracking: ${shippingResult.trackingNumber}`);

    // -----------------------------------------------------------------------
    // Step 4 — Notification
    // -----------------------------------------------------------------------
    console.log(`[Order] → Calling Notification Service...`);
    let notificationResult;
    try {
      const notifRes = await axios.post(`${NOTIFICATION_URL}/notifications`, {
        orderId,
        customerId,
        status: 'CONFIRMED',
        message:
          `Your order ${orderId} has been confirmed! ` +
          `Track your shipment with ${shippingResult.carrier} using tracking number ${shippingResult.trackingNumber}. ` +
          `Estimated delivery: ${shippingResult.estimatedDelivery}.`,
      });
      notificationResult = notifRes.data;
    } catch (err) {
      // Notification failure is non-fatal — log and continue
      console.warn(`[Order] Notification failed (non-fatal): ${err.message}`);
      notificationResult = { sent: false, error: err.message };
    }
    console.log(`[Order] ✓ Notification sent — id: ${notificationResult.notificationId}`);

    // -----------------------------------------------------------------------
    // Persist & respond
    // -----------------------------------------------------------------------
    const latencyMs = Date.now() - startedAt;

    const order = {
      orderId,
      customerId,
      status: 'CONFIRMED',
      amount,
      items,
      payment:      paymentResult,
      inventory:    inventoryResult,
      shipping:     shippingResult,
      notification: notificationResult,
      createdAt:    new Date().toISOString(),
      latencyMs,
    };
    orders.push(order);

    console.log(`[Order] ✓ Order ${orderId} completed in ${latencyMs}ms\n`);
    return res.status(201).json(order);

  } catch (err) {
    // Unexpected error
    console.error(`[Order] Unexpected error:`, err.message);
    return res.status(500).json({ orderId, error: 'Internal server error', detail: err.message });
  }
});

// Health / debug
app.get('/orders', (_req, res) => res.json(orders));

app.listen(PORT, () =>
  console.log(`[Order Service] Listening on port ${PORT}`)
);
