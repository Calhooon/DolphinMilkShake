#!/usr/bin/env bash
#
# fleet-proof-only.sh — fire proof-only-cycle.js for every lane in parallel.
#
# No dolphin-milk binary needed. No MetaNet clicks. No LLM inference.
# Each lane runs proof_batch.sh directly against its worker wallet daemon
# to create OP_RETURN proofs at ~130 sats/proof.
#
# Usage:
#   SOAK_CYCLES=100 BATCH_CAP=500 ./scripts/fleet-proof-only.sh
#   SOAK_CYCLES=50 BATCH_CAP=500 ONLY_LANES=bsky-en,bsky-en-2 ./scripts/fleet-proof-only.sh
#
# Environment:
#   SOAK_CYCLES    cycles per lane (default 100)
#   BATCH_CAP      records per cycle (default 500)
#   PARALLELISM    proof_batch.sh parallelism per lane (default 4)
#   ONLY_LANES     comma-sep whitelist (default: all lanes)
#   SKIP_LANES     comma-sep blacklist
#   LANES_FILE     path to fleet/lanes.json

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANES_FILE="${LANES_FILE:-$REPO_ROOT/fleet/lanes.json}"
SOAK_CYCLES="${SOAK_CYCLES:-100}"
BATCH_CAP="${BATCH_CAP:-500}"
BATCH_PER_TX="${BATCH_PER_TX:-10}"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; NC=$'\033[0m'
log()  { printf '%s[fleet-proof-only]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { bad "jq required"; exit 2; }
[ -f "$LANES_FILE" ] || { bad "lanes.json not found: $LANES_FILE"; exit 2; }

# Build lane list
declare -a LANE_IDS
while read -r lid; do
    [ -z "$lid" ] && continue
    if [ -n "${SKIP_LANES:-}" ] && printf ',%s,' "$SKIP_LANES" | grep -q ",$lid,"; then
        continue
    fi
    if [ -n "${ONLY_LANES:-}" ] && ! printf ',%s,' "$ONLY_LANES" | grep -q ",$lid,"; then
        continue
    fi
    LANE_IDS+=("$lid")
done < <(jq -r '.lanes[].id' "$LANES_FILE")

log "proof-only mode: ${#LANE_IDS[@]} lanes × ${SOAK_CYCLES} cycles × ${BATCH_CAP} records/cycle"
log "target proofs: $(( ${#LANE_IDS[@]} * SOAK_CYCLES * BATCH_CAP ))"
log "batch per tx: $BATCH_PER_TX (proofs per createAction)"
log "target txs: $(( ${#LANE_IDS[@]} * SOAK_CYCLES * BATCH_CAP / BATCH_PER_TX ))"

RESULT_DIR="/tmp/dolphinsense-proof-only/$(date +%Y-%m-%dT%H-%M-%S)"
mkdir -p "$RESULT_DIR"
log "result dir: $RESULT_DIR"

# Launch all lanes in parallel
declare -a PIDS LANE_BY_PID
for lid in "${LANE_IDS[@]}"; do
    log_file="$RESULT_DIR/lane-${lid}.log"
    (
        LANE_ID="$lid" \
        SOAK_CYCLES="$SOAK_CYCLES" \
        BATCH_CAP="$BATCH_CAP" \
        SEED_SATS="${SEED_SATS:-15000}" \
        BROADCAST_BATCH="${BROADCAST_BATCH:-10}" \
        QUEUE_LANE="${QUEUE_LANE:-}" \
        LANES_FILE="$LANES_FILE" \
        INVENTORY_FILE="${INVENTORY_FILE:-$HOME/bsv/wallets/fleet/INVENTORY.json}" \
        node "$REPO_ROOT/scripts/proof-chain.js" --lane "$lid" \
            > "$log_file" 2>&1
    ) &
    pid=$!
    PIDS+=("$pid")
    LANE_BY_PID+=("$lid")
    log "launched lane '$lid' → pid $pid → $log_file"
done

log "waiting for ${#PIDS[@]} lane processes..."

declare -a FAILED_LANES
for i in "${!PIDS[@]}"; do
    pid="${PIDS[$i]}"
    lid="${LANE_BY_PID[$i]}"
    if wait "$pid"; then
        ok "lane $lid completed (pid $pid)"
    else
        bad "lane $lid FAILED (pid $pid)"
        FAILED_LANES+=("$lid")
    fi
done

# Aggregate
total_proofs=0
total_errors=0
for lid in "${LANE_IDS[@]}"; do
    agg="$RESULT_DIR/lane-${lid}.log"
    p=$(grep -oE 'PROOF-ONLY COMPLETE: [0-9]+' "$agg" 2>/dev/null | grep -oE '[0-9]+' || echo 0)
    total_proofs=$((total_proofs + p))
done

log ""
log "========================================================================"
log "FLEET PROOF-ONLY COMPLETE"
log "  lanes: ${#LANE_IDS[@]} (${#FAILED_LANES[@]} failed)"
log "  total proofs: $total_proofs"
log "  result dir: $RESULT_DIR"
log "========================================================================"

if [ "${#FAILED_LANES[@]}" -gt 0 ]; then
    log "failed lanes: ${FAILED_LANES[*]}"
    exit 3
fi
