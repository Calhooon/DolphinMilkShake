#!/bin/bash
# proof_batch.sh — per-record OP_RETURN provenance proof creator (xargs -P 8)
# Usage: proof_batch.sh <wallet_url> <records_jsonl> [parallelism]
#
# Uses xargs -P N for real kernel-level concurrency. macOS /bin/bash is 3.2
# (2007) which does NOT support `wait -n` — the old background-job pool
# degraded to serial-batches-of-8. xargs -P is supported on macOS natively.
# This script re-invokes itself via --worker per line number to avoid
# JSON-quote escaping; each worker sed-extracts its own record.
set -u

# ---- WORKER MODE ----
if [ "${1:-}" = "--worker" ]; then
  shift
  WALLET_URL="$1"; RECORDS_FILE="$2"; LINE="$3"
  TXID_FILE="${RECORDS_FILE}.txids"
  ERR_FILE="${RECORDS_FILE}.errors"
  record=$(sed -n "${LINE}p" "$RECORDS_FILE")
  [ -z "$record" ] && exit 0
  HASH=$(printf '%s' "$record" | shasum -a 256 | cut -d' ' -f1)
  if [ -z "$HASH" ]; then
    printf 'hash-fail\n' >> "$ERR_FILE"
    exit 0
  fi
  LOCKING="006a20${HASH}"
  # acceptDelayedBroadcast=false forces synchronous broadcast — the wallet
  # waits for the broadcast to complete (or fail) before returning, instead of
  # queuing internally with status="sending". E16 confirmed: without this, txs
  # showed status=completed in listActions but never appeared on WoC because
  # broadcast was queued and never fired during sustained load.
  RESULT=$(curl -sS --max-time 30 -X POST "${WALLET_URL}/createAction" \
    -H "Origin: ${WALLET_URL}" \
    -H 'Content-Type: application/json' \
    -d "{\"description\":\"dolphinsense provenance\",\"outputs\":[{\"lockingScript\":\"${LOCKING}\",\"satoshis\":0,\"outputDescription\":\"record proof\"}],\"options\":{\"acceptDelayedBroadcast\":false}}" 2>/dev/null)
  TXID=$(printf '%s' "$RESULT" | jq -r '.txid // empty' 2>/dev/null)
  if [ -n "$TXID" ] && [ "$TXID" != "null" ]; then
    printf '%s\n' "$TXID" >> "$TXID_FILE"
  else
    printf 'curl-fail\n' >> "$ERR_FILE"
  fi
  exit 0
fi

# ---- MAIN MODE ----
WALLET_URL="${1:-}"
RECORDS_FILE="${2:-}"
# E15 finding: wallet 3324 rejects 96/100 createActions at P=8 (parallel
# contention). Single serial calls succeed reliably. Default to P=1 until
# the wallet can be confirmed safe for higher parallelism. Override with
# the third argument if testing parallel.
PARALLELISM="${3:-1}"
if [ -z "$WALLET_URL" ] || [ -z "$RECORDS_FILE" ]; then
  echo '{"error":"usage: proof_batch.sh <wallet_url> <records_jsonl> [parallelism]"}'
  exit 1
fi
if [ ! -f "$RECORDS_FILE" ]; then
  echo "{\"error\":\"records file not found: $RECORDS_FILE\"}"
  exit 1
fi

TXID_FILE="${RECORDS_FILE}.txids"
ERR_FILE="${RECORDS_FILE}.errors"
: > "$TXID_FILE"
: > "$ERR_FILE"

N_RECORDS=$(wc -l < "$RECORDS_FILE" | tr -d ' ')
SCRIPT_PATH="$0"

# xargs -P N: kernel-level concurrent subprocess spawning. Each subprocess
# receives a line number and sed-extracts its own record. POSIX O_APPEND
# writes < PIPE_BUF are atomic so sidecar appends don't tear.
seq 1 "$N_RECORDS" | xargs -n 1 -P "$PARALLELISM" -I LINE \
  bash "$SCRIPT_PATH" --worker "$WALLET_URL" "$RECORDS_FILE" LINE

CREATED=$(wc -l < "$TXID_FILE" | tr -d ' ')
ERRORS=$(wc -l < "$ERR_FILE" | tr -d ' ')
FIRST=$(head -n 1 "$TXID_FILE" 2>/dev/null)
LAST=$(tail -n 1 "$TXID_FILE" 2>/dev/null)
MANIFEST_SHA=$(shasum -a 256 "$TXID_FILE" | cut -d' ' -f1)

printf '{"proofs_created":%d,"errors":%d,"txid_file":"%s","first_txid":"%s","last_txid":"%s","manifest_sha256":"%s","parallelism":%d}\n' \
  "$CREATED" "$ERRORS" "$TXID_FILE" "$FIRST" "$LAST" "$MANIFEST_SHA" "$PARALLELISM"
