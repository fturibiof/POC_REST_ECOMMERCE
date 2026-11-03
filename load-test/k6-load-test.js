/**
 * k6 load test — PoC MGL870, scenarios S1 to S5 (docs/poc-plan.md §4).
 *
 * Normally launched by scripts/run.sh, inside the compose network:
 *   docker compose run --rm k6 run -e OPTION=A -e SCENARIO=S1 /scripts/k6-load-test.js
 *
 * Environment:
 *   OPTION           A | A2 | B | C (changes the expected status codes only)
 *   SCENARIO         S1 | S2 | S3 | S4 | S4b | S5-off | S5-on
 *                    | S2-<rate> (breaking-point curve: one constant level, e.g. S2-250)
 *   DURATION_FACTOR  1 by default; 0.25 for a short rehearsal run (not for the campaign)
 *   RUN_DIR          where to write k6-summary.json / k6-summary.txt
 *
 * Executor: ramping-arrival-rate — the target is a number of orders per
 * second, whatever the response time (open model, like real customers).
 * If the system slows down, k6 needs more VUs; when it runs out of them, the
 * missing orders are counted in `dropped_iterations`.
 *
 * Mix (same for every scenario): 80 % valid orders, 10 % declined cards,
 * 10 % out-of-stock item.
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const OPTION = (__ENV.OPTION || 'A').toUpperCase();
const SCENARIO = __ENV.SCENARIO || 'S1';
const FACTOR = Number(__ENV.DURATION_FACTOR || 1);
const BASE_URL = __ENV.BASE_URL || 'http://order:3000';
const SERVICE_URLS = { payment: 'http://payment:3001', shipping: 'http://shipping:3003' };
const RUN_DIR = __ENV.RUN_DIR || '/results';

// ---------------------------------------------------------------------------
// Profiles: [duration in s, target orders/s] — durations are scaled by FACTOR
// ---------------------------------------------------------------------------
const NOMINAL = 100;
const PROFILES = {
  S1: { stages: [[30, NOMINAL], [180, NOMINAL]] },
  S2: {
    stages: [
      [10, 100], [50, 100], [10, 200], [50, 200], [10, 300], [50, 300],
      [10, 400], [50, 400], [10, 500], [300, 500],
    ],
  },
  S3: { stages: [[10, NOMINAL], [230, NOMINAL]], fault: { at: 60, target: 'payment', body: { delayMs: 2000, durationS: 120 } } },
  S4: { stages: [[10, NOMINAL], [230, NOMINAL]], fault: { at: 60, target: 'payment', body: { down: true, durationS: 30 } } },
  // Optional (H7): a secondary service is down — off the critical path in B and C.
  S4b: { stages: [[10, NOMINAL], [230, NOMINAL]], fault: { at: 60, target: 'shipping', body: { down: true, durationS: 30 } } },
  'S5-off': { stages: [[10, NOMINAL], [170, NOMINAL]] },
  'S5-on': { stages: [[10, NOMINAL], [170, NOMINAL]] },
};

// Breaking-point curve: S2-<rate> = 30 s ramp, then 3 min at that rate, each
// level from a fresh system. Where an option falls, not just whether it does at 500/s.
const level = /^S2-(\d+)$/.exec(SCENARIO);
if (level) PROFILES[SCENARIO] = { stages: [[30, Number(level[1])], [180, Number(level[1])]] };

const profile = PROFILES[SCENARIO];
if (!profile) throw new Error(`Unknown SCENARIO ${SCENARIO}`);
const scale = (seconds) => Math.max(1, Math.round(seconds * FACTOR));

// The k6 scenario is named after the PoC scenario: k6 tags every metric with
// `scenario=<k6 scenario name>`, which overrides a --tag scenario=... flag.
const scenarios = {
  [SCENARIO]: {
    executor: 'ramping-arrival-rate',
    exec: 'placeOrder',
    startRate: 0,
    timeUnit: '1s',
    preAllocatedVUs: 200,
    maxVUs: Number(__ENV.MAX_VUS || 2000), // high enough that k6 is not the bottleneck
    stages: profile.stages.map(([duration, target]) => ({ duration: `${scale(duration)}s`, target })),
  },
};
if (profile.fault) {
  scenarios.fault = {
    executor: 'shared-iterations',
    exec: 'injectFault',
    vus: 1,
    iterations: 1,
    startTime: `${scale(profile.fault.at)}s`,
  };
}

export const options = {
  scenarios,
  summaryTrendStats: ['min', 'avg', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Not pass/fail criteria (the analysis applies the thresholds of the PoC
  // Plan): these always-true thresholds only make k6 compute the sub-metrics.
  thresholds: {
    'http_req_duration{name:POST /orders}': ['max>=0'],
    'unexpected_responses{kind:valid}': ['rate>=0'],
  },
  // Tags option / scenario / testid are added on the command line (run.sh),
  // so every metric pushed to Prometheus can be filtered in Grafana.
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
/** Response other than the expected one: 5xx, timeout, network error, wrong status. */
const unexpected = new Rate('unexpected_responses');
/** Orders sent, per kind (valid, declined_card, out_of_stock). */
const sent = new Counter('orders_sent');

// Expected first response per kind: A and C answer with the outcome of the
// critical path, B only acknowledges (the outcome comes later, by event).
const SYNC_CODES = { valid: 201, declined_card: 402, out_of_stock: 409 };
const EXPECTED = { A: SYNC_CODES, A2: SYNC_CODES, B: { valid: 202, declined_card: 202, out_of_stock: 202 }, C: SYNC_CODES }[OPTION];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------
const GOOD_CARDS = ['4111111111111111', '5500005555555559', '3714496353984312', '6011111111111117'];
const DECLINED_CARD = '4111111100000000';
const ITEMS = ['ITEM-001', 'ITEM-002', 'ITEM-003', 'ITEM-004', 'ITEM-005'];
const OUT_OF_STOCK_ITEM = 'ITEM-006';

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function payload(kind) {
  return JSON.stringify({
    customerId: `CUST-${randInt(1, 9999)}`,
    items: [{ itemId: kind === 'out_of_stock' ? OUT_OF_STOCK_ITEM : pick(ITEMS), quantity: 1 }],
    paymentInformation: {
      cardNumber: kind === 'declined_card' ? DECLINED_CARD : pick(GOOD_CARDS),
      cardHolder: 'Test User',
      expiryDate: '12/29',
      cvv: '123',
    },
    shippingAddress: { street: `${randInt(1, 999)} Test Ave`, city: 'Montreal', state: 'QC', zipCode: 'H2X 1Y4', country: 'CA' },
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Scenario functions
// ---------------------------------------------------------------------------
export function placeOrder() {
  const roll = Math.random();
  const kind = roll < 0.8 ? 'valid' : roll < 0.9 ? 'declined_card' : 'out_of_stock';

  const res = http.post(`${BASE_URL}/orders`, payload(kind), {
    headers: JSON_HEADERS,
    timeout: '10s',
    tags: { name: 'POST /orders', kind },
  });

  const ok = check(res, { [`${kind} -> ${EXPECTED[kind]}`]: (r) => r.status === EXPECTED[kind] }, { kind });
  unexpected.add(!ok, { kind });
  sent.add(1, { kind });
}

/** S3 / S4 / S4b: one call to the fault injector of the target service, at the planned time. */
export function injectFault() {
  const body = { ...profile.fault.body, durationS: scale(profile.fault.body.durationS) };
  const res = http.post(`${SERVICE_URLS[profile.fault.target]}/admin/fault`, JSON.stringify(body), { headers: JSON_HEADERS, tags: { name: 'fault' } });
  check(res, { 'fault injected': (r) => r.status === 202 });
}

// ---------------------------------------------------------------------------
// Summary: full JSON for scripts/report-run.mjs + short text for the console
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const m = data.metrics;
  const ms = (v) => (v === undefined ? 'n/a' : `${Math.round(v)} ms`);
  const d = m['http_req_duration{name:POST /orders}']?.values || m.http_req_duration?.values || {};
  const text = `
PoC MGL870 — option ${OPTION}, scenario ${SCENARIO}${FACTOR !== 1 ? ` (durations x${FACTOR})` : ''}
  orders sent         : ${m.orders_sent?.values.count ?? 0}  (${(m.orders_sent?.values.rate ?? 0).toFixed(1)}/s)
  dropped by k6       : ${m.dropped_iterations?.values.count ?? 0}  (k6 had no free VU: the system was too slow)
  VUs max             : ${m.vus_max?.values.max ?? 'n/a'}
  acceptance latency  : p50 ${ms(d['p(50)'])} · p95 ${ms(d['p(95)'])} · p99 ${ms(d['p(99)'])} · max ${ms(d.max)}
  unexpected responses: ${((m.unexpected_responses?.values.rate ?? 0) * 100).toFixed(2)} %
`;
  return {
    stdout: text,
    [`${RUN_DIR}/k6-summary.json`]: JSON.stringify(data, null, 1),
    [`${RUN_DIR}/k6-summary.txt`]: text,
  };
}
