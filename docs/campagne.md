# Campagne de mesures — protocole

**Statut :** proposé (02/11/2026), à valider par l'équipe avant le lancement (étape E11 du [suivi](suivi.md)).

La campagne produit les **seuls chiffres** utilisés dans l'analyse et l'ADR final. Les scénarios, seuils et hypothèses sont ceux du [PoC Plan](poc-plan.md) ; ce document dit comment on les mesure.

## 1. Ce qui est joué

| Scénario | Ce qu'il teste | Options | Durée d'un passage |
|---|---|---|---|
| S1 | charge normale, 100 commandes/s | A, A2, B, C | 3 min 30 |
| S2 | paliers jusqu'à 500/s, tenus 5 min | A, A2, B, C | ≈ 9 min 30 (**1re répétition seulement**) |
| S2-200 … S2-400 | courbe de rupture : 200, 250, 300, 400/s, un passage par niveau | A, A2, B, C | 3 min 30 |
| S3 | Payment ralenti à 2 s pendant 2 min | A, A2, B, C | 4 min |
| S4 | Payment indisponible pendant 30 s | A, A2, B, C | 4 min |
| S5-off, S5-on | 10 % de messages en double, sans puis avec idempotence | B | 3 min chacun |
| S4b *(facultatif)* | Shipping indisponible pendant 30 s | A, A2, B, C | 4 min |
| S1, S2 log-normal *(facultatif, `SENSITIVITY=1`)* | mêmes délais moyens, avec une queue (p99 ≈ 0,9 s) | A, A2, B, C | 1 passage, dans `results/sensitivity/` |

S1, S3 et S4 : 3 répétitions, on retient la médiane. S2 : 1 passage à 500/s plus la courbe de rupture, plus décisionnelle qu'une médiane à un seul niveau. Au total, environ **5 h 50** (6 h 50 avec la sensibilité), redémarrages et attente de fin de traitement compris.

```bash
export DOCKER_CONTEXT=default
scripts/campaign.sh 3            # WITH_S4B=1 : S4b · SENSITIVITY=1 : délais log-normaux · S2_ALL_REPS=1 : S2 trois fois
```

## 2. Règles

1. **Plan validé avant** : seuils et hypothèses figés sur la page de revue ; on ne les change pas après avoir vu les résultats.
2. **Code figé** : un seul commit pour toute la campagne, enregistré avec chaque passage (`run.json`).
3. **Une seule machine, au repos** : aucun autre programme lourd pendant les mesures (IDE, navigateur, autres conteneurs).
4. **Chaque passage repart à neuf** : services redémarrés, files vides, stock plein.
5. **Ordre alterné** des options à chaque répétition (A A2 B C, A2 B C A, B C A A2) : une dérive de la machine ne pénalise pas toujours la même option.
6. **Un passage invalide n'est jamais effacé** : il reste dans `results/`, sa raison est notée au journal du suivi, et il est rejoué.

Un passage est **invalide** si : il a été interrompu ; la machine a servi à autre chose pendant ce temps ; la panne n'apparaît pas au bon moment dans Grafana (S3, S4, S4b) ; k6 a atteint son plafond de CPU (`k6CpuMax` ≥ 1,9 dans `metrics.json`, pour 2 CPU dans `compose.yml`) : on mesurerait alors le générateur autant que le système.

## 3. Ce qu'elle produit

| Sortie | Emplacement |
|---|---|
| Un dossier par passage : résumé k6, audit de l'invariant, métriques, commande témoin | `results/runs/<id>/` |
| Une ligne par passage | `results/runs.csv` |
| Journal de la campagne | `results/campaign-<date>.log` |
| Captures Grafana et traces du **passage médian** de chaque option × scénario (choisi par le script) | `docs/recette/img/` |
| Résultats : médiane, min et max des 3 répétitions, passage source de chaque chiffre | onglet « Résultats » de la page de revue |

Ensuite : l'équipe lit les résultats, confirme ou infirme chaque hypothèse, remplit la matrice de décision et rédige l'ADR final (E12, E13).

## 4. À trancher avant le lancement

1. **Le plan** : onglet « Plan à valider » de la page de revue.
2. **Le pic S2** : lors de la répétition, k6 n'a pas envoyé toutes les commandes en A et C (plafond de 2 000 utilisateurs virtuels probablement atteint). Deux choix :
   - **monter le plafond** (par exemple 4 000, au prix de plus de mémoire pour k6) pour que toute la charge soit envoyée ;
   - **garder 2 000** et traiter les commandes non envoyées comme le signe que le système ne suit plus.
   Proposition révisée (03/11) : **garder 2 000**. Les commandes abandonnées comptent désormais dans la charge offerte (taux d'enregistrement, PoC Plan §2) : elles font partie de la mesure et ne rendent plus le passage invalide. 2 000 utilisateurs à 500/s veulent dire que le système met plus de 4 s à répondre (loi de Little), ce qui est déjà un échec ; monter le plafond ajouterait surtout des connexions devant Order. Ce qui invalide un passage, c'est k6 à son plafond de **CPU**.
3. **La machine et le créneau** : environ 6 h sans autre usage, et la machine reste allumée ensuite pour les captures.
4. **S4b** : l'inclure ou non (il sert l'hypothèse H7, option C).
5. **A′ (`A2`)** : la garder dans la campagne (environ 1 h 20 de passages). Elle ajoute une option « synchrone défendue » ; ses réglages sont fixés d'avance (commentaires de `services/order/index.js`) et ne doivent pas être retouchés après les résultats.
