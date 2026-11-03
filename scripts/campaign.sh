#!/usr/bin/env bash
# Whole campaign (skill campagne-mesures): S1, S3, S4 on A, A2, B and C, S5 on B,
# REPETITIONS times; S2 (peak at 500/s) in the first repetition only, then one
# breaking-point curve per option (S2-<rate>, one run per level), then the
# captures of the median runs.
#
#   scripts/campaign.sh [repetitions]          # 3 by default
#   WITH_S4B=1 scripts/campaign.sh             # also the optional S4b (Shipping down)
#   S2_ALL_REPS=1 scripts/campaign.sh          # S2 in every repetition (no curve needed for the median)
#   SWEEP_RATES="" scripts/campaign.sh         # no breaking-point curve
#   SENSITIVITY=1 scripts/campaign.sh          # also S1 and S2 with tailed delays (results/sensitivity/)
#
# Within a repetition, the order of the options rotates (A B C, B C A, C A B):
# a slow drift of the machine during the campaign does not always penalise
# the same option. A failed run is logged and the campaign goes on.

set -uo pipefail
cd "$(dirname "$0")/.."

REPETITIONS=${1:-3}
SCENARIOS=(S1 S3 S4)
[[ ${WITH_S4B:-0} == 1 ]] && SCENARIOS+=(S4b)
# Levels of the breaking-point curve; 500/s is already S2.
SWEEP_RATES=${SWEEP_RATES-200 250 300 400}
ROTATIONS=("A A2 B C" "A2 B C A" "B C A A2" "C A A2 B")
LOG="results/campaign-$(date +%Y%m%d-%H%M%S).log"
mkdir -p results

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
run() {
  if scripts/run.sh "$@" >>"$LOG" 2>&1; then log "ok     $*"; else log "FAILED $*  (see $LOG)"; fi
}

log "campaign: $REPETITIONS repetition(s), scenarios ${SCENARIOS[*]} (+ S2 in r1) + S5 on B, curve ${SWEEP_RATES:-none}, commit $(git rev-parse --short HEAD)"
for ((rep = 1; rep <= REPETITIONS; rep++)); do
  read -r -a options <<<"${ROTATIONS[$(((rep - 1) % 4))]}"
  scenarios=("${SCENARIOS[@]}")
  [[ $rep == 1 || ${S2_ALL_REPS:-0} == 1 ]] && scenarios+=(S2)
  for scenario in "${scenarios[@]}"; do
    for option in "${options[@]}"; do run "$option" "$scenario" "$rep"; done
  done
  run B S5-off "$rep"
  run B S5-on "$rep"
done

# Where each option falls: one run per level, from a fresh system each time.
for rate in $SWEEP_RATES; do
  for option in A A2 B C; do run "$option" "S2-$rate" 1; done
done

# Sensitivity to the tail of the simulated delays (same mean, see Work in runtime.js).
if [[ ${SENSITIVITY:-0} == 1 ]]; then
  for scenario in S1 S2; do
    for option in A A2 B C; do WORK_DISTRIBUTION=lognormal run "$option" "$scenario" 1; done
  done
fi

log "captures of the median runs"
node scripts/captures.mjs >>"$LOG" 2>&1 && log "captures ok" || log "captures FAILED"
log "done — results/runs.csv, docs/recette/img/, $LOG"
