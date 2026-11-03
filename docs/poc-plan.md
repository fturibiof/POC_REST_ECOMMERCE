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
| A′ (`A2`) — synchrone défendu | comme A, avec disjoncteur sur Payment, contrôle d'admission (300 en vol) et paiement idempotent (remboursement sur timeout) | appels REST bloquants | 201 après tout le workflow ; 503 immédiat si refusée à l'entrée |

## 2. Exigences (énoncé §6, ADR AD-1 à AD-5)

| # | Exigence | Seuil de succès |
|---|---|---|
| R1 | Charge normale : 100 cmd/s sans accumulation | débit atteint ≥ 98 % de la cible ; commandes en attente (ou files) stables : fin de palier ≤ 2 × début de palier |
| R2 | Pic : 500 cmd/s pendant 5 min, sans effondrement incontrôlé | commandes enregistrées ≥ 99 % de la charge offerte (`scripts/acceptance-table.mjs`) ; latence d'acceptation bornée (ne croît pas sans fin) |
| R3 | Latence d'acceptation sous charge normale | p95 < 1 s |
| R4 | Fiabilité | 0 commande confirmée sans paiement autorisé **et** stock réservé (audit) |
| R5 | Observabilité | une commande reconstruite de bout en bout à partir de son identifiant |

**Définitions.** *Acceptation* : temps entre l'envoi de la commande et la première réponse HTTP (201 en A et C, 202 en B), mesuré par k6. *Complétion* : de la réception par Order jusqu'à l'issue connue et, si la commande est confirmée, jusqu'à la demande d'expédition (décision D12), mesurée par Order de la même façon pour A, B et C. En A, acceptation et complétion sont presque égales ; en C, le 201 arrive avant la fin du workflow ; la notification n'est pas comptée. *Erreur non prévue* : 5xx, délai dépassé, erreur réseau ou statut inattendu ; un refus de carte (402) ou un stock insuffisant (409) est une réponse **prévue**.

*Charge offerte* : commandes que k6 devait envoyer = émises + abandonnées (`dropped_iterations` : k6 n'avait plus d'utilisateur virtuel libre, parce que le système répondait trop lentement). *Commande enregistrée* : commande dont Order connaît l'issue (confirmée ou rejetée) dans `audit.json`, commande témoin exclue. *Taux d'enregistrement* = enregistrées / offertes, calculé par `scripts/acceptance-table.mjs` à partir de `k6-summary.json` et `audit.json` ; on publie aussi la part des confirmées parmi les enregistrées (≈ 80 % attendu pour les trois options sans timeout) pour montrer que le comportement métier est le même et que l'écart est architectural.

**Pourquoi les erreurs non prévues ne servent plus à comparer A et B.** B répond 202 à toutes les commandes, y compris celles qui seront refusées ensuite, alors que A et C répondent avec l'issue ; le taux d'erreurs de B est donc proche de 0 par construction, pas par mérite. Le taux d'enregistrement compte la même chose pour les trois options : combien de commandes offertes ont réellement été prises en charge par Order. Les erreurs non prévues restent rapportées, mais seulement comme diagnostic au sein d'une option.

**Débit atteint sous saturation.** Si k6 abandonne des commandes, le « débit atteint » n'est plus une mesure du système seul : il est borné par le plafond d'utilisateurs virtuels. On ne le cite donc jamais isolé ; on écrit « n'absorbe pas la charge offerte » en citant ensemble les commandes abandonnées par k6 et les commandes émises mais non enregistrées.

## 3. Hypothèses → scénarios → métriques

H1 à H4 reprennent celles de l'ADR ; H5 à H7 sont proposées en plus. Sauf mention contraire, A, B et C sont mesurées sur S1 à S4.

| # | Hypothèse (résumé) | Scénarios | Métriques | Confirmée si |
|---|---|---|---|---|
| H1 | À 500/s, B enregistre la charge offerte ; A n'y parvient pas | S1, S2 | taux d'enregistrement (abandons k6 + émises non enregistrées), part des confirmées, acceptation p50/p95/p99, commandes complétées/s, commandes en attente, profondeur des files | sur la médiane des 3 répétitions : B ≥ 99 % de la charge offerte enregistrée, A < 99 % |
| H2 | Payment lent (2 s) ou indisponible (30 s) : B continue d'accepter les commandes sans en perdre ; A les ralentit ou les rejette | S3, S4 | acceptation p95, commandes rejetées ou perdues, `events_failed_total`, `events_unknown_order_total`, profondeur de la file Payment, temps de retour à la normale après la panne | B : acceptation p95 < 1 s pendant la panne et 0 commande perdue **observée** (audit `unfinished` = 0, `events_failed_total` = 0, `events_unknown_order_total` = 0) ; A : rejets ou p95 > 1 s |
| H3 | Sans idempotence, les doublons produisent des effets en double ; avec déduplication par `eventId`, aucun ; coût mesurable | S5-off, S5-on | doubles paiements, doubles réservations, doubles notifications (audit), taille du registre d'idempotence, surcoût de complétion p95, lignes de code ajoutées | S5-off > 0 doublon d'effet ; S5-on = 0 ; coût chiffré |
| H4 | À 100/s, B consomme plus de CPU et de RAM (broker compris) ; Payment lent sature les connexions de A, pas celles de B | S1, S3 | CPU et RAM par conteneur et total, connexions du pool (utilisées, en attente) en A, connexions entrantes d'Order | B > A en ressources à S1 ; pool de A saturé à S3, connexions de B stables |
| H5 | À 100/s, A offre une latence de **complétion** plus faible que B (énoncé, H2) | S1 | complétion p50/p95/p99 | p95 de A < p95 de B |
| H6 | L'invariant tient dans **tous** les scénarios, pour A, B et C | tous | audit : confirmées sans paiement ou sans réservation, paiements non remboursés de commandes rejetées, commandes restées en attente | 0 violation ; les commandes en attente à la fin sont expliquées |
| H7 | C donne au client la même garantie que A (201 = paiement et stock acquis) avec une acceptation plus rapide que A et des ressources inférieures à B ; mais C reste aussi sensible que A à un Payment lent ou indisponible | S1, S2, S3, S4 (S4b si joué) | acceptation p95, taux d'enregistrement, CPU et RAM ; S4b : commandes acceptées pendant la panne de Shipping | S1 : acceptation C < A et ressources C < B ; S3/S4 : C ≈ A ; S4b : C et B acceptent, A rejette |

Toute métrique collectée doit apparaître dans ce tableau (énoncé §10) ; sinon elle n'est pas présentée.

**Modifications du 03/11 (revue de la PR, proposées) :**
- **H1, clause retirée** (« à 100/s, écart de p95 d'acceptation < 10 % ») : elle ne pouvait jamais être vraie. B répond 202 avant de travailler, A répond 201 après tout le workflow, donc l'écart vient de la définition et non de la mesure. La comparaison qui a un sens à 100/s porte sur la complétion, et c'est déjà H5 : reformuler la clause sur la complétion aurait créé un doublon.
- **H2, « sans en perdre » est un constat, pas une garantie.** Un message en échec est rejeté sans file de lettres mortes (`services/common/bus.js`, `nack` sans remise en file) et un événement dont la commande est inconnue est ignoré (compté par `events_unknown_order_total`). On écrit donc « aucune perte observée », en citant les compteurs.
- **H1, H7 et R2 : taux d'enregistrement** au lieu des erreurs non prévues (voir §2).

## 4. Scénarios et profils de charge

Mélange de commandes identique partout : 80 % valides, 10 % carte refusée, 10 % stock insuffisant.

| # | Profil | Panne | Durée |
|---|---|---|---|
| S1 | montée 0 → 100/s (30 s), puis 100/s | — | 3 min 30 |
| S2 | paliers d'1 min à 100, 200, 300, 400/s, puis **500/s pendant 5 min** | — | ≈ 9 min 30 |
| S3 | 100/s | Payment à 2 s de t = 60 s à t = 180 s | 4 min |
| S4 | 100/s | Payment indisponible de t = 60 s à t = 90 s | 4 min |
| S5-off / S5-on | 100/s, B seulement | 10 % d'événements livrés deux fois ; idempotence désactivée puis activée | 3 min chacun |
| S2-<débit> | courbe de rupture : 200, 250, 300, 400/s, 30 s de montée puis 3 min, un passage par niveau et par option | — | 3 min 30 |
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

- Une seule machine : générateur de charge, services et broker se partagent le CPU. k6 est plafonné à 2 CPU (`compose.yml`) ; sa charge CPU est publiée pour chaque passage (`k6CpuAvg`, `k6CpuMax`), et un passage où k6 atteint son plafond est invalide ([campagne.md](campagne.md)).
- **Paiements orphelins en A et C (choix assumé).** Quand Payment dépasse le délai d'Order (5 s), Order rejette la commande (503) sans rembourser, alors qu'il rembourse bien quand le stock manque (`services/order/index.js`, `securePaymentAndStock`). Payment, lui, finit par autoriser le paiement : l'argent est pris pour une commande rejetée (`paidButNotConfirmed` dans l'audit). Ce n'est pas un oubli qui handicaperait A : un remboursement envoyé sur timeout peut arriver avant le paiement qu'il est censé annuler. Le faire correctement exige une clé d'idempotence côté Payment et une réconciliation : c'est ce que fait A′ (`A2`), pas A. L'écart entre A et A′ mesure donc le coût de cette mécanique, que B obtient du courtier (la commande attend dans la file au lieu d'être abandonnée).
- **Registre d'idempotence jamais purgé (B).** Le registre des `eventId` déjà traités (`services/common/bus.js`) grandit pendant tout le passage ; une implémentation réelle le purgerait par durée de vie. `idempotencyStoreMax` est donc un **pire cas non purgé**, et la pénalité RAM de B (H4) une borne haute. Ordre de grandeur : quelques millions d'UUID tiennent en dizaines de Mo, à comparer à la mémoire de RabbitMQ.
- **Pas de file de lettres mortes (B, C).** Un message dont le traitement échoue est rejeté définitivement. L'absence de perte est observée (`events_failed_total` = 0), pas garantie par la conception.
- **Événements d'une commande inconnue (B, C).** Ignorés par Order, par exemple après un redémarrage d'Order (état en mémoire) ; comptés par `events_unknown_order_total`.
- **C confirme avant l'expédition.** En A et B, CONFIRMED exige l'expédition demandée ; en C, il est posé dès le 201. Un `confirmedWithoutShipment` > 0 en C pendant une panne de Shipping (S4b) n'est donc pas une violation (note dans `audit.json`).
- Délais simulés constants dans la campagne ; sensibilité mesurée à part avec `WORK_DISTRIBUTION=lognormal` (même moyenne, p99 ≈ 0,9 s ; `results/sensitivity/`).
- État en mémoire, broker sur un seul nœud : la panne du broker n'est pas étudiée.
- Node.js est mono-thread : les résultats reflètent aussi ce choix de technologie.
