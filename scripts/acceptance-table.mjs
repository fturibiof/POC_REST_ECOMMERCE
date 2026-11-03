#!/usr/bin/env node
/**
 * Acceptance table (R2, H1): how many of the orders OFFERED by k6 Order
 * actually recorded, per run. Crosses k6-summary.json (client side) with
 * audit.json (Order's ledger), so no number is copied by hand.
 *
 *   node scripts/acceptance-table.mjs results/runs/<id> [...]   # Markdown
 *   node scripts/acceptance-table.mjs --csv results/runs/*       # CSV
 *   node scripts/acceptance-table.mjs                            # every run of results/runs and results/rehearsals
 *
 * Why not k6's `unexpected_responses`: B answers 202 to every order, including
 * those that will be refused later, so its rate is ~0 by construction and cannot
 * be compared with A and C (which answer with the outcome).
 *
 * Definitions (docs/poc-plan.md §2):
 *   offered  = sent + dropped   (k6 open model: a dropped iteration is an order
 *                                the system was offered but k6 could not send,
 *                                because every virtual user was still waiting)
 *   recorded = confirmed + rejected in audit.json, i.e. orders whose outcome
 *              Order knows, minus the witness order sent outside k6 by run.sh
 *   confirmedShare = confirmed / recorded: same business mix in every option
 *              (~80 % valid) means the gap in `recorded` is architectural.
 *              Only meaningful without timeouts (S1, S2): in S3 the rejected
 *              orders include Payment timeouts.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const csv = args.includes('--csv');
let dirs = args.filter((a) => a !== '--csv');
if (!dirs.length) {
  dirs = ['results/runs', 'results/rehearsals']
    .filter((root) => existsSync(root))
    .flatMap((root) => readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name)));
}

const read = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));

function row(dir) {
  const run = read(dir, 'run.json');
  const k6 = read(dir, 'k6-summary.json').metrics;
  const { orders } = read(dir, 'audit.json');
  const sent = k6.orders_sent?.values.count ?? 0;
  const dropped = k6.dropped_iterations?.values.count ?? 0;
  // The witness order (run.sh) reaches Order but is not counted by k6.
  // A2 may refuse it at the door (503 REFUSED): it is then not recorded either.
  const response = existsSync(path.join(dir, 'witness-response.json')) ? readFileSync(path.join(dir, 'witness-response.json'), 'utf8') : '';
  const witness = existsSync(path.join(dir, 'witness.json')) && !response.includes('"REFUSED"') ? 1 : 0;
  const recorded = orders.confirmed + orders.rejected - witness;
  const offered = sent + dropped;
  const pct = (n, d) => (d ? (100 * n) / d : null);
  return {
    runId: run.runId,
    option: run.option,
    scenario: run.scenario,
    durationFactor: run.durationFactor,
    offered,
    sent,
    dropped,
    recorded,
    confirmed: orders.confirmed,
    rejected: orders.rejected,
    unfinished: orders.unfinished,
    recordedOfOfferedPct: pct(recorded, offered),
    recordedOfSentPct: pct(recorded, sent),
    confirmedSharePct: pct(orders.confirmed, orders.confirmed + orders.rejected),
  };
}

const rows = dirs.map(row).sort((a, b) => a.runId.localeCompare(b.runId));
const cols = Object.keys(rows[0] ?? {});

if (csv) {
  console.log(cols.join(','));
  for (const r of rows) console.log(cols.map((c) => (typeof r[c] === 'number' ? Number(r[c].toFixed(2)) : r[c] ?? '')).join(','));
} else {
  const fr = (v) => (v === null ? '—' : v.toFixed(1).replace('.', ','));
  const int = (v) => v.toLocaleString('fr-CA');
  console.log('| Passage | Option | Scénario | Offertes | Émises | Abandonnées (k6) | Enregistrées | % des offertes | % des émises | Confirmées / enregistrées |');
  console.log('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(`| ${r.runId} | ${r.option} | ${r.scenario} | ${int(r.offered)} | ${int(r.sent)} | ${int(r.dropped)} | ${int(r.recorded)} | ${fr(r.recordedOfOfferedPct)} % | ${fr(r.recordedOfSentPct)} % | ${fr(r.confirmedSharePct)} % |`);
  }
  if (rows.some((r) => r.durationFactor !== 1)) {
    console.log('\n> Passages à durée réduite (`durationFactor` ≠ 1) : répétitions, **non citables** (D13).');
  }
  console.log('> « Confirmées / enregistrées » ne sert de contrôle d\'équité que sans timeout (S1, S2).');
}
