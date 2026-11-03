/**
 * Shared runtime for the five services: configuration, Prometheus metrics,
 * technical endpoints and the payment fault injector.
 *
 * Every metric carries the labels `service` and `option` (A, B or C), so the
 * Grafana dashboard can filter by architecture.
 */

const express = require('express');
const client = require('prom-client');
const { trace } = require('@opentelemetry/api');

const OPTION = (process.env.OPTION || 'A').toUpperCase();
if (!['A', 'B', 'C'].includes(OPTION)) throw new Error(`OPTION must be A, B or C, got ${OPTION}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How each service is reached, per option:
 *   A (synchronous)  all services by REST
 *   B (event-driven) all services by events
 *   C (hybrid)       Payment and Inventory by REST (critical path, the client
 *                    waits for both); Shipping and Notification by events
 */
const EVENT_DRIVEN = {
  payment: ['B'],
  inventory: ['B'],
  shipping: ['B', 'C'],
  notification: ['B', 'C'],
};
const isEventDriven = (service) => EVENT_DRIVEN[service].includes(OPTION);

function createApp(service) {
  client.register.setDefaultLabels({ service, option: OPTION });
  client.collectDefaultMetrics(); // CPU, heap, event-loop lag of the Node process

  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ service, option: OPTION, status: 'UP' }));
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  });
  return app;
}

/** Adds the order id to the current span, so Tempo can find an order by its id. */
function tagOrder(orderId) {
  trace.getActiveSpan()?.setAttribute('order.id', orderId);
}

/**
 * Simulated work of a service (call to a payment provider, database...).
 * The delay can be changed at runtime by the fault injector (scenario S3).
 */
class Work {
  constructor(defaultDelayMs) {
    this.delayMs = defaultDelayMs;
  }
  run() {
    return sleep(this.delayMs);
  }
}

/**
 * Fault injection, used by the k6 `fault` scenario for S3 and S4:
 *   POST /admin/fault { "delayMs": 2000, "durationS": 120 }  -> slow service
 *   POST /admin/fault { "down": true,   "durationS": 30 }    -> unavailable
 * The fault is reverted automatically after `durationS`, and the gauge
 * `fault_active` lets Grafana show exactly when it happened.
 *
 * `onDown` / `onUp` let each service decide what "unavailable" means
 * (called by REST: answer 503; called by events: stop consuming messages).
 */
function mountFaultInjector(app, work, { onDown = () => {}, onUp = () => {} } = {}) {
  const faultActive = new client.Gauge({
    name: 'fault_active',
    help: 'Injected fault in progress (1) or not (0)',
    labelNames: ['kind'],
  });
  faultActive.set({ kind: 'slow' }, 0);
  faultActive.set({ kind: 'down' }, 0);

  const state = { down: false };

  app.post('/admin/fault', async (req, res) => {
    const { delayMs, down, durationS = 30 } = req.body;
    const normalDelay = work.delayMs;

    if (down) {
      state.down = true;
      faultActive.set({ kind: 'down' }, 1);
      await onDown();
    } else if (delayMs !== undefined) {
      work.delayMs = delayMs;
      faultActive.set({ kind: 'slow' }, 1);
    }
    console.log(`[fault] ${JSON.stringify(req.body)} started`);

    setTimeout(async () => {
      if (down) {
        state.down = false;
        faultActive.set({ kind: 'down' }, 0);
        await onUp();
      } else {
        work.delayMs = normalDelay;
        faultActive.set({ kind: 'slow' }, 0);
      }
      console.log(`[fault] ${JSON.stringify(req.body)} ended`);
    }, durationS * 1000);

    res.status(202).json({ accepted: true });
  });

  return state;
}

/** Counts per order id, used by the end-of-run audit (duplicate effects). */
class Ledger {
  constructor(...kinds) {
    for (const kind of kinds) this[kind] = new Map();
  }
  add(kind, orderId) {
    this[kind].set(orderId, (this[kind].get(orderId) || 0) + 1);
  }
  toJSON() {
    const out = {};
    for (const [kind, map] of Object.entries(this)) out[kind] = Object.fromEntries(map);
    return out;
  }
}

/**
 * Starts the HTTP server and exposes its open connections (hypothesis H4:
 * a slow dependency makes connections pile up in front of Order in option A).
 */
function listen(app, port, service) {
  const server = app.listen(port, () =>
    console.log(`[${service}] option ${OPTION} listening on port ${port}`)
  );
  new client.Gauge({
    name: 'http_server_open_connections',
    help: 'Open inbound TCP connections',
    collect() {
      return new Promise((resolve) =>
        server.getConnections((_err, count) => {
          this.set(count || 0);
          resolve();
        })
      );
    },
  });
  return server;
}

module.exports = { OPTION, isEventDriven, client, createApp, tagOrder, Work, mountFaultInjector, Ledger, listen, sleep };
