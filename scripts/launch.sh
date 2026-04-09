#!/usr/bin/env bash
# launch.sh -- Start all 4 DolphinMilkShake agents
#
# Each agent runs as a separate rust-bsv-worm instance with its own:
#   - Config file (agents/*.toml)
#   - Wallet (unique port)
#   - Server port
#   - Data directory
#
# Usage:
#   ./scripts/launch.sh          # Start all agents
#   ./scripts/launch.sh captain  # Start only Captain
#
# Prerequisites:
#   - rust-bsv-worm binary (dolphin-milk) in PATH
#   - bsv-wallet binary in PATH
#   - Each agent's data dir initialized (dolphin-milk init --data-dir ...)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Agent definitions: name, server_port, wallet_port, data_dir
declare -A AGENTS
AGENTS=(
    [captain]="3001:3322:~/.dolphin-milk-captain"
    [coral]="3002:3323:~/.dolphin-milk-coral"
    [reef]="3003:3324:~/.dolphin-milk-reef"
    [pearl]="3004:3325:~/.dolphin-milk-pearl"
)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[DolphinMilkShake]${NC} $1"; }
ok()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

# Expand tilde in paths
expand_path() {
    echo "${1/#\~/$HOME}"
}

# Check if a port is in use
port_in_use() {
    lsof -i ":$1" >/dev/null 2>&1
}

# Start a single agent
start_agent() {
    local name="$1"
    local config="${AGENTS[$name]}"
    local server_port wallet_port data_dir

    IFS=':' read -r server_port wallet_port data_dir <<< "$config"
    data_dir="$(expand_path "$data_dir")"

    log "Starting $name (server=$server_port, wallet=$wallet_port, data=$data_dir)"

    # Check if ports are already in use
    if port_in_use "$server_port"; then
        warn "$name server port $server_port already in use -- skipping"
        return 1
    fi
    if port_in_use "$wallet_port"; then
        warn "$name wallet port $wallet_port already in use -- skipping"
        return 1
    fi

    # Initialize data dir if needed
    if [ ! -d "$data_dir" ]; then
        log "Initializing data directory for $name..."
        dolphin-milk init --data-dir "$data_dir"
    fi

    # Copy agent config into place
    local config_file="$PROJECT_DIR/agents/${name}.toml"
    if [ ! -f "$config_file" ]; then
        err "Config file not found: $config_file"
        return 1
    fi
    cp "$config_file" "$data_dir/dolphin-milk.toml"

    # Copy system prompt into place
    local prompt_file="$PROJECT_DIR/prompts/${name}.md"
    if [ -f "$prompt_file" ]; then
        mkdir -p "$data_dir/workspace"
        cp "$prompt_file" "$data_dir/workspace/SYSTEM_PROMPT.md"
    fi

    # Start the agent (dolphin-milk start launches wallet + server)
    log "Launching $name..."
    DOLPHIN_MILK_DATA_DIR="$data_dir" \
        dolphin-milk start --port "$server_port" \
        > "$data_dir/agent.log" 2>&1 &

    local pid=$!
    echo "$pid" > "$data_dir/agent.pid"
    ok "$name started (PID $pid)"
}

# Stop a single agent
stop_agent() {
    local name="$1"
    local config="${AGENTS[$name]}"
    local data_dir

    IFS=':' read -r _ _ data_dir <<< "$config"
    data_dir="$(expand_path "$data_dir")"

    local pidfile="$data_dir/agent.pid"
    if [ -f "$pidfile" ]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid"
            ok "Stopped $name (PID $pid)"
        else
            warn "$name (PID $pid) was not running"
        fi
        rm -f "$pidfile"
    else
        warn "No PID file for $name"
    fi
}

# Health check
check_agent() {
    local name="$1"
    local config="${AGENTS[$name]}"
    local server_port

    IFS=':' read -r server_port _ _ <<< "$config"

    if curl -sf "http://localhost:${server_port}/health" > /dev/null 2>&1; then
        ok "$name is healthy (port $server_port)"
    else
        err "$name is NOT responding (port $server_port)"
    fi
}

# Main
case "${1:-all}" in
    all)
        log "Starting all agents..."
        for name in captain coral reef pearl; do
            start_agent "$name" || true
        done
        log "Waiting 5 seconds for agents to initialize..."
        sleep 5
        log "Health check:"
        for name in captain coral reef pearl; do
            check_agent "$name"
        done
        ;;
    stop)
        log "Stopping all agents..."
        for name in captain coral reef pearl; do
            stop_agent "$name"
        done
        ;;
    status)
        log "Agent status:"
        for name in captain coral reef pearl; do
            check_agent "$name"
        done
        ;;
    captain|coral|reef|pearl)
        start_agent "$1"
        ;;
    *)
        echo "Usage: $0 [all|stop|status|captain|coral|reef|pearl]"
        exit 1
        ;;
esac
