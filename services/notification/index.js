/**
 * Notification Service — port 3004
 *
 * Simulates sending a notification (email/SMS) to the customer.
 * In a real system this would integrate with an email/SMS provider.
 *
 * POST /notifications
 *   Body: { orderId, customerId, status, message }
 *   Response: { notificationId, sent, timestamp }
 */

const express = require('express');
const app = express();
app.use(express.json());

const PORT = 3004;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SIMULATED_DELAY_MS = 100;

// In-memory log of all notifications sent
const notifications = [];

app.post('/notifications', async (req, res) => {
  await sleep(SIMULATED_DELAY_MS);
  const { orderId, customerId, status, message } = req.body;

  const notification = {
    notificationId: `NOTIF-${Date.now()}`,
    orderId,
    customerId,
    status,
    message,
    channel: 'email',       // simulated
    sent: true,
    timestamp: new Date().toISOString(),
  };

  notifications.push(notification);
  console.log(`[Notification] Sent to customer ${customerId}: "${message}"`);

  res.status(201).json({
    notificationId: notification.notificationId,
    sent: notification.sent,
    timestamp: notification.timestamp,
  });
});

// Health / debug: list all notifications
app.get('/notifications', (_req, res) => res.json(notifications));

app.listen(PORT, () =>
  console.log(`[Notification Service] Listening on port ${PORT}`)
);
