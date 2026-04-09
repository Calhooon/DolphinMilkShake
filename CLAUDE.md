# DolphinSense (DolphinMilkShake)

Hackathon entry: 4 autonomous AI agents with BSV wallets running a verifiable intelligence pipeline. Per-record micropayments + BRC-18 provenance proofs targeting 1.5M transactions in 24 hours.

## Three-Repo Architecture

| Repo | Role | Status |
|------|------|--------|
| **rust-overlay** (`~/bsv/rust-overlay`) | BSV overlay services deployed on Cloudflare Workers. Provides agent discovery (tm_agent/ls_agent), SHIP, SLAP. | DONE. Deployed at https://rust-overlay.dev-a3e.workers.dev |
| **rust-bsv-worm** (`~/bsv/rust-bsv-worm`) | Autonomous AI agent framework. 69 HTTP routes, PushDrop state tokens, BSV wallet, x402 payments, MessageBox, BRC-100 discovery. | Active development. Overlay client (issue #309) being implemented by another terminal. |
| **DolphinMilkShake** (`~/bsv/DolphinMilkShake`) | THIS REPO. The APPLICATION layer -- system prompts, configs, launch scripts, research question seeds, rule-based classifier, Mission Control UI. | In progress. |

**Key insight: the worm needs ZERO modifications.** DolphinSense demonstrates what you can build on top of bsv-worm. The system prompts ARE the application. The worm provides the tools; the prompts tell it what to do with them.

## File Layout

```
DolphinMilkShake/
├── agents/                 # Per-agent dolphin-milk.toml configs
│   ├── captain.toml        # Broker: port 3001, wallet 3322, claude-sonnet-4-6
│   ├── coral.toml          # Scraper: port 3002, wallet 3323, gpt-5-mini
│   ├── reef.toml           # Analyst: port 3003, wallet 3324, gpt-5-mini
│   └── pearl.toml          # Creator: port 3004, wallet 3325, claude-sonnet-4-6
├── prompts/                # System prompts -- THE CORE OF THE PROJECT
│   ├── captain.md          # Research orchestration, task decomposition, quality QA, budget mgmt
│   ├── coral.md            # Scraping: Reddit/HN/RSS/BSV (free), X/SEO/Web (x402)
│   ├── reef.md             # Classification: rule engine (95%) + LLM fallback (5%)
│   └── pearl.md            # Report writing, NanoStore uploads, provenance links
├── seeds/
│   └── questions.json      # 20+ pre-seeded research questions for Captain
├── tools/
│   └── classifier.py       # Rule-based classifier script Reef runs via execute_bash
├── scripts/
│   ├── launch.sh           # Start 4 worm instances + 4 wallets + health checks
│   └── register.sh         # Register agents on overlay via tm_agent
├── CLAUDE.md               # This file
└── README.md               # Hackathon-facing README
```

## Agent Configuration

Each agent `.toml` extends the DmConfig schema from rust-bsv-worm (`rust-bsv-worm/src/config/schema.rs`). Key sections:

- `wallet` -- URL + port for the BSV wallet backend
- `llm` -- Model selection, token limits, compaction settings
- `budget` -- Satoshi limits per task/hour/day
- `heartbeat` -- Active hours, inbox polling, reflection, checklist
- `certificates` -- Agent name for BRC-52 authorization
- `browser` -- Chrome automation (only Coral has this enabled)
- `overlay` -- Registration config for tm_agent (pending rust-bsv-worm#309)
- `system_prompt_file` -- Path to the system prompt markdown

Port assignments:

| Agent | Server | Wallet | Data Dir |
|-------|--------|--------|----------|
| Captain | 3001 | 3322 | ~/.dolphin-milk-captain |
| Coral | 3002 | 3323 | ~/.dolphin-milk-coral |
| Reef | 3003 | 3324 | ~/.dolphin-milk-reef |
| Pearl | 3004 | 3325 | ~/.dolphin-milk-pearl |

## Data Sources

The agents scrape 10 source types. Free sources provide bulk volume; paid x402 sources provide high-value data:

**Free (via `web_fetch`):**
- Reddit JSON API -- `https://www.reddit.com/r/{sub}/top.json?t=hour`
- Hacker News Firebase API -- `https://hacker-news.firebaseio.com/v0/`
- RSS feeds -- standard XML feeds from 50-100 tech/crypto/AI news sources
- BSV blockchain -- WhatsOnChain API (`https://api.whatsonchain.com/v1/bsv/main/`)

**Paid (via `x402_call`):**
- X-Research -- `/search` (36K sats/page), `/trending` (3,600 sats/call)
- SEO -- `/serp` (14,895 sats/call), `/suggest` (14,895 sats/call)
- Web Reader -- `/read` (17,874 sats/call), `/search` (29,789 sats/call)
- Claude Haiku -- edge-case classification + report writing via x402

## Per-Record Payment Model

This is how we hit 1.5M transactions. Each INDIVIDUAL record generates ~3.2 txs:

| Step | Txs per record |
|------|---------------|
| Captain pays Coral for scraping this record | 1 |
| Captain pays Reef for analyzing this record | 1 |
| Provenance proof for this record (BRC-18 OP_RETURN) | 1 |
| Captain pays Pearl for summarizing (1 per 10 records) | 0.1 |
| Quality challenge (10% sample) | 0.1 |

With ~470K records through the pipeline: 470K * 3.2 = ~1.49M transactions.

At 4 agents * 5 tx/s = 20 tx/s sustained: 20 * 86,400 = 1.73M capacity. 87% utilization.

## Quality Assurance

Captain randomly selects 10% of records for spot-checks:
1. Same data sent to a DIFFERENT specialist for re-analysis
2. Results compared -- if they diverge significantly, the original specialist is challenged
3. Loser pays a small stake (10 sats)
4. Quality attestation cert updated
5. Over 24 hours, specialists build reputation via cert attestations

## Worm Tools Available to Agents

These are built into rust-bsv-worm and available via the agent's tool palette:

- `web_fetch` -- HTTP GET/POST, returns body text. Used for free data sources.
- `x402_call` -- Paid API call via BSV micropayment. Used for X-Research, SEO, Web Reader, Claude.
- `execute_bash` -- Run a shell command. Reef uses this for the rule-based classifier.
- `memory_search` -- Search agent's local memory store. Used for cross-referencing.
- `memory_store` -- Save data to local memory. Used for caching records.
- `send_message` -- Send MessageBox message to another agent (BRC-33, signed + encrypted, FREE).
- `read_messages` -- Read incoming MessageBox messages.
- `wallet_send` -- Send BSV micropayment to an address.
- `wallet_balance` -- Check wallet balance.
- `discover_agent` -- Query overlay for agents with matching attributes (BRC-100).
- `verify_agent` -- Verify agent's BRC-52 capability certificate.
- `create_provenance` -- Record BRC-18 provenance proof (OP_RETURN with data hash).

## Testing

```bash
# Check overlay health
curl https://rust-overlay.dev-a3e.workers.dev/health

# Launch all agents
./scripts/launch.sh

# Register on overlay
./scripts/register.sh

# Health check
curl http://localhost:3001/health  # Captain
curl http://localhost:3002/health  # Coral
curl http://localhost:3003/health  # Reef
curl http://localhost:3004/health  # Pearl

# Test classifier standalone
echo '{"text": "Bitcoin is amazing", "source": "reddit"}' | python3 tools/classifier.py
```

## Key Decisions

- Captain and Pearl use claude-sonnet-4-6 (better reasoning/prose)
- Coral and Reef use gpt-5-mini (cost efficiency on high-volume tasks)
- Per-record payments (not per-batch) to maximize meaningful tx volume
- Rule-based classifier handles 95% of records (no LLM cost); x402 Claude Haiku for the remaining 5%
- All inter-agent communication via MessageBox (FREE, signed, encrypted)
- All payments via wallet_send (real BSV micropayments)
- All provenance via BRC-18 OP_RETURN (unique record hash per tx)
- WORM mode (compliance) enabled for hackathon auditability

## Reference Implementations

| What | Location |
|------|----------|
| TS Engine | ~/bsv/overlay-services/src/Engine.ts |
| TS SHIP/SLAP | ~/bsv/overlay-discovery-services/src/ |
| TS overlay-express | ~/bsv/overlay-express/src/OverlayExpress.ts |
| Worm config schema | ~/bsv/rust-bsv-worm/src/config/schema.rs |
| Worm tools | ~/bsv/rust-bsv-worm/src/tools/ |
| GASP protocol | ~/bsv/gasp-core/src/GASP.ts |
| DOLPHINSENSE plan | ~/bsv/brc-sse-payment-channels/DOLPHINSENSE.md |
