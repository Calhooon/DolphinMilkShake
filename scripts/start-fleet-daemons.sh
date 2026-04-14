#!/usr/bin/env bash
#
# start-fleet-daemons.sh -- start/stop/status for fleet wallet daemons.
#
# Reads ~/bsv/wallets/fleet/INVENTORY.json (or --inventory <path>) and
# manages bsv-wallet daemon processes for every entry. Each daemon is
# spawned detached with nohup, its PID is captured in ~/bsv/wallets/fleet/.pids/,
# and its stdout+stderr are piped to ~/bsv/wallets/fleet/.logs/.
#
# Safety rules (learned from the 3323 incident):
#   1. NEVER SIGTERM a daemon whose .env file is missing from disk
#   2. Before SIGTERM, verify .env file exists AND has ROOT_KEY=<64-char hex>
#   3. Stop is graceful (SIGTERM, 5s wait, SIGKILL only if unresponsive)
#   4. Env files and DBs are NEVER touched by this script — provisioning
#      is a separate concern, this is just lifecycle
#
# Usage:
#   ./scripts/start-fleet-daemons.sh start            # Start all daemons
#   ./scripts/start-fleet-daemons.sh stop             # Stop all daemons gracefully
#   ./scripts/start-fleet-daemons.sh status           # Show all daemon states
#   ./scripts/start-fleet-daemons.sh restart          # Stop + start
#   ./scripts/start-fleet-daemons.sh start <name>     # Start a specific wallet
#   ./scripts/start-fleet-daemons.sh stop <name>      # Stop a specific wallet
#
# Options:
#   --inventory <path>   use a different inventory JSON (default: ~/bsv/wallets/fleet/INVENTORY.json)
#   --dry-run            print what would happen, don't execute

set -euo pipefail

FLEET_DIR="$HOME/bsv/wallets/fleet"
INVENTORY="$FLEET_DIR/INVENTORY.json"
PID_DIR="$FLEET_DIR/.pids"
LOG_DIR="$FLEET_DIR/.logs"
BIN="${BIN:-$HOME/bsv/bsv-wallet-cli/target/release/bsv-wallet}"
MAIN_TAAL_API_KEY="${MAIN_TAAL_API_KEY:-mainnet_9596de07e92300c6287e4393594ae39c}"
DRY_RUN=0
TARGET_NAME=""
CMD=""

# ---- arg parse --------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        start|stop|status|restart) CMD="$1"; shift ;;
        --inventory) INVENTORY="$2"; shift 2 ;;
        --dry-run)   DRY_RUN=1; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//' | head -30
            exit 0 ;;
        -*) echo "unknown flag: $1" >&2; exit 1 ;;
        *)  TARGET_NAME="$1"; shift ;;
    esac
done

[ -z "$CMD" ] && { echo "usage: $(basename "$0") {start|stop|status|restart} [name]" >&2; exit 1; }

# ---- deps -------------------------------------------------------------
command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }
[ -x "$BIN" ] || { echo "bsv-wallet binary not found: $BIN" >&2; exit 2; }
[ -f "$INVENTORY" ] || { echo "inventory not found: $INVENTORY" >&2; exit 2; }

mkdir -p "$PID_DIR" "$LOG_DIR"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'
log()  { printf '%s[fleet-daemons]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }

# ---- fetch wallet list as TSV -----------------------------------------
# Columns: name, env_path, db_path, wallet_port
wallet_tsv=$(jq -r '
    (if type == "array" then .
     elif type == "object" and has("wallets") then .wallets
     else [] end)[]
    | [.name, (.env // .env_path), (.db // .db_path), .wallet_port]
    | @tsv' "$INVENTORY")

# Filter if a specific name was requested
if [ -n "$TARGET_NAME" ]; then
    wallet_tsv=$(printf '%s\n' "$wallet_tsv" | awk -F'\t' -v name="$TARGET_NAME" '$1 == name')
    [ -z "$wallet_tsv" ] && { bad "wallet not found in inventory: $TARGET_NAME"; exit 1; }
fi

# ---- helpers ----------------------------------------------------------

# Verify an env file exists AND has a valid-looking ROOT_KEY.
# This is the rule: never act on a wallet whose key backup isn't on disk.
verify_env_safe() {
    local env_path="$1"
    [ -f "$env_path" ] || return 1
    grep -q '^ROOT_KEY=[a-f0-9]\{64\}$' "$env_path" || return 1
    return 0
}

is_running() {
    local pid_file="$1"
    [ -f "$pid_file" ] || return 1
    local pid
    pid=$(cat "$pid_file" 2>/dev/null)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_one() {
    local name="$1" env_path="$2" db_path="$3" wallet_port="$4"
    local pid_file="$PID_DIR/${name}.pid"
    local log_file="$LOG_DIR/${name}.log"

    printf '\n[%s] start (port %s)\n' "$name" "$wallet_port" >&2

    if is_running "$pid_file"; then
        warn "already running (pid $(cat "$pid_file"))"
        return 0
    fi

    if ! verify_env_safe "$env_path"; then
        bad "env file missing or missing ROOT_KEY — refusing to start"
        return 1
    fi
    [ -f "$db_path" ] || { bad "db file missing: $db_path"; return 1; }

    if [ "$DRY_RUN" -eq 1 ]; then
        ok "[DRY RUN] would start daemon --db $db_path --port $wallet_port"
        return 0
    fi

    # Spawn detached. We source the env file (ROOT_KEY) AND pass
    # MAIN_TAAL_API_KEY so TAAL broadcast works. Use nohup + disown so the
    # daemon survives this shell exiting.
    (
        set +u
        export $(grep -v '^\s*#' "$env_path" | xargs)
        export MAIN_TAAL_API_KEY="$MAIN_TAAL_API_KEY"
        nohup "$BIN" --db "$db_path" --port "$wallet_port" daemon \
            > "$log_file" 2>&1 &
        echo $! > "$pid_file"
        disown
    )

    sleep 0.5
    if is_running "$pid_file"; then
        ok "started (pid $(cat "$pid_file"))"
    else
        bad "failed to start — check $log_file"
        return 1
    fi
}

stop_one() {
    local name="$1" env_path="$2"
    local pid_file="$PID_DIR/${name}.pid"

    printf '\n[%s] stop\n' "$name" >&2

    if ! is_running "$pid_file"; then
        warn "not running"
        rm -f "$pid_file"
        return 0
    fi

    # SAFETY: do not SIGTERM unless env file is on disk with ROOT_KEY
    if ! verify_env_safe "$env_path"; then
        bad "env file missing or corrupt — REFUSING to stop daemon"
        bad "fix the env file first, then retry stop"
        return 1
    fi

    local pid
    pid=$(cat "$pid_file")

    if [ "$DRY_RUN" -eq 1 ]; then
        ok "[DRY RUN] would SIGTERM pid $pid"
        return 0
    fi

    kill -TERM "$pid" 2>/dev/null || true
    # Wait up to 5 seconds for graceful exit
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if ! kill -0 "$pid" 2>/dev/null; then
            ok "stopped gracefully (pid $pid)"
            rm -f "$pid_file"
            return 0
        fi
        sleep 0.5
    done

    warn "daemon did not exit on SIGTERM, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.2
    rm -f "$pid_file"
    return 0
}

status_one() {
    local name="$1" env_path="$2" wallet_port="$3"
    local pid_file="$PID_DIR/${name}.pid"
    local state="stopped"
    local pid=""
    if is_running "$pid_file"; then
        pid=$(cat "$pid_file")
        state="running"
    fi

    local env_ok="missing"
    verify_env_safe "$env_path" && env_ok="ok"

    local http_ok="n/a"
    if [ "$state" = "running" ]; then
        if curl -sS --max-time 2 -o /dev/null -X POST \
              -H "Content-Type: application/json" \
              -H "Origin: http://localhost:$wallet_port" \
              -d '{"identityKey":true}' \
              "http://localhost:$wallet_port/getPublicKey" 2>/dev/null; then
            http_ok="ok"
        else
            http_ok="no-response"
        fi
    fi

    printf '  %-24s  port=%-5s  state=%-7s  pid=%-6s  env=%-7s  http=%s\n' \
        "$name" "$wallet_port" "$state" "${pid:-}" "$env_ok" "$http_ok"
}

# ---- dispatch ---------------------------------------------------------

FAIL=0

case "$CMD" in
    start)
        log "starting fleet daemons"
        while IFS=$'\t' read -r name env db wport; do
            [ -z "$name" ] && continue
            start_one "$name" "$env" "$db" "$wport" || FAIL=$((FAIL + 1))
        done <<< "$wallet_tsv"
        ;;
    stop)
        log "stopping fleet daemons"
        while IFS=$'\t' read -r name env db wport; do
            [ -z "$name" ] && continue
            stop_one "$name" "$env" || FAIL=$((FAIL + 1))
        done <<< "$wallet_tsv"
        ;;
    restart)
        log "restarting fleet daemons"
        while IFS=$'\t' read -r name env db wport; do
            [ -z "$name" ] && continue
            stop_one "$name" "$env" || FAIL=$((FAIL + 1))
        done <<< "$wallet_tsv"
        sleep 1
        while IFS=$'\t' read -r name env db wport; do
            [ -z "$name" ] && continue
            start_one "$name" "$env" "$db" "$wport" || FAIL=$((FAIL + 1))
        done <<< "$wallet_tsv"
        ;;
    status)
        log "fleet daemon status"
        printf '\n'
        while IFS=$'\t' read -r name env db wport; do
            [ -z "$name" ] && continue
            status_one "$name" "$env" "$wport"
        done <<< "$wallet_tsv"
        printf '\n'
        ;;
esac

if [ "$FAIL" -gt 0 ]; then
    bad "$FAIL operation(s) failed"
    exit 1
fi
log "done"
exit 0
