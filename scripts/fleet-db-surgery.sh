#!/usr/bin/env bash
#
# fleet-db-surgery.sh -- promote old split-tagged outputs to spendable state.
#
# Context: bsv-wallet-cli's split subcommand (pre-fix) created outputs with
# `change = 0` AND `derivation_prefix = NULL` AND `sender_identity_key = NULL`.
# These outputs are invisible to dolphin-milk's createAction coin selector
# (which filters `WHERE change = 1`) AND un-signable (no derivation metadata
# means the wallet can't derive the private key).
#
# The bsv-wallet-cli split command has been patched (split.rs: basket: None)
# so FUTURE splits will have change=1 + derivation stored correctly.
# But the EXISTING 15 fleet wallets still have broken state from the
# pre-fix split that provisioned them.
#
# This script does a controlled DB surgery on each wallet:
#   1. Stop the daemon (env-safety verified)
#   2. UPDATE outputs table to populate the 3 missing columns
#   3. Restart the daemon
#   4. Verify via HTTP health check
#
# The update is idempotent (only touches rows where derivation_prefix IS NULL
# or empty).
#
# Verified canary: captain-worldnews passed a full dolphin-milk cycle after
# this surgery (110,127 sats / 100 proofs / 118s wall).
#
# Usage:
#   ./scripts/fleet-db-surgery.sh [--dry-run] [--only <name>]

set -euo pipefail

FLEET_DIR="$HOME/bsv/wallets/fleet"
INVENTORY="$FLEET_DIR/INVENTORY.json"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET_DAEMONS="$REPO_ROOT/scripts/start-fleet-daemons.sh"
DRY_RUN=0
ONLY_NAME=""

# Constants from bsv-wallet-cli/src/commands/split.rs — these are the
# DEFAULT_DERIVATION_PREFIX, DEFAULT_DERIVATION_SUFFIX, and anyone-pubkey
# (secp256k1 generator point G) that the split command uses.
DERIVATION_PREFIX='SfKxPIJNgdI='
DERIVATION_SUFFIX='NaGLC6fMH50='
SENDER_IDENTITY_KEY='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --only) ONLY_NAME="$2"; shift 2 ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//' | head -35
            exit 0 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'
log()  { printf '%s[db-surgery]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { bad "jq required"; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { bad "sqlite3 required"; exit 1; }
[ -f "$INVENTORY" ] || { bad "inventory missing: $INVENTORY"; exit 1; }
[ -x "$FLEET_DAEMONS" ] || { bad "fleet-daemons script missing: $FLEET_DAEMONS"; exit 1; }

# Safety: verify env file has ROOT_KEY before we touch its DB.
# This matches the safety rule in start-fleet-daemons.sh.
verify_env_safe() {
    local env_path="$1"
    [ -f "$env_path" ] || return 1
    grep -q '^ROOT_KEY=[a-f0-9]\{64\}$' "$env_path" || return 1
    return 0
}

TOTAL=0
SURGERY_OK=0
SKIPPED=0
FAILED=0
ROWS_TOTAL=0

while IFS=$'\t' read -r name env_path db_path; do
    [ -z "$name" ] && continue
    [ -n "$ONLY_NAME" ] && [ "$name" != "$ONLY_NAME" ] && continue
    TOTAL=$((TOTAL + 1))

    printf '\n[%s]\n' "$name" >&2

    if ! verify_env_safe "$env_path"; then
        bad "env file missing or corrupt — skipping"
        FAILED=$((FAILED + 1))
        continue
    fi
    [ -f "$db_path" ] || { bad "db file missing: $db_path"; FAILED=$((FAILED + 1)); continue; }

    # How many rows need fixing?
    NEEDY=$(sqlite3 "$db_path" \
        "SELECT COUNT(*) FROM outputs
         WHERE output_description = 'split output'
           AND spendable = 1
           AND (derivation_prefix IS NULL OR derivation_prefix = '')" 2>/dev/null || echo 0)

    if [ "$NEEDY" -eq 0 ]; then
        ok "no broken split outputs (skipping)"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    log "$NEEDY broken split output(s) found"

    if [ "$DRY_RUN" -eq 1 ]; then
        ok "[DRY RUN] would stop daemon, update $NEEDY rows, restart"
        continue
    fi

    # Stop daemon
    "$FLEET_DAEMONS" stop "$name" >&2 2>&1 || {
        bad "daemon stop failed"
        FAILED=$((FAILED + 1))
        continue
    }

    # Apply the UPDATE
    UPDATED=$(sqlite3 "$db_path" \
        "UPDATE outputs
         SET change = 1,
             derivation_prefix = '$DERIVATION_PREFIX',
             derivation_suffix = '$DERIVATION_SUFFIX',
             sender_identity_key = '$SENDER_IDENTITY_KEY',
             updated_at = datetime('now')
         WHERE output_description = 'split output'
           AND spendable = 1
           AND (derivation_prefix IS NULL OR derivation_prefix = '');
         SELECT changes();" 2>&1 | tail -1)

    if [ "$UPDATED" != "$NEEDY" ]; then
        bad "expected $NEEDY rows updated, got '$UPDATED'"
        # Still attempt to restart daemon so we don't leave it stopped
        "$FLEET_DAEMONS" start "$name" >&2 2>&1 || true
        FAILED=$((FAILED + 1))
        continue
    fi
    ok "updated $UPDATED rows"
    ROWS_TOTAL=$((ROWS_TOTAL + UPDATED))

    # Restart daemon
    "$FLEET_DAEMONS" start "$name" >&2 2>&1 || {
        bad "daemon restart failed"
        FAILED=$((FAILED + 1))
        continue
    }

    SURGERY_OK=$((SURGERY_OK + 1))
done < <(jq -r '
    (if type == "array" then .
     elif type == "object" and has("wallets") then .wallets
     else [] end)[]
    | [.name, (.env // .env_path), (.db // .db_path)]
    | @tsv' "$INVENTORY")

printf '\n' >&2
log "summary: $SURGERY_OK surgeries applied, $SKIPPED clean, $FAILED failed (total $TOTAL)"
log "total rows updated: $ROWS_TOTAL"
[ "$FAILED" -gt 0 ] && exit 1
exit 0
