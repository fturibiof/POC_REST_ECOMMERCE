# PoC MGL870 — traitement des commandes : synchrone, événementiel ou hybride ?

Expérience architecturale limitée pour décider comment traiter les commandes d'une plateforme de commerce électronique (énoncé : [docs/enonce-travail-etude.md](docs/enonce-travail-etude.md)). La décision est consignée dans [docs/ADR-001.md](docs/ADR-001.md).

**Point d'entrée de l'équipe : [docs/suivi.md](docs/suivi.md)** · plan d'expérience : [docs/poc-plan.md](docs/poc-plan.md) · règles pour l'IA : [AGENTS.md](AGENTS.md).

## Les trois options

Cinq services Node.js (Order, Payment, Inventory, Shipping, Notification), **le même code** pour les trois options : seule la façon de communiquer change (variable `OPTION`).

| Option | Payment, Inventory | Shipping, Notification | Réponse au client |
|---|---|---|---|
| A — synchrone | REST bloquant | REST bloquant | 201 après tout le workflow |
| B — événementielle | événements RabbitMQ | événements RabbitMQ | 202 dès que l'événement `OrderCreated` est enregistré |
| C — hybride | REST bloquant | événements (`OrderConfirmed`) | 201 dès que paiement et stock sont acquis |

```
A   Client ─► Order ─► Payment ─► Inventory ─► Shipping ─► Notification   (appels bloquants)

B   Client ─► Order ─► OrderCreated ─► Payment ─► PaymentAuthorized ─► Inventory ─► InventoryReserved
                                     ─► Shipping ─► ShipmentRequested ─► Order ─► OrderConfirmed ─► Notification

C   Client ─► Order ─► Payment ─► Inventory   (bloquant)  ─► OrderConfirmed ─► Shipping, Notification
```

Conditions identiques pour les trois (équité) : délais simulés (Payment 200 ms, autres 100 ms), concurrence de 100 par service appelé (pool HTTP en REST, prefetch en événements), 1 CPU et 512 Mo par service. **Invariant** : une commande n'est confirmée que si le paiement est autorisé et le stock réservé ; sinon le paiement est remboursé.

## Démarrer

Prérequis : Docker (contexte `default`, moteur natif ; Docker Desktop n'a que 3,9 Go), Node.js 22, `npm install`.

```bash
export DOCKER_CONTEXT=default
OPTION=A docker compose up -d --build                        # option A
OPTION=B COMPOSE_PROFILES=B docker compose up -d --build     # option B (avec RabbitMQ)
OPTION=C COMPOSE_PROFILES=B docker compose up -d --build     # option C (avec RabbitMQ)
```

| Adresse | Quoi |
|---|---|
| http://localhost:3000 | Order (`POST /orders`, `GET /orders/<id>`, `GET /stats`) |
| http://localhost:3001 … 3004 | Payment, Inventory, Shipping, Notification (`GET /audit`, `POST /admin/fault`) |
| http://localhost:3300 | Grafana : tableau de bord *PoC* et traces (Tempo) |
| http://localhost:9090 | Prometheus |
| http://localhost:15672 | RabbitMQ (guest / guest), options B et C |

### Passer une commande

```bash
curl -s -X POST localhost:3000/orders -H 'Content-Type: application/json' -d '{
  "customerId": "CUST-42",
  "items": [{ "itemId": "ITEM-001", "quantity": 1 }],
  "paymentInformation": { "cardNumber": "4111111111111111", "cardHolder": "Jane Doe", "expiryDate": "12/28", "cvv": "123" },
  "shippingAddress": { "street": "123 Main St", "city": "Montreal", "state": "QC", "zipCode": "H2X 1Y4", "country": "CA" }
}'
```

- Carte refusée : numéro qui se termine par `0000` (402 en A et C, `REJECTED` plus tard en B).
- Stock insuffisant : `ITEM-006` (409 en A et C, `REJECTED` plus tard en B ; le paiement est remboursé).
- Suivre une commande en B : `curl localhost:3000/orders/<orderId>`.

### Injecter une panne

```bash
curl -X POST localhost:3001/admin/fault -H 'Content-Type: application/json' -d '{"delayMs":2000,"durationS":120}'  # Payment lent (S3)
curl -X POST localhost:3001/admin/fault -H 'Content-Type: application/json' -d '{"down":true,"durationS":30}'     # Payment indisponible (S4)
curl -X POST localhost:3003/admin/fault -H 'Content-Type: application/json' -d '{"down":true,"durationS":30}'     # Shipping indisponible (S4b)
```

« Indisponible » : réponse 503 quand le service est appelé en REST, consommation suspendue quand il reçoit des événements (les messages attendent dans sa file).

## Mesurer

| Commande | Quoi |
|---|---|
| `scripts/run.sh <A\|B\|C> <S1\|S2\|S3\|S4\|S4b\|S5-off\|S5-on> [répétition]` | un passage : redémarrage à neuf, charge k6, attente de la fin du traitement, audit, métriques, ligne dans `results/runs.csv`, lien Grafana |
| `DURATION_FACTOR=0.25 scripts/run.sh …` | répétition courte, rangée à part dans `results/rehearsals/` (jamais une preuve) |
| `scripts/campaign.sh [3]` | toute la campagne (S1 à S4 sur A, B, C ; S5 sur B), puis les captures |
| `npm run captures` | captures Grafana et Tempo du passage médian de chaque option × scénario |
| `node scripts/build-recette.mjs` | page de recette `docs/recette/recette.html` |
| `npm run dashboard` | régénère le tableau de bord Grafana depuis `scripts/build-dashboard.mjs` |

Scénarios et seuils : [docs/poc-plan.md](docs/poc-plan.md). Validité d'un passage et règles de la campagne : skill [campagne-mesures](.claude/skills/campagne-mesures/SKILL.md).

## Observabilité

- **Traces** (OpenTelemetry → Tempo) : une commande se suit de bout en bout. En B et C, le contexte de trace voyage dans les en-têtes des messages RabbitMQ (`services/common/bus.js`), ce qui donne une seule trace à travers le broker. Recherche dans Grafana → Explore → Tempo : `{ span.order.id = "ORD-…" }`. Échantillonnage de 10 % sous charge ; la commande témoin de chaque passage est toujours tracée.
- **Métriques** (Prometheus) : k6 (côté client), les services (`prom-client`), RabbitMQ (par file), cAdvisor (CPU et mémoire par conteneur). Chaque panneau du tableau de bord indique l'hypothèse qu'il sert.

## Structure

```
services/common/   runtime (métriques, pannes), bus (RabbitMQ), telemetry (traces)
services/<svc>/    les cinq services, modes REST et événements
load-test/         script k6 des scénarios S1 à S5
scripts/           run, campaign, audit, report-run, captures, build-dashboard, build-recette
infra/             Prometheus, Tempo, Grafana (datasources, tableau de bord), RabbitMQ
results/           passages (runs/, runs.csv) et répétitions courtes (rehearsals/)
docs/              énoncé, ADR, PoC Plan, suivi, recette
```
