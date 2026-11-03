---
name: revue-adr
description: Revue critique et contrôle de cohérence de l'ADR-001, du PoC Plan ou de l'analyse de la PoC MGL870. Mode « critique » - challenger le document contre l'énoncé avant validation. Mode « cohérence » - vérifier que chaque affirmation remonte à une hypothèse, un scénario, un passage et un chiffre. À utiliser quand on demande une revue, une critique, un « check » avant remise, ou « est-ce que la conclusion tient ».
---

# Revue de l'ADR et des livrables

Reprise de la skill `revue-critique` de Docconnect, adaptée à la PoC. Argument : `critique <document>`, `coherence <document>` ; sans mode, faire les deux.

| Rôle | Emplacement |
|---|---|
| Attendu (fait foi) | `docs/enonce-travail-etude.md` (§2, §5, §6, §8, §10 à §14) |
| Décision | `docs/ADR-001.md` |
| Hypothèses, seuils, métriques | `docs/poc-plan.md` |
| Preuves | `results/runs.csv`, `results/runs/<id>/`, page de recette (onglets RES, DEC) |
| Décisions de conception, journal | `docs/suivi.md` |

## Mode critique

Passer le document à cette grille ; ne retenir que les vrais problèmes :

1. **Sections exigées** (énoncé §2 et §13) : Status, Context, Architectural drivers, Options, Candidate decision, Evidence, Experimental results, Trade-offs, Limitations, Final decision, Consequences.
2. **Hypothèses vérifiables** : chacune a un scénario, une métrique et un seuil de succès ; aucune n'est formulée de façon à ne pas pouvoir échouer.
3. **Métriques utiles** (§10) : chaque métrique présentée sert une hypothèse ; aucune n'est là « parce qu'elle était facile à collecter ».
4. **Équité A/B** : un écart de conditions (délais, concurrence, ressources, version du code) qui expliquerait le résultat ?
5. **Validité** : générateur de charge goulot, une seule machine, répétitions insuffisantes, dispersion ignorée, passage invalide utilisé.
6. **Invariant** : traité pour les 5 cas de l'énoncé (§4 : paiement échoué, stock insuffisant, service indisponible, message en double, étape lente).
7. **Décision** : découle des preuves ; les compromis et limites sont nommés ; « NO DECISION » est envisagé honnêtement.

## Mode cohérence

1. Lister chaque affirmation chiffrée ou comparative du document.
2. Remonter sa chaîne : hypothèse → scénario → passage(s) → fichier → chiffre. Recalculer le chiffre depuis `results/` quand c'est possible.
3. Matrice de décision : chaque case cite un résultat (RES-…) ; une case sans preuve est une **opinion** (§11).
4. Classer chaque écart : **chiffre faux ou sans source** · **conclusion plus forte que la preuve** · **hypothèse non testée** · **limite non déclarée**.

## Sortie

Tableau `# · point | Avis | Risque | Parade`, points bloquants d'abord. Dire ce qui est solide. Ne rien corriger sans l'accord de l'équipe : proposer le texte de remplacement.
