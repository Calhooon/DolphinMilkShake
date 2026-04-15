#!/usr/bin/env bash
#
# preflight-certs.sh -- boot every lane's cluster, verify BRC-52 certs, tear down.
#
# Runs fleet-cycle.sh with PREFLIGHT_CERTS_ONLY=1, which makes each lane-cycle.js
# short-circuit right after startCluster() succeeds. startCluster's step 5 does
# the cert audit (GET /certificates on each agent, verify declared capabilities
# are covered) and throws if any cert is missing or has wrong caps. If all 60
# agents (20 lanes × 3 roles) boot successfully, the preflight passes.
#
# Zero on-chain spend: no cycles run, no proofs created, no LLM calls.
#
# Runtime: ~90-120s (dominated by 60 dolphin-milk daemon boots + 60s cert
# audit window). With LAUNCH_STAGGER_SEC=10, 20 lanes stagger over ~200s so
# boot contention is low.
#
# Usage:
#   ./scripts/preflight-certs.sh                 # full 20-lane preflight
#   LAUNCH_STAGGER_SEC=5 ./scripts/preflight-certs.sh  # faster, more contention
#
# Exit code mirrors fleet-cycle.sh: 0 = all passed, non-zero = at least one
# lane failed cert audit. Per-lane pass/fail is visible in the main log and
# in /tmp/dolphinsense-fleet-runs/<timestamp>/lane-*.log.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

printf '%s[preflight-certs]%s booting all lanes with PREFLIGHT_CERTS_ONLY=1\n' "$BLUE" "$NC" >&2

export PREFLIGHT_CERTS_ONLY=1
export SOAK_CYCLES=1  # lane-cycle.js short-circuits before the cycle loop anyway

if "$SCRIPT_DIR/fleet-cycle.sh" "$@"; then
    printf '\n%s[preflight-certs] ✓ ALL LANES PASSED CERT AUDIT%s\n' "$GREEN" "$NC" >&2
    exit 0
else
    ec=$?
    printf '\n%s[preflight-certs] ✗ at least one lane failed cert audit (exit %d)%s\n' "$RED" "$ec" "$NC" >&2
    printf '   inspect /tmp/dolphinsense-fleet-runs/<latest>/lane-*.log for details\n' >&2
    exit $ec
fi
