#!/bin/bash
# Wallet throughput benchmark — POC #11
# Creates OP_RETURN txs (0-sat, miner-fee only) and measures tx/s

WALLET_URL="http://localhost:3322"
TX_COUNT=${1:-1000}
BATCH_SIZE=100

echo "=== Wallet Throughput Benchmark ==="
echo "Target: ${TX_COUNT} OP_RETURN txs against ${WALLET_URL}"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Check wallet health first
BALANCE=$(curl -s "${WALLET_URL}/balance" 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "ERROR: wallet not reachable at ${WALLET_URL}"
  exit 1
fi
echo "Wallet balance before: ${BALANCE}"
echo ""

TOTAL_SUCCESS=0
TOTAL_FAIL=0
START_TIME=$(date +%s%N)

for batch in $(seq 1 $((TX_COUNT / BATCH_SIZE))); do
  BATCH_START=$(date +%s%N)
  BATCH_OK=0
  BATCH_FAIL=0

  for i in $(seq 1 ${BATCH_SIZE}); do
    SEQ=$(( (batch - 1) * BATCH_SIZE + i ))
    HASH=$(printf '%064x' ${SEQ})
    RESULT=$(curl -s -w "\n%{http_code}" -X POST "${WALLET_URL}/createAction" \
      -H 'Content-Type: application/json' \
      -H "Origin: ${WALLET_URL}" \
      -d "{\"description\":\"benchmark proof ${SEQ}\",\"outputs\":[{\"lockingScript\":\"006a20${HASH}\",\"satoshis\":0,\"outputDescription\":\"benchmark proof\"}]}" 2>/dev/null)

    HTTP_CODE=$(echo "$RESULT" | tail -1)
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
      BATCH_OK=$((BATCH_OK + 1))
    else
      BATCH_FAIL=$((BATCH_FAIL + 1))
    fi
  done

  BATCH_END=$(date +%s%N)
  BATCH_MS=$(( (BATCH_END - BATCH_START) / 1000000 ))
  BATCH_TPS=$(echo "scale=1; ${BATCH_SIZE} * 1000 / ${BATCH_MS}" | bc 2>/dev/null || echo "?")
  TOTAL_SUCCESS=$((TOTAL_SUCCESS + BATCH_OK))
  TOTAL_FAIL=$((TOTAL_FAIL + BATCH_FAIL))

  echo "Batch ${batch}: ${BATCH_OK}/${BATCH_SIZE} ok, ${BATCH_MS}ms, ${BATCH_TPS} tx/s"
done

END_TIME=$(date +%s%N)
TOTAL_MS=$(( (END_TIME - START_TIME) / 1000000 ))
TOTAL_TPS=$(echo "scale=2; ${TOTAL_SUCCESS} * 1000 / ${TOTAL_MS}" | bc 2>/dev/null || echo "?")

echo ""
echo "=== Results ==="
echo "Total txs: ${TOTAL_SUCCESS} success, ${TOTAL_FAIL} failed"
echo "Total time: ${TOTAL_MS}ms"
echo "Throughput: ${TOTAL_TPS} tx/s"
echo ""

# Check wallet health after
BALANCE_AFTER=$(curl -s "${WALLET_URL}/balance" 2>/dev/null)
echo "Wallet balance after: ${BALANCE_AFTER}"
echo "Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
