#!/usr/bin/env bash
#
# keep-alive.sh -- overnight supervisor for the fleet.
#
# Polls every POLL_INTERVAL seconds and restarts anything that has died:
#   1. Fleet wallet daemons (bsv-wallet on ports 3400-3489, 90 of them)
#   2. Bluesky jetstream feeder (single process)
#   3. Wikipedia stream feeder (single process)
#   4. Wallet watchdog (single process)
#
# Does NOT supervise dolphin-milk agents (captain/worker/synthesis spawned
# per-cycle by lane-cycle.js) — those are handled by cluster.js SUPERVISE=1
# which must be set in the fleet-cycle.sh environment.
#
# Does NOT supervise fleet-cycle.sh itself — if the soak finishes cleanly
# or dies, it stays dead. Wrap in an outer loop or increase SOAK_CYCLES
# if you want a true "runs forever" mode.
#
# Idempotent: if nothing is dead, sleeps and polls again. Safe to run
# multiple instances (duplicate restarts would just fail idempotent
# start-fleet-daemons.sh calls).
#
# Usage:
#   ./scripts/keep-alive.sh                 # run forever with defaults
#   POLL_INTERVAL=30 ./scripts/keep-alive.sh # custom poll interval
#
# Run in background:
#   nohup ./scripts/keep-alive.sh > /tmp/keep-alive.log 2>&1 &
#
# Environment:
#   POLL_INTERVAL  seconds between polls (default 60)
#   BSKY_EN_TENANTS, BSKY_JA_TENANTS, BSKY_PT_TENANTS, BSKY_MULTI_TENANTS
#                  forwarded to bluesky feeder on restart (same values
#                  you used when first starting it)
#   WIKI_TENANTS   forwarded to wiki feeder on restart
#
# WARNING: the feeder restart commands hardcode the 30-lane tenant lists
# as of 2026-04-15. If you add lanes, update this script's FEEDER_BSKY_CMD
# and FEEDER_WIKI_CMD blocks OR pass the env vars when launching keep-alive.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET_DIR="$HOME/bsv/wallets/fleet"
PID_DIR="$FLEET_DIR/.pids"
INVENTORY="$FLEET_DIR/INVENTORY.json"
POLL_INTERVAL="${POLL_INTERVAL:-60}"

# Default feeder tenant lists — override via env if your topology changes.
: "${BSKY_EN_TENANTS:=bsky-en,bsky-en-2,bsky-en-3,bsky-en-4,bsky-en-5,bsky-en-6,bsky-en-7,bsky-en-8,bsky-en-9,bsky-en-10,bsky-en-11,bsky-en-12,bsky-en-13,bsky-en-14,bsky-en-15,bsky-en-16,bsky-en-17,bsky-en-18,bsky-en-19,bsky-en-20,bsky-en-21}"
: "${BSKY_JA_TENANTS:=bsky-ja,bsky-ja-2}"
: "${BSKY_PT_TENANTS:=bsky-pt,bsky-pt-2}"
: "${BSKY_MULTI_TENANTS:=bsky-multi}"
: "${WIKI_TENANTS:=wiki-en,wiki-en-2,wiki-en-3,wiki-en-4}"
export BSKY_EN_TENANTS BSKY_JA_TENANTS BSKY_PT_TENANTS BSKY_MULTI_TENANTS WIKI_TENANTS

# ---- logging ---------------------------------------------------------------
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; DIM=$'\033[2m'; NC=$'\033[0m'
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log()  { printf '%s[%s]%s %s[keep-alive]%s %s\n' "$DIM" "$(ts)" "$NC" "$BLUE" "$NC" "$*"; }
ok()   { printf '%s[%s]%s %s[ OK ]%s    %s\n' "$DIM" "$(ts)" "$NC" "$GREEN" "$NC" "$*"; }
warn() { printf '%s[%s]%s %s[WARN]%s    %s\n' "$DIM" "$(ts)" "$NC" "$YELLOW" "$NC" "$*"; }
err()  { printf '%s[%s]%s %s[FAIL]%s    %s\n' "$DIM" "$(ts)" "$NC" "$RED" "$NC" "$*"; }

# ---- checks ----------------------------------------------------------------
command -v jq >/dev/null 2>&1 || { err "jq required"; exit 2; }
[ -f "$INVENTORY" ] || { err "inventory not found: $INVENTORY"; exit 2; }
[ -d "$PID_DIR" ] || { err "pid dir not found: $PID_DIR (run start-fleet-daemons.sh start first)"; exit 2; }

# ---- pid helpers -----------------------------------------------------------
pid_alive() {
    local pid="$1"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# ---- wallet daemon supervision ---------------------------------------------
check_wallet_daemons() {
    local dead_names=()
    local wallet_names
    wallet_names=$(jq -r '.wallets[].name' "$INVENTORY")

    for name in $wallet_names; do
        local pid_file="$PID_DIR/$name.pid"
        if [ ! -f "$pid_file" ]; then
            dead_names+=("$name")
            continue
        fi
        local pid
        pid=$(cat "$pid_file" 2>/dev/null || echo "")
        if ! pid_alive "$pid"; then
            dead_names+=("$name")
        fi
    done

    if [ ${#dead_names[@]} -eq 0 ]; then
        return 0
    fi

    warn "wallet daemons dead: ${#dead_names[@]}  [${dead_names[*]}]"
    for name in "${dead_names[@]}"; do
        log "  restarting wallet daemon: $name"
        if "$REPO_ROOT/scripts/start-fleet-daemons.sh" start "$name" >/dev/null 2>&1; then
            ok "  restarted: $name"
        else
            err "  failed to restart: $name"
        fi
    done
}

# ---- feeder supervision ----------------------------------------------------
check_bsky_feeder() {
    if pgrep -f "bluesky-jetstream-feeder.js" >/dev/null 2>&1; then
        return 0
    fi
    warn "bluesky feeder dead — restarting"
    cd "$REPO_ROOT" || return 1
    nohup env \
        BSKY_EN_TENANTS="$BSKY_EN_TENANTS" \
        BSKY_JA_TENANTS="$BSKY_JA_TENANTS" \
        BSKY_PT_TENANTS="$BSKY_PT_TENANTS" \
        BSKY_MULTI_TENANTS="$BSKY_MULTI_TENANTS" \
        node feeder/bluesky-jetstream-feeder.js > /tmp/feeder-bsky-21.log 2>&1 &
    disown
    sleep 1
    if pgrep -f "bluesky-jetstream-feeder.js" >/dev/null 2>&1; then
        ok "bluesky feeder restarted"
    else
        err "bluesky feeder restart FAILED (check /tmp/feeder-bsky-21.log)"
    fi
}

check_wiki_feeder() {
    if pgrep -f "wikipedia-stream-feeder.js" >/dev/null 2>&1; then
        return 0
    fi
    warn "wikipedia feeder dead — restarting"
    cd "$REPO_ROOT" || return 1
    nohup env \
        WIKI_TENANTS="$WIKI_TENANTS" \
        node feeder/wikipedia-stream-feeder.js > /tmp/feeder-wiki-4.log 2>&1 &
    disown
    sleep 1
    if pgrep -f "wikipedia-stream-feeder.js" >/dev/null 2>&1; then
        ok "wikipedia feeder restarted"
    else
        err "wikipedia feeder restart FAILED (check /tmp/feeder-wiki-4.log)"
    fi
}

check_watchdog() {
    if pgrep -f "wallet-watchdog.js" >/dev/null 2>&1; then
        return 0
    fi
    warn "wallet watchdog dead — restarting"
    cd "$REPO_ROOT" || return 1
    nohup node scripts/wallet-watchdog.js > /tmp/watchdog-30lane-soak.log 2>&1 &
    disown
    sleep 1
    if pgrep -f "wallet-watchdog.js" >/dev/null 2>&1; then
        ok "wallet watchdog restarted"
    else
        err "wallet watchdog restart FAILED"
    fi
}

# ---- main loop -------------------------------------------------------------
log "starting keep-alive: poll every ${POLL_INTERVAL}s"
log "  watching: 90 wallet daemons, bluesky feeder, wikipedia feeder, wallet-watchdog"
log "  wallet daemons restart via start-fleet-daemons.sh (per-name, idempotent)"
log "  does NOT supervise fleet-cycle.sh or dolphin-milk agents (use SUPERVISE=1 for those)"

trap 'log "received signal, exiting"; exit 0' INT TERM

while true; do
    check_wallet_daemons
    check_bsky_feeder
    check_wiki_feeder
    check_watchdog
    sleep "$POLL_INTERVAL"
done
