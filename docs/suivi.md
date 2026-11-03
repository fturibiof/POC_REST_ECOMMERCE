# PoC 1 — Synchrone ou événementiel : suivi

**Dernière mise à jour :** 02/11/2026
**Remise :** lundi 09/11/2026, 18 h (objectif interne : 12 h)
**Prochaine action :** E1/E2 — l'équipe rejoue la recette publiée (E9) et valide l'onglet « Plan à valider » ; puis E11, la campagne

**Mode de travail :** on avance le plus loin possible ; décisions, PoC Plan et résultats restent « Proposé » et sont validés ou contestés par l'équipe **dans la recette**, avant la campagne.

À lire en début de séance, à mettre à jour en fin de séance (étapes + journal).

Références : [énoncé](enonce-travail-etude.md) · [ADR-001](ADR-001.md) · [PoC Plan](poc-plan.md) · [scénarios de recette](recette/scenarios.md) · [protocole de campagne](campagne.md) · **pull request : https://github.com/fturibiof/POC_REST_ECOMMERCE/pull/1** (depuis le fork `MarcTsobgny2321/POC_REST_ECOMMERCE`) · [AGENTS.md](../AGENTS.md) · **recette publiée : https://claude.ai/artifact/CT7gqqh1kWYKE6sBEiSqD2** (privée : à partager depuis le menu Partager)

Statuts : ⬜ à faire · 🔄 en cours · ✅ terminé · ⏸ bloqué

## Objectifs

Le but n'est pas de construire une plateforme, mais de **prendre une décision d'architecture appuyée sur des preuves** (énoncé §12-13).

| # | Objectif | Atteint quand | Livrable (énoncé §14) |
|---|---|---|---|
| O1 | Répondre à la question : synchrone, événementiel, hybride ou pas de décision | ADR-001 donne une décision finale, chaque argument renvoyant à une mesure | ADR-001 final |
| O2 | Comparer A, B et C **à armes égales** | même logique métier, mêmes délais, même concurrence, mêmes ressources ; seul le style de communication change | PoC Implementation |
| O3 | Produire des preuves reproductibles | S1 à S4 sur A, B et C, S5 sur B, 3 répétitions, données brutes versionnées, une commande relance un passage | Experimental Evidence |
| O4 | Pouvoir expliquer ce qui s'est passé | une commande se suit de bout en bout (trace) ; le tableau de bord montre saturation, files et ressources par option, scénario, passage | Experimental Evidence |
| O5 | Vérifier l'invariant métier | audit de fin de passage : aucune commande confirmée sans paiement autorisé et stock réservé ; doubles effets comptés | Architecture Analysis |
| O6 | Relier chaque mesure à une hypothèse | tableau du PoC Plan validé **avant** la campagne | PoC Plan |

## Décisions

| # | Décision | Statut | Raison |
|---|---|---|---|
| D1 | Même code par service, mode choisi par `OPTION=A\|B\|C` | Proposé | seul le transport diffère (O2) |
| D2 | B en chorégraphie avec RabbitMQ (comme l'ADR) | À valider | broker léger, déjà prévu par l'ADR |
| D3 | Concurrence de référence 100 : pool HTTP pour les appels synchrones (A, partie synchrone de C), prefetch pour les événements (B, partie événementielle de C) | À valider | même capacité par service appelé (O2) |
| D4 | B : 202 renvoyé après confirmation du broker | Proposé | « accepté » = enregistré durablement |
| D5 | Pannes injectées par une route d'administration, identique en A, B et C : Payment (S3, S4) et Shipping (S4b) | Proposé | plus simple que Toxiproxy (Docconnect), même panne pour les deux options |
| D6 | Supervision : Prometheus, Tempo, Grafana, cAdvisor (versions de Docconnect) ; ni Loki ni Alertmanager | Proposé | la trace suffit à reconstruire une commande (O4) |
| D7 | Docker en contexte `default` (moteur natif, 12 CPU, 16 Go) ; k6 en conteneur | Proposé | Docker Desktop n'a que 3,9 Go ; k6 n'est pas installé |
| D8 | Captures Grafana et traces **automatiques** (Playwright, mode kiosque), passage **médian**, axes fixes | Proposé | reproductibles, pas de choix du « plus beau » passage |
| D9 | Recette HTML publiée par livrable, résultats des testeurs partagés (OK / KO / Bloqué + commentaire) | Proposé | les résultats sont présentés à l'équipe comme propositions |
| D10 | Graphiques A, B, C calculés depuis `results/runs.csv` (3 répétitions), dans la recette | Proposé | une capture ne montre qu'un passage |
| D11 | **Option C hybride construite et mesurée** : Payment et Inventory en synchrone (201 = paiement et stock garantis), puis `OrderConfirmed` publié pour Shipping et Notification | Validé (Marc, 02/11) | une conclusion « hybride » doit reposer sur des mesures (énoncé §11), pas sur une opinion |
| D12 | Complétion mesurée de la même façon pour A, B et C : de la réception jusqu'à l'issue connue **et**, si la commande est confirmée, l'expédition demandée. En C, le 201 arrive donc avant la fin du workflow, comme le 202 en B | Proposé | comparer des durées comparables (H5) ; la notification n'est pas comptée |
| D13 | Répétitions courtes (`DURATION_FACTOR`) rangées à part (`results/rehearsals/`) : jamais utilisées comme preuves | Proposé | traçabilité (AGENTS.md, règle 2) |
| D14 | Tableau de bord Grafana généré par `scripts/build-dashboard.mjs`, chaque panneau nomme l'hypothèse qu'il sert | Proposé | énoncé §10 : aucune métrique sans hypothèse |
| D15 | Campagne : ordre des options alterné à chaque répétition (A B C, B C A, C A B) | Proposé | une dérive de la machine ne pénalise pas toujours la même option |

**Questions ouvertes :** noms ou rôles dans la recette ? Présentation orale (décide des vidéos, D8) ? Machine qui joue la campagne (les captures s'y font) ?

## Étapes

| # | Étape | Dépend de | Responsable | Terminée quand | Statut |
|---|---|---|---|---|---|
| E1 | Cadrage : énoncé, ADR-001 candidat, décisions D1-D15, responsables | — | équipe | responsables attribués ; décisions validées en recette (E9) | 🔄 |
| E2 | Prérequis : `AGENTS.md`, suivi, brouillon du PoC Plan, scénarios de recette, skills | E1 | Marc + IA | fichiers en place ; PoC Plan validé en recette (E9), **avant la campagne** | ✅ (validation en E9) |
| E3 | Socle : `docker compose` (1 conteneur par service), Prometheus, Tempo, Grafana, cAdvisor | E1 | | la stack démarre ; les métriques des 5 services remontent | ✅ construit (recette SOC à rejouer) |
| E4 | Option A complétée : identifiants uniques, pool, remboursement, pannes S3/S4 | E3 | | recette A-1 à A-5 | ✅ construit (recette A à rejouer) |
| E5 | Option B : chorégraphie, 202, statut, latence de complétion | E3 | | recette B-1 à B-3 | ✅ construit (recette B à rejouer) |
| E6 | Robustesse B : panne, idempotence, doublons (S5) | E5 | | recette B-4 à B-6 | ✅ construit (recette B-4 à B-6 à rejouer) |
| E6b | Option C hybride : chemin critique synchrone, Shipping et Notification par événements | E4, E5 | | recette C-1 à C-3 | ✅ construit (recette C à rejouer) |
| E7 | Observabilité : traces A, B, C (contexte dans les en-têtes AMQP), tableau de bord filtré par option, scénario, passage | E4, E5, E6b | | recette OBS-1 à OBS-3 | ✅ construit (recette OBS à rejouer) |
| E8 | Banc d'essai : k6 S1 à S5, `run.sh`, `campaign.sh`, audit, `results/runs.csv` | E4, E5, E6b | | recette BANC-1 | ✅ construit (recette BANC-1 à rejouer) |
| E9 | Recette : captures automatiques, page HTML publiée (v1 : livrables E3-E8) | E7, E8 | | recette BANC-2 ; page publiée | ✅ publiée le 02/11 (v1 : répétition générale) |
| E10 | **Point d'arrêt (mer. 04/11)** : passage court de chaque scénario sur A, B et C | E6, E6b, E9 | | sinon réduire le périmètre (ci-dessous) | ✅ 02/11 : 17 passages courts, aucun échec |
| E11 | Campagne : S1 à S4 × A, B, C et S5 × B, 3 répétitions (≈ 1 h 30 par répétition ; protocole [campagne.md](campagne.md), skill `campagne-mesures`) | E10 | | résultats bruts versionnés, aucun passage invalide non expliqué | ⬜ |
| E12 | Résultats proposés : captures du passage médian, graphiques, onglet « Résultats » de la recette | E11 | | recette RES-S1 à RES-S5 | ⬜ |
| E13 | Analyse et matrice de décision, **par l'équipe** ; ADR-001 final, limites, section « utilisation de l'IA » | E12 | équipe | recette DEC-1, DEC-2 ; skill `revue-adr` passée | ⬜ |
| E14 | Relecture croisée et remise | E13 | équipe | remis | ⬜ |

*(Sans objet : E10 atteint le 02/11.)* **Si E10 n'est pas atteint le mercredi :** observabilité réduite à un `correlationId` dans les logs, S5 limité à Payment et Inventory, 2 répétitions au lieu de 3, pas de vidéo, S2 sur C en une seule répétition.

## Corrections proposées pour l'ADR-001 (E2)

- H1 : 500 cmd/s correspond à 5 fois la charge nominale, pas 10.
- AD-2 : « 2 semaindes » → « 2 secondes ».
- Ajouter H5 (latence de complétion, énoncé H2), H6 (invariant) et H7 (option C), voir le PoC Plan.
- Option C : préciser qu'elle est construite et mesurée (D11).
- Relier chaque hypothèse aux scénarios S1 à S5 (tableau du PoC Plan).

## Journal

| Date | Fait | Résultat ou constat |
|---|---|---|
| 28/10 | Option A : 5 services REST, délais simulés | Order orchestre 4 appels bloquants |
| 29/10 | Premier test k6 (0 → 100 → 500/s) | 193 req/s en moyenne, p95 2,1 s, environ 23 % de requêtes abandonnées par k6 ; limite possible du générateur (600 VUs) ; identifiants non uniques sous charge |
| 02/11 | Lecture de l'énoncé ; plan ; reprise d'éléments de Docconnect (supervision, `AGENTS.md`, `suivi.md`, `revue-critique`, `uat-manual`, captures Playwright) | branche `feat/poc-a-b-observabilite` ; dépendances installées (versions fixées) ; `services/common/runtime.js` en brouillon ; prérequis E2 rédigés |
| 02/11 | Décision D11 : l'option C (hybride) est construite et mesurée | ajout de E6b, de H7 et du scénario facultatif S4b (Shipping indisponible) |
| 02/11 | E3 à E8 construits d'un trait (seule session qui code, après passation de la session `poc-rest-ecommerce-4d`) : services A, B, C ; `compose.yml` ; supervision ; k6 S1 à S5 et S4b ; `run.sh`, `campaign.sh`, audit, `report-run` ; tableau de bord ; captures ; page de recette | trace B vérifiée : une seule trace à travers le broker (OBS-2) ; défaut trouvé et corrigé : k6 écrasait l'étiquette `scenario` (filtre Grafana vide) |
| 02/11 | E10 : répétition générale courte (durées × 0,25, 1 passage) de S1 à S4, S4b sur A, B, C et S5 sur B | voir l'onglet « Résultats » de la recette ; **ce ne sont pas des preuves** |
| 02/11 | Commit `eec1236` du travail en cours ; corrections des documents proposées par Marc : définitions alignées sur D12, C ajoutée dans D1, D3 et D5, dépendance E6b de E8, E9 et E10 remis « en cours » (marqués terminés trop tôt) | l'URL de la recette sera ajoutée aux références à la publication |
| 02/11 | E10 et E9 : 17 passages courts réussis (A, B, C × S1 à S4 et S4b ; B × S5-off, S5-on) ; 92 captures relues par échantillon ; recette publiée | constats à discuter en recette, **pas des preuves** : (1) A-S2 et C-S2, k6 n'a pas envoyé 15 738 et 13 290 commandes (plafond de 2 000 VUs atteint ?) : validité de S2 à trancher avant la campagne ; (2) A-S3 et C-S3, environ 1 700 commandes payées mais rejetées : Order abandonne après 5 s alors que Payment finit par autoriser (paiement « fantôme ») ; (3) A-S4 et C-S4, 3 remboursements impossibles car Payment était en panne ; (4) B-S5-off, 2 438 effets en double, B-S5-on, 0 |
| 02/11 | Protocole de campagne proposé (`docs/campagne.md`) | 4 points à trancher avant E11 : plan, plafond k6 pour S2, machine et créneau, S4b |
