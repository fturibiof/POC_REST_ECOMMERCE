/**
 * k6 Load Test — POC REST E-Commerce
 *
 * Executor: ramping-arrival-rate — targets are expressed in req/s, not VUs.
 * k6 automatically scales VUs up to maxVUs to try to hit the target rate.
 *
 * Usage:
 *   k6 run load-test/k6-load-test.js
 *
 * With raw JSON output for post-processing:
 *   k6 run --out json=load-test/results/run-001.json load-test/k6-load-test.js
 *
 * Override target URL at runtime:
 *   k6 run -e BASE_URL=http://192.168.1.10:3000 load-test/k6-load-test.js
 *
 * Scenario stages (total = 5 min / 300 s):
 *   0:00 – 0:30   Ramp   0 → 100 req/s   (warm-up)
 *   0:30 – 2:30   Hold      100 req/s     (normal load — 2 min)
 *   2:30 – 3:00   Ramp 100 → 500 req/s   (ramp to peak)
 *   3:00 – 4:30   Hold      500 req/s     (peak load   — 1.5 min)
 *   4:30 – 5:00   Ramp 500 →   0 req/s   (cool-down)
 *
 * VU sizing rationale:
 *   Each request takes ≥ 500 ms (artificial delays: 200+100+100+100).
 *   At 500 req/s that requires ≥ 500 × 0.5 = 250 concurrent VUs.
 *   We pre-allocate 300 and allow burst up to 600 to absorb queueing.
 */

import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

/** End-to-end latency as reported by the Order Service itself (latencyMs field) */
const orderServiceLatency = new Trend('order_service_latency', true);

/** Only counts unintended errors — intentional 4xx are excluded */
const errorRate = new Rate('error_rate');

/** Count of payment declines (intentional bad-card scenario) */
const paymentDeclines = new Counter('payment_declines');

/** Count of intentional inventory failures (bad-SKU scenario) */
const inventoryFailures = new Counter('inventory_failures');

/** Count of fully successful orders (201) */
const successfulOrders = new Counter('successful_orders');

/** Count of unintended stock-exhaustion errors (happy-path → 409) */
const stockExhaustedErrors = new Counter('stock_exhausted_errors');

// ---------------------------------------------------------------------------
// Load profile — ramping-arrival-rate (req/s targets, 5 min total)
// ---------------------------------------------------------------------------
export const options = {
  // Ask k6 to compute these percentiles so handleSummary can read them.
  // By default k6 only computes p(90) and p(95).
  summaryTrendStats: ['min', 'avg', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],

  scenarios: {
    order_load: {
      executor:        'ramping-arrival-rate',
      startRate:       0,           // req/s at t=0
      timeUnit:        '1s',        // rate unit
      preAllocatedVUs: 300,         // VUs ready from the start
      maxVUs:          600,         // hard cap (k6 will warn if it needs more)
      stages: [
        { duration: '30s',  target: 100 },  // ramp  0 → 100 req/s  (warm-up)
        { duration: '120s', target: 100 },  // hold    100 req/s     (normal — 2 min)
        { duration: '30s',  target: 500 },  // ramp 100 → 500 req/s
        { duration: '90s',  target: 500 },  // hold    500 req/s     (peak — 1.5 min)
        { duration: '30s',  target: 0   },  // ramp 500 →   0 req/s  (cool-down)
      ],
    },
  },

  thresholds: {
    // k6 built-in HTTP duration — only evaluated on successful (2xx) happy-path
    // requests via the tag filter, so intentional 4xx don't skew it.
    'http_req_duration{group:::happy_path}':  ['p(95)<1500', 'p(99)<3000'],

    // Order Service self-reported latency (excludes HTTP overhead)
    'order_service_latency':                  ['p(95)<1500', 'p(99)<3000'],

    // Unintended errors only (stock exhaustion, 5xx, network errors)
    'error_rate':                             ['rate<0.05'],
  },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// In-memory stock mirrors services/inventory/index.js but scaled up
// massively so stock never runs out during the load test.
// The inventory service resets on restart — keep these numbers in sync
// if you change the service. For load testing we use single-item orders
// for each request to make stock math predictable.
// ---------------------------------------------------------------------------
const ITEMS = [
  { itemId: 'ITEM-001', maxQty: 1 },
  { itemId: 'ITEM-002', maxQty: 1 },
  { itemId: 'ITEM-003', maxQty: 1 },
  { itemId: 'ITEM-005', maxQty: 1 },  // Skip ITEM-004 — only 5 in stock
];

// A bad SKU used to provoke an inventory failure (item does not exist)
const BAD_ITEM = { itemId: 'ITEM-999', quantity: 1 };

// Good cards pass; a card ending in "0000" is declined by the payment service
const GOOD_CARDS = [
  '4111111111111111',
  '5500005555555559',
  '3714496353984312',
  '6011111111111117',
];
const BAD_CARD = '4111111100000000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Single-item basket — keeps stock depletion predictable */
function randomItems() {
  const item = pick(ITEMS);
  return [{ itemId: item.itemId, quantity: item.maxQty }];
}

function buildPayload({ badCard = false, badItem = false } = {}) {
  return JSON.stringify({
    customerId: `CUST-${randInt(1, 9999)}`,
    items: badItem ? [BAD_ITEM] : randomItems(),
    paymentInformation: {
      cardNumber:  badCard ? BAD_CARD : pick(GOOD_CARDS),
      cardHolder: 'Test User',
      expiryDate: '12/29',
      cvv:        '123',
    },
    shippingAddress: {
      street:  `${randInt(1, 999)} Test Ave`,
      city:    'Springfield',
      state:   'IL',
      zipCode: '62701',
      country: 'US',
    },
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Default function — one iteration per VU per arrival slot
//
// NOTE: No sleep() here. With ramping-arrival-rate the executor controls
// *when* iterations start; sleep() inside the function only wastes VU
// capacity without affecting the actual arrival rate.
// ---------------------------------------------------------------------------
export default function () {
  // Scenario weights:  80% happy path | 10% bad card | 10% bad item
  const roll = Math.random();

  if (roll < 0.80) {
    // ── Happy path ────────────────────────────────────────────────────────
    group('happy_path', () => {
      const res = http.post(`${BASE_URL}/orders`, buildPayload(), { headers: JSON_HEADERS });

      const ok = check(res, {
        'status is 201':      (r) => r.status === 201,
        'payment approved':   (r) => r.json('payment.approved') === true,
        'inventory reserved': (r) => r.json('inventory.reserved') === true,
        'has trackingNumber': (r) => r.json('shipping.trackingNumber') !== undefined,
        'notification sent':  (r) => r.json('notification.sent') === true,
      });

      if (res.status === 201) {
        successfulOrders.add(1);
        const latency = res.json('latencyMs');
        if (latency) orderServiceLatency.add(latency);
        errorRate.add(false);
      } else if (res.status === 409) {
        // Stock exhausted — an unintended failure we want to track separately
        stockExhaustedErrors.add(1);
        errorRate.add(true);
      } else {
        // Any other unexpected status (5xx, network error, etc.)
        errorRate.add(true);
      }
    });

  } else if (roll < 0.90) {
    // ── Payment decline (intentional) ────────────────────────────────────
    group('payment_decline', () => {
      const res = http.post(`${BASE_URL}/orders`, buildPayload({ badCard: true }), { headers: JSON_HEADERS });

      check(res, {
        'status is 402':  (r) => r.status === 402,
        'has reason':     (r) => r.json('reason') !== undefined,
      });

      paymentDeclines.add(1);
      errorRate.add(false); // expected — not counted as a test failure
    });

  } else {
    // ── Inventory failure / unknown SKU (intentional) ─────────────────────
    group('inventory_failure', () => {
      const res = http.post(`${BASE_URL}/orders`, buildPayload({ badItem: true }), { headers: JSON_HEADERS });

      check(res, {
        'status is 409':  (r) => r.status === 409,
        'has reason':     (r) => r.json('reason') !== undefined,
      });

      inventoryFailures.add(1);
      errorRate.add(false); // expected — not counted as a test failure
    });
  }
}

// ---------------------------------------------------------------------------
// Summary hook — human-readable digest written to stdout + timestamped file
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const m = data.metrics;

  const fmt  = (v, unit = 'ms') => v !== undefined ? `${Math.round(v)}${unit}` : 'n/a';
  const pct  = (v)              => v !== undefined ? `${(v * 100).toFixed(1)}%` : 'n/a';
  const rate = (v)              => v !== undefined ? v.toFixed(2) : 'n/a';

  // Percentile values live under the key names set in summaryTrendStats
  const d  = m.http_req_duration?.values;
  const ol = m.order_service_latency?.values;

  const summary = `
╔══════════════════════════════════════════════════════════════╗
║           POC E-Commerce — k6 Load Test Summary              ║
╚══════════════════════════════════════════════════════════════╝

  Profile            : 0→100 req/s (warm-up 30s) → hold 100 req/s (2min)
                       → ramp 100→500 req/s (30s) → hold 500 req/s (1.5min)
                       → cool-down (30s)  |  Total: 5 min
  Total iterations   : ${m.iterations?.values?.count         ?? 'n/a'}
  VUs (peak)         : ${m.vus_max?.values?.max              ?? 'n/a'}

── Throughput ─────────────────────────────────────────────────
  Requests/sec       : ${rate(m.http_reqs?.values?.rate)} req/s
  Successful orders  : ${m.successful_orders?.values?.count  ?? 0}
  Payment declines   : ${m.payment_declines?.values?.count   ?? 0}  (intentional)
  Inventory failures : ${m.inventory_failures?.values?.count ?? 0}  (intentional bad-SKU)
  Stock exhausted    : ${m.stock_exhausted_errors?.values?.count ?? 0}  (unintended — restart services to reset)

── Latency — all requests (http_req_duration) ─────────────────
  min                : ${fmt(d?.min)}
  avg                : ${fmt(d?.avg)}
  p50                : ${fmt(d?.['p(50)'])}
  p90                : ${fmt(d?.['p(90)'])}
  p95                : ${fmt(d?.['p(95)'])}
  p99                : ${fmt(d?.['p(99)'])}
  max                : ${fmt(d?.max)}

── Latency — happy-path only (order_service_latency, latencyMs) 
  min                : ${fmt(ol?.min)}
  avg                : ${fmt(ol?.avg)}
  p50                : ${fmt(ol?.['p(50)'])}
  p95                : ${fmt(ol?.['p(95)'])}
  p99                : ${fmt(ol?.['p(99)'])}
  max                : ${fmt(ol?.max)}

── Error rates ────────────────────────────────────────────────
  Unintended errors  : ${pct(m.error_rate?.values?.rate)}   (threshold: <5%)
  Raw HTTP failures  : ${pct(m.http_req_failed?.values?.rate)}  (includes intentional 4xx)

`;

  const filename = `load-test/results/summary-${Date.now()}.txt`;
  return {
    stdout: summary,
    [filename]: summary,
  };
}
