#!/usr/bin/env bash
# launch.sh -- Start the DolphinSense agent pod
#
# Launches 4 rust-bsv-worm instances (Captain, Coral, Reef, Pearl) with
# their own wallets, ports, configs, and system prompts.
#
# Usage:
#   ./scripts/launch.sh              # Start all agents
#   ./scripts/launch.sh captain      # Start only Captain
#   ./scripts/launch.sh stop         # Stop all agents
#   ./scripts/launch.sh status       # Health-check all agents
#   ./scripts/launch.sh fund         # Show wallet addresses for funding
#   ./scripts/launch.sh logs captain # Tail Captain's logs
#
# Prerequisites:
#   - dolphin-milk binary in PATH (from rust-bsv-worm)
#   - bsv-wallet binary in PATH
#   - Python 3 for the classifier (tools/classifier.py)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OVERLAY_URL="https://rust-overlay.dev-a3e.workers.dev"

# Agent definitions: name:server_port:wallet_port:data_dir
declare -A AGENTS
AGENTS=(
    [captain]="3001:3322:~/.dolphin-milk-captain"
    [coral]="3002:3323:~/.dolphin-milk-coral"
    [reef]="3003:3324:~/.dolphin-milk-reef"
    [pearl]="3004:3325:~/.dolphin-milk-pearl"
)

AGENT_ORDER=(captain coral reef pearl)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${BLUE}[DolphinSense]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

expand_path() { echo "${1/#\~/$HOME}"; }

port_in_use() { lsof -i ":$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

preflight() {
    log "Running pre-flight checks..."
    local ok_count=0
    local fail_count=0

    # Check dolphin-milk binary
    if command -v dolphin-milk >/dev/null 2>&1; then
        ok "dolphin-milk binary found: $(which dolphin-milk)"
        ((ok_count++))
    else
        err "dolphin-milk binary not found in PATH"
        err "Build it: cd ~/bsv/rust-bsv-worm && cargo build --release"
        ((fail_count++))
    fi

    # Check bsv-wallet binary
    if command -v bsv-wallet >/dev/null 2>&1; then
        ok "bsv-wallet binary found: $(which bsv-wallet)"
        ((ok_count++))
    else
        warn "bsv-wallet binary not found -- wallet may be embedded in dolphin-milk"
        ((ok_count++))
    fi

    # Check Python 3 (for classifier)
    if command -v python3 >/dev/null 2>&1; then
        ok "python3 found: $(python3 --version)"
        ((ok_count++))
    else
        warn "python3 not found -- Reef's rule engine will not work"
        ((fail_count++))
    fi

    # Check classifier script
    if [ -f "$PROJECT_DIR/tools/classifier.py" ]; then
        ok "classifier.py found"
        ((ok_count++))
    else
        err "classifier.py not found at $PROJECT_DIR/tools/classifier.py"
        ((fail_count++))
    fi

    # Test classifier
    if command -v python3 >/dev/null 2>&1 && [ -f "$PROJECT_DIR/tools/classifier.py" ]; then
        local test_result
        test_result=$(echo '{"title":"Bitcoin is great","content":"BSV is amazing","source":"reddit","record_id":"test-1"}' | python3 "$PROJECT_DIR/tools/classifier.py" 2>&1) || true
        if echo "$test_result" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
            ok "classifier.py produces valid JSON"
            ((ok_count++))
        else
            warn "classifier.py output is not valid JSON"
        fi
    fi

    # Check overlay health
    if curl -sf "${OVERLAY_URL}/health" > /dev/null 2>&1; then
        ok "Overlay is healthy at ${OVERLAY_URL}"
        ((ok_count++))
    else
        warn "Overlay not responding at ${OVERLAY_URL}"
    fi

    # Check seeds file
    if [ -f "$PROJECT_DIR/seeds/questions.json" ]; then
        local q_count
        q_count=$(python3 -c "import json; print(len(json.load(open('$PROJECT_DIR/seeds/questions.json'))['questions']))" 2>/dev/null) || q_count="?"
        ok "Research questions loaded: ${q_count} seeds"
        ((ok_count++))
    else
        warn "seeds/questions.json not found"
    fi

    echo ""
    log "Pre-flight: ${ok_count} passed, ${fail_count} failed"
    if [ "$fail_count" -gt 0 ]; then
        err "Fix the above errors before launching"
        return 1
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Agent lifecycle
# ---------------------------------------------------------------------------

init_agent() {
    local name="$1"
    local config="${AGENTS[$name]}"
    local server_port wallet_port data_dir
    IFS=':' read -r server_port wallet_port data_dir <<< "$config"
    data_dir="$(expand_path "$data_dir")"

    if [ ! -d "$data_dir" ]; then
        log "Initializing $name data directory at $data_dir..."
        dolphin-milk init --data-dir "$data_dir"
    fi

    # Copy agent config
    local config_file="$PROJECT_DIR/agents/${name}.toml"
    if [ -f "$config_file" ]; then
        cp "$config_file" "$data_dir/dolphin-milk.toml"
    else
        err "Config not found: $config_file"
        return 1
    fi

    # Copy system prompt
    local prompt_file="$PROJECT_DIR/prompts/${name}.md"
    if [ -f "$prompt_file" ]; then
        mkdir -p "$data_dir/workspace"
        cp "$prompt_file" "$data_dir/workspace/SYSTEM_PROMPT.md"
    fi

    # Copy seeds and tools into Captain's workspace
    if [ "$name" = "captain" ]; then
        if [ -f "$PROJECT_DIR/seeds/questions.json" ]; then
            cp "$PROJECT_DIR/seeds/questions.json" "$data_dir/workspace/questions.json"
        fi
    fi

    # Copy classifier into Reef's workspace
    if [ "$name" = "reef" ]; then
        mkdir -p "$data_dir/workspace/tools"
        if [ -f "$PROJECT_DIR/tools/classifier.py" ]; then
            cp "$PROJECT_DIR/tools/classifier.py" "$data_dir/workspace/tools/classifier.py"
        fi
    fi
}

start_agent() {
    local name="$1"
    local config="${AGENTS[$name]}"
    local server_port wallet_port data_dir
    IFS=':' read -r server_port wallet_port data_dir <<< "$config"
    data_dir="$(expand_path "$data_dir")"

    log "Starting ${BOLD}${name}${NC} (server=${server_port}, wallet=${wallet_port})"

    # Check ports
    if port_in_use "$server_port"; then
        warn "$name server port $server_port already in use -- skipping"
        return 1
    fi
    if port_in_use "$wallet_port"; then
        warn "$name wallet port $wallet_port already in use -- skipping"
        return 1
    fi

    # Initialize and copy configs
    init_agent "$name" || return 1

    # Launch agent
    DOLPHIN_MILK_DATA_DIR="$data_dir" \
        dolphin-milk start --port "$server_port" \
        > "$data_dir/agent.log" 2>&1 &

    local pid=$!
    echo "$pid" > "$data_dir/agent.pid"
    ok "$name started (PID $pid, server=$server_port, wallet=$wallet_port)"
}

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
            # Graceful SIGTERM, wait up to 10 seconds
            kill "$pid"
            local waited=0
            while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
                sleep 1
                ((waited++))
            done
            if kill -0 "$pid" 2>/dev/null; then
                warn "$name (PID $pid) did not stop gracefully, sending SIGKILL"
                kill -9 "$pid" 2>/dev/null || true
            fi
            ok "Stopped $name (PID $pid)"
        else
            warn "$name (PID $pid) was not running"
        fi
        rm -f "$pidfile"
    else
        warn "No PID file for $name at $pidfile"
    fi
}

check_agent() {
    local name="$1"
    local config="${AGENTS[$name]}"
    local server_port wallet_port data_dir
    IFS=':' read -r server_port wallet_port data_dir <<< "$config"
    data_dir="$(expand_path "$data_dir")"

    local status_line="${BOLD}${name}${NC}"
    local pid_status="no PID"
    local health_status="not responding"

    # Check PID
    local pidfile="$data_dir/agent.pid"
    if [ -f "$pidfile" ]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            pid_status="PID $pid running"
        else
            pid_status="PID $pid dead"
        fi
    fi

    # Check health endpoint (with retry)
    local attempts=0
    while [ $attempts -lt 3 ]; do
        if curl -sf "http://localhost:${server_port}/health" > /dev/null 2>&1; then
            health_status="healthy"
            break
        fi
        ((attempts++))
        [ $attempts -lt 3 ] && sleep 1
    done

    if [ "$health_status" = "healthy" ]; then
        ok "$status_line -- $pid_status, port $server_port: ${GREEN}healthy${NC}"
    else
        err "$status_line -- $pid_status, port $server_port: ${RED}not responding${NC}"
    fi
}

show_wallet_addresses() {
    log "Wallet funding addresses:"
    echo ""
    for name in "${AGENT_ORDER[@]}"; do
        local config="${AGENTS[$name]}"
        local server_port wallet_port data_dir
        IFS=':' read -r server_port wallet_port data_dir <<< "$config"
        data_dir="$(expand_path "$data_dir")"

        local addr
        addr=$(dolphin-milk receive --data-dir "$data_dir" 2>/dev/null) || addr="(start agent first)"
        info "${BOLD}${name}${NC} (wallet port ${wallet_port}): ${addr}"
    done
    echo ""
    log "Fund these addresses with BSV. Recommended amounts:"
    info "  Captain: 120M sats (~\$20) -- pays all specialists"
    info "  Coral:    50M sats (~\$8)  -- buffer for x402 scraping"
    info "  Reef:     10M sats (~\$2)  -- buffer for x402 analysis"
    info "  Pearl:    30M sats (~\$5)  -- buffer for x402 content"
}

tail_logs() {
    local name="$1"
    local config="${AGENTS[$name]}"
    local data_dir
    IFS=':' read -r _ _ data_dir <<< "$config"
    data_dir="$(expand_path "$data_dir")"

    local logfile="$data_dir/agent.log"
    if [ -f "$logfile" ]; then
        log "Tailing $name logs (Ctrl+C to stop)..."
        tail -f "$logfile"
    else
        err "No log file for $name at $logfile"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

print_banner() {
    echo -e "${CYAN}"
    echo "  ____        _       _     _       ____"
    echo " |  _ \\  ___ | |_ __ | |__ (_)_ __ / ___|  ___ _ __  ___  ___"
    echo " | | | |/ _ \\| | '_ \\| '_ \\| | '_ \\\\___ \\ / _ \\ '_ \\/ __|/ _ \\"
    echo " | |_| | (_) | | |_) | | | | | | | |___) |  __/ | | \\__ \\  __/"
    echo " |____/ \\___/|_| .__/|_| |_|_|_| |_|____/ \\___|_| |_|___/\\___|"
    echo "               |_|"
    echo -e "${NC}"
    echo "  Autonomous AI Research | BSV Micropayments | On-Chain Provenance"
    echo ""
}

case "${1:-all}" in
    all)
        print_banner
        preflight || exit 1
        echo ""
        log "Starting all agents..."
        for name in "${AGENT_ORDER[@]}"; do
            start_agent "$name" || true
        done
        echo ""
        log "Waiting for agents to initialize..."
        # Wait with progress dots
        for i in $(seq 1 8); do
            printf "."
            sleep 1
        done
        echo ""
        echo ""
        log "Health check:"
        for name in "${AGENT_ORDER[@]}"; do
            check_agent "$name"
        done
        echo ""
        log "All agents launched. Next steps:"
        info "  1. Fund wallets:    ./scripts/launch.sh fund"
        info "  2. Mission Control: open http://localhost:4000"
        info "  (Agents self-register on the overlay at startup)"
        ;;
    stop)
        print_banner
        log "Stopping all agents..."
        # Stop in reverse order (specialists first, captain last)
        for name in pearl reef coral captain; do
            stop_agent "$name"
        done
        ok "All agents stopped."
        ;;
    status)
        print_banner
        log "Agent status:"
        for name in "${AGENT_ORDER[@]}"; do
            check_agent "$name"
        done
        ;;
    fund)
        print_banner
        show_wallet_addresses
        ;;
    logs)
        if [ -z "${2:-}" ]; then
            err "Usage: $0 logs <agent_name>"
            exit 1
        fi
        tail_logs "$2"
        ;;
    restart)
        agent_name="${2:-}"
        if [ -z "$agent_name" ]; then
            log "Restarting all agents..."
            for name in pearl reef coral captain; do
                stop_agent "$name"
            done
            sleep 2
            for name in "${AGENT_ORDER[@]}"; do
                start_agent "$name" || true
            done
        else
            stop_agent "$agent_name"
            sleep 2
            start_agent "$agent_name"
        fi
        ;;
    preflight)
        print_banner
        preflight
        ;;
    captain|coral|reef|pearl)
        start_agent "$1"
        ;;
    *)
        echo "Usage: $0 [all|stop|status|fund|logs|restart|preflight|captain|coral|reef|pearl]"
        echo ""
        echo "Commands:"
        echo "  all                Start all 4 agents (default)"
        echo "  stop               Stop all agents gracefully"
        echo "  status             Health-check all agents"
        echo "  fund               Show wallet addresses for funding"
        echo "  logs <agent>       Tail an agent's log file"
        echo "  restart [agent]    Restart all or a specific agent"
        echo "  preflight          Run pre-flight checks only"
        echo "  <agent_name>       Start a single agent"
        exit 1
        ;;
esac
