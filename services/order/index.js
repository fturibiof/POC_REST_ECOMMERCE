/**
 * Order Service — port 3000, the only entry point for the client.
 *
 * POST /orders { customerId, items: [{ itemId, quantity }], paymentInformation, shippingAddress }
 *
 * Option A — synchronous orchestration (REST). The client waits for:
 *   Payment -> Inventory -> Shipping -> Notification
 *   201 CONFIRMED | 402 card declined | 409 out of stock | 503 dependency unavailable
 *
 * Option B — event-driven choreography (RabbitMQ). The order is stored,
 * OrderCreated is published, and the client gets 202 PENDING as soon as the
 * broker has confirmed the event. The other services react to the events:
 *   OrderCreated -> PaymentAuthorized -> InventoryReserved -> ShipmentRequested -> OrderConfirmed
 *   PaymentFailed | InventoryFailed -> OrderRejected
 *
 * Option C — hybrid. Payment and Inventory are called synchronously (the
 * critical path: 201 means payment and stock are secured), then OrderConfirmed
 * is published; Shipping and Notification react to it.
 *   201 CONFIRMED | 402 | 409 | 503, like A, but without waiting for shipping
 *
 * Compensation (A, C): if the stock reservation fails, the payment is refunded.
 * Business invariant (all options): an order is CONFIRMED only if its payment
 * was authorized AND its stock reserved.
 *
 * Two latencies:
 *   acceptance  measured by k6 (first response to the client)
 *   completion  measured here, the same way for A, B and C: from reception
 *               until the outcome is known and, for a confirmed order, its
 *               shipment requested
 *
 * GET /orders/:id  current status (how a client follows an order in B)
 * GET /stats       counts (the run script waits for inProgress = 0)
 * GET /audit       order ids per status (end-of-run invariant check)
 */

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const axios = require('axios');
const { trace } = require('@opentelemetry/api');
const { OPTION, client, createApp, tagOrder, listen } = require('../common/runtime');

const SERVICE = 'order';
const PORT = Number(process.env.PORT || 3000);

const app = createApp(SERVICE);

// Expose the trace id of each order, so a witness order can be found in Tempo.
app.use((req, res, next) => {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  if (traceId) res.set('x-trace-id', traceId);
  next();
});

// ---------------------------------------------------------------------------
// Order store and workflow metrics (shared by A, B and C)
// ---------------------------------------------------------------------------
const orders = new Map(); // orderId -> order
const counts = { inProgress: 0, CONFIRMED: 0, REJECTED: 0 };

const received = new client.Counter({ name: 'orders_received_total', help: 'Orders received by the Order service' });
const completed = new client.Counter({ name: 'orders_completed_total', help: 'Orders whose workflow is finished', labelNames: ['outcome'] });
const completion = new client.Histogram({
  name: 'order_completion_seconds',
  help: 'Reception -> outcome known and, if confirmed, shipment requested',
  labelNames: ['outcome'],
  buckets: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300],
});
new client.Gauge({
  name: 'orders_pending',
  help: 'Orders whose workflow is not finished (in progress or waiting in a queue)',
  collect() {
    this.set(counts.inProgress);
  },
});

const ITEM_PRICES = { 'ITEM-001': 999.99, 'ITEM-002': 29.99, 'ITEM-003': 79.99, 'ITEM-004': 349.99, 'ITEM-005': 149.99, 'ITEM-006': 499.99 };

function createOrder({ customerId, items, shippingAddress }) {
  const order = {
    orderId: `ORD-${randomUUID()}`,
    customerId,
    items,
    shippingAddress,
    status: 'PENDING',
    amount: Number(items.reduce((sum, { itemId, quantity }) => sum + (ITEM_PRICES[itemId] ?? 0) * quantity, 0).toFixed(2)),
    createdAt: Date.now(),
    steps: { payment: false, inventory: false, shipment: false },
    finished: false,
  };
  orders.set(order.orderId, order);
  counts.inProgress++;
  received.inc();
  tagOrder(order.orderId);
  return order;
}

/** Sets the business outcome of an order, once. Returns false if it was already set. */
function settle(order, status, reason) {
  if (order.status !== 'PENDING') return false;
  if (status === 'CONFIRMED' && !(order.steps.payment && order.steps.inventory)) {
    throw new Error(`Invariant violated: ${order.orderId} confirmed without payment and stock`);
  }
  order.status = status;
  order.reason = reason;
  counts[status]++;
  return true;
}

/** Ends the workflow of an order, once: this is where completion is measured. */
function finish(order) {
  if (order.finished) return;
  order.finished = true;
  order.completedAt = Date.now();
  counts.inProgress--;
  const outcome = order.status.toLowerCase();
  completed.inc({ outcome });
  completion.observe({ outcome }, (order.completedAt - order.createdAt) / 1000);
}

function validate(body) {
  const { customerId, items, paymentInformation, shippingAddress } = body;
  return customerId && items?.length && paymentInformation && shippingAddress;
}

// ---------------------------------------------------------------------------
// REST calls to downstream services (A: all four, C: Payment and Inventory)
// ---------------------------------------------------------------------------
function createRestClients(targets) {
  // One connection pool per downstream service, bounded like a real HTTP
  // client: with a slow dependency, requests wait for a free connection.
  const POOL_SIZE = Number(process.env.HTTP_POOL_SIZE || 100);
  const TIMEOUT_MS = Number(process.env.DOWNSTREAM_TIMEOUT_MS || 5000);
  const URLS = {
    payment: process.env.PAYMENT_URL || 'http://localhost:3001',
    inventory: process.env.INVENTORY_URL || 'http://localhost:3002',
    shipping: process.env.SHIPPING_URL || 'http://localhost:3003',
    notification: process.env.NOTIFICATION_URL || 'http://localhost:3004',
  };
  const agents = {};
  const apis = {};
  for (const target of targets) {
    agents[target] = new http.Agent({ keepAlive: true, maxSockets: POOL_SIZE });
    apis[target] = axios.create({ baseURL: URLS[target], httpAgent: agents[target], maxRedirects: 0, validateStatus: () => true });
  }

  const sum = (byHost) => Object.values(byHost).reduce((n, list) => n + list.length, 0);
  new client.Gauge({
    name: 'http_client_pool_connections',
    help: 'Outbound connections per downstream service: in_use, or queued waiting for a free one',
    labelNames: ['target', 'state'],
    collect() {
      for (const [target, agent] of Object.entries(agents)) {
        this.set({ target, state: 'in_use' }, sum(agent.sockets));
        this.set({ target, state: 'queued' }, sum(agent.requests));
      }
    },
  });
  const downstream = new client.Histogram({
    name: 'downstream_request_seconds',
    help: 'Duration of calls to downstream services, waiting time for a connection included',
    labelNames: ['target', 'status'],
    buckets: [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5],
  });
  const compensationFailures = new client.Counter({
    name: 'compensation_failures_total',
    help: 'Refunds or releases that could not be done',
    labelNames: ['action'],
  });

  /** Calls a downstream service; network errors and timeouts become a 503. */
  async function call(target, path, body) {
    const end = downstream.startTimer({ target });
    try {
      // AbortSignal counts the time spent waiting for a pooled connection too.
      const res = await apis[target].post(path, body, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      end({ status: res.status });
      return res;
    } catch (err) {
      const timedOut = err.code === 'ERR_CANCELED' || err.name === 'CanceledError';
      end({ status: timedOut ? 'timeout' : 'error' });
      return { status: 503, data: { reason: `${target} ${timedOut ? 'timeout' : 'unreachable'}: ${err.message}` } };
    }
  }

  async function compensate(action, target, path, body) {
    const res = await call(target, path, body);
    if (res.status !== 201) compensationFailures.inc({ action });
  }

  return { call, compensate };
}

/**
 * Critical path shared by A and C: payment, then stock (refund if the stock
 * cannot be reserved). Returns null on success, or the rejection to send.
 */
async function securePaymentAndStock(rest, order, paymentInformation) {
  const { orderId, amount, items } = order;

  const payment = await rest.call('payment', '/payments', { orderId, amount, paymentInformation });
  if (payment.status !== 201) return { httpStatus: payment.status === 402 ? 402 : 503, reason: payment.data.reason };
  order.steps.payment = true;
  order.payment = payment.data;

  const inventory = await rest.call('inventory', '/inventory/reserve', { orderId, items });
  if (inventory.status !== 201) {
    await rest.compensate('refund', 'payment', '/payments/refund', { orderId });
    return { httpStatus: inventory.status === 409 ? 409 : 503, reason: inventory.data.reason };
  }
  order.steps.inventory = true;
  order.inventory = inventory.data;
  return null;
}

function rejectNow(res, order, { httpStatus, reason }) {
  settle(order, 'REJECTED', reason);
  finish(order);
  return res.status(httpStatus).json({ orderId: order.orderId, status: 'REJECTED', reason });
}

// ---------------------------------------------------------------------------
// Option A — synchronous orchestration
// ---------------------------------------------------------------------------
async function startSync() {
  const rest = createRestClients(['payment', 'inventory', 'shipping', 'notification']);

  app.post('/orders', async (req, res) => {
    if (!validate(req.body)) return res.status(400).json({ error: 'Missing customerId, items, paymentInformation or shippingAddress' });
    const order = createOrder(req.body);
    const { orderId, customerId, items, shippingAddress } = order;

    const rejection = await securePaymentAndStock(rest, order, req.body.paymentInformation);
    if (rejection) return rejectNow(res, order, rejection);

    const shipping = await rest.call('shipping', '/shipments', { orderId, customerId, shippingAddress, items });
    if (shipping.status !== 201) {
      await rest.compensate('release', 'inventory', '/inventory/release', { orderId, items });
      await rest.compensate('refund', 'payment', '/payments/refund', { orderId });
      return rejectNow(res, order, { httpStatus: 503, reason: shipping.data.reason });
    }
    order.steps.shipment = true;
    settle(order, 'CONFIRMED');
    finish(order);

    // The client still waits for the notification (it is part of the
    // workflow), but its failure does not cancel a confirmed order.
    const notification = await rest.call('notification', '/notifications', { orderId, customerId, status: 'CONFIRMED' });

    res.status(201).json({
      orderId,
      status: 'CONFIRMED',
      amount: order.amount,
      payment: order.payment,
      inventory: order.inventory,
      shipping: shipping.data,
      notification: { sent: notification.status === 201 },
    });
  });
}

// ---------------------------------------------------------------------------
// Option B — event-driven choreography
// ---------------------------------------------------------------------------
async function startEvents() {
  const { createBus } = require('../common/bus');
  const bus = await createBus(SERVICE);

  app.post('/orders', async (req, res) => {
    if (!validate(req.body)) return res.status(400).json({ error: 'Missing customerId, items, paymentInformation or shippingAddress' });
    const order = createOrder(req.body);
    const { orderId, amount, customerId, items, shippingAddress } = order;

    try {
      await bus.publish('OrderCreated', { orderId, amount, paymentInformation: req.body.paymentInformation, order: { customerId, items, shippingAddress } });
    } catch (err) {
      // Not durable: the order is not accepted.
      return rejectNow(res, order, { httpStatus: 503, reason: `Order could not be recorded: ${err.message}` });
    }
    res.status(202).json({ orderId, status: 'PENDING' });
  });

  const withOrder = (handler) => async (event) => {
    const order = orders.get(event.orderId);
    if (order) await handler(order, event);
  };

  // Confirm only when payment, stock AND shipment are known, whatever the
  // arrival order of the events (duplicates and redeliveries can reorder them).
  async function confirmIfComplete(order) {
    const { payment, inventory, shipment } = order.steps;
    if (payment && inventory && shipment && settle(order, 'CONFIRMED')) {
      finish(order);
      await bus.publish('OrderConfirmed', { orderId: order.orderId, customerId: order.customerId });
    }
  }

  async function reject(order, reason) {
    if (settle(order, 'REJECTED', reason)) {
      finish(order);
      await bus.publish('OrderRejected', { orderId: order.orderId, customerId: order.customerId, reason });
    }
  }

  await bus.subscribe({
    PaymentAuthorized: withOrder(async (order) => {
      order.steps.payment = true;
      await confirmIfComplete(order);
    }),
    InventoryReserved: withOrder(async (order) => {
      order.steps.inventory = true;
      await confirmIfComplete(order);
    }),
    ShipmentRequested: withOrder(async (order) => {
      order.steps.shipment = true;
      await confirmIfComplete(order);
    }),
    PaymentFailed: withOrder((order, event) => reject(order, event.reason)),
    InventoryFailed: withOrder((order, event) => reject(order, event.reason)),
  });
}

// ---------------------------------------------------------------------------
// Option C — hybrid: synchronous critical path, then events
// ---------------------------------------------------------------------------
async function startHybrid() {
  const { createBus } = require('../common/bus');
  const bus = await createBus(SERVICE);
  const rest = createRestClients(['payment', 'inventory']);

  app.post('/orders', async (req, res) => {
    if (!validate(req.body)) return res.status(400).json({ error: 'Missing customerId, items, paymentInformation or shippingAddress' });
    const order = createOrder(req.body);
    const { orderId, customerId, items, shippingAddress } = order;

    const rejection = await securePaymentAndStock(rest, order, req.body.paymentInformation);
    if (rejection) return rejectNow(res, order, rejection);

    try {
      await bus.publish('OrderConfirmed', { orderId, customerId, order: { customerId, items, shippingAddress } });
    } catch (err) {
      // Shipping could not be triggered: undo the critical path.
      await rest.compensate('release', 'inventory', '/inventory/release', { orderId, items });
      await rest.compensate('refund', 'payment', '/payments/refund', { orderId });
      return rejectNow(res, order, { httpStatus: 503, reason: `Order could not be recorded: ${err.message}` });
    }
    settle(order, 'CONFIRMED');
    // The workflow goes on asynchronously: finish() when the shipment is requested.
    res.status(201).json({ orderId, status: 'CONFIRMED', amount: order.amount, payment: order.payment, inventory: order.inventory });
  });

  await bus.subscribe({
    ShipmentRequested: async (event) => {
      const order = orders.get(event.orderId);
      if (!order) return;
      order.steps.shipment = true;
      finish(order);
    },
  });
}

// ---------------------------------------------------------------------------
// Technical endpoints
// ---------------------------------------------------------------------------
app.get('/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Unknown order' });
  const { orderId, status, reason, createdAt, completedAt, steps } = order;
  res.json({ orderId, status, reason, createdAt, completedAt, steps });
});

app.get('/stats', (_req, res) => res.json(counts));

app.get('/audit', (_req, res) => {
  const byStatus = { PENDING: [], CONFIRMED: [], REJECTED: [], unfinished: [] };
  for (const order of orders.values()) {
    byStatus[order.status].push(order.orderId);
    if (!order.finished) byStatus.unfinished.push(order.orderId);
  }
  res.json(byStatus);
});

const start = { A: startSync, B: startEvents, C: startHybrid }[OPTION];
start().then(() => listen(app, PORT, SERVICE));
