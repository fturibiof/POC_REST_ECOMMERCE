/**
 * Shipping Service — port 3003
 *
 * Simulates creating a shipment and returning a tracking number.
 *
 * POST /shipments
 *   Body: { orderId, customerId, shippingAddress, items }
 *   Response: { shipmentId, trackingNumber, estimatedDelivery, carrier }
 */

const express = require('express');
const app = express();
app.use(express.json());

const PORT = 3003;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SIMULATED_DELAY_MS = 100;

const CARRIERS = ['FedEx', 'UPS', 'DHL', 'USPS'];

// In-memory shipments
const shipments = [];

app.post('/shipments', async (req, res) => {
  await sleep(SIMULATED_DELAY_MS);
  const { orderId, customerId, shippingAddress, items } = req.body;

  const carrier = CARRIERS[Math.floor(Math.random() * CARRIERS.length)];

  // Estimate delivery: 3–7 business days from now
  const deliveryDays = Math.floor(Math.random() * 5) + 3;
  const estimatedDelivery = new Date(
    Date.now() + deliveryDays * 24 * 60 * 60 * 1000
  ).toISOString().split('T')[0];

  const shipment = {
    shipmentId: `SHIP-${Date.now()}`,
    trackingNumber: `TRK${Math.random().toString(36).substring(2, 12).toUpperCase()}`,
    orderId,
    customerId,
    shippingAddress,
    items,
    carrier,
    estimatedDelivery,
    createdAt: new Date().toISOString(),
  };

  shipments.push(shipment);

  console.log(
    `[Shipping] Created shipment ${shipment.shipmentId} via ${carrier}, tracking: ${shipment.trackingNumber}`
  );

  res.status(201).json({
    shipmentId: shipment.shipmentId,
    trackingNumber: shipment.trackingNumber,
    carrier: shipment.carrier,
    estimatedDelivery: shipment.estimatedDelivery,
  });
});

// Health / debug
app.get('/shipments', (_req, res) => res.json(shipments));

app.listen(PORT, () =>
  console.log(`[Shipping Service] Listening on port ${PORT}`)
);
