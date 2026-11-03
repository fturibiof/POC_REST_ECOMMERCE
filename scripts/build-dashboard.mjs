#!/usr/bin/env node
/**
 * Generates the Grafana dashboard infra/grafana/dashboards/poc.json.
 *
 *   node scripts/build-dashboard.mjs
 *
 * Each panel names the hypothesis it serves (docs/poc-plan.md §3): a metric
 * that serves no hypothesis is not shown (énoncé §10).
 *
 * Filters: option (A, B, C), scenario, run. k6 metrics carry the three tags;
 * service metrics carry `option`; container and broker metrics carry none —
 * one option runs at a time, so the time range of the run selects them.
 */

import { writeFileSync } from 'node:fs';

const DS = { type: 'prometheus', uid: 'prometheus' };
const SUT = 'order|payment|inventory|shipping|notification|rabbitmq';
const RUN = 'testid=~"$run", name="POST /orders"';
const OPT = 'option="$option"';

let nextId = 1;
let y = 0;

function row(title) {
  const panel = { id: nextId++, type: 'row', title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] };
  y += 1;
  return panel;
}

/**
 * Time series panel.
 * targets: [[expr, legend]]; unit: Grafana unit; options: extra field config.
 */
function timeseries({ title, hypothesis, description, targets, unit = 'short', w = 8, h = 8, x = 0, stack = false, softMax, thresholdLine }) {
  const defaults = {
    unit,
    min: 0,
    custom: {
      drawStyle: 'line',
      lineWidth: 2,
      fillOpacity: stack ? 30 : 5,
      showPoints: 'never',
      spanNulls: true,
      stacking: { mode: stack ? 'normal' : 'none' },
      ...(softMax !== undefined && { axisSoftMax: softMax }),
      ...(thresholdLine !== undefined && { thresholdsStyle: { mode: 'line+area' } }),
    },
    ...(thresholdLine !== undefined && {
      thresholds: { mode: 'absolute', steps: [{ color: 'transparent', value: null }, { color: 'red', value: thresholdLine }] },
    }),
  };
  return {
    id: nextId++,
    type: 'timeseries',
    title,
    description: `${hypothesis} — ${description}`,
    datasource: DS,
    gridPos: { h, w, x, y },
    fieldConfig: { defaults, overrides: [] },
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi', sort: 'desc' } },
    targets: targets.map(([expr, legendFormat], i) => ({ refId: String.fromCharCode(65 + i), datasource: DS, expr, legendFormat, range: true })),
  };
}

/** Places panels of one line, left to right. */
function line(...panels) {
  let x = 0;
  for (const p of panels) {
    p.gridPos.x = x;
    p.gridPos.y = y;
    x += p.gridPos.w;
  }
  y += Math.max(...panels.map((p) => p.gridPos.h));
  return panels;
}

const quantiles = (metric, filter, by = '') =>
  [0.5, 0.95, 0.99].map((q) => [
    `histogram_quantile(${q}, sum ${by ? `by (${by}) ` : ''}(rate(${metric}{${filter}}[$__rate_interval])))`,
    `p${q * 100}`,
  ]);

const panels = [
  row('Côté client (k6) — ce que voit le client'),
  ...line(
    timeseries({
      title: 'Commandes envoyées et réponses par statut (/s)',
      hypothesis: 'H1, H2',
      description: 'débit reçu par le client, par code HTTP. 201/402/409 (A, C) ou 202 (B) sont prévus ; 503 et 0 (délai dépassé) ne le sont pas.',
      targets: [[`sum by (status) (rate(k6_http_reqs_total{${RUN}}[$__rate_interval]))`, '{{status}}']],
      unit: 'reqps',
      w: 12,
      stack: true,
    }),
    timeseries({
      title: "Latence d'acceptation (première réponse)",
      hypothesis: 'H1, H2, H7 · seuil R3 : p95 < 1 s',
      description: 'temps entre l’envoi de la commande et la première réponse HTTP, mesuré par k6. La ligne rouge marque 1 s.',
      targets: quantiles('k6_http_req_duration_seconds', RUN),
      unit: 's',
      w: 12,
      softMax: 1.2,
      thresholdLine: 1,
    })
  ),
  ...line(
    timeseries({
      title: 'Réponses inattendues (%)',
      hypothesis: 'H1, H2 · seuil R2 : < 1 %',
      description: '5xx, délai dépassé ou erreur réseau, rapportés à toutes les réponses.',
      targets: [[
        `100 * (sum(rate(k6_http_reqs_total{${RUN}, status!~"201|202|402|409"}[$__rate_interval])) or vector(0)) / sum(rate(k6_http_reqs_total{${RUN}}[$__rate_interval]))`,
        'inattendues',
      ]],
      unit: 'percent',
      softMax: 5,
      thresholdLine: 1,
    }),
    timeseries({
      title: 'Utilisateurs virtuels k6 actifs',
      hypothesis: 'validité',
      description: 'si les VUs approchent de maxVUs, k6 devient le goulot et le passage n’est plus valide (skill campagne-mesures).',
      targets: [['sum(k6_vus{testid=~"$run"})', 'VUs']],
    }),
    timeseries({
      title: 'Commandes non envoyées par k6 (/s)',
      hypothesis: 'H1',
      description: 'k6 n’avait plus d’utilisateur virtuel libre : le système répondait trop lentement pour suivre la cadence.',
      targets: [['sum(rate(k6_dropped_iterations_total{testid=~"$run"}[$__rate_interval])) or vector(0)', 'abandonnées']],
      unit: 'reqps',
    })
  ),

  row('Workflow — ce que fait le système'),
  ...line(
    timeseries({
      title: 'Commandes terminées par issue (/s)',
      hypothesis: 'H1',
      description: 'débit de traitement réel : commandes dont le workflow est fini (confirmées ou rejetées).',
      targets: [[`sum by (outcome) (rate(orders_completed_total{${OPT}}[$__rate_interval]))`, '{{outcome}}']],
      unit: 'reqps',
      stack: true,
    }),
    timeseries({
      title: 'Latence de complétion (commandes confirmées)',
      hypothesis: 'H5, H2',
      description: 'réception → issue connue et expédition demandée, mesurée par Order de la même façon pour A, B et C.',
      targets: quantiles('order_completion_seconds_bucket', `${OPT}, outcome="confirmed"`, 'le'),
      unit: 's',
    }),
    timeseries({
      title: 'Commandes en cours (travail accumulé)',
      hypothesis: 'H1 · seuil R1 : stable sur un palier',
      description: 'commandes reçues dont le workflow n’est pas fini : en traitement (A) ou en attente dans les files (B, C).',
      targets: [[`sum(orders_pending{${OPT}})`, 'en cours']],
    })
  ),

  row('Saturation — où le travail attend'),
  ...line(
    timeseries({
      title: 'Pool HTTP d’Order par service appelé (A, C)',
      hypothesis: 'H4',
      description: 'connexions utilisées et requêtes en attente d’une connexion libre (pool de 100 par service).',
      targets: [[`sum by (target, state) (http_client_pool_connections{${OPT}})`, '{{target}} {{state}}']],
      w: 6,
    }),
    timeseries({
      title: 'Messages dans les files RabbitMQ (B, C)',
      hypothesis: 'H2, H4',
      description: 'messages prêts ou en cours de traitement, par file (une file par service).',
      targets: [['sum by (queue) (rabbitmq_detailed_queue_messages)', '{{queue}}']],
      w: 6,
    }),
    timeseries({
      title: 'Connexions entrantes d’Order',
      hypothesis: 'H4',
      description: 'connexions TCP ouvertes par les clients : elles s’accumulent quand Order répond lentement.',
      targets: [[`sum(http_server_open_connections{service="order", ${OPT}})`, 'order']],
      w: 6,
    }),
    timeseries({
      title: 'Retard de la boucle d’événements Node (p99)',
      hypothesis: 'validité',
      description: 'un service dont la boucle prend du retard est saturé en CPU, ce qui fausse ses délais simulés.',
      targets: [[`nodejs_eventloop_lag_p99_seconds{${OPT}}`, '{{service}}']],
      unit: 's',
      w: 6,
    })
  ),

  row('Ressources — ce que ça coûte'),
  ...line(
    timeseries({
      title: 'CPU par conteneur (cœurs)',
      hypothesis: 'H4, H7',
      description: 'cAdvisor ; RabbitMQ compte dans le coût de B et C.',
      targets: [[
        `sum by (container_label_com_docker_compose_service) (rate(container_cpu_usage_seconds_total{container_label_com_docker_compose_service=~"${SUT}"}[$__rate_interval]))`,
        '{{container_label_com_docker_compose_service}}',
      ]],
      w: 12,
      stack: true,
    }),
    timeseries({
      title: 'Mémoire par conteneur',
      hypothesis: 'H4, H7, H3',
      description: 'mémoire de travail (cAdvisor) ; inclut le registre d’idempotence des consommateurs.',
      targets: [[
        `sum by (container_label_com_docker_compose_service) (container_memory_working_set_bytes{container_label_com_docker_compose_service=~"${SUT}"})`,
        '{{container_label_com_docker_compose_service}}',
      ]],
      unit: 'bytes',
      w: 12,
      stack: true,
    })
  ),

  row('Pannes et doublons'),
  ...line(
    timeseries({
      title: 'Panne injectée',
      hypothesis: 'H2, H7',
      description: '1 pendant la panne : lent (S3) ou indisponible (S4 sur Payment, S4b sur Shipping).',
      targets: [[`max by (service, kind) (fault_active{${OPT}})`, '{{service}} {{kind}}']],
      softMax: 1,
    }),
    timeseries({
      title: 'Doublons injectés et ignorés (/s)',
      hypothesis: 'H3',
      description: 'événements publiés deux fois (S5) et doublons écartés par les consommateurs idempotents.',
      targets: [
        [`sum(rate(events_duplicates_injected_total{${OPT}}[$__rate_interval])) or vector(0)`, 'injectés'],
        [`sum(rate(events_duplicates_ignored_total{${OPT}}[$__rate_interval])) or vector(0)`, 'ignorés'],
      ],
      unit: 'reqps',
    }),
    timeseries({
      title: 'Registre d’idempotence (identifiants gardés)',
      hypothesis: 'H3',
      description: 'coût mémoire de la déduplication : un identifiant par événement traité, tous services confondus.',
      targets: [[`sum(idempotency_store_size{${OPT}})`, 'identifiants']],
    })
  ),
];

const variable = (name, label, query) => ({
  name,
  label,
  type: 'query',
  datasource: DS,
  query: { query, refId: name },
  refresh: 2, // on time range change
  sort: 1,
  includeAll: false,
  multi: false,
});

const dashboard = {
  uid: 'poc',
  title: 'PoC — commandes : synchrone, événementiel, hybride',
  description: 'Un passage = une option, un scénario, une répétition. Lien exact affiché par scripts/run.sh.',
  tags: ['mgl870', 'poc'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  editable: true,
  graphTooltip: 1, // shared crosshair
  time: { from: 'now-15m', to: 'now' },
  refresh: '',
  annotations: {
    list: [
      {
        name: 'Passages',
        datasource: { type: 'datasource', uid: 'grafana' },
        enable: true,
        iconColor: 'rgba(120, 120, 120, 0.4)',
        target: { type: 'tags', tags: ['run'], limit: 100, matchAny: true },
      },
    ],
  },
  templating: {
    list: [
      {
        name: 'option',
        label: 'Option',
        type: 'custom',
        query: 'A,B,C',
        current: { text: 'A', value: 'A' },
        options: ['A', 'B', 'C'].map((v, i) => ({ text: v, value: v, selected: i === 0 })),
      },
      variable('scenario', 'Scénario', 'label_values(k6_http_reqs_total{option="$option"}, scenario)'),
      variable('run', 'Passage', 'label_values(k6_http_reqs_total{option="$option", scenario="$scenario"}, testid)'),
    ],
  },
  panels,
};

const out = new URL('../infra/grafana/dashboards/poc.json', import.meta.url);
writeFileSync(out, JSON.stringify(dashboard, null, 2) + '\n');
console.log(`dashboard written: ${panels.length} panels`);
