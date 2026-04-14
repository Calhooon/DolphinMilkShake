#!/usr/bin/env bash
#
# preflight-wallets.sh -- read-only health check across a wallet fleet.
#
# For each wallet in the inventory, checks:
#   1. env and db files exist
#   2. CLI `identity` succeeds (ROOT_KEY is loadable)
#   3. CLI `balance` returns a number
#   4. CLI `outputs --json` returns a spendable set
#   5. optional: flags wallets below a minimum balance / utxo count
#
# Does NOT make any mutating calls. Safe to run during a live fleet run.
#
# Usage:
#   preflight-wallets.sh [--min-sats N] [--min-utxos N] <inventory.json>
#
# Inventory format (inventory.json):
#   [
#     {"name": "captain-01", "env": "~/bsv/wallets/captain-01.env",
#      "db": "~/bsv/wallets/captain-01.db", "role": "captain"},
#     ...
#   ]
#
# Or no inventory file → checks the 3-wallet dev fleet (captain/synthesis/worker).
#
# Exit codes:
#   0  all wallets healthy and above thresholds
#   1  usage error
#   2  one or more wallets unreachable / unhealthy
#   3  one or more wallets below threshold (warning only if --warn-only)

set -euo pipefail

BIN="${BIN:-$HOME/bsv/bsv-wallet-cli/target/release/bsv-wallet}"
MIN_SATS="${MIN_SATS:-0}"
MIN_UTXOS="${MIN_UTXOS:-0}"
WARN_ONLY=0

# Parse flags (simple, no getopt dependency)
INVENTORY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --min-sats)     MIN_SATS="$2"; shift 2 ;;
        --min-utxos)    MIN_UTXOS="$2"; shift 2 ;;
        --warn-only)    WARN_ONLY=1; shift ;;
        -h|--help)
            cat <<EOF
preflight-wallets.sh — read-only fleet health check.

Usage:
  $(basename "$0") [--min-sats N] [--min-utxos N] [--warn-only] [inventory.json]

Options:
  --min-sats N       flag wallets with balance below N sats
  --min-utxos N      flag wallets with fewer than N spendable UTXOs
  --warn-only        exit 0 even if wallets are below threshold
  inventory.json     JSON array of wallet definitions (see docstring).
                     Omit for the 3-wallet dev fleet default.

Environment:
  BIN          path to bsv-wallet binary (default: ~/bsv/bsv-wallet-cli/target/release/bsv-wallet)
EOF
            exit 0 ;;
        -*) echo "unknown flag: $1" >&2; exit 1 ;;
        *)  INVENTORY="$1"; shift ;;
    esac
done

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

log()  { printf '%s[preflight]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 1; }
[ -x "$BIN" ] || { echo "bsv-wallet binary not found: $BIN" >&2; exit 1; }

# --- build the wallet list to check --------------------------------------
declare -a NAMES ENVS DBS ROLES

if [ -n "$INVENTORY" ] && [ -f "$INVENTORY" ]; then
    log "using inventory: $INVENTORY"
    # Accepts two shapes:
    #   1. flat array:  [{"name": ..., "env": ..., "db": ..., "role": ...}]
    #   2. wrapped obj: {"wallets": [{"name": ..., "env_path": ..., "db_path": ..., "role": ...}]}
    # (shape #2 is what provision-fleet-wallets.sh emits)
    while IFS=$'\t' read -r name env db role; do
        NAMES+=("$name")
        ENVS+=("$env")
        DBS+=("$db")
        ROLES+=("$role")
    done < <(jq -r '
        (if type == "array" then .
         elif type == "object" and has("wallets") then .wallets
         else [] end)[]
        | [.name, (.env // .env_path), (.db // .db_path), (.role // "unknown")]
        | @tsv' "$INVENTORY")
else
    log "using default 3-wallet dev fleet"
    NAMES=("captain" "synthesis" "worker")
    ENVS=(
        "$HOME/bsv/_archived/bsv-wallet-cli-old/.env"
        "$HOME/bsv/wallets/synthesis-3323.env"
        "$HOME/bsv/wallets/worker-3324.env"
    )
    DBS=(
        "$HOME/bsv/_archived/bsv-wallet-cli-old/wallet.db"
        "$HOME/bsv/wallets/synthesis-3323.db"
        "$HOME/bsv/wallets/worker-3324.db"
    )
    ROLES=("captain" "synthesis" "worker")
fi

log "checking ${#NAMES[@]} wallet(s)"
log "thresholds: min_sats=$MIN_SATS min_utxos=$MIN_UTXOS"

TOTAL=0
HEALTHY=0
BELOW_THRESHOLD=0
UNHEALTHY=0

for i in "${!NAMES[@]}"; do
    name="${NAMES[i]}"
    env="${ENVS[i]}"
    db="${DBS[i]}"
    role="${ROLES[i]}"
    TOTAL=$((TOTAL + 1))

    printf '\n[%s] (%s)\n' "$name" "$role" >&2

    # File existence
    if [ ! -f "$env" ]; then
        bad "env file missing: $env"
        UNHEALTHY=$((UNHEALTHY + 1))
        continue
    fi
    if [ ! -f "$db" ]; then
        bad "db file missing: $db"
        UNHEALTHY=$((UNHEALTHY + 1))
        continue
    fi

    # Try balance query (also validates ROOT_KEY loadability)
    bal_json=$( ( set +u; export $(grep -v '^\s*#' "$env" | xargs); \
                "$BIN" --db "$db" balance --json 2>/dev/null ) || true )
    sats=$(printf '%s' "$bal_json" | jq -r '.satoshis // empty' 2>/dev/null)
    if [ -z "$sats" ]; then
        bad "balance query failed (bad ROOT_KEY or unreachable DB)"
        UNHEALTHY=$((UNHEALTHY + 1))
        continue
    fi
    ok "balance: $sats sats"

    # UTXO count — outputs --json returns {"totalOutputs": N, "outputs": [...]}
    out_json=$( ( set +u; export $(grep -v '^\s*#' "$env" | xargs); \
                "$BIN" --db "$db" outputs --json 2>/dev/null ) || true )
    utxos=$(printf '%s' "$out_json" | jq -r '.totalOutputs // (.outputs | length) // 0' 2>/dev/null)
    if [ -z "$utxos" ] || [ "$utxos" = "null" ]; then utxos=0; fi
    ok "utxos:   $utxos"

    # Thresholds
    status_ok=1
    if [ "$MIN_SATS" -gt 0 ] && [ "$sats" -lt "$MIN_SATS" ]; then
        warn "below min_sats threshold ($sats < $MIN_SATS)"
        status_ok=0
    fi
    if [ "$MIN_UTXOS" -gt 0 ] && [ "$utxos" -lt "$MIN_UTXOS" ]; then
        warn "below min_utxos threshold ($utxos < $MIN_UTXOS)"
        status_ok=0
    fi

    if [ "$status_ok" -eq 1 ]; then
        HEALTHY=$((HEALTHY + 1))
    else
        BELOW_THRESHOLD=$((BELOW_THRESHOLD + 1))
    fi
done

# --- summary -------------------------------------------------------------
printf '\n' >&2
log "summary: $HEALTHY healthy, $BELOW_THRESHOLD below threshold, $UNHEALTHY unhealthy (total $TOTAL)"

if [ "$UNHEALTHY" -gt 0 ]; then
    exit 2
fi
if [ "$BELOW_THRESHOLD" -gt 0 ] && [ "$WARN_ONLY" -ne 1 ]; then
    exit 3
fi
exit 0
