# DolphinMilkShake

Autonomous BSV agent swarm for the hackathon. Four specialized agents discover each other via the BSV overlay network and collaborate on research missions.

## Architecture

```
┌─────────────────────────────────────────────┐
│           rust-overlay (CF Workers)          │
│  tm_agent / ls_agent — agent discovery      │
│  tm_ship / ls_ship   — node discovery       │
│  https://rust-overlay.dev-a3e.workers.dev   │
└──────────────┬──────────────────┬───────────┘
               │ register         │ discover
    ┌──────────┴──┐          ┌────┴──────────┐
    │  Captain    │          │    Coral      │
    │  (research  │◄────────►│  (scraping    │
    │  orchestr.) │          │  specialist)  │
    └──────┬──────┘          └───────────────┘
           │ delegate
    ┌──────┴──────┐          ┌───────────────┐
    │    Reef     │          │    Pearl      │
    │  (analysis  │◄────────►│  (creator     │
    │  specialist)│          │  specialist)  │
    └─────────────┘          └───────────────┘
```

Each agent is a rust-bsv-worm instance with:
- Unique identity (BSV wallet on its own port)
- Specialized system prompt
- Overlay registration (tm_agent PushDrop)
- Peer discovery via ls_agent lookups

## Agents

| Agent | Role | Server Port | Wallet Port | Model |
|-------|------|-------------|-------------|-------|
| **Captain** | Research orchestrator | 3001 | 3322 | claude-sonnet-4-6 |
| **Coral** | Web scraping & data collection | 3002 | 3323 | gpt-5-mini |
| **Reef** | Data analysis & pattern recognition | 3003 | 3324 | gpt-5-mini |
| **Pearl** | Content creation & report writing | 3004 | 3325 | claude-sonnet-4-6 |

## Dependencies

- [rust-overlay](https://github.com/Calgooon/rust-overlay) -- overlay infrastructure (577 tests, deployed)
- [rust-bsv-worm](https://github.com/Calgooon/rust-bsv-worm) -- agent framework (69 routes, PushDrop state tokens)

## Quick Start

```bash
# 1. Ensure overlay is deployed
curl https://rust-overlay.dev-a3e.workers.dev/health

# 2. Launch all 4 agents (starts wallets + worm servers)
./scripts/launch.sh

# 3. Register agents on the overlay
./scripts/register.sh

# 4. Open Mission Control
open http://localhost:4000
```

## Project Structure

```
DolphinMilkShake/
├── agents/                 # Agent configuration files
│   ├── captain.toml        # Research orchestrator
│   ├── coral.toml          # Scraping specialist
│   ├── reef.toml           # Analysis specialist
│   └── pearl.toml          # Creator specialist
├── prompts/                # System prompts for each agent
│   ├── captain.md
│   ├── coral.md
│   ├── reef.md
│   └── pearl.md
├── scripts/
│   ├── launch.sh           # Start all 4 worm instances
│   └── register.sh         # Register agents on overlay
├── CLAUDE.md               # Project documentation
└── README.md
```

## How It Works

1. **Launch**: `launch.sh` starts 4 rust-bsv-worm instances, each with its own wallet, port, and config.
2. **Register**: `register.sh` submits a PushDrop transaction for each agent to the overlay via `tm_agent`, making them discoverable.
3. **Discover**: Each agent queries `ls_agent` on the overlay to find its peers and their capabilities.
4. **Collaborate**: The Captain agent orchestrates research missions by delegating tasks to Coral (scraping), Reef (analysis), and Pearl (content creation).
5. **Prove**: Every interaction is recorded as a BSV transaction with cryptographic proof of work.

## Overlay Integration

The overlay at `https://rust-overlay.dev-a3e.workers.dev` provides:

- **tm_agent / ls_agent** -- Agent discovery topic. Each agent registers with a PushDrop token containing its identity key, endpoint URL, and capabilities.
- **tm_ship / ls_ship** -- SHIP (Service Host Interconnect Protocol) for node-level discovery.
- **tm_slap / ls_slap** -- SLAP (Service Lookup Availability Protocol) for service enumeration.

Agent registration is tracked in [rust-bsv-worm#309](https://github.com/Calgooon/rust-bsv-worm/issues/309).

## License

MIT
