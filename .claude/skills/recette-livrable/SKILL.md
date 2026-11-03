---
name: recette-livrable
description: Produire et publier la page de recette HTML de la PoC MGL870 pour un gros livrable (socle, option A, option B, observabilité, banc d'essai, résultats, décision) — captures Grafana et Tempo automatiques, relecture des images, mise à jour des scénarios, publication sans perdre les résultats des testeurs. À utiliser quand on demande de « faire la recette », « régénérer les captures », « publier la recette », « présenter les résultats à l'équipe », ou d'ajouter un scénario de recette.
---

# Recette d'un livrable

Reprise de la skill `uat-manual` de Docconnect, simplifiée. La page présente chaque livrable **comme une proposition** : l'équipe rejoue, coche et commente.

| Élément | Emplacement |
|---|---|
| Scénarios (source) | `docs/recette/scenarios.md` |
| Page (source unique) | `docs/recette/recette.html` — données dans `<script id="recette-data">` |
| Captures | `docs/recette/img/` (générées) |
| Script de captures | `scripts/captures.mjs` (`npm run captures`) |
| Données des graphiques | `results/runs.csv` |
| Page publiée | Artifact claude.ai, capacité `db` ; URL notée dans `docs/suivi.md` à la première publication |
| Résultats des testeurs | base de la page, collection `results` : un document par scénario `{ status: ok\|ko\|blocked, rev, by, at, comment }` |

La page et le script sont créés à l'étape E9 du suivi.

## Règles

- **Les captures sont générées, jamais faites à la main** ; nom validé par regex : `^(SOC|A|B|C|OBS|BANC|RES|DEC)-[0-9A-Za-z-]+-\d{2}-[a-z0-9-]+$`.
- **Passage médian** des répétitions pour les résultats, choisi par le script ; **mêmes axes** pour A, B et C ; chaque image a sa légende : identifiant du passage, commit, date.
- **Ne jamais perdre les résultats des testeurs** : republier sur la même URL **sans `capabilities`** (la déclaration `db` est conservée ; `capabilities: {}` couperait la base). Ne jamais supprimer l'Artifact.
- Identifiant de scénario jamais renommé ; `rev` +1 si les étapes ou l'attendu changent.
- Pas d'embellissement : un défaut visible reste visible et est commenté.
- Les résultats (onglet RES) et la décision (DEC) sont des **propositions** : pas de « confirmé » sans le chiffre et le passage source.

## 1. Générer les captures

Sur la machine qui a joué les passages, supervision démarrée :

```bash
npm run captures              # tous les livrables
npm run captures -- --only B  # un préfixe
```

Le script lit `results/runs.csv`, ouvre Grafana en mode kiosque sur la fenêtre de chaque passage (Playwright, 1600 × 900), attend la fin du chargement des panneaux, capture, ouvre les traces Tempo des commandes témoins, puis liste les images **nouvelles, modifiées, supprimées** et signale celles qui contiennent « No data » ou une erreur.

## 2. Relire

Ouvrir chaque image nouvelle ou modifiée (outil Read). Chercher : panneau vide, échelle écrasée, légende illisible, trace incomplète, fenêtre de temps décalée, panne absente du panneau prévu. Corriger la cause (requête du tableau de bord, attente du script), jamais l'image.

## 3. Mettre à jour la page

- Reporter les scénarios de `docs/recette/scenarios.md` dans les données de la page (un onglet par livrable).
- Onglet « Résultats » : graphiques calculés depuis `results/runs.csv` (skill `dataviz` pour les couleurs et les axes), captures du passage médian, lecture proposée de chaque hypothèse avec ses chiffres.
- Vérifier la page en local dans un navigateur : aucune erreur, pas de défilement horizontal à 390 px.

## 4. Publier

1. Première fois : `Artifact` avec `capabilities` `db`, `icon` « check » ; noter l'URL dans `docs/suivi.md`.
2. Ensuite : lire l'Artifact (`action: "read"`) si une autre session l'a publié, puis republier le même fichier sur la même URL, **sans `capabilities`**, avec un `label` court (ex. « Recette option B »).
3. Vérifier les résultats existants (`ArtifactData` `list` sur `results`).

## Compte rendu

Lien de la page, livrables couverts, captures nouvelles et modifiées, défauts repérés, scénarios à faire rejouer et par qui.
