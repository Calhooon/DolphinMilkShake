#!/usr/bin/env bash
#
# fund-wallet.sh -- bootstrap a receiving wallet from a source wallet.
#
# Performs the full pipeline:
#   1. get the receiver's BRC-29 receive address (CLI address --json)
#   2. send SATS from source to that address (CLI send --json) → captures BEEF
#   3. internalize the BEEF on the receiver (CLI fund <beef> --vout 0)
#   4. optionally split the new UTXO into N outputs for parallel headroom
#
# This was validated manually on 2026-04-14 during the E20d funding detour
# (3322 → 3323 +15M split 10-way; 3322 → 3324 +10M split 20-way). This
# script is that recipe, automated.
#
# Safe against running daemons: uses SQLite WAL via --db + ROOT_KEY env.
# Does NOT touch the daemon process, does NOT rekey, does NOT restart.
#
# Usage:
#   fund-wallet.sh <source_env> <source_db> <recv_env> <recv_db> <sats> [split_count]
#
# Example:
#   fund-wallet.sh \
#     ~/bsv/_archived/bsv-wallet-cli-old/.env \
#     ~/bsv/_archived/bsv-wallet-cli-old/wallet.db \
#     ~/bsv/wallets/synthesis-3323.env \
#     ~/bsv/wallets/synthesis-3323.db \
#     15000000 10
#
# Environment:
#   BIN   path to bsv-wallet binary (default: $HOME/bsv/bsv-wallet-cli/target/release/bsv-wallet)
#
# Exit codes:
#   0  success, balance increased by <sats>
#   1  usage error
#   2  missing binary
#   3  missing env or db file
#   4  send failed (broadcast error)
#   5  internalize failed (BEEF parse / fund accepted != true)
#   6  split failed (non-fatal, fund step still succeeded)

set -euo pipefail

BIN="${BIN:-$HOME/bsv/bsv-wallet-cli/target/release/bsv-wallet}"

# ---- color helpers ---------------------------------------------------------
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'
log()  { printf '%s[fund-wallet]%s %s\n' "$BLUE" "$NC" "$*" >&2; }
ok()   { printf '%s[ OK ]%s %s\n' "$GREEN" "$NC" "$*" >&2; }
warn() { printf '%s[WARN]%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
err()  { printf '%s[FAIL]%s %s\n' "$RED" "$NC" "$*" >&2; }

# ---- arg parse -------------------------------------------------------------
if [ $# -lt 5 ] || [ $# -gt 6 ]; then
    cat >&2 <<EOF
usage: $(basename "$0") <source_env> <source_db> <recv_env> <recv_db> <sats> [split_count]

  source_env     path to sender wallet .env file (must contain ROOT_KEY=...)
  source_db      path to sender wallet .db file
  recv_env       path to receiver wallet .env file (must contain ROOT_KEY=...)
  recv_db        path to receiver wallet .db file
  sats           amount to send in satoshis
  split_count    optional: split new UTXO into N outputs after internalize

example:
  $(basename "$0") \\
    ~/bsv/_archived/bsv-wallet-cli-old/.env \\
    ~/bsv/_archived/bsv-wallet-cli-old/wallet.db \\
    ~/bsv/wallets/synthesis-3323.env \\
    ~/bsv/wallets/synthesis-3323.db \\
    15000000 10
EOF
    exit 1
fi

SRC_ENV="$1"
SRC_DB="$2"
RECV_ENV="$3"
RECV_DB="$4"
SATS="$5"
SPLIT_COUNT="${6:-0}"

# ---- preflight -------------------------------------------------------------
[ -x "$BIN" ] || { err "bsv-wallet binary not found or not executable: $BIN"; exit 2; }
[ -f "$SRC_ENV" ] || { err "source env file not found: $SRC_ENV"; exit 3; }
[ -f "$SRC_DB" ] || { err "source db file not found: $SRC_DB"; exit 3; }
[ -f "$RECV_ENV" ] || { err "receiver env file not found: $RECV_ENV"; exit 3; }
[ -f "$RECV_DB" ] || { err "receiver db file not found: $RECV_DB"; exit 3; }

case "$SATS" in
    ''|*[!0-9]*) err "sats must be a positive integer: '$SATS'"; exit 1 ;;
esac
[ "$SATS" -ge 1 ] || { err "sats must be >= 1: '$SATS'"; exit 1; }

case "$SPLIT_COUNT" in
    ''|*[!0-9]*) err "split_count must be a non-negative integer: '$SPLIT_COUNT'"; exit 1 ;;
esac

# jq is used for parsing --json outputs; fail clearly if missing
command -v jq >/dev/null 2>&1 || {
    err "jq is required but not installed. Install with: brew install jq"
    exit 2
}

log "funding receiver with $SATS sats (split: $SPLIT_COUNT)"
log "  source db:   $SRC_DB"
log "  receiver db: $RECV_DB"

# ---- helper: run a bsv-wallet CLI command inside the wallet's env ---------
# Usage: run_cli <env_file> <db_path> <subcommand> [args...]
run_cli() {
    local env_file="$1"; local db_path="$2"; shift 2
    ( set +u; export $(grep -v '^\s*#' "$env_file" | xargs); \
      "$BIN" --db "$db_path" "$@" --json )
}

# ---- step 1: get receiver address ------------------------------------------
log "step 1/4 — get receive address"
RECV_ADDR_JSON="$(run_cli "$RECV_ENV" "$RECV_DB" address 2>&1 || true)"
RECV_ADDR="$(printf '%s' "$RECV_ADDR_JSON" | jq -r '.address // empty' 2>/dev/null)"
if [ -z "$RECV_ADDR" ]; then
    err "failed to get receive address from receiver wallet"
    err "cli output: $RECV_ADDR_JSON"
    exit 3
fi
ok "receive address: $RECV_ADDR"

# ---- step 1b: capture pre-balance so we can verify at the end --------------
SRC_BAL_BEFORE="$(run_cli "$SRC_ENV" "$SRC_DB" balance 2>/dev/null | jq -r '.satoshis // 0')"
RECV_BAL_BEFORE="$(run_cli "$RECV_ENV" "$RECV_DB" balance 2>/dev/null | jq -r '.satoshis // 0')"
log "pre-send: source=$SRC_BAL_BEFORE recv=$RECV_BAL_BEFORE"

# ---- step 2: send ----------------------------------------------------------
log "step 2/4 — send $SATS sats to $RECV_ADDR"
SEND_RAW="$(run_cli "$SRC_ENV" "$SRC_DB" send "$RECV_ADDR" "$SATS" 2>&1 || true)"
# The send output is noisy (log lines + JSON). Extract the JSON envelope.
SEND_JSON="$(printf '%s\n' "$SEND_RAW" | grep -oE '\{"beef":"[^"]+","txid":"[a-f0-9]+"\}' | tail -n 1 || true)"
if [ -z "$SEND_JSON" ]; then
    err "send did not return a BEEF+txid JSON"
    err "last 20 lines of output:"
    printf '%s\n' "$SEND_RAW" | tail -20 >&2
    exit 4
fi
TXID="$(printf '%s' "$SEND_JSON" | jq -r '.txid')"
BEEF="$(printf '%s' "$SEND_JSON" | jq -r '.beef')"
ok "broadcast: txid=$TXID"
log "beef length: ${#BEEF} chars"

# ---- step 3: internalize on receiver ---------------------------------------
log "step 3/4 — internalize BEEF on receiver (--vout 0)"
FUND_JSON="$(run_cli "$RECV_ENV" "$RECV_DB" fund "$BEEF" --vout 0 2>&1 || true)"
FUND_ACCEPTED="$(printf '%s' "$FUND_JSON" | jq -r '.accepted // false' 2>/dev/null)"
if [ "$FUND_ACCEPTED" != "true" ]; then
    err "internalize did not return accepted=true"
    err "cli output: $FUND_JSON"
    exit 5
fi
ok "receiver internalized"

# Verify balance
RECV_BAL_AFTER="$(run_cli "$RECV_ENV" "$RECV_DB" balance 2>/dev/null | jq -r '.satoshis // 0')"
DELTA=$(( RECV_BAL_AFTER - RECV_BAL_BEFORE ))
log "receiver balance: $RECV_BAL_BEFORE → $RECV_BAL_AFTER (delta +$DELTA)"

if [ "$DELTA" -ne "$SATS" ]; then
    warn "balance delta ($DELTA) does not exactly match sent amount ($SATS)"
    warn "this can happen if the daemon's monitor also caught the output;"
    warn "if delta is 2x sats, you may have a double-count — investigate"
fi

# ---- step 4: optional split ------------------------------------------------
if [ "$SPLIT_COUNT" -gt 0 ]; then
    log "step 4/4 — split new UTXO into $SPLIT_COUNT outputs"
    SPLIT_RAW="$(run_cli "$RECV_ENV" "$RECV_DB" split --count "$SPLIT_COUNT" 2>&1 || true)"
    # Extract the JSON envelope — CLI mixes log lines (WARN/INFO) with JSON
    SPLIT_JSON_LINE="$(printf '%s\n' "$SPLIT_RAW" | grep -oE '\{"outputs":[0-9]+[^}]*\}' | tail -n 1)"
    if [ -z "$SPLIT_JSON_LINE" ]; then
        warn "split did not return a JSON envelope"
        warn "last 10 lines of output:"
        printf '%s\n' "$SPLIT_RAW" | tail -10 >&2
        exit 6
    fi
    SPLIT_OUT="$(printf '%s' "$SPLIT_JSON_LINE" | jq -r '.outputs // empty')"
    SPLIT_TXID="$(printf '%s' "$SPLIT_JSON_LINE" | jq -r '.txid // empty')"
    if [ "$SPLIT_OUT" != "$SPLIT_COUNT" ]; then
        warn "split output count mismatch (want=$SPLIT_COUNT got='$SPLIT_OUT')"
        exit 6
    fi
    ok "split complete: $SPLIT_OUT outputs, txid=$SPLIT_TXID"
else
    log "step 4/4 — skipped (no split requested)"
fi

# ---- summary ---------------------------------------------------------------
SRC_BAL_AFTER="$(run_cli "$SRC_ENV" "$SRC_DB" balance 2>/dev/null | jq -r '.satoshis // 0')"
RECV_BAL_FINAL="$(run_cli "$RECV_ENV" "$RECV_DB" balance 2>/dev/null | jq -r '.satoshis // 0')"

cat >&2 <<EOF

${GREEN}=== fund complete ===${NC}
  tx:           $TXID
  sats sent:    $SATS
  split count:  $SPLIT_COUNT

  source:       $SRC_BAL_BEFORE → $SRC_BAL_AFTER ($(( SRC_BAL_AFTER - SRC_BAL_BEFORE )) net)
  receiver:     $RECV_BAL_BEFORE → $RECV_BAL_FINAL (+$(( RECV_BAL_FINAL - RECV_BAL_BEFORE )) net)

EOF

# Machine-readable output on stdout for scripting consumers
jq -nc \
    --arg txid "$TXID" \
    --argjson sats "$SATS" \
    --argjson split "$SPLIT_COUNT" \
    --argjson src_before "$SRC_BAL_BEFORE" \
    --argjson src_after "$SRC_BAL_AFTER" \
    --argjson recv_before "$RECV_BAL_BEFORE" \
    --argjson recv_after "$RECV_BAL_FINAL" \
    '{txid: $txid, sats: $sats, split: $split,
      source: {before: $src_before, after: $src_after},
      receiver: {before: $recv_before, after: $recv_after}}'
