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

# ---- N×send loop ----------------------------------------------------------
#
# CRITICAL CHANGE 2026-04-15: the old behavior was "1 big send + receiver
# splits the new UTXO". But `bsv-wallet split` consumes the WHOLE wallet
# (all existing UTXOs) and recreates N new ones — which is destructive
# when the receiver wallet is in use, AND fails on SQLite contention,
# AND doesn't actually split JUST the new UTXO we sent.
#
# New behavior: SENDER does the split. We do N small sends of (SATS/N)
# each. Each send creates exactly ONE fresh UTXO at the receiver. The
# receiver's existing UTXOs are NEVER touched. In-flight x402 calls
# on the receiver continue uninterrupted. There is no consolidation.
#
# Cost: N transaction fees instead of 1. At ~60 sats/tx, 30 splits =
# 1800 sats overhead — negligible.
#
# Backwards compat: SPLIT_COUNT=0 keeps the old "1 send" behavior.
if [ "$SPLIT_COUNT" -le 1 ]; then
    NUM_SENDS=1
    SEND_AMOUNT=$SATS
else
    NUM_SENDS=$SPLIT_COUNT
    SEND_AMOUNT=$(( SATS / SPLIT_COUNT ))
    if [ "$SEND_AMOUNT" -lt 1000 ]; then
        warn "per-send amount ($SEND_AMOUNT sats) is very small; using 1000 minimum"
        SEND_AMOUNT=1000
    fi
fi

log "step 2 — sending $NUM_SENDS × $SEND_AMOUNT sats to $RECV_ADDR (sender-side split)"

LAST_TXID=""
SUCCESSFUL_SENDS=0
TOTAL_SENT=0
for i in $(seq 1 $NUM_SENDS); do
    # Retry up to 3 times on SQLite lock contention. The master daemon's
    # own background work occasionally collides with our send command's
    # SQLite writes — retrying after a backoff almost always succeeds.
    SEND_JSON=""
    for attempt in 1 2 3; do
        SEND_RAW="$(run_cli "$SRC_ENV" "$SRC_DB" send "$RECV_ADDR" "$SEND_AMOUNT" 2>&1 || true)"
        SEND_JSON="$(printf '%s\n' "$SEND_RAW" | grep -oE '\{"beef":"[^"]+","txid":"[a-f0-9]+"\}' | tail -n 1 || true)"
        [ -n "$SEND_JSON" ] && break
        if printf '%s' "$SEND_RAW" | grep -q "database is locked\|SQLx error"; then
            sleep $((attempt))
            continue
        fi
        break
    done
    if [ -z "$SEND_JSON" ]; then
        warn "send $i/$NUM_SENDS failed after retries (no BEEF+txid JSON)"
        warn "last 5 lines of output:"
        printf '%s\n' "$SEND_RAW" | tail -5 >&2
        continue
    fi
    TXID_I="$(printf '%s' "$SEND_JSON" | jq -r '.txid')"
    BEEF_I="$(printf '%s' "$SEND_JSON" | jq -r '.beef')"

    # Internalize on receiver
    FUND_JSON="$(run_cli "$RECV_ENV" "$RECV_DB" fund "$BEEF_I" --vout 0 2>&1 || true)"
    FUND_ACCEPTED="$(printf '%s' "$FUND_JSON" | jq -r '.accepted // false' 2>/dev/null)"
    if [ "$FUND_ACCEPTED" != "true" ]; then
        warn "send $i internalize failed for txid $TXID_I"
        warn "cli output: $FUND_JSON"
        continue
    fi

    LAST_TXID="$TXID_I"
    SUCCESSFUL_SENDS=$((SUCCESSFUL_SENDS + 1))
    TOTAL_SENT=$((TOTAL_SENT + SEND_AMOUNT))

    if [ "$NUM_SENDS" -gt 1 ]; then
        printf '  %s[%d/%d]%s sent %d sats → %s\n' "$BLUE" "$i" "$NUM_SENDS" "$NC" "$SEND_AMOUNT" "${TXID_I:0:16}..." >&2
        # Inter-send pause to avoid SQLite lock contention on the source
        # wallet daemon. Without this, rapid back-to-back sends race the
        # daemon's own writes and ~10-20% fail with "database is locked".
        # 600ms is empirically enough to clear locks; total cost for
        # N=30 splits is 18s extra which is negligible.
        sleep 0.6
    fi
done

if [ "$SUCCESSFUL_SENDS" -eq 0 ]; then
    err "all $NUM_SENDS sends failed"
    exit 4
fi
TXID="$LAST_TXID"
ok "completed $SUCCESSFUL_SENDS/$NUM_SENDS sends, total $TOTAL_SENT sats"

# Verify final balance
RECV_BAL_AFTER="$(run_cli "$RECV_ENV" "$RECV_DB" balance 2>/dev/null | jq -r '.satoshis // 0')"
DELTA=$(( RECV_BAL_AFTER - RECV_BAL_BEFORE ))
log "receiver balance: $RECV_BAL_BEFORE → $RECV_BAL_AFTER (delta +$DELTA)"

if [ "$DELTA" -lt $(( TOTAL_SENT - 100 )) ]; then
    warn "delta ($DELTA) less than sent ($TOTAL_SENT) by more than 100 sats"
    warn "some sends may have landed but failed to internalize"
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
