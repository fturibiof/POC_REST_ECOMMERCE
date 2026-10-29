/**
 * Payment Service — port 3001
 *
 * Simulates payment processing. Always succeeds unless the card number
 * ends in "0000" (to make failure testing easy).
 *
 * POST /payments
 *   Body: { orderId, amount, paymentInformation: { cardNumber, ... } }
 *   Response (success): { approved: true, transactionId, amount }
 *   Response (failure): 402 { approved: false, reason }
 */

const express = require('express');
const app = express();
app.use(express.json());

const PORT = 3001;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SIMULATED_DELAY_MS = 200;

// In-memory ledger
const transactions = [];

app.post('/payments', async (req, res) => {
  await sleep(SIMULATED_DELAY_MS);
  const { orderId, amount, paymentInformation } = req.body;
  const { cardNumber } = paymentInformation || {};

  // Simulate decline: cards ending in "0000" are declined
  if (!cardNumber || String(cardNumber).endsWith('0000')) {
    console.log(`[Payment] DECLINED for order ${orderId}`);
    return res.status(402).json({
      approved: false,
      reason: 'Card declined — simulated failure (card number ends in 0000)',
    });
  }

  const transaction = {
    transactionId: `TXN-${Date.now()}`,
    orderId,
    amount,
    cardLast4: String(cardNumber).slice(-4),
    approved: true,
    processedAt: new Date().toISOString(),
  };
  transactions.push(transaction);

  console.log(`[Payment] Approved ${transaction.transactionId} for order ${orderId}, amount: $${amount}`);

  res.status(201).json({
    approved: true,
    transactionId: transaction.transactionId,
    amount: transaction.amount,
    processedAt: transaction.processedAt,
  });
});

// Health / debug
app.get('/payments', (_req, res) => res.json(transactions));

app.listen(PORT, () =>
  console.log(`[Payment Service] Listening on port ${PORT}`)
);
