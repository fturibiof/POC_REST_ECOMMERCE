#!/usr/bin/env node
/**
 * Turns one run into numbers: reads run.json, k6-summary.json and audit.json,
 * queries Prometheus over the run window, writes metrics.json and appends one
 * line to results/runs.csv (results/rehearsals.csv for short rehearsals). Each column serves a hypothesis of docs/poc-plan.md.
 *
 *   node scripts/report-run.mjs results/runs/<id>
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: report-run.mjs <run directory>');
const PROM = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const CSV = `${path.dirname(path.resolve(dir))}.csv`; // results/runs.csv or results/rehearsals.csv

const read = (file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
const run = read('run.json');
const k6 = read('k6-summary.json').metrics;
const audit = read('audit.json');
const witness = existsSync(path.join(dir, 'witness.json')) ? read('witness.json') : {};

// ---------------------------------------------------------------------------
// Prometheus helpers
// ---------------------------------------------------------------------------
async function promApi(endpoint, params) {
  const res = await fetch(`${PROM}/api/v1/${endpoint}?${new URLSearchParams(params)}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`${body.error} — ${params.query}`);
  return body.data.result;
}
/** Instant query; returns { label value: number } for `by` or a single number. */
async function value(query, time, by) {
  const result = await promApi('query', { query, time });
  if (by) return Object.fromEntries(result.map((r) => [r.metric[by], Number(r.value[1])]));
  return result.length ? Number(result[0].value[1]) : null;
}
async function series(query, start, end) {
  const result = await promApi('query_range', { query, start, end, step: 5 });
  return result.length ? result[0].values.map(([t, v]) => [Number(t), Number(v)]) : [];
}

const SUT = 'order|payment|inventory|shipping|notification|rabbitmq';
const SVC = `container_label_com_docker_compose_service=~"${SUT}"`;
const whole = `${run.end - run.start}s`; // load + drain
const load = `${run.loadEnd - run.start}s`; // load only

const round = (v, digits = 0) => (v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(digits)));
const ms = (seconds) => round(seconds * 1000);

// ---------------------------------------------------------------------------
// Client side (k6): acceptance — H1, H2, H5
// ---------------------------------------------------------------------------
const acceptance = k6['http_req_duration{name:POST /orders}']?.values || {};
const sent = k6.orders_sent?.values.count ?? 0;
const dropped = k6.dropped_iterations?.values.count ?? 0;

// ---------------------------------------------------------------------------
// Fault window (S3, S4, S4b) and recovery — H2, H7
// ---------------------------------------------------------------------------
const faultSeries = await series('max(fault_active)', run.start, run.end);
const faultOn = faultSeries.filter(([, v]) => v > 0).map(([t]) => t);
const fault = faultOn.length ? { start: faultOn[0], end: faultOn[faultOn.length - 1] } : null;

let accP95FaultMs = null;
let recoveryS = null;
if (fault) {
  const window = `${Math.max(fault.end - fault.start, 10)}s`;
  accP95FaultMs = ms(await value(
    `histogram_quantile(0.95, sum(rate(k6_http_req_duration_seconds{testid="${run.runId}",name="POST /orders"}[${window}])))`,
    fault.end
  ));
  // Back to normal = orders in progress back to their level before the fault.
  const pendingSeries = await series('sum(orders_pending)', run.start, run.end);
  const before = pendingSeries.filter(([t]) => t >= fault.start - 30 && t < fault.start).map(([, v]) => v);
  const baseline = before.length ? before.reduce((a, b) => a + b, 0) / before.length : 0;
  const back = pendingSeries.find(([t, v]) => t > fault.end && v <= baseline * 1.5 + 5);
  recoveryS = back ? back[0] - fault.end : null;
}

// ---------------------------------------------------------------------------
// Workflow, saturation, resources — H1, H4, H5
// ---------------------------------------------------------------------------
const completionQ = (q) =>
  value(`histogram_quantile(${q}, sum by (le) (increase(order_completion_seconds_bucket{outcome="confirmed"}[${whole}])))`, run.end);

const [complP50, complP95, complP99] = await Promise.all([completionQ(0.5), completionQ(0.95), completionQ(0.99)]);

const saturation = {
  maxPending: await value(`max_over_time(sum(orders_pending)[${whole}:5s])`, run.end),
  maxQueue: await value(`max_over_time(sum(rabbitmq_detailed_queue_messages)[${whole}:5s])`, run.end),
  maxQueueByQueue: await value(`max by (queue) (max_over_time(rabbitmq_detailed_queue_messages[${whole}]))`, run.end, 'queue'),
  maxPoolQueued: await value(`max_over_time(sum(http_client_pool_connections{state="queued"})[${whole}:5s])`, run.end),
  maxPoolInUse: await value(`max_over_time(sum(http_client_pool_connections{state="in_use"})[${whole}:5s])`, run.end),
  maxOrderConnections: await value(`max_over_time(http_server_open_connections{service="order"}[${whole}])`, run.end),
  maxEventLoopLagS: await value(`max(max_over_time(nodejs_eventloop_lag_p99_seconds[${whole}]))`, run.end),
};

const cpuByService = await value(
  `avg_over_time(sum by (container_label_com_docker_compose_service) (rate(container_cpu_usage_seconds_total{${SVC}}[15s]))[${load}:5s])`,
  run.loadEnd, 'container_label_com_docker_compose_service'
);
const memByService = await value(
  `max_over_time(sum by (container_label_com_docker_compose_service) (container_memory_working_set_bytes{${SVC}})[${whole}:5s])`,
  run.end, 'container_label_com_docker_compose_service'
);
const resources = {
  cpuCoresAvg: await value(`avg_over_time(sum(rate(container_cpu_usage_seconds_total{${SVC}}[15s]))[${load}:5s])`, run.loadEnd),
  cpuCoresMax: await value(`max_over_time(sum(rate(container_cpu_usage_seconds_total{${SVC}}[15s]))[${load}:5s])`, run.loadEnd),
  memMiBMax: (await value(`max_over_time(sum(container_memory_working_set_bytes{${SVC}})[${whole}:5s])`, run.end)) / 2 ** 20,
  cpuByService,
  memMiBByService: Object.fromEntries(Object.entries(memByService).map(([k, v]) => [k, round(v / 2 ** 20)])),
  // Load generator, on the same machine (limit of docs/poc-plan.md §6): if k6 sits
  // at its CPU cap (compose.yml), the run measures k6 as much as the system.
  k6CpuAvg: await value(`avg_over_time(sum(rate(container_cpu_usage_seconds_total{container_label_com_docker_compose_service="k6"}[15s]))[${load}:5s])`, run.loadEnd),
  k6CpuMax: await value(`max_over_time(sum(rate(container_cpu_usage_seconds_total{container_label_com_docker_compose_service="k6"}[15s]))[${load}:5s])`, run.loadEnd),
};

// ---------------------------------------------------------------------------
// Duplicates and idempotence — H3
// ---------------------------------------------------------------------------
const events = {
  duplicatesInjected: await value(`sum(increase(events_duplicates_injected_total[${whole}])) or vector(0)`, run.end),
  duplicatesIgnored: await value(`sum(increase(events_duplicates_ignored_total[${whole}])) or vector(0)`, run.end),
  idempotencyStoreMax: await value(`max_over_time(sum(idempotency_store_size)[${whole}:5s])`, run.end),
  failed: await value(`sum(increase(events_failed_total[${whole}])) or vector(0)`, run.end),
  // Loss paths of B and C that the audit cannot see (no dead-letter queue, unknown orderId).
  unknownOrder: await value(`sum(increase(events_unknown_order_total[${whole}])) or vector(0)`, run.end),
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const finished = audit.orders.confirmed + audit.orders.rejected;
const row = {
  runId: run.runId,
  option: run.option,
  scenario: run.scenario,
  repetition: run.repetition,
  durationFactor: run.durationFactor,
  commit: run.commit,
  dirty: run.dirty,
  sent,
  dropped,
  achievedRate: round(sent / (run.loadEnd - run.start), 1),
  accP50Ms: round(acceptance['p(50)']),
  accP95Ms: round(acceptance['p(95)']),
  accP99Ms: round(acceptance['p(99)']),
  accMaxMs: round(acceptance.max),
  unexpectedPct: round((k6.unexpected_responses?.values.rate ?? 0) * 100, 2),
  complP50S: round(complP50, 2),
  complP95S: round(complP95, 2),
  complP99S: round(complP99, 2),
  confirmed: audit.orders.confirmed,
  rejected: audit.orders.rejected,
  pending: audit.orders.pending,
  unfinished: audit.orders.unfinished,
  confirmedWithoutShipment: audit.confirmedWithoutShipment.count,
  rejectedShare: round(finished ? audit.orders.rejected / finished : 0, 3),
  drainS: run.end - run.loadEnd,
  maxPending: round(saturation.maxPending),
  maxQueue: round(saturation.maxQueue),
  maxPaymentQueue: round(saturation.maxQueueByQueue.payment),
  maxPoolQueued: round(saturation.maxPoolQueued),
  maxOrderConnections: round(saturation.maxOrderConnections),
  maxEventLoopLagMs: ms(saturation.maxEventLoopLagS),
  cpuCoresAvg: round(resources.cpuCoresAvg, 2),
  cpuCoresMax: round(resources.cpuCoresMax, 2),
  memMiBMax: round(resources.memMiBMax),
  rabbitCpuAvg: round(cpuByService.rabbitmq, 2),
  rabbitMemMiB: resources.memMiBByService.rabbitmq ?? null,
  faultStart: fault?.start ?? null,
  faultEnd: fault?.end ?? null,
  accP95FaultMs,
  recoveryS,
  invariantViolations: audit.invariantViolations,
  paidNotConfirmed: audit.leftovers.paidButNotConfirmed.count,
  duplicateEffects: audit.duplicateEffectsTotal,
  duplicatesInjected: round(events.duplicatesInjected),
  duplicatesIgnored: round(events.duplicatesIgnored),
  idempotencyStoreMax: round(events.idempotencyStoreMax),
  witnessTraceId: witness.traceId ?? null,
  eventsFailed: round(events.failed),
  unknownOrderEvents: round(events.unknownOrder),
  k6CpuAvg: round(resources.k6CpuAvg, 2),
  k6CpuMax: round(resources.k6CpuMax, 2),
};

writeFileSync(
  path.join(dir, 'metrics.json'),
  JSON.stringify({ row, fault, saturation, resources, events, completion: { complP50, complP95, complP99 } }, null, 2)
);

const csvValue = (v) => (v === null || v === undefined ? '' : String(v));
if (!existsSync(CSV)) writeFileSync(CSV, Object.keys(row).join(',') + '\n');
appendFileSync(CSV, Object.values(row).map(csvValue).join(',') + '\n');

console.log(
  `  sent ${row.sent} (dropped ${row.dropped}) · acceptance p95 ${row.accP95Ms} ms · completion p95 ${row.complP95S} s · ` +
  `unexpected ${row.unexpectedPct} % · invariant violations ${row.invariantViolations} · duplicate effects ${row.duplicateEffects}`
);
