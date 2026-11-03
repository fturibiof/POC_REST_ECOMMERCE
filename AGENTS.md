# AGENTS.md — PoC 1 MGL870 : synchrone ou événementiel ?

Instructions pour tout agent IA (Claude, Copilot, Codex…) qui travaille dans ce dépôt. Équipe de 5 ; remise le **lundi 09/11/2026, 18 h**.

**Point d'entrée : lire [docs/suivi.md](docs/suivi.md) en début de séance, le mettre à jour en fin de séance.**

| Document | Rôle |
|---|---|
| [docs/enonce-travail-etude.md](docs/enonce-travail-etude.md) | énoncé : fait foi sur l'attendu |
| [docs/ADR-001.md](docs/ADR-001.md) | décision candidate, puis finale |
| [docs/poc-plan.md](docs/poc-plan.md) | hypothèses → scénarios → métriques → seuils |
| [docs/suivi.md](docs/suivi.md) | objectifs, décisions, étapes, journal |
| [docs/recette/scenarios.md](docs/recette/scenarios.md) | scénarios de recette par livrable |

## Le but

Prendre une **décision d'architecture prouvée** (ADR-001), pas construire une plateforme. Ce qui est évalué : **preuve → raisonnement → décision**.

## Esprit critique (obligatoire)

- **Challenger les choix** de l'équipe, y compris ceux déjà pris, quand un risque, une incohérence ou une meilleure option existe.
- Toujours **constructif** : nommer le risque concret, proposer une parade, laisser l'équipe trancher.
- S'appuyer sur le code, les mesures et l'énoncé, pas sur des principes abstraits (« l'événementiel scale mieux » n'est pas un argument).
- Dire clairement quand une idée est bonne ; ne pas inventer de critique pour la forme.
- Format : tableau court `# · point | Avis | Risque | Parade`.

## Règles de la PoC

1. **Équité A/B/C** : les trois options (synchrone, événementielle, hybride) partagent la logique métier, les délais simulés, la concurrence et les ressources. Toute modification de l'une s'applique aux autres, sinon la comparaison ne vaut rien.
2. **Traçabilité** : aucun chiffre dans un livrable sans le fichier de `results/` et l'identifiant du passage d'où il vient. Ne jamais modifier un résultat à la main.
3. **Objectivité** : on montre le passage **médian** des répétitions, jamais le « meilleur » ; mêmes échelles pour A et B ; un résultat défavorable à la décision candidate est rapporté tel quel.
4. **Explicabilité** : code simple, commentaires sur le *pourquoi* architectural. L'IA générative est permise si l'équipe peut expliquer chaque décision et chaque résultat : le responsable d'une étape doit pouvoir la défendre à l'oral.
5. **Proposer, pas décider** : un choix reste « Proposé » dans `docs/suivi.md` tant que l'équipe ne l'a pas validé. Ne jamais marquer « Validé » ou « Accepted » ce qui l'est en partie.

## Façon de travailler

- **Plan discuté avant d'écrire** pour toute nouvelle étape ; ensuite avancer d'un trait et présenter le résultat à l'équipe (recette).
- Une branche par étape (`feat/e<n>-<sujet>`) ; pas de commit ni de push sans demande ; commit en nommant les chemins (jamais `git add -A`).
- Chaque gros livrable se termine par sa **recette** (skill `recette-livrable`).
- Documents et réponses courts, en français, sans jargon inutile.

## Skills (`.claude/skills/`)

| Skill | Quand |
|---|---|
| `campagne-mesures` | lancer un passage ou une campagne, consigner les résultats |
| `recette-livrable` | générer les captures, mettre à jour et publier la page de recette |
| `revue-adr` | relire l'ADR, le PoC Plan ou l'analyse : critique et cohérence avec les preuves |
