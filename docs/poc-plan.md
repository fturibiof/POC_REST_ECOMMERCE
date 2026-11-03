# PoC Plan — Communication du traitement des commandes

**Statut :** brouillon proposé (02/11/2026), **à valider par l'équipe avant la campagne** (E2).
Décision visée : [ADR-001](ADR-001.md). Énoncé : [§5 à §10](enonce-travail-etude.md).

## 1. Problème et décision candidate

- **Question :** synchrone (A), événementiel (B), hybride (C), ou pas de décision ?
- **Incertitude :** l'événementiel absorbe-t-il assez mieux les pics et les pannes pour justifier sa complexité (idempotence, broker, observabilité asynchrone) ? L'hybride en garde-t-il l'essentiel à moindre coût ?
- **Décision candidate (ADR-001) :** B, provisoirement.

| Option | Payment, Inventory | Shipping, Notification | Réponse au client |
|---|---|---|---|
| A — synchrone | appels REST bloquants | appels REST bloquants | 201 après tout le workflow |
| B — événementiel | événements | événements | 202 dès l'enregistrement |
| C — hybride | appels REST bloquants | événements (`OrderConfirmed`) | 201 dès que paiement et stock sont acquis |

## 2. Exigences (énoncé §6, ADR AD-1 à AD-5)

| # | Exigence | Seuil de succès |
|---|---|---|
| R1 | Charge normale : 100 cmd/s sans accumulation | débit atteint ≥ 98 % de la cible ; commandes en attente (ou files) stables : fin de palier ≤ 2 × début de palier |
| R2 | Pic : 500 cmd/s pendant 5 min, sans effondrement incontrôlé | erreurs non prévues < 1 % ; latence d'acceptation bornée (ne croît pas sans fin) |
| R3 | Latence d'acceptation sous charge normale | p95 < 1 s |
| R4 | Fiabilité | 0 commande confirmée sans paiement autorisé **et** stock réservé (audit) |
| R5 | Observabilité | une commande reconstruite de bout en bout à partir de son identifiant |

**Définitions.** *Acceptation* : temps entre l'envoi de la commande et la première réponse HTTP (201 en A et C, 202 en B), mesuré par k6. *Complétion* : de la réception par Order jusqu'à l'issue connue et, si la commande est confirmée, jusqu'à la demande d'expédition (décision D12), mesurée par Order de la même façon pour A, B et C. En A, acceptation et complétion sont presque égales ; en C, le 201 arrive avant la fin du workflow ; la notification n'est pas comptée. *Erreur non prévue* : 5xx, délai dépassé, erreur réseau ou statut inattendu ; un refus de carte (402) ou un stock insuffisant (409) est une réponse **prévue**.

## 3. Hypothèses → scénarios → métriques

H1 à H4 reprennent celles de l'ADR ; H5 à H7 sont proposées en plus. Sauf mention contraire, A, B et C sont mesurées sur S1 à S4.

| # | Hypothèse (résumé) | Scénarios | Métriques | Confirmée si |
|---|---|---|---|---|
| H1 | À 100/s, A et B équivalents (écart de p95 d'acceptation < 10 %) ; à 500/s, B garde son débit et < 1 % d'erreurs, A se dégrade et dépasse 1 % | S1, S2 | débit atteint, requêtes abandonnées par k6, acceptation p50/p95/p99, erreurs non prévues, commandes complétées/s, commandes en attente, profondeur des files | les deux conditions sont vraies sur la médiane des 3 répétitions |
| H2 | Payment lent (2 s) ou indisponible (30 s) : B continue d'accepter les commandes et n'en perd aucune ; A les ralentit ou les rejette | S3, S4 | acceptation p95, commandes rejetées ou perdues, profondeur de la file Payment, temps de retour à la normale après la panne | B : acceptation p95 < 1 s pendant la panne et 0 commande perdue ; A : rejets ou p95 > 1 s |
| H3 | Sans idempotence, les doublons produisent des effets en double ; avec déduplication par `eventId`, aucun ; coût mesurable | S5-off, S5-on | doubles paiements, doubles réservations, doubles notifications (audit), taille du registre d'idempotence, surcoût de complétion p95, lignes de code ajoutées | S5-off > 0 doublon d'effet ; S5-on = 0 ; coût chiffré |
| H4 | À 100/s, B consomme plus de CPU et de RAM (broker compris) ; Payment lent sature les connexions de A, pas celles de B | S1, S3 | CPU et RAM par conteneur et total, connexions du pool (utilisées, en attente) en A, connexions entrantes d'Order | B > A en ressources à S1 ; pool de A saturé à S3, connexions de B stables |
| H5 | À 100/s, A offre une latence de **complétion** plus faible que B (énoncé, H2) | S1 | complétion p50/p95/p99 | p95 de A < p95 de B |
| H6 | L'invariant tient dans **tous** les scénarios, pour A, B et C | tous | audit : confirmées sans paiement ou sans réservation, paiements non remboursés de commandes rejetées, commandes restées en attente | 0 violation ; les commandes en attente à la fin sont expliquées |
| H7 | C donne au client la même garantie que A (201 = paiement et stock acquis) avec une acceptation plus rapide que A et des ressources inférieures à B ; mais C reste aussi sensible que A à un Payment lent ou indisponible | S1, S2, S3, S4 (S4b si joué) | acceptation p95, débit, erreurs, CPU et RAM ; S4b : commandes acceptées pendant la panne de Shipping | S1 : acceptation C < A et ressources C < B ; S3/S4 : C ≈ A ; S4b : C et B acceptent, A rejette |

Toute métrique collectée doit apparaître dans ce tableau (énoncé §10) ; sinon elle n'est pas présentée.

## 4. Scénarios et profils de charge

Mélange de commandes identique partout : 80 % valides, 10 % carte refusée, 10 % stock insuffisant.

| # | Profil | Panne | Durée |
|---|---|---|---|
| S1 | montée 0 → 100/s (30 s), puis 100/s | — | 3 min 30 |
| S2 | paliers d'1 min à 100, 200, 300, 400/s, puis **500/s pendant 5 min** | — | ≈ 9 min 30 |
| S3 | 100/s | Payment à 2 s de t = 60 s à t = 180 s | 4 min |
| S4 | 100/s | Payment indisponible de t = 60 s à t = 90 s | 4 min |
| S5-off / S5-on | 100/s, B seulement | 10 % d'événements livrés deux fois ; idempotence désactivée puis activée | 3 min chacun |
| S4b (facultatif) | 100/s | **Shipping** indisponible de t = 60 s à t = 90 s : un service *secondaire* (énoncé, exemple H3) ; distingue C de A | 4 min |

S1 à S4 sont joués sur A, B et C ; S5 sur B seulement (énoncé §8).

Après chaque passage : attente de la fin du traitement (B), puis audit.

## 5. Conditions d'expérience

| Paramètre | Valeur |
|---|---|
| Délais simulés | Payment 200 ms ; Inventory, Shipping, Notification 100 ms |
| Concurrence par service appelé | 100 (pool HTTP en A, prefetch en B) |
| Ressources | 1 CPU et 512 Mo par service ; RabbitMQ 2 CPU et 1 Go (B et C) ; k6 dans un conteneur séparé |
| Répétitions | 3 par option et scénario ; on retient la médiane, on montre min et max |
| Machine | la même pour toute la campagne, sans autre charge (IDE et navigateur fermés pendant les mesures) |
| Traces | échantillonnage 10 % pendant les mesures ; 100 % pour la démonstration d'une commande |

## 6. Limites connues (à compléter après la campagne)

- Une seule machine : générateur de charge, services et broker se partagent le CPU.
- Délais simulés constants : pas de variabilité réelle du fournisseur de paiement.
- État en mémoire, broker sur un seul nœud : la panne du broker n'est pas étudiée.
- Node.js est mono-thread : les résultats reflètent aussi ce choix de technologie.
