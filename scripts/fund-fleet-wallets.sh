#!/usr/bin/env bash
#
# fund-fleet-wallets.sh -- bootstrap the 15-wallet fleet from the master wallet.
#
# Loops through ~/bsv/wallets/fleet/INVENTORY.json and calls fund-wallet.sh
# for each entry with role-specific amounts + split counts.
#
# Sizing (per WALLETS.md + E20d measured numbers):
#   - captain:    10M sats, split 10  → 1M/UTXO   (handles ~25 cycles/hr × 91K sats)
#   - worker:      5M sats, split 20  → 250K/UTXO (handles ~2500 createActions/hr)
#   - synthesis:   3M sats, split 10  → 300K/UTXO (handles ~1 synth/hr amortized)
#
# Total 5-lane smoke burn: 5 × (10M + 5M + 3M) = 90M sats from 3322.
#
# Idempotent: skips wallets whose balance is already >= target amount.
#
# Usage:
#   ./scripts/fund-fleet-wallets.sh [--dry-run] [--only <name>]
#
# Env:
#   SOURCE_ENV   default ~/bsv/_archived/bsv-wallet-cli-old/.env
#   SOURCE_DB    default ~/bsv/_archived/bsv-wallet-cli-old/wallet.db

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

# Role sizing (sats, split_count)
CAPTAIN_SATS=10000000  ; CAPTAIN_SPLIT=10
WORKER_SATS=5000000    ; WORKER_SPLIT=20
SYNTHESIS_SATS=3000000 ; SYNTHESIS_SPLIT=10

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --only) ONLY_NAME="$2"; shift 2 ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//' | head -25
            exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'
log()  { printf '%s[fund-fleet]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { bad "jq required"; exit 2; }
[ -x "$FUND_SCRIPT" ] || { bad "fund-wallet.sh not executable: $FUND_SCRIPT"; exit 2; }
[ -f "$INVENTORY" ] || { bad "inventory not found: $INVENTORY"; exit 2; }
[ -f "$SOURCE_ENV" ] || { bad "source env not found: $SOURCE_ENV"; exit 2; }
[ -f "$SOURCE_DB" ] || { bad "source db not found: $SOURCE_DB"; exit 2; }

# Helper: fetch balance via CLI (requires env sourced)
current_balance() {
    local env_path="$1" db_path="$2"
    ( set +u; export $(grep -v '^\s*#' "$env_path" | xargs); \
      "$BIN" --db "$db_path" balance --json 2>/dev/null \
        | jq -r '.satoshis // 0' ) || echo 0
}

# Master wallet balance sanity check
MASTER_BAL=$(current_balance "$SOURCE_ENV" "$SOURCE_DB")
log "master wallet balance: $MASTER_BAL sats"
if [ "$MASTER_BAL" -lt 100000000 ]; then
    warn "master wallet has < 100M sats — may be insufficient for full 15-wallet fund"
fi

# Walk inventory and fund each
fleet_tsv=$(jq -r '
    (if type == "array" then .
     elif type == "object" and has("wallets") then .wallets
     else [] end)[]
    | [.name, .role, (.env // .env_path), (.db // .db_path)]
    | @tsv' "$INVENTORY")

TOTAL=0
FUNDED=0
SKIPPED=0
FAILED=0
TOTAL_SPENT=0

while IFS=$'\t' read -r name role env_path db_path; do
    [ -z "$name" ] && continue
    [ -n "$ONLY_NAME" ] && [ "$name" != "$ONLY_NAME" ] && continue
    TOTAL=$((TOTAL + 1))

    # Pick amounts by role
    case "$role" in
        captain)   sats=$CAPTAIN_SATS   ; split=$CAPTAIN_SPLIT ;;
        worker)    sats=$WORKER_SATS    ; split=$WORKER_SPLIT ;;
        synthesis) sats=$SYNTHESIS_SATS ; split=$SYNTHESIS_SPLIT ;;
        *) bad "unknown role for $name: $role"; FAILED=$((FAILED+1)); continue ;;
    esac

    printf '\n[%s] (%s) — target %s sats, split %d\n' "$name" "$role" "$sats" "$split" >&2

    # Idempotent check — tolerate up to 500 sats below target for split
    # fees (a 20-output split consumes ~89 sats in fees, 10-output ~54).
    # Anything within 500 sats of target is "close enough", don't top up.
    cur=$(current_balance "$env_path" "$db_path")
    tolerance=500
    if [ "$cur" -ge "$((sats - tolerance))" ]; then
        ok "already at target ($cur ≈ $sats within ${tolerance}s tolerance) — skipping"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    needed=$((sats - cur))
    log "currently $cur sats, need +$needed"

    if [ "$DRY_RUN" -eq 1 ]; then
        ok "[DRY RUN] would send $needed sats + split $split"
        continue
    fi

    if "$FUND_SCRIPT" "$SOURCE_ENV" "$SOURCE_DB" "$env_path" "$db_path" "$needed" "$split" > /dev/null; then
        # Verify balance jumped
        post=$(current_balance "$env_path" "$db_path")
        ok "funded: $cur → $post"
        FUNDED=$((FUNDED + 1))
        TOTAL_SPENT=$((TOTAL_SPENT + needed))
    else
        bad "fund-wallet.sh failed for $name"
        FAILED=$((FAILED + 1))
    fi
done <<< "$fleet_tsv"

printf '\n' >&2
log "summary: $FUNDED funded, $SKIPPED skipped, $FAILED failed (total $TOTAL)"
log "total sent from master: $TOTAL_SPENT sats"
MASTER_AFTER=$(current_balance "$SOURCE_ENV" "$SOURCE_DB")
log "master wallet: $MASTER_BAL → $MASTER_AFTER"

[ "$FAILED" -gt 0 ] && exit 1
exit 0
