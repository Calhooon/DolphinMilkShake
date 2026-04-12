# DolphinSense (DolphinMilkShake)

Hackathon entry: 25 autonomous AI agents in a 3-layer pyramid with BSV wallets running a verifiable intelligence pipeline. Natural worm proof loop generates ~1.5M transactions in 24 hours. ~$45 total cost.

## Three-Repo Architecture

| Repo | Role | Status |
|------|------|--------|
| **rust-overlay** (`~/bsv/rust-overlay`) | BSV overlay services on CF Workers. Agent discovery (tm_agent/ls_agent), SHIP, SLAP. | DONE. Deployed at https://rust-overlay.dev-a3e.workers.dev |
| **rust-bsv-worm** (`~/bsv/rust-bsv-worm`) | Autonomous AI agent framework. 79 routes, BRC-18 proofs, x402 payments, MessageBox, BRC-100 discovery. | Active dev. Multi-agent handshake (gate 5) in progress. |
| **DolphinMilkShake** (`~/bsv/DolphinMilkShake`) | THIS REPO. Application layer — system prompts, configs, launch scripts, classifier, Mission Control UI. | In progress. |

**Key insight: the worm needs ZERO modifications.** Each agent is an unmodified rust-bsv-worm instance with a system prompt. The prompts ARE the application.

## 25-Agent Pyramid

```
Layer 1 (Top):     2 Captains (Opus) — orchestrate, produce final deliverables
Layer 2 (Middle):  5 Coordinators (Haiku/Sonnet) — dispatch, aggregate, QA
Layer 3 (Bottom): 18 Workers (Haiku/GPT-5-mini) — scrape, classify, write, audit
```

See ARCHITECTURE.md for full agent roster, port assignments, tx math, hardware measurements.

## File Layout

```
DolphinMilkShake/
├── agents/                 # Per-agent dolphin-milk.toml configs (25 files)
│   ├── captain.toml        # (existing, needs update for Opus + new port scheme)
│   ├── coral.toml          # (existing, template for scraper variants)
│   ├── reef.toml           # (existing, template for classifier variants)
│   └── pearl.toml          # (existing, template for writer variants)
├── prompts/                # System prompts by role
│   ├── captain.md          # Orchestration, memory management, report assembly
│   ├── coral.md            # Scraping template (source-specific variants)
│   ├── reef.md             # Classification template
│   ├── pearl.md            # Writer template
│   ├── coordinator.md      # NEW — task dispatch + aggregation
│   ├── crossref.md         # NEW — multi-source correlation
│   └── auditor.md          # NEW — spot-check + quality scoring
├── poc/                    # POC results (benchmarks, logs, measurements)
├── seeds/
│   └── questions.json      # 25 pre-seeded research questions
├── tools/
│   └── classifier.py       # Rule-based classifier (Reef runs via execute_bash)
├── scripts/
│   ├── launch.sh           # Start/stop/status all 25 agents
│   └── provision.sh        # Spin up 25 wallets + fund + certify
├── ARCHITECTURE.md         # Full technical design
├── DOLPHINSENSE.md         # Original 4-agent design (historical)
├── CLAUDE.md               # This file
└── README.md               # Hackathon-facing README
```

## Agent Configuration

Each `.toml` extends DmConfig from rust-bsv-worm (`src/config/schema.rs`). Key sections:
- `wallet` — URL + port for BSV wallet backend
- `llm` — Model selection (Opus for captains, Sonnet for writers/auditors, GPT-5-mini for workers)
- `budget` — Satoshi limits per task/hour/day
- `heartbeat` — Inbox polling interval (15s for workers, 30s for coordinators, 60s for captains)
- `certificates` — Agent name + capabilities for BRC-52
- `overlay` — Self-registration at startup
- `system_prompt_file` — Path to role-specific prompt

Port scheme: agents on 3001-3025, wallets on 3322-3346. See ARCHITECTURE.md for full roster.

## How Data Flows

Agents have isolated workspaces. Data moves via:
1. **MessageBox (BRC-33)** — task assignments, results, summaries (body IS the data)
2. **NanoStore (x402)** — large datasets/reports uploaded, UHRP URL shared via message
3. **memory_store/memory_search** — per-agent local recall (tantivy BM25 indexed)

Captain stores structured memories with tags + NanoStore URLs + txids. Uses memory_search to recall when assembling reports.

## How 1.5M Transactions Happen

NOT from batch scripts or artificial inflation. From the worm's **natural proof loop**:
- Every iteration: x402 LLM payment + BRC-18 decision proof + BRC-48 budget tokens = ~4-5 txs
- Every message: MessageSend + MessageReceive proofs = ~2-3 txs
- Every task: lifecycle tokens (setup + teardown) = ~5 txs
- Every x402 call: payment + capability proof = ~2-3 txs

25 agents × ~7K iterations/day × ~7 txs/iteration + messaging + lifecycle = ~1.5M

## Milestones

| Milestone | Due | What |
|-----------|-----|------|
| **M1: POC Validation** | Apr 15 | Validate risky assumptions: wallet throughput, 3-layer cascade, overlay at scale, memory recall, NanoStore sharing, 1-hour burn |
| **M2: 24-Hour Run** | Apr 16 | Provision 25 wallets, write all configs/prompts, launch script, Mission Control UI, 4-hour dry run |

POC results saved in `poc/` directory. Issues #11-#22 track all work.

## Worm Tools Available to Agents

Built into rust-bsv-worm, no modifications needed:
- `web_fetch` — HTTP GET/POST for free data sources
- `x402_call` — Paid API call via BSV micropayment
- `execute_bash` — Shell commands (classifier script, data processing)
- `memory_store` / `memory_search` — Per-agent local memory (tantivy)
- `send_message` — MessageBox to another agent (BRC-33, signed/encrypted, FREE)
- `overlay_lookup` — Find agents by capability on the overlay
- `wallet_identity` — Get own identity key
- Plus 30+ other tools (browser, file I/O, etc.)

## Key Decisions

- **Opus for Captains** — complex orchestration, 24-hour memory management, report assembly
- **Sonnet for Writers/Auditors/Quality Lead** — quality prose and reasoning
- **GPT-5-mini/Haiku for Workers** — fast, cheap, high-volume tasks
- **25 agents** — enough natural tx volume from proof loop without batch scripts
- **3-layer pyramid** — every piece of work flows through 3 layers = 3x tx multiplier
- **NanoStore as shared data layer** — upload once, share URL, multiple agents fetch
- **WORM mode** enabled for hackathon auditability

## Reference Implementations

| What | Location |
|------|----------|
| Worm config schema | ~/bsv/rust-bsv-worm/src/config/schema.rs |
| Worm tools | ~/bsv/rust-bsv-worm/src/tools/ |
| Worm proof loop | ~/bsv/rust-bsv-worm/src/onchain/proofs.rs |
| Worm heartbeat/scheduler | ~/bsv/rust-bsv-worm/src/heartbeat/mod.rs |
| Worm MessageBox client | ~/bsv/rust-bsv-worm/src/messagebox/client.rs |
| E2E handshake test | ~/bsv/rust-bsv-worm/tests/multi-worm/test_two_agent_handshake.js |
| Overlay engine | ~/bsv/rust-overlay/crates/overlay-engine/src/engine.rs |
