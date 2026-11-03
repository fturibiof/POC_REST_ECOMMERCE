#!/usr/bin/env node
/**
 * Builds the recette page docs/recette/recette.html (skill recette-livrable).
 *
 *   node scripts/build-recette.mjs                          # results/runs.csv if present
 *   node scripts/build-recette.mjs --csv results/rehearsals.csv
 *
 * Sources (the page has no content of its own, so it never drifts from them):
 *   docs/recette/scenarios.md   scenarios per deliverable (SOC, A, B, C, OBS, BANC, RES, DEC)
 *   docs/suivi.md               decisions D1..Dn (to validate in review)
 *   docs/poc-plan.md            requirements R1..R5 and hypotheses H1..Hn
 *   docs/recette/img/           captures + legendes.json (scripts/captures.mjs)
 *   results/*.csv               one line per run (scripts/report-run.mjs)
 *
 * Testers' marks (OK / KO / Blocked + comment) live in the published page's
 * shared database, one document per item and tester: marks/<item>--<tester>.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const CSV = arg('--csv', existsSync('results/runs.csv') ? 'results/runs.csv' : 'results/rehearsals.csv');
const IMG = 'docs/recette/img';
const OUT = 'docs/recette/recette.html';

// ---------------------------------------------------------------------------
// Markdown helpers: tables under a heading, minimal inline formatting
// ---------------------------------------------------------------------------
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) =>
  escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\\\|/g, '|');

function sections(markdown) {
  const out = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) out.push((current = { title: h[1], lines: [] }));
    else if (current) current.lines.push(line);
  }
  return out;
}

function tables(lines) {
  const result = [];
  let rows = null;
  for (const line of lines) {
    if (/^\|/.test(line)) {
      const cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      if (!rows) result.push((rows = [cells]));
      else rows.push(cells);
    } else rows = null;
  }
  return result.map(([header, ...body]) => body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))));
}

const prose = (lines) =>
  lines.filter((l) => l.trim() && !/^\|/.test(l)).map((l) => inline(l.replace(/^- /, '• '))).join('<br>');

// ---------------------------------------------------------------------------
// Captures attached to scenarios (prefix of the capture names)
// ---------------------------------------------------------------------------
const legends = existsSync(`${IMG}/legendes.json`) ? JSON.parse(readFileSync(`${IMG}/legendes.json`, 'utf8')) : {};
const images = existsSync(IMG) ? readdirSync(IMG).filter((f) => f.endsWith('.jpg')).sort() : [];
const shotsFor = (prefix, contains = '') => images.filter((f) => f.startsWith(prefix) && f.includes(contains));

const SHOTS = {
  'SOC-3': () => shotsFor('RES-S1-B-01'),
  'A-4': () => shotsFor('RES-S3-A-'),
  'A-5': () => shotsFor('RES-S4-A-'),
  'B-4': () => shotsFor('RES-S4-B-'),
  'B-5': () => shotsFor('RES-S5-off-B-'),
  'B-6': () => shotsFor('RES-S5-on-B-'),
  'C-3': () => shotsFor('RES-S4b-C-'),
  'OBS-1': () => shotsFor('RES-S1-A-', 'trace'),
  'OBS-2': () => shotsFor('RES-S1-B-', 'trace'),
  'OBS-2b': () => shotsFor('RES-S1-C-', 'trace'),
  'OBS-3': () => shotsFor('RES-S1-A-01'),
};

// ---------------------------------------------------------------------------
// Deliverables (scenarios.md)
// ---------------------------------------------------------------------------
const TAB_OF = { SOC: 'socle', A: 'option-a', B: 'option-b', C: 'option-c', OBS: 'observabilite', BANC: 'banc', RES: 'resultats', DEC: 'decision' };
const scenarioSections = sections(readFileSync('docs/recette/scenarios.md', 'utf8'));
const deliverables = [];
for (const s of scenarioSections) {
  const code = s.title.split(' ')[0];
  if (!TAB_OF[code]) continue;
  const items = (tables(s.lines)[0] || []).map((r) => ({
    id: r.Id,
    rev: Number(r.rev || 1),
    objective: r.Objectif || '',
    how: inline(r['Comment faire'] || ''),
    expected: inline(r.Attendu || r['Hypothèses'] || ''),
    shots: (SHOTS[r.Id]?.() || []).map((f) => ({ file: f, legend: legends[f] || f })),
  }));
  deliverables.push({ tab: TAB_OF[code], code, title: s.title, intro: prose(s.lines), items });
}

// ---------------------------------------------------------------------------
// Plan to validate: decisions (suivi.md), requirements and hypotheses (poc-plan.md)
// ---------------------------------------------------------------------------
const suivi = sections(readFileSync('docs/suivi.md', 'utf8'));
const decisions = (tables(suivi.find((s) => s.title.startsWith('Décisions'))?.lines || [])[0] || []).map((r) => ({
  id: r['#'], text: inline(r['Décision']), status: r.Statut, why: inline(r.Raison),
}));
const plan = sections(readFileSync('docs/poc-plan.md', 'utf8'));
const requirements = (tables(plan.find((s) => s.title.startsWith('2.'))?.lines || [])[0] || []).map((r) => ({
  id: r['#'], text: inline(r['Exigence']), threshold: inline(r['Seuil de succès']),
}));
const hypotheses = (tables(plan.find((s) => s.title.startsWith('3.'))?.lines || [])[0] || []).map((r) => ({
  id: r['#'], text: inline(r['Hypothèse (résumé)']), scenarios: inline(r['Scénarios']), metrics: inline(r['Métriques']), confirmed: inline(r['Confirmée si']),
}));

// ---------------------------------------------------------------------------
// Results (CSV): per scenario, A / B / C side by side
// ---------------------------------------------------------------------------
let results = { source: null, scenarios: [] };
if (existsSync(CSV)) {
  const [header, ...lines] = readFileSync(CSV, 'utf8').trim().split('\n');
  const cols = header.split(',');
  const runs = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
  const order = ['S1', 'S2', 'S3', 'S4', 'S4b', 'S5-off', 'S5-on'];
  // Breaking-point curve (S2-<rate>), by increasing rate.
  order.push(...[...new Set(runs.map((r) => r.scenario).filter((sc) => /^S2-[0-9]+$/.test(sc)))].sort((x, y) => x.slice(3) - y.slice(3)));
  const byScenario = {};
  for (const r of runs) (byScenario[r.scenario] ||= []).push(r);
  results = {
    source: CSV,
    rehearsal: runs.some((r) => Number(r.durationFactor) !== 1),
    scenarios: order.filter((s) => byScenario[s]).map((s) => ({
      id: s,
      runs: byScenario[s].map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== ''))),
      shots: Object.fromEntries(['A', 'A2', 'B', 'C'].map((o) => [o, shotsFor(`RES-${s}-${o}-`).map((f) => ({ file: f, legend: legends[f] || f }))])),
    })),
  };
}

let commit = 'inconnu';
try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}

const DATA = {
  generatedAt: new Date().toISOString(),
  commit,
  deliverables,
  decisions,
  requirements,
  hypotheses,
  results,
};

const template = readFileSync('docs/recette/recette.template.html', 'utf8');
const html = template.replace('/*__RECETTE_DATA__*/null', JSON.stringify(DATA).replace(/</g, '\\u003c'));
writeFileSync(OUT, html);
console.log(`recette written: ${OUT} — ${deliverables.reduce((n, d) => n + d.items.length, 0)} scenarios, ${decisions.length} decisions, ${hypotheses.length} hypotheses, ${results.scenarios.length} result scenarios (${CSV})`);
