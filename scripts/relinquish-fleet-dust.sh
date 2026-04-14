#!/usr/bin/env bash
#
# relinquish-fleet-dust.sh -- sweep sub-dust UTXOs from every fleet wallet.
#
# Context: fund-wallet.sh's send→fund→split flow leaves a small (~36 sat)
# untagged dust output in some wallets as a side-effect of how bsv-wallet-cli's
# BRC-29 receive path tracks payment markers. Dolphin-milk's overlay
# registration createAction selects the smallest available UTXO first and
# fails with "Insufficient funds: need 45, have 36" when it picks the dust.
#
# This script iterates every wallet in the fleet inventory and calls
# /relinquishOutput on any UTXO below the DUST_THRESHOLD. Relinquishing
# marks the output unspendable; the funds are effectively abandoned but
# they're dust anyway.
#
# Safe to run repeatedly (idempotent — no dust = no action).
#
# Usage:
#   ./scripts/relinquish-fleet-dust.sh [--dust-threshold N] [--inventory PATH]
#
# Default: threshold=1000 sats (anything smaller is swept).

set -euo pipefail

DUST_THRESHOLD="${DUST_THRESHOLD:-1000}"
INVENTORY="${INVENTORY:-$HOME/bsv/wallets/fleet/INVENTORY.json}"
BIN="${BIN:-$HOME/bsv/bsv-wallet-cli/target/release/bsv-wallet}"

while [ $# -gt 0 ]; do
    case "$1" in
        --dust-threshold) DUST_THRESHOLD="$2"; shift 2 ;;
        --inventory) INVENTORY="$2"; shift 2 ;;
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
log()  { printf '%s[relinquish-dust]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$NC" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { bad "jq required"; exit 1; }
[ -x "$BIN" ] || { bad "bsv-wallet binary not found: $BIN"; exit 1; }
[ -f "$INVENTORY" ] || { bad "inventory missing: $INVENTORY"; exit 1; }

log "threshold: $DUST_THRESHOLD sats"
log "inventory: $INVENTORY"

TOTAL=0
SWEPT=0
SKIPPED=0
FAILED=0

while IFS=$'\t' read -r name env_path db_path wallet_port; do
    [ -z "$name" ] && continue
    TOTAL=$((TOTAL + 1))

    # List outputs and find dust
    dust_json=$( ( set +u; export $(grep -v '^\s*#' "$env_path" | xargs); \
                  "$BIN" --db "$db_path" outputs --json 2>/dev/null ) \
               | jq --argjson t "$DUST_THRESHOLD" \
                    '.outputs[] | select(.satoshis < $t) | {outpoint, satoshis}' 2>/dev/null || true )

    if [ -z "$dust_json" ]; then
        ok "$name: no dust"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Walk each dust output and relinquish it
    dust_count=$(printf '%s' "$dust_json" | jq -s 'length')
    printf '\n[%s] %d dust UTXO(s) found\n' "$name" "$dust_count" >&2

    while IFS=$'\t' read -r outpoint sats; do
        [ -z "$outpoint" ] && continue
        resp=$(curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' \
              -H "Origin: http://localhost:$wallet_port" \
              -d "$(jq -nc --arg op "$outpoint" '{basket: "default", output: $op}')" \
              "http://localhost:$wallet_port/relinquishOutput" 2>&1)
        if printf '%s' "$resp" | jq -e '.relinquished == true' >/dev/null 2>&1; then
            ok "relinquished $outpoint ($sats sats)"
            SWEPT=$((SWEPT + 1))
        else
            bad "relinquish failed for $outpoint: $resp"
            FAILED=$((FAILED + 1))
        fi
    done < <(printf '%s' "$dust_json" | jq -sr '.[] | [.outpoint, .satoshis] | @tsv')
done < <(jq -r '
    (if type == "array" then .
     elif type == "object" and has("wallets") then .wallets
     else [] end)[]
    | [.name, (.env // .env_path), (.db // .db_path), .wallet_port]
    | @tsv' "$INVENTORY")

printf '\n' >&2
log "summary: $SWEPT dust outputs relinquished, $SKIPPED wallets clean, $FAILED failures (total $TOTAL wallets)"
[ "$FAILED" -gt 0 ] && exit 1
exit 0
