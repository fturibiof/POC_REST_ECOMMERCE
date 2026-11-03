---
name: campagne-mesures
description: Lancer un passage de mesure (une option A ou B, un scénario S1 à S5) ou toute la campagne de la PoC MGL870, vérifier qu'il est valide, consigner les résultats dans results/ et le journal du suivi. À utiliser quand on demande de « lancer un test », « faire un passage », « lancer la campagne », « rejouer S3 », ou de vérifier qu'un résultat est exploitable.
---

# Campagne de mesures

Les règles d'équité, de traçabilité et d'objectivité sont dans `AGENTS.md` ; les hypothèses, seuils et profils dans `docs/poc-plan.md`.

| Élément | Emplacement |
|---|---|
| Un passage | `scripts/run.sh <A\|B\|C> <S1\|S2\|S3\|S4\|S4b\|S5-off\|S5-on> [répétition]` (S5 : B seulement) |
| Toute la campagne | `scripts/campaign.sh [répétitions]` (3 par défaut) |
| Profils de charge et panne | `load-test/k6-load-test.js` (variable `SCENARIO`) |
| Sorties d'un passage | `results/runs/<id>/` : résumé k6, `audit.json`, `metrics.json`, commande témoin |
| Tableau de tous les passages | `results/runs.csv` (une ligne par passage, jamais modifiée à la main) |
| Tableau de bord | Grafana `http://localhost:3300`, lien exact affiché à la fin du passage |

Les scripts sont créés à l'étape E8 du suivi : avant, cette skill ne s'applique pas.

## Avant de lancer

1. Contexte Docker `default` (moteur natif) : `docker context show`.
2. Machine au repos : fermer IDE lourd, navigateur, autres conteneurs (`docker ps`). Noter la mémoire libre (`free -g`).
3. Branche et commit propres : le commit est enregistré avec le passage ; pas de modification non commitée du code des services ou du script k6.
4. Supervision démarrée et volumes conservés : **ne jamais** faire `docker compose down -v` avant la fin des captures (skill `recette-livrable`).

## Pendant

- Ne rien lancer d'autre sur la machine.
- Un passage s'interrompt ou la machine est sollicitée : le passage est **invalide**, le noter (voir plus bas) et le relancer.

## Après chaque passage : valider

| Contrôle | Où | Si échec |
|---|---|---|
| k6 n'est pas le goulot | `dropped_iterations` et VUs max < `maxVUs` | relancer avec plus de VUs, noter |
| Tout est traité (B) | commandes en attente = 0 à la fin, ou expliquées | prolonger l'attente, noter |
| Audit | `audit.json` : violations d'invariant, doubles effets | **ne pas corriger** : c'est un résultat ; le signaler |
| Panne visible | panneau « panne » de Grafana aux bons instants (S3, S4) | passage invalide |

Un passage invalide n'est **pas supprimé** : il reste dans `results/`, marqué dans le journal du suivi avec sa raison, et il est relancé.

## Après la campagne

1. Vérifier qu'il y a 3 passages valides par option et scénario.
2. Lancer les captures (skill `recette-livrable`) **sur cette machine**, avant d'arrêter la supervision.
3. Journal de `docs/suivi.md` : date, machine, commit, passages invalides et raisons, faits marquants.
4. Proposer un commit de `results/` (en nommant les chemins).

## Compte rendu

Tableau court : option × scénario → passages valides, médiane de la métrique clé, anomalies. Aucun chiffre sans son identifiant de passage. Ne pas conclure sur les hypothèses ici : c'est le rôle de l'onglet « Résultats » et de l'équipe.
