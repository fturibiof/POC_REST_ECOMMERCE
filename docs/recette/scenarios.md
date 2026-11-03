# Scénarios de recette par livrable

Source de la page de recette publiée (skill `recette-livrable`). Chaque livrable se termine par sa recette : un membre de l'équipe **qui ne l'a pas construit** la rejoue et coche OK / KO / Bloqué.

**Règles :**
- Un identifiant n'est **jamais renommé** : les résultats des testeurs s'y rattachent.
- `rev` +1 quand les étapes ou le résultat attendu changent : les coches précédentes passent « à revérifier ».
- Captures nommées `<identifiant>-<nn>-<sujet>` (ex. `B-4-01-file-payment`, `RES-S4-C-02-files`), produites par script, jamais à la main.
- Les commandes citées dans « Comment faire » existent quand le livrable est terminé (étapes du [suivi](../suivi.md)).

## SOC — Socle (E3)

| Id | rev | Objectif | Comment faire | Attendu |
|---|---|---|---|---|
| SOC-1 | 1 | O3 | `OPTION=A docker compose up -d` puis `docker compose ps` | les 5 services et la supervision sont `running` |
| SOC-2 | 1 | O4 | Prometheus, page *Targets* | les 5 services et cAdvisor sont `UP` |
| SOC-3 | 1 | O4 | Grafana `localhost:3300`, tableau de bord PoC | filtres option, scénario, passage présents ; panneaux sans erreur |

## A — Option A, synchrone (E4)

| Id | rev | Objectif | Comment faire | Attendu |
|---|---|---|---|---|
| A-1 | 1 | O2 | commande valide (`curl` du README) | 201, statut `CONFIRMED`, paiement, réservation, expédition, notification présents |
| A-2 | 1 | O5 | carte se terminant par `0000` | 402 ; aucune réservation de stock |
| A-3 | 1 | O5 | article en rupture | 409 ; le paiement est **remboursé** (audit) |
| A-4 | 1 | O2 | Payment lent : `POST :3001/admin/fault {"delayMs":2000,"durationS":60}` puis une commande | réponse en plus de 2 s ; retour à la normale après 60 s ; panneau « panne » visible dans Grafana |
| A-5 | 1 | O2 | Payment indisponible : `{"down":true,"durationS":30}` puis une commande | 503 immédiat ; aucune commande confirmée pendant la panne |

## B — Option B, événementielle (E5, E6)

| Id | rev | Objectif | Comment faire | Attendu |
|---|---|---|---|---|
| B-1 | 1 | O2 | `OPTION=B`, commande valide, puis `GET /orders/<id>` | 202 `PENDING`, puis `CONFIRMED` ; événements dans l'ordre `OrderCreated → PaymentAuthorized → InventoryReserved → ShipmentRequested → OrderConfirmed` |
| B-2 | 1 | O5 | carte refusée | 202, puis `REJECTED` ; notification de rejet envoyée ; aucune réservation |
| B-3 | 1 | O5 | article en rupture | 202, puis `REJECTED` ; paiement **remboursé** |
| B-4 | 1 | O2 | Payment indisponible 30 s pendant un envoi continu | commandes toujours acceptées (202) ; la file `payment` grossit puis se vide ; toutes finissent confirmées ou rejetées |
| B-5 | 1 | O5 | `IDEMPOTENCY=off DUPLICATE_RATE=0.1`, quelques dizaines de commandes, audit | doubles paiements, réservations ou notifications **détectés** par l'audit |
| B-6 | 1 | O5 | même chose avec `IDEMPOTENCY=on` | 0 double effet ; doublons ignorés comptés dans Grafana |

## C — Option C, hybride (E6b)

| Id | rev | Objectif | Comment faire | Attendu |
|---|---|---|---|---|
| C-1 | 1 | O2 | `OPTION=C`, commande valide, puis `GET /orders/<id>` | 201 `CONFIRMED` dès que paiement et stock sont acquis ; expédition et notification arrivent ensuite par événement |
| C-2 | 1 | O5 | carte refusée, puis article en rupture | 402, puis 409 avec paiement **remboursé** ; aucun événement `OrderConfirmed` |
| C-3 | 1 | O2 | Shipping indisponible 30 s pendant un envoi continu (S4b) | commandes toujours confirmées (201) ; la file `shipping` grossit puis se vide |

## OBS — Observabilité (E7)

| Id | rev | Objectif | Comment faire | Attendu |
|---|---|---|---|---|
| OBS-1 | 1 | O4 | A : une commande, recherche dans Tempo par `order.id` | une trace : Order puis les 4 appels, en cascade bloquante |
| OBS-2 | 1 | O4 | B : une commande, même recherche | **une seule** trace qui traverse les 5 services via le broker (contexte propagé dans les messages) |
| OBS-2b | 1 | O4 | C : une commande, même recherche | une seule trace : partie synchrone (Payment, Inventory) puis partie événementielle (Shipping, Notification) |
| OBS-3 | 1 | O4 | lien Grafana affiché par `run.sh` | le tableau de bord s'ouvre sur la fenêtre du passage, filtré sur son option et son scénario |

## BANC — Banc d'essai (E8, E9)

| Id | rev | Objectif | Comment faire | Attendu |
|---|---|---|---|---|
| BANC-1 | 1 | O3 | `scripts/run.sh A S1` (version courte possible) | dossier `results/runs/<id>/` (résumé k6, audit, métriques), ligne ajoutée à `results/runs.csv`, lien Grafana affiché |
| BANC-2 | 1 | O3 | `npm run captures` | captures nommées selon le contrat, aucune « No data » ; liste des images nouvelles, modifiées, supprimées |

## RES — Résultats proposés (E12)

Un scénario par S1 à S5 : graphiques A, B, C (médiane, min, max des 3 répétitions), captures du passage médian, hypothèses concernées **confirmées ou infirmées** avec le chiffre et le passage source. Attendu : l'équipe est d'accord avec la lecture proposée, ou la conteste en commentaire.

| Id | Hypothèses |
|---|---|
| RES-S1 | H1 (nominal), H4 (ressources), H5, H6, H7 |
| RES-S2 | H1 (pic), H6, H7 |
| RES-S3 | H2, H4 (connexions), H6, H7 |
| RES-S4 | H2, H6, H7 (S4b si joué) |
| RES-S5 | H3, H6 |

## DEC — Décision proposée (E13)

| Id | rev | Objectif | Attendu |
|---|---|---|---|
| DEC-1 | 1 | O1 | matrice de décision : chaque case cite un résultat (RES-…) |
| DEC-2 | 1 | O1 | ADR-001 final : décision, preuves, compromis, limites, conséquences ; skill `revue-adr` passée sans point bloquant |
