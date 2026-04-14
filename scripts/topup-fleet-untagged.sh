#!/usr/bin/env bash
#
# topup-fleet-untagged.sh -- add an untagged UTXO to every fleet wallet.
#
# Why this exists: bsv-wallet-cli's `split` subcommand creates outputs with
# `tags: ["relinquish"]`, and dolphin-milk's createAction coin selector does
# NOT see tagged outputs. Fresh fleet wallets that were funded via
# send→fund→split end up with ONLY tagged outputs and are unspendable by
# dolphin-milk for overlay registration / cert acquisition / x402 payments.
#
# The fix: add ONE more send per wallet WITHOUT a split. That creates a
# single fresh untagged BRC-29 output that dolphin-milk can use. E20d worked
# because those wallets (3323/3324) had pre-existing untagged outputs from
# prior organic activity — fresh fleet wallets don't.
#
# Sizing: each top-up is sized to handle x402's gross-payment churn
# (sats_paid is ~10× sats_effective; the wallet needs the gross as
# headroom even though ~90% gets refunded):
#   captain   +3,000,000 sats  (handles ~10 cycles at 280K gross/cycle)
#   worker    +  500,000 sats  (handles ~30 cycles at 14K gross/cycle)
#   synthesis +3,000,000 sats  (handles ~3 cycles at 1M gross/cycle)
#
# Total: 5 × (3M + 0.5M + 3M) = 32.5M sats from 3322.
#
# Usage:
#   ./scripts/topup-fleet-untagged.sh [--dry-run] [--only <name>]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET_DIR="$HOME/bsv/wallets/fleet"
INVENTORY="$FLEET_DIR/INVENTORY.json"
SOURCE_ENV="${SOURCE_ENV:-$HOME/bsv/_archived/bsv-wallet-cli-old/.env}"
SOURCE_DB="${SOURCE_DB:-$HOME/bsv/_archived/bsv-wallet-cli-old/wallet.db}"
FUND_SCRIPT="$REPO_ROOT/scripts/fund-wallet.sh"
BIN="${BIN:-$HOME/bsv/bsv-wallet-cli/target/release/bsv-wallet}"
DRY_RUN=0
ONLY_NAME=""

CAPTAIN_TOPUP=3000000
WORKER_TOPUP=500000
SYNTHESIS_TOPUP=3000000

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --only) ONLY_NAME="$2"; shift 2 ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//' | head -30
            exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'
log()  { printf '%s[topup-untagged]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { bad "jq required"; exit 1; }
[ -x "$FUND_SCRIPT" ] || { bad "fund-wallet.sh missing: $FUND_SCRIPT"; exit 1; }
[ -f "$INVENTORY" ] || { bad "inventory missing: $INVENTORY"; exit 1; }

# Count existing untagged spendable outputs per wallet — if >=1 already, skip.
untagged_count() {
    local env_path="$1" db_path="$2"
    ( set +u; export $(grep -v '^\s*#' "$env_path" | xargs); \
      "$BIN" --db "$db_path" outputs --json 2>/dev/null ) \
    | jq '[.outputs[] | select(.spendable == true) | select(.tags | length == 0) | select(.satoshis >= 1000)] | length' 2>/dev/null
}

TOTAL=0
TOPPED=0
SKIPPED=0
FAILED=0
TOTAL_SENT=0

while IFS=$'\t' read -r name role env_path db_path; do
    [ -z "$name" ] && continue
    [ -n "$ONLY_NAME" ] && [ "$name" != "$ONLY_NAME" ] && continue
    TOTAL=$((TOTAL + 1))

    case "$role" in
        captain)   amount=$CAPTAIN_TOPUP ;;
        worker)    amount=$WORKER_TOPUP ;;
        synthesis) amount=$SYNTHESIS_TOPUP ;;
        *) bad "unknown role for $name: $role"; FAILED=$((FAILED+1)); continue ;;
    esac

    printf '\n[%s] (%s) — topup target %s sats, no split\n' "$name" "$role" "$amount" >&2

    # Idempotent check: skip if wallet already has ≥1 untagged non-dust UTXO
    cur_untagged=$(untagged_count "$env_path" "$db_path")
    if [ "${cur_untagged:-0}" -ge 1 ]; then
        ok "already has $cur_untagged untagged non-dust UTXO(s) — skipping"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        ok "[DRY RUN] would send $amount sats (no split)"
        continue
    fi

    # Call fund-wallet.sh with split_count=0
    if "$FUND_SCRIPT" "$SOURCE_ENV" "$SOURCE_DB" "$env_path" "$db_path" "$amount" 0 > /dev/null; then
        ok "topped up +$amount sats (untagged)"
        TOPPED=$((TOPPED + 1))
        TOTAL_SENT=$((TOTAL_SENT + amount))
    else
        bad "topup failed for $name"
        FAILED=$((FAILED + 1))
    fi
done < <(jq -r '
    (if type == "array" then .
     elif type == "object" and has("wallets") then .wallets
     else [] end)[]
    | [.name, .role, (.env // .env_path), (.db // .db_path)]
    | @tsv' "$INVENTORY")

printf '\n' >&2
log "summary: $TOPPED topped up, $SKIPPED already had untagged, $FAILED failed (total $TOTAL)"
log "total sent from master: $TOTAL_SENT sats"
[ "$FAILED" -gt 0 ] && exit 1
exit 0
