#!/usr/bin/env bash
#
# fleet-cycle.sh -- run the cycle-v2 loop against all configured lanes in parallel.
#
# Reads fleet/lanes.json, spawns one `node scripts/lane-cycle.js --lane <id>`
# process per lane concurrently, waits for all to finish, and aggregates
# per-lane results into a fleet-level summary.
#
# Prerequisites (checked at startup, script refuses to run if violated):
#   1. 15 fleet wallet daemons running (ports 3400-3414) — start via
#      scripts/start-fleet-daemons.sh start
#   2. Feeder process running and populating per-sub queue.jsonl files —
#      start via scripts/feeder-preflight.sh
#   3. dolphin-milk release binary built at $RUST_BSV_WORM_DIR/target/release/dolphin-milk
#   4. MetaNet Desktop parent wallet running on port 3321
#
# Usage:
#   ./scripts/fleet-cycle.sh                         # run ONE cycle per lane
#   SOAK_CYCLES=20 ./scripts/fleet-cycle.sh           # 20 cycles per lane (1h run)
#   SKIP_LANES=gaming,movies ./scripts/fleet-cycle.sh # run 3 of 5 lanes
#
# Env:
#   SOAK_CYCLES            cycles per lane (default 1)
#   SKIP_LANES             comma-separated lane IDs to skip
#   BATCH_CAP              records per cycle (default 100)
#   SKINNY_CAPTAIN_MODE    parallel (default — E20d-validated) | liveness
#   ENABLE_SYNTHESIS       1 (default) | 0
#   RUST_BSV_WORM_DIR      path to dolphin-milk (default ~/bsv/rust-bsv-worm)
#
# Exit codes:
#   0  all lanes completed successfully
#   1  usage / config error
#   2  preflight failure (missing daemons / binary / queue)
#   3  one or more lanes failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANES_FILE="${LANES_FILE:-$REPO_ROOT/fleet/lanes.json}"
INVENTORY="${INVENTORY:-$HOME/bsv/wallets/fleet/INVENTORY.json}"
RUST_BSV_WORM_DIR="${RUST_BSV_WORM_DIR:-$HOME/bsv/rust-bsv-worm}"
FIREHOSE_DIR="${FIREHOSE_DIR:-/tmp/dolphinsense-firehose}"
BINARY="$RUST_BSV_WORM_DIR/target/release/dolphin-milk"

SOAK_CYCLES="${SOAK_CYCLES:-1}"
SKIP_LANES="${SKIP_LANES:-}"
BATCH_CAP="${BATCH_CAP:-100}"
SKINNY_CAPTAIN_MODE="${SKINNY_CAPTAIN_MODE:-parallel}"
ENABLE_SYNTHESIS="${ENABLE_SYNTHESIS:-1}"
QUEUE_MODE="${QUEUE_MODE:-1}"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'
log()  { printf '%s[fleet-cycle]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { bad "jq required"; exit 1; }
command -v node >/dev/null 2>&1 || { bad "node required"; exit 1; }
[ -f "$LANES_FILE" ] || { bad "lanes.json missing: $LANES_FILE"; exit 1; }
[ -f "$INVENTORY" ] || { bad "wallet inventory missing: $INVENTORY"; exit 1; }
[ -x "$BINARY" ] || { bad "dolphin-milk binary missing: $BINARY"; exit 2; }

# ---- preflight --------------------------------------------------------

log "preflight: parent wallet (3321) reachable?"
if ! curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
     -X POST -H 'Content-Type: application/json' -d '{}' \
     http://localhost:3321/.well-known/auth 2>/dev/null | grep -qE '^[234]'; then
    bad "parent wallet 3321 not responding — is MetaNet Desktop running?"
    exit 2
fi
ok "parent wallet responding"

log "preflight: all fleet wallet daemons running?"
RUNNING_COUNT=0
MISSING_COUNT=0
while IFS=$'\t' read -r name wport; do
    [ -z "$name" ] && continue
    if curl -sS --max-time 2 -o /dev/null -X POST \
         -H 'Content-Type: application/json' \
         -H "Origin: http://localhost:$wport" \
         -d '{"identityKey":true}' \
         "http://localhost:$wport/getPublicKey" 2>/dev/null; then
        RUNNING_COUNT=$((RUNNING_COUNT + 1))
    else
        bad "wallet $name not responding on port $wport"
        MISSING_COUNT=$((MISSING_COUNT + 1))
    fi
done < <(jq -r '.wallets[] | [.name, .wallet_port] | @tsv' "$INVENTORY")
if [ "$MISSING_COUNT" -gt 0 ]; then
    bad "$MISSING_COUNT wallet daemons not reachable — start them via ./scripts/start-fleet-daemons.sh start"
    exit 2
fi
ok "$RUNNING_COUNT fleet wallets responding"

# ---- build lane list ---------------------------------------------------

declare -a LANE_IDS
while read -r lid; do
    [ -z "$lid" ] && continue
    # Skip if in SKIP_LANES (blacklist)
    if [ -n "$SKIP_LANES" ] && printf ',%s,' "$SKIP_LANES" | grep -q ",$lid,"; then
        warn "skipping lane: $lid"
        continue
    fi
    # If ONLY_LANES (whitelist) is set, include only lanes listed there.
    # ONLY_LANES=bsky-en-11 runs just that one lane. Comma-separated for multiple:
    # ONLY_LANES=bsky-en-11,wiki-en-3. Useful for targeted preflight or rerunning
    # previously-failed lanes without touching the rest.
    if [ -n "${ONLY_LANES:-}" ] && ! printf ',%s,' "$ONLY_LANES" | grep -q ",$lid,"; then
        continue
    fi
    LANE_IDS+=("$lid")
done < <(jq -r '.lanes[].id' "$LANES_FILE")

log "running ${#LANE_IDS[@]} lane(s) in parallel: ${LANE_IDS[*]}"
log "config: cycles=$SOAK_CYCLES batch=$BATCH_CAP mode=$SKINNY_CAPTAIN_MODE synthesis=$ENABLE_SYNTHESIS queue=$QUEUE_MODE"

# ---- feeder queue preflight --------------------------------------------

log "preflight: feeder queues populated?"
EMPTY_QUEUES=()
for lid in "${LANE_IDS[@]}"; do
    sub=$(jq -r --arg id "$lid" '.lanes[] | select(.id == $id) | .subreddit' "$LANES_FILE")
    qpath="$FIREHOSE_DIR/$sub/queue.jsonl"
    if [ ! -f "$qpath" ]; then
        EMPTY_QUEUES+=("$sub")
        continue
    fi
    depth=$(wc -l < "$qpath" | tr -d ' ')
    if [ "$depth" -lt "$BATCH_CAP" ]; then
        EMPTY_QUEUES+=("$sub")
        warn "queue for r/$sub has $depth records, need $BATCH_CAP"
    else
        ok "queue for r/$sub: $depth records ready"
    fi
done
if [ "${#EMPTY_QUEUES[@]}" -gt 0 ]; then
    bad "queue(s) not ready: ${EMPTY_QUEUES[*]}"
    bad "start the feeder first: node feeder/reddit-cache-feeder.js"
    bad "(make sure SUBS env var covers: $(IFS=,; echo "${LANE_IDS[*]}"))"
    exit 2
fi

# ---- launch all lanes in parallel --------------------------------------

RUN_STAMP=$(date -u +%Y-%m-%dT%H-%M-%S)
RESULT_DIR="/tmp/dolphinsense-fleet-runs/$RUN_STAMP"
mkdir -p "$RESULT_DIR"
log "result dir: $RESULT_DIR"

declare -a PIDS LANE_BY_PID

# Stagger lane launches to avoid thundering-herd on the parent wallet
# (port 3321) during BRC-31 handshake + getPublicKey. Each lane does
# ~3-5 parallel getPublicKey hits on the parent during cluster startup;
# N lanes × 5 hits simultaneously overwhelms MetaNet's 15s timeout.
# LAUNCH_STAGGER_SEC gives the parent wallet breathing room.
LAUNCH_STAGGER_SEC="${LAUNCH_STAGGER_SEC:-10}"

for lid in "${LANE_IDS[@]}"; do
    log_file="$RESULT_DIR/lane-${lid}.log"
    (
        LANE_ID="$lid" \
        RUST_BSV_WORM_DIR="$RUST_BSV_WORM_DIR" \
        LANES_FILE="$LANES_FILE" \
        INVENTORY_FILE="$INVENTORY" \
        SOAK_CYCLES="$SOAK_CYCLES" \
        BATCH_CAP="$BATCH_CAP" \
        SKINNY_CAPTAIN_MODE="$SKINNY_CAPTAIN_MODE" \
        ENABLE_SYNTHESIS="$ENABLE_SYNTHESIS" \
        SYNTHESIS_EVERY_N="${SYNTHESIS_EVERY_N:-25}" \
        QUEUE_MODE="$QUEUE_MODE" \
        FIREHOSE_DIR="$FIREHOSE_DIR" \
        PREFLIGHT_CERTS_ONLY="${PREFLIGHT_CERTS_ONLY:-0}" \
        SKIP_NANOSTORE_UPLOAD="${SKIP_NANOSTORE_UPLOAD:-0}" \
        node "$REPO_ROOT/scripts/lane-cycle.js" --lane "$lid" \
            > "$log_file" 2>&1
    ) &
    pid=$!
    PIDS+=("$pid")
    LANE_BY_PID+=("$lid")
    log "launched lane '$lid' → pid $pid → $log_file"
    # Stagger next launch so parent wallet isn't overwhelmed
    if [ "$lid" != "${LANE_IDS[${#LANE_IDS[@]} - 1]}" ] && [ "$LAUNCH_STAGGER_SEC" -gt 0 ]; then
        sleep "$LAUNCH_STAGGER_SEC"
    fi
done

# ---- wait for all --------------------------------------------------------

log "waiting for ${#PIDS[@]} lane processes..."
declare -a FAILED_LANES
for i in "${!PIDS[@]}"; do
    pid="${PIDS[i]}"
    lid="${LANE_BY_PID[i]}"
    if wait "$pid"; then
        ok "lane $lid completed (pid $pid)"
    else
        bad "lane $lid FAILED (pid $pid)"
        FAILED_LANES+=("$lid")
    fi
done

# ---- aggregate -----------------------------------------------------------

log "aggregating results"
AGGREGATE="$RESULT_DIR/fleet-aggregate.json"
jq -n \
    --arg stamp "$RUN_STAMP" \
    --arg mode "$SKINNY_CAPTAIN_MODE" \
    --argjson soak "$SOAK_CYCLES" \
    --argjson batch "$BATCH_CAP" \
    --argjson synth "$ENABLE_SYNTHESIS" \
    --arg lanes "$(IFS=,; echo "${LANE_IDS[*]}")" \
    --arg failed "$(IFS=,; echo "${FAILED_LANES[*]:-}")" \
    '{run_stamp: $stamp, mode: $mode, soak_cycles: $soak, batch_cap: $batch,
      synthesis_enabled: ($synth == 1), lanes: ($lanes | split(",")),
      failed_lanes: (if $failed == "" then [] else ($failed | split(",")) end),
      lane_results: []}' > "$AGGREGATE"

# Walk each lane's log for the JSON aggregate block at the bottom
for lid in "${LANE_IDS[@]}"; do
    log_file="$RESULT_DIR/lane-${lid}.log"
    # test_cycle_v2.js pattern: an "AGGREGATE SOAK SUMMARY" line followed by JSON
    lane_json=$(awk '/^\{$/,/^\}$/' "$log_file" 2>/dev/null | tail -c 100000 || true)
    if [ -n "$lane_json" ]; then
        tmp="$AGGREGATE.tmp"
        jq --arg lid "$lid" --argjson lane "$lane_json" \
            '.lane_results += [{id: $lid, result: $lane}]' "$AGGREGATE" > "$tmp" && mv "$tmp" "$AGGREGATE"
    fi
done

printf '\n' >&2
log "fleet summary: ${#LANE_IDS[@]} lanes ran, ${#FAILED_LANES[@]} failed"
log "aggregate: $AGGREGATE"

# Print per-lane headline from each log (last 'CYCLE 1 TOTAL' line)
printf '\n' >&2
log "per-lane headline:"
for lid in "${LANE_IDS[@]}"; do
    log_file="$RESULT_DIR/lane-${lid}.log"
    headline=$(grep 'CYCLE .* TOTAL' "$log_file" 2>/dev/null | tail -n 1 || true)
    if [ -n "$headline" ]; then
        printf '  %-14s %s\n' "$lid" "$headline" >&2
    else
        printf '  %-14s (no cycle total — check %s)\n' "$lid" "$log_file" >&2
    fi
done

[ "${#FAILED_LANES[@]}" -gt 0 ] && exit 3
exit 0
