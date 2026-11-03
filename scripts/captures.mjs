#!/usr/bin/env node
/**
 * Grafana and Tempo captures for the recette page (skill recette-livrable).
 *
 *   npm run captures                         # campaign runs (results/runs.csv)
 *   npm run captures -- --csv results/rehearsals.csv --out /tmp/check
 *   npm run captures -- --only S4            # one scenario
 *
 * For each option × scenario, the MEDIAN run of the repetitions is chosen on
 * the key metric of the scenario (never the "best" one), then Grafana is
 * opened in kiosk mode on the exact window of that run. Captures are named
 * RES-<scenario>-<option>-<nn>-<subject>.jpg; the script lists the new,
 * modified and removed images and flags panels showing "No data".
 * Must run on the machine that ran the campaign (Prometheus and Tempo data).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const CSV = arg('--csv', 'results/runs.csv');
const OUT = arg('--out', 'docs/recette/img');
const ONLY = arg('--only', null);
const GRAFANA = process.env.GRAFANA_URL || 'http://localhost:3300';
const NAME = /^RES-[A-Za-z0-9-]+-[ABC]-\d{2}-[a-z0-9-]+$/;

// Key metric per scenario: the one the scenario is about (docs/poc-plan.md §3).
const KEY_METRIC = {
  S1: 'accP95Ms', S2: 'accP95Ms', S3: 'complP95S', S4: 'recoveryS', S4b: 'recoveryS',
  'S5-off': 'duplicateEffects', 'S5-on': 'duplicateEffects',
};
// Panels shown on their own for each scenario, besides the whole dashboard.
const PANELS = {
  S1: ["Latence d'acceptation (première réponse)", 'Latence de complétion (commandes confirmées)', 'CPU par conteneur (cœurs)', 'Mémoire par conteneur'],
  S2: ["Latence d'acceptation (première réponse)", 'Commandes envoyées et réponses par statut (/s)', 'Commandes en cours (travail accumulé)', 'Commandes non envoyées par k6 (/s)'],
  S3: ["Latence d'acceptation (première réponse)", 'Latence de complétion (commandes confirmées)', 'Pool HTTP d’Order par service appelé (A, C)', 'Messages dans les files RabbitMQ (B, C)'],
  S4: ['Commandes envoyées et réponses par statut (/s)', 'Commandes en cours (travail accumulé)', 'Messages dans les files RabbitMQ (B, C)'],
  S4b: ['Commandes envoyées et réponses par statut (/s)', 'Commandes en cours (travail accumulé)', 'Messages dans les files RabbitMQ (B, C)'],
  'S5-off': ['Doublons injectés et ignorés (/s)', 'Registre d’idempotence (identifiants gardés)'],
  'S5-on': ['Doublons injectés et ignorés (/s)', 'Registre d’idempotence (identifiants gardés)'],
};

const slug = (text) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// ---------------------------------------------------------------------------
// Runs: read the CSV, keep the median run of each option × scenario
// ---------------------------------------------------------------------------
const [header, ...lines] = readFileSync(CSV, 'utf8').trim().split('\n');
const columns = header.split(',');
const runs = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [columns[i], v])));

const groups = {};
for (const r of runs) {
  if (ONLY && r.scenario !== ONLY) continue;
  (groups[`${r.scenario}|${r.option}`] ||= []).push(r);
}
const selected = Object.values(groups).map((group) => {
  const key = KEY_METRIC[group[0].scenario];
  const sorted = [...group].sort((a, b) => Number(a[key] || 0) - Number(b[key] || 0));
  return { run: sorted[Math.floor((sorted.length - 1) / 2)], key, of: group.length };
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
const dashboard = JSON.parse(readFileSync('infra/grafana/dashboards/poc.json', 'utf8'));
const panelId = (title) => dashboard.panels.find((p) => p.title === title)?.id;
const runDir = (id) => [path.join(path.dirname(CSV), path.basename(CSV, '.csv'), id)].find(existsSync);

mkdirSync(OUT, { recursive: true });
const before = Object.fromEntries(
  readdirSync(OUT).filter((f) => f.startsWith('RES-')).map((f) => [f, createHash('sha1').update(readFileSync(path.join(OUT, f))).digest('hex')])
);
const written = {};
const warnings = [];
const legends = {};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

async function shot(name, url, { fullHeight } = {}) {
  if (!NAME.test(name)) throw new Error(`capture name outside the contract: ${name}`);
  await page.setViewportSize({ width: 1600, height: fullHeight || 900 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500); // panels render after their queries return
  const noData = await page.getByText('No data', { exact: true }).count();
  if (noData) warnings.push(`${name}: ${noData} panel(s) "No data"`);
  const file = path.join(OUT, `${name}.jpg`);
  writeFileSync(file, await page.screenshot({ type: 'jpeg', quality: 80 }));
  written[`${name}.jpg`] = createHash('sha1').update(readFileSync(file)).digest('hex');
}

for (const { run, key, of } of selected) {
  const { runId, option, scenario } = run;
  const meta = JSON.parse(readFileSync(path.join(runDir(runId), 'run.json'), 'utf8'));
  const from = (meta.start - 30) * 1000;
  const to = (meta.end + 30) * 1000;
  const vars = `var-option=${option}&var-scenario=${scenario}&var-run=${runId}`;
  const base = `${GRAFANA}/d/poc/poc?orgId=1&from=${from}&to=${to}&${vars}&kiosk`;
  const prefix = `RES-${scenario}-${option}`;
  const caption = `passage ${runId} (médiane de ${of} sur ${key}), commit ${meta.commit}`;

  await shot(`${prefix}-01-tableau-de-bord`, base, { fullHeight: 2150 });
  legends[`${prefix}-01-tableau-de-bord.jpg`] = `Tableau de bord complet — ${caption}`;

  let n = 2;
  for (const title of PANELS[scenario] || []) {
    const name = `${prefix}-${String(n++).padStart(2, '0')}-${slug(title)}`;
    await shot(name, `${base}&viewPanel=${panelId(title)}`);
    legends[`${name}.jpg`] = `${title} — ${caption}`;
  }

  // Witness order: its trace in Tempo (sampled at 100 % whatever the ratio).
  const witness = path.join(runDir(runId), 'witness.json');
  if (existsSync(witness)) {
    const { traceId } = JSON.parse(readFileSync(witness, 'utf8'));
    const panes = { a: { datasource: 'tempo', queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, queryType: 'traceql', query: traceId }], range: { from: String(from), to: String(to) } } };
    const name = `${prefix}-${String(n++).padStart(2, '0')}-trace-commande-temoin`;
    await shot(name, `${GRAFANA}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}&kiosk`);
    legends[`${name}.jpg`] = `Trace de la commande témoin ${traceId} — ${caption}`;
  }
}
await browser.close();

// ---------------------------------------------------------------------------
// Report: new / modified / removed, legends for the recette page
// ---------------------------------------------------------------------------
const generatedScenarios = new Set(selected.map(({ run }) => `RES-${run.scenario}-${run.option}-`));
const removed = Object.keys(before).filter((f) => !written[f] && [...generatedScenarios].some((p) => f.startsWith(p)));
for (const f of removed) rmSync(path.join(OUT, f));

const legendFile = path.join(OUT, 'legendes.json');
const allLegends = existsSync(legendFile) ? JSON.parse(readFileSync(legendFile, 'utf8')) : {};
for (const f of removed) delete allLegends[f];
writeFileSync(legendFile, JSON.stringify({ ...allLegends, ...legends }, null, 2) + '\n');

const added = Object.keys(written).filter((f) => !before[f]);
const modified = Object.keys(written).filter((f) => before[f] && before[f] !== written[f]);
console.log(`captures: ${Object.keys(written).length} (${added.length} new, ${modified.length} modified, ${removed.length} removed) in ${OUT}`);
for (const f of [...added, ...modified]) console.log(`  to review: ${f}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
