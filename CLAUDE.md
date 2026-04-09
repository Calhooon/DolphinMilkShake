# DolphinMilkShake

Hackathon project: autonomous BSV agent swarm using rust-overlay + rust-bsv-worm.

## Architecture

Four rust-bsv-worm instances configured as specialized agents that discover each other via the BSV overlay network and collaborate on research missions.

```
DolphinMilkShake/
├── agents/           # dolphin-milk.toml config overrides per agent
│   ├── captain.toml  # port 3001, wallet 3322, orchestrator
│   ├── coral.toml    # port 3002, wallet 3323, scraper
│   ├── reef.toml     # port 3003, wallet 3324, analyst
│   └── pearl.toml    # port 3004, wallet 3325, creator
├── prompts/          # System prompt markdown for each agent
│   ├── captain.md
│   ├── coral.md
│   ├── reef.md
│   └── pearl.md
├── scripts/
│   ├── launch.sh     # Starts all 4 agents
│   └── register.sh   # Registers agents on overlay
├── CLAUDE.md
└── README.md
```

## Related Repos

| Repo | Role | Location |
|------|------|----------|
| rust-overlay | BSV overlay services (CF Workers) | ~/bsv/rust-overlay |
| rust-bsv-worm | Agent framework | ~/bsv/rust-bsv-worm |
| DolphinMilkShake | This repo -- swarm orchestration | ~/bsv/DolphinMilkShake |

## Agent Configuration

Each agent TOML extends the base DmConfig from rust-bsv-worm (see `rust-bsv-worm/src/config/schema.rs`). Key sections:

- `wallet` -- URL + port for the BSV wallet backend
- `llm` -- Model selection, token limits, compaction settings
- `budget` -- Satoshi limits per task/hour/day
- `heartbeat` -- Active hours, reflection, checklist
- `certificates` -- Agent name for BRC-52 authorization
- `browser` -- Chrome automation for scraping agents
- `overlay` -- **NOT YET IN WORM** (tracked in rust-bsv-worm#309). Target schema for agent registration on tm_agent.

Each agent runs on a unique pair of ports:
- Server port: where the worm HTTP API listens (3001-3004)
- Wallet port: where bsv-wallet serves (3322-3325)

## Overlay Integration

The overlay is deployed at `https://rust-overlay.dev-a3e.workers.dev`.

Topic managers and lookup services:
- `tm_agent` / `ls_agent` -- agent discovery (identity key, endpoint, capabilities)
- `tm_ship` / `ls_ship` -- SHIP node discovery
- `tm_slap` / `ls_slap` -- SLAP service lookup

Agent registration flow (target, pending rust-bsv-worm#309):
1. Agent starts with its config
2. On boot, agent creates a PushDrop transaction with fields: [identity_key, endpoint_url, capabilities_json, agent_name, version]
3. Agent submits the tx to the overlay via `POST /submit` with topic `tm_agent`
4. Other agents discover peers via `POST /lookup` with service `ls_agent`

## Wallet Setup

Each agent needs its own funded BSV wallet. The wallets are started by `launch.sh` via `bsv-wallet serve --db <path> --port <port>`.

Wallet data directories:
- Captain: `~/.dolphin-milk-captain/wallet.db`
- Coral: `~/.dolphin-milk-coral/wallet.db`
- Reef: `~/.dolphin-milk-reef/wallet.db`
- Pearl: `~/.dolphin-milk-pearl/wallet.db`

To fund a wallet: `dolphin-milk receive --data-dir ~/.dolphin-milk-captain` to get an address, then send BSV to it.

## Running Tests / Verification

```bash
# Check overlay health
curl https://rust-overlay.dev-a3e.workers.dev/health

# Launch all agents
./scripts/launch.sh

# Register on overlay
./scripts/register.sh

# Verify agents are running
curl http://localhost:3001/health  # Captain
curl http://localhost:3002/health  # Coral
curl http://localhost:3003/health  # Reef
curl http://localhost:3004/health  # Pearl
```

## Key Decisions

- Captain uses claude-sonnet-4-6 for better reasoning and orchestration
- Coral and Reef use gpt-5-mini for cost efficiency on high-volume tasks
- Pearl uses claude-sonnet-4-6 for higher quality content generation
- All agents use strict budget enforcement with conservative limits
- Compliance mode is on (WORM mode) for hackathon auditability
- Browser automation is only enabled for Coral (the scraping agent)
