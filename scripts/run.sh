#!/usr/bin/env bash
# One measured run: one option, one scenario, one repetition.
#
#   scripts/run.sh <A|B|C> <S1|S2|S3|S4|S4b|S5-off|S5-on> [repetition]
#   DURATION_FACTOR=0.25 scripts/run.sh A S1     # short rehearsal (not for the campaign)
#
# Steps: restart the system under test from scratch -> k6 load (+ fault for
# S3/S4/S4b) -> witness order traced at 100 % -> wait until every accepted order
# is final -> audit -> metrics -> line in results/runs.csv -> Grafana link.
# See the skill campagne-mesures for the validity checks.

set -euo pipefail
cd "$(dirname "$0")/.."

OPTION=${1:?usage: run.sh <A|B|C> <scenario> [repetition]}
SCENARIO=${2:?usage: run.sh <A|B|C> <scenario> [repetition]}
REP=${3:-1}
FACTOR=${DURATION_FACTOR:-1}
DRAIN_TIMEOUT_S=${DRAIN_TIMEOUT_S:-300}
export DOCKER_CONTEXT=${DOCKER_CONTEXT:-default}

case "$SCENARIO" in
  S1|S2|S3|S4|S4b) IDEMPOTENCY=on; DUPLICATE_RATE=0 ;;
  S5-off)      IDEMPOTENCY=off; DUPLICATE_RATE=0.1 ;;
  S5-on)       IDEMPOTENCY=on;  DUPLICATE_RATE=0.1 ;;
  *) echo "unknown scenario $SCENARIO" >&2; exit 2 ;;
esac
if [[ $SCENARIO == S5-* && $OPTION != B ]]; then echo "S5 is defined for option B only" >&2; exit 2; fi
export OPTION IDEMPOTENCY DUPLICATE_RATE

RUN_ID="$(date +%Y%m%d-%H%M%S)-${OPTION}-${SCENARIO}-r${REP}"
# Short rehearsals never mix with campaign results.
OUT_BASE=$([[ $FACTOR == 1 ]] && echo results/runs || echo results/rehearsals)
OUT="$OUT_BASE/$RUN_ID"
mkdir -p "$OUT"
SUT=(order payment inventory shipping notification)
[[ $OPTION != A ]] && SUT+=(rabbitmq) # B and C use the broker
compose() { COMPOSE_PROFILES=B docker compose "$@"; }
now() { date +%s; }

echo "▶ $RUN_ID"

# 1. Supervision stays up between runs; the system under test restarts from
#    scratch (empty stores, empty queues, full stock).
compose up -d prometheus tempo cadvisor grafana >/dev/null
compose rm -sfv order payment inventory shipping notification rabbitmq >/dev/null 2>&1 || true
compose up -d --wait "${SUT[@]}" >/dev/null 2>&1
sleep "${SETTLE_S:-15}" # let the start-up CPU peak pass

# 2. Witness order, sent in the middle of the run (of the fault for S3/S4),
#    with a sampled traceparent: its trace is always kept, whatever the sampling.
case "$SCENARIO" in
  S3) WITNESS_AT=120 ;; S4|S4b) WITNESS_AT=75 ;; *) WITNESS_AT=90 ;;
esac
WITNESS_AT=$(awk "BEGIN { printf \"%d\", $WITNESS_AT * $FACTOR }")
witness() {
  sleep "$WITNESS_AT"
  local trace_id; trace_id=$(openssl rand -hex 16)
  curl -s -o "$OUT/witness-response.json" -w '{"httpStatus":%{http_code},"seconds":%{time_total}}' \
    -X POST localhost:3000/orders -H 'Content-Type: application/json' \
    -H "traceparent: 00-${trace_id}-$(openssl rand -hex 8)-01" \
    -d '{"customerId":"WITNESS","items":[{"itemId":"ITEM-001","quantity":1}],"paymentInformation":{"cardNumber":"4111111111111111"},"shippingAddress":{"city":"Montreal","country":"CA"}}' \
    > "$OUT/witness-http.json" || true
  echo "{\"traceId\":\"$trace_id\",\"sentAt\":$(now)}" > "$OUT/witness.json"
}
witness &
WITNESS_PID=$!

# 3. Load (and fault) — k6 pushes its metrics to Prometheus, tagged for Grafana
#    (option, testid; `scenario` is the name of the k6 scenario itself).
START=$(now)
compose run --rm --no-deps --user "$(id -u):$(id -g)" k6 run --quiet \
  -o experimental-prometheus-rw \
  --tag option="$OPTION" --tag testid="$RUN_ID" \
  -e OPTION="$OPTION" -e SCENARIO="$SCENARIO" -e DURATION_FACTOR="$FACTOR" -e RUN_DIR="/$OUT" \
  /scripts/k6-load-test.js | tee "$OUT/k6-console.txt"
LOAD_END=$(now)
wait "$WITNESS_PID" || true

# 4. Wait until every accepted order is finished (B and C keep working after
#    the load stops). A run that does not drain is reported, not hidden.
pending() { curl -s localhost:3000/stats | sed 's/.*"inProgress":\([0-9]*\).*/\1/'; }
while (( $(pending) > 0 && $(now) - LOAD_END < DRAIN_TIMEOUT_S )); do sleep 2; done
END=$(now)
echo "  drained in $((END - LOAD_END)) s, still pending: $(pending)"
sleep 10 # last scrape and trace flush

# 5. Audit, run description, metrics, CSV line.
node scripts/audit.mjs > "$OUT/audit.json"
cat > "$OUT/run.json" <<EOF
{
  "runId": "$RUN_ID", "option": "$OPTION", "scenario": "$SCENARIO", "repetition": $REP,
  "durationFactor": $FACTOR, "idempotency": "$IDEMPOTENCY", "duplicateRate": $DUPLICATE_RATE,
  "concurrency": ${CONCURRENCY:-100}, "traceSampling": ${TRACE_SAMPLING:-0.1},
  "start": $START, "loadEnd": $LOAD_END, "end": $END,
  "commit": "$(git rev-parse --short HEAD)", "dirty": $([[ -n $(git status --porcelain services load-test compose.yml) ]] && echo true || echo false),
  "host": { "name": "$(hostname)", "cpus": $(nproc), "memGiB": $(free -g | awk '/Mem:/ {print $2}') }
}
EOF
node scripts/report-run.mjs "$OUT"

# 6. Grafana: annotate the run window and print the link to the dashboard.
curl -s -X POST localhost:3300/api/annotations -H 'Content-Type: application/json' \
  -d "{\"time\":$((START * 1000)),\"timeEnd\":$((END * 1000)),\"tags\":[\"run\",\"$OPTION\",\"$SCENARIO\"],\"text\":\"$RUN_ID\"}" >/dev/null || true
echo "  Grafana: http://localhost:3300/d/poc/poc?from=$((START * 1000 - 30000))&to=$((END * 1000 + 30000))&var-option=$OPTION&var-scenario=$SCENARIO&var-run=$RUN_ID"
echo "✔ $OUT"
