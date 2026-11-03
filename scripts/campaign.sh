#!/usr/bin/env bash
# Whole campaign (skill campagne-mesures): S1 to S4 on A, B and C, S5 on B,
# REPETITIONS times, then the captures of the median runs.
#
#   scripts/campaign.sh [repetitions]          # 3 by default (≈ 1 h 30 each)
#   WITH_S4B=1 scripts/campaign.sh             # also the optional S4b (Shipping down)
#
# Within a repetition, the order of the options rotates (A B C, B C A, C A B):
# a slow drift of the machine during the campaign does not always penalise
# the same option. A failed run is logged and the campaign goes on.

set -uo pipefail
cd "$(dirname "$0")/.."

REPETITIONS=${1:-3}
SCENARIOS=(S1 S2 S3 S4)
[[ ${WITH_S4B:-0} == 1 ]] && SCENARIOS+=(S4b)
ROTATIONS=("A B C" "B C A" "C A B")
LOG="results/campaign-$(date +%Y%m%d-%H%M%S).log"
mkdir -p results

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
run() {
  if scripts/run.sh "$@" >>"$LOG" 2>&1; then log "ok     $*"; else log "FAILED $*  (see $LOG)"; fi
}

log "campaign: $REPETITIONS repetition(s), scenarios ${SCENARIOS[*]} + S5 on B, commit $(git rev-parse --short HEAD)"
for ((rep = 1; rep <= REPETITIONS; rep++)); do
  read -r -a options <<<"${ROTATIONS[$(((rep - 1) % 3))]}"
  for scenario in "${SCENARIOS[@]}"; do
    for option in "${options[@]}"; do run "$option" "$scenario" "$rep"; done
  done
  run B S5-off "$rep"
  run B S5-on "$rep"
done

log "captures of the median runs"
node scripts/captures.mjs >>"$LOG" 2>&1 && log "captures ok" || log "captures FAILED"
log "done — results/runs.csv, docs/recette/img/, $LOG"
