#!/usr/bin/env bash
# register.sh -- Register all agents on the BSV overlay network
#
# Each agent submits a PushDrop transaction to tm_agent, making it
# discoverable by other agents via ls_agent lookups.
#
# This script is a placeholder until dolphin-milk#309 (overlay integration)
# is implemented. Once that lands, agents will self-register on startup.
#
# Usage:
#   ./scripts/register.sh          # Register all agents
#   ./scripts/register.sh captain  # Register only Captain

set -euo pipefail

OVERLAY_URL="https://rust-overlay.dev-a3e.workers.dev"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[register]${NC} $1"; }
ok()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

# Agent definitions
declare -A AGENT_ENDPOINTS AGENT_CAPABILITIES

AGENT_ENDPOINTS=(
    [captain]="http://localhost:3001"
    [coral]="http://localhost:3002"
    [reef]="http://localhost:3003"
    [pearl]="http://localhost:3004"
)

AGENT_CAPABILITIES=(
    [captain]='["research-orchestration","task-delegation","synthesis","peer-discovery"]'
    [coral]='["web-scraping","data-collection","source-finding","content-extraction"]'
    [reef]='["data-analysis","pattern-recognition","statistical-reasoning","summarization"]'
    [pearl]='["content-creation","report-writing","visualization","editing"]'
)

# Check overlay health
check_overlay() {
    log "Checking overlay health..."
    local health
    health=$(curl -sf "${OVERLAY_URL}/health" 2>/dev/null) || {
        err "Overlay is not responding at ${OVERLAY_URL}"
        exit 1
    }
    ok "Overlay is healthy: $health"
}

# Register a single agent
# NOTE: This is a stub. Full registration requires:
#   1. Agent creates a PushDrop transaction with fields:
#      [identity_key, endpoint, capabilities_json, agent_name, version]
#   2. Agent wraps it in a BEEF envelope
#   3. POST /submit with topic=tm_agent and the BEEF tx
#
# Until dolphin-milk#309 is implemented, this script verifies the agent
# is running and prints what the registration payload WOULD look like.
register_agent() {
    local name="$1"
    local endpoint="${AGENT_ENDPOINTS[$name]}"
    local capabilities="${AGENT_CAPABILITIES[$name]}"

    log "Registering $name..."

    # Verify agent is running
    if ! curl -sf "${endpoint}/health" > /dev/null 2>&1; then
        err "$name is not responding at ${endpoint} -- start it first with ./scripts/launch.sh"
        return 1
    fi

    # Get agent's identity key from its wallet
    local identity_key
    identity_key=$(curl -sf "${endpoint}/status" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('identity_key', 'unknown'))
" 2>/dev/null) || identity_key="unknown"

    log "$name identity key: $identity_key"
    log "$name endpoint: $endpoint"
    log "$name capabilities: $capabilities"

    # TODO (dolphin-milk#309): Replace this with actual PushDrop registration
    # The registration transaction should contain:
    #   Field 0: identity_key (33 bytes, compressed pubkey)
    #   Field 1: endpoint URL (UTF-8)
    #   Field 2: capabilities (JSON array, UTF-8)
    #   Field 3: agent_name (UTF-8)
    #   Field 4: version ("1.0.0")
    #
    # Submit via: POST ${OVERLAY_URL}/submit
    #   Content-Type: application/octet-stream
    #   X-Topics: tm_agent
    #   Body: BEEF-encoded transaction

    warn "$name: Registration stub -- full PushDrop registration requires dolphin-milk#309"
    ok "$name: Would register at ${OVERLAY_URL} with tm_agent topic"
}

# Discover registered agents
discover_agents() {
    log "Discovering agents on overlay..."

    # Query ls_agent for all registered agents
    local result
    result=$(curl -sf -X POST "${OVERLAY_URL}/lookup" \
        -H "Content-Type: application/json" \
        -d '{"service":"ls_agent","query":{}}' 2>/dev/null) || {
        warn "No agents registered on overlay yet (or ls_agent not configured)"
        return 0
    }

    ok "Discovered agents:"
    echo "$result" | python3 -m json.tool 2>/dev/null || echo "$result"
}

# Main
check_overlay

case "${1:-all}" in
    all)
        log "Registering all agents..."
        for name in captain coral reef pearl; do
            register_agent "$name" || true
        done
        echo ""
        discover_agents
        ;;
    discover)
        discover_agents
        ;;
    captain|coral|reef|pearl)
        register_agent "$1"
        ;;
    *)
        echo "Usage: $0 [all|discover|captain|coral|reef|pearl]"
        exit 1
        ;;
esac
