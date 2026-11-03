#!/usr/bin/env node
/**
 * End-of-run audit (hypotheses H3 and H6): reads the ledgers of the five
 * services and checks the business invariant and the duplicate effects.
 *
 *   node scripts/audit.mjs > results/runs/<id>/audit.json
 *
 * Invariant: an order is CONFIRMED only if its payment is authorized (and not
 * refunded) AND its stock is reserved (and not released). A confirmed order
 * must also end up with a shipment (B and C request it asynchronously).
 */

const BASE = process.env.AUDIT_HOST || 'http://localhost';
const fetchJson = async (port) => (await fetch(`${BASE}:${port}/audit`)).json();

const [orders, payment, inventory, shipping, notification] = await Promise.all(
  [3000, 3001, 3002, 3003, 3004].map(fetchJson)
);

const count = (ledger, id) => ledger?.[id] ?? 0;
const SAMPLE = 20; // ids kept per finding, enough to look a few of them up in Tempo

function findings(ids, predicate) {
  const matching = ids.filter(predicate);
  return { count: matching.length, sample: matching.slice(0, SAMPLE) };
}

const confirmed = orders.CONFIRMED;
const notConfirmed = [...orders.REJECTED, ...orders.PENDING];
const allIds = [...confirmed, ...notConfirmed];
const paid = (id) => count(payment.authorized, id) - count(payment.refunded, id) > 0;
const reserved = (id) => count(inventory.reserved, id) - count(inventory.released, id) > 0;

const audit = {
  orders: {
    confirmed: confirmed.length,
    rejected: orders.REJECTED.length,
    pending: orders.PENDING.length,
    unfinished: orders.unfinished.length, // workflow not finished when the run ended
  },
  invariant: {
    confirmedWithoutPayment: findings(confirmed, (id) => !paid(id)),
    confirmedWithoutStock: findings(confirmed, (id) => !reserved(id)),
  },
  confirmedWithoutShipment: findings(confirmed, (id) => count(shipping.shipments, id) === 0),
  // Money taken or stock held for an order that is not confirmed.
  leftovers: {
    paidButNotConfirmed: findings(orders.REJECTED, paid),
    stockHeldButNotConfirmed: findings(orders.REJECTED, reserved),
  },
  // Same effect applied more than once to the same order (scenario S5).
  duplicateEffects: {
    payments: findings(allIds, (id) => count(payment.authorized, id) > 1),
    reservations: findings(allIds, (id) => count(inventory.reserved, id) > 1),
    shipments: findings(allIds, (id) => count(shipping.shipments, id) > 1),
    notifications: findings(allIds, (id) => count(notification.sent, id) > 1),
  },
};

audit.invariantViolations =
  audit.invariant.confirmedWithoutPayment.count + audit.invariant.confirmedWithoutStock.count;
audit.duplicateEffectsTotal = Object.values(audit.duplicateEffects).reduce((n, f) => n + f.count, 0);

console.log(JSON.stringify(audit, null, 2));
