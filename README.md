# DolphinSense

> Four autonomous AI agents wake up with BSV wallets. One is the Captain -- it asks the questions. The other three are specialists -- a scraper, an analyst, and a creator. The Captain commissions research: *"Which crypto communities are making the most noise about AI agents?"* The specialists fan out across Reddit, Hacker News, X, the web, SEO data, and the BSV blockchain itself. They scrape, classify, analyze, and package the results into verified intelligence reports -- paying each other in real BSV micropayments for every step. Every scrape, every classification, every insight has cryptographic provenance on-chain.
>
> **Autonomous AI research, paid in micropayments, verified on blockchain.**

## The Problem

Content intelligence -- trend monitoring, competitive research, social listening -- is a $30B+ industry dominated by black-box SaaS tools. You cannot verify how data was collected, whether analysis is honest, or who touched what.

DolphinSense creates a fully auditable intelligence pipeline where:
- Every data point has on-chain provenance (which agent scraped it, when, from where)
- Every analysis step is paid for and recorded (who classified it, what score, what confidence)
- Every deliverable is permanently stored with verifiable lineage
- Quality is enforced by economic incentives, not trust

## Architecture

```
                         +----------------------------+
                         |        HUMAN (You)         |
                         |  Launches mission via UI   |
                         |  Reads intelligence reports |
                         +-------------+--------------+
                                       |
                                       v
+----------------------------------------------------------------------+
|                      MISSION CONTROL WEB UI                          |
|  Live pipeline: research questions, records flowing, quality scores, |
|  report links, payment flows, agent status                           |
+------+-------------------+-------------------+-----------------------+
       | SSE               | SSE               | SSE
       v                   v                   v
+-----------+       +-----------+       +-----------+       +-----------+
|  CAPTAIN  |       |   CORAL   |       |   REEF    |       |   PEARL   |
|  (Broker) |<----->| (Scraper) |       | (Analyst) |       | (Creator) |
|           |<----->|           |       |           |       |           |
| BRC-100   |<----->| BRC-100   |       | BRC-100   |       | BRC-100   |
| Orchestr. |       | web_fetch |       | exec_bash |       | x402_call |
| Quality   |       | browser   |       | memory    |       | (Claude)  |
| Commission|       | x402(seo) |       |   search  |       | (NanoSt.) |
| Pay agents|       | x402(x-r) |       | verify    |       | (1Sat)    |
+-----------+       +-----------+       +-----------+       +-----------+
      |                   |                   |                   |
      |      MessageBox (BRC-33) -- FREE -- signed/encrypted     |
      +-------------------+-------------------+-------------------+
                                  |
                       BSV Network (payments + proofs)
                                  |
                    +-----------------------------+
                    |  1.5M transactions on-chain  |
                    |  Every one verifiable         |
                    +-----------------------------+

Data sources (Coral scrapes these):
+--------+--------+---------+---------+----------+----------+---------+
| Reddit |   HN   |   RSS   |  BSV    | X/Twitter|   SEO    | Web     |
| (FREE) | (FREE) |  (FREE) | (FREE)  |  (x402)  |  (x402)  | (x402)  |
+--------+--------+---------+---------+----------+----------+---------+

Reports stored permanently:
+------------------------------------------+
|              NanoStore                    |
|  Batch reports, hourly briefs, daily     |
|  report -- all with UHRP permanent URLs  |
+------------------------------------------+
```

## Agent Roles

| Agent | Name | Role | Model |
|-------|------|------|-------|
| **Broker** | Captain | Asks the questions. Commissions research. Pays for work. Quality-checks results. Assembles deliverables. | claude-sonnet-4-6 |
| **Scraper** | Coral | Fetches raw data from everywhere: Reddit, HN, X, web pages, RSS, SEO, BSV chain. Returns structured records. | gpt-5-mini |
| **Analyst** | Reef | Classifies, scores sentiment, extracts entities, cross-references, verifies data integrity. Returns enriched records. | gpt-5-mini |
| **Creator** | Pearl | Writes reports, generates summaries, uploads to NanoStore. Returns permanent URLs. | claude-sonnet-4-6 |

## Research Pipeline

Captain maintains a rotating queue of research questions. Some are pre-seeded, some emerge from previous findings.

```
CAPTAIN (Broker)
  |
  |  "Research: trending AI agent topics across all sources"
  |
  +---> CORAL: "Scrape /r/bitcoin, /r/machinelearning top posts"
  |     web_fetch (FREE) -> 300 Reddit posts
  |     Captain -> Coral: 300 sats (1 sat/record)
  |
  +---> CORAL: "Search X for 'AI agents' 'micropayments'"
  |     x402(x-research/search) -> 60 tweets
  |     Captain -> Coral: 310 sats (per-record + x402 pass-through)
  |
  +---> CORAL: "SERP + autocomplete for 'AI agent framework'"
  |     x402(seo/serp) + x402(seo/suggest) -> rankings + suggestions
  |     Captain -> Coral: 200 sats
  |
  +---> CORAL: "HN front page + Show HN posts about AI"
  |     web_fetch (FREE) -> 50 HN stories
  |     Captain -> Coral: 50 sats
  |
  +---> CORAL: "BSV mempool -- unusual tx patterns today?"
  |     web_fetch to WhatsOnChain (FREE) -> block stats
  |     Captain -> Coral: 25 sats
  |
  |  -- Raw data delivered via MessageBox (FREE) --
  |
  +---> REEF: "Classify all 450 records: topic, sentiment, entities"
  |     execute_bash (rule engine, 95%) + x402(claude-haiku) for edge cases
  |     Captain -> Reef: 900 sats (2 sats/record)
  |
  +---> REEF: "Cross-reference: what topics appear on Reddit AND X AND HN?"
  |     memory_search + execute_bash (correlation logic)
  |     Captain -> Reef: 100 sats
  |     *** Multi-source signal detection ***
  |
  |  -- Enriched data delivered via MessageBox (FREE) --
  |
  +---> PEARL: "Write trend brief: top signals, sentiment, key quotes"
  |     x402(claude-haiku) -> 500-word intelligence brief
  |     Captain -> Pearl: 300 sats
  |
  +---> PEARL: "Upload to NanoStore"
  |     x402(nanostore/upload) -> permanent UHRP URL
  |     Captain -> Pearl: 50 sats
  |
  +---> CAPTAIN: Quality-checks 10% of results. Updates research queue.
        "HN and Reddit both buzz about a new AI framework -- dig deeper."
        -> New research cycle spawns automatically.
```

**One research cycle: ~25-35 transactions.** Running continuously, 24 hours. Each cycle scrapes everywhere, cross-references everything.

## Data Sources

| Source | Method | Cost | 24h Volume |
|--------|--------|------|-----------|
| **Reddit** (100+ subreddits) | `web_fetch` to JSON API | FREE | ~200K records |
| **Hacker News** | `web_fetch` to Firebase API | FREE | ~19K records |
| **RSS feeds** (50-100 sources) | `web_fetch` to feed URLs | FREE | ~20K articles |
| **BSV blockchain** | `web_fetch` to WhatsOnChain | FREE | ~50K data points |
| **X/Twitter search** | x402 X-Research `/search` | 36K sats/page | ~10K tweets |
| **X/Twitter trending** | x402 X-Research `/trending` | 3,600 sats/call | ~1K snapshots |
| **SEO SERP results** | x402 SEO `/serp` | 14,895 sats/call | ~5K results |
| **SEO autocomplete** | x402 SEO `/suggest` | 14,895 sats/call | ~3K suggestions |
| **Web articles** | x402 Web Reader `/read` | 17,874 sats/call | ~2K articles |
| **Web search** | x402 Web Reader `/search` | 29,789 sats/call | ~1K searches |

**Total: ~310K+ records from 10 source types.** The value is in cross-referencing -- when Reddit, X, HN, and Google all light up on the same topic, that is a real signal.

## Transaction Breakdown (24 Hours)

Per-record payments drive the volume. Each individual record flowing through the pipeline generates transactions:

| Step | Txs per record |
|------|---------------|
| Captain pays Coral for scraping this record | 1 |
| Captain pays Reef for analyzing this record | 1 |
| Provenance proof for this record (BRC-18 OP_RETURN) | 1 |
| Captain pays Pearl for summarizing (1 per 10 records) | 0.1 |
| Quality challenge (10% sample) | 0.1 |
| **Total per record** | **~3.2** |

### 24-Hour Volume

| Tx Type | Count | % | Description |
|---------|-------|---|-------------|
| Scraping payments (Captain -> Coral) | 470K | 31% | Per-record micropayment for raw data |
| Analysis payments (Captain -> Reef) | 470K | 31% | Per-record micropayment for classification |
| Provenance proofs (BRC-18) | 470K | 31% | OP_RETURN per record: source, hash, scores |
| Report payments (Captain -> Pearl) | 47K | 3% | Per-10-record micropayment for summaries |
| Quality challenges | 23K | 2% | Captain spot-checks random records |
| NanoStore uploads | 5K | <1% | Report chunks stored permanently |
| Certificate attestations | 2K | <1% | Quality reputation updates |
| x402 service calls | 3K | <1% | Web Reader, X-Research, SEO, Claude |
| **TOTAL** | **~1.49M** | **100%** | |

**Every transaction carries unique data. Every transaction serves a verifiable purpose.**

A judge clicks any txid:
- Payment tx: Captain paid Coral 1 sat for record #284,901 from /r/bitcoin
- Proof tx: OP_RETURN with `{record_hash, source: "reddit", sentiment: 0.7, topic: "AI_agents", agent: "reef"}`
- Challenge tx: Captain paid Reef 5 sats to re-analyze record #284,901 (spot-check)

## Cost Analysis

| Category | USD |
|----------|-----|
| Miner fees (1.49M txs @ ~25 sats) | $6.25 |
| LLM reasoning (agent loops) | $8.56 |
| x402 data services (X, SEO, Web Reader) | $14.11 |
| x402 analysis services (Claude Haiku) | $3.95 |
| x402 storage + images | $0.14 |
| **TOTAL** | **~$33** |

### Agent Funding

| Agent | Starting Balance | Purpose |
|-------|-----------------|---------|
| Captain | 120M sats (~$20) | Pays all three specialists + x402 services |
| Coral | 50M sats (~$8.40) | Buffer for x402 scraping (X-Research, SEO, Web Reader) |
| Reef | 10M sats (~$1.68) | Buffer for x402 analysis (Claude Haiku edge cases) |
| Pearl | 30M sats (~$5.04) | Buffer for x402 content (Claude Haiku, NanoStore) |
| **Total** | **210M sats (~$35)** | |

## What DolphinSense Produces

**Every ~20 minutes**: Research Batch Report -- top findings with source links, sentiment analysis, key entities, cross-source correlation, on-chain provenance txids. Uploaded to NanoStore.

**Every hour**: Hourly Trend Brief -- trending topics vs last hour, emerging narratives, sentiment shifts, notable outliers.

**End of 24 hours**: Daily Intelligence Report -- executive summary, top 50 trending topics, emerging narrative analysis, cross-source intelligence map, BSV ecosystem health metrics, full provenance appendix.

## What Judges See

1. **Live Mission Control UI** -- records flowing through the pipeline in real time, payments animated between agents, quality scores updating
2. **NanoStore report URLs** -- click any report, read actual intelligence with source links and provenance txids
3. **WhatsOnChain verification** -- click any txid, see the OP_RETURN data proving provenance
4. **Agent discovery logs** -- agents finding each other via BRC-100 and verifying certificates
5. **The daily report** -- a real, useful intelligence deliverable produced entirely by autonomous AI agents

## Project Structure

```
DolphinMilkShake/
├── agents/                 # Per-agent dolphin-milk.toml configs
│   ├── captain.toml        # Broker: port 3001, wallet 3322
│   ├── coral.toml          # Scraper: port 3002, wallet 3323
│   ├── reef.toml           # Analyst: port 3003, wallet 3324
│   └── pearl.toml          # Creator: port 3004, wallet 3325
├── prompts/                # System prompts (the core of the project)
│   ├── captain.md          # Research orchestration + quality assurance
│   ├── coral.md            # Scraping specialist + source rotation
│   ├── reef.md             # Analysis + rule-based classification
│   └── pearl.md            # Report writing + NanoStore uploads
├── seeds/
│   └── questions.json      # Pre-seeded research questions
├── tools/
│   └── classifier.py       # Rule-based classifier (Reef runs via execute_bash)
├── scripts/
│   ├── launch.sh           # Start all 4 worm instances + wallets
│   └── register.sh         # Register agents on overlay
├── CLAUDE.md
└── README.md
```

## Quick Start

```bash
# 1. Verify overlay is deployed
curl https://rust-overlay.dev-a3e.workers.dev/health

# 2. Launch all 4 agents (starts wallets + worm servers)
./scripts/launch.sh

# 3. Register agents on the overlay
./scripts/register.sh

# 4. Open Mission Control
open http://localhost:4000
```

## Dependencies

- [rust-overlay](https://github.com/Calgooon/rust-overlay) -- BSV overlay services, deployed at https://rust-overlay.dev-a3e.workers.dev
- [rust-bsv-worm](https://github.com/Calgooon/rust-bsv-worm) -- autonomous agent framework (69 routes, PushDrop state tokens)

## Timeline

| Day | Milestone |
|-----|-----------|
| 1 (Apr 8) | System prompts + rule engine |
| 2 (Apr 9) | Mission launcher + discovery |
| 3 (Apr 10) | Scraping pipeline (Coral + Captain) |
| 4 (Apr 11) | Analysis pipeline (Reef + quality checks) |
| 5 (Apr 12) | Report pipeline (Pearl + NanoStore) |
| 6 (Apr 13) | Full pipeline integration |
| 7 (Apr 14) | Mission Control UI |
| 8 (Apr 15) | 1-hour test burn |
| 9 (Apr 16) | Full 24-hour run |
| 10 (Apr 17) | Demo + submit |

## Hackathon Checklist

| Requirement | How DolphinSense Meets It |
|-------------|---------------------------|
| At least 2 AI agents with BSV wallets | 4 agents (Captain, Coral, Reef, Pearl), each with BRC-100 wallet + identity key |
| At least 1.5M transactions in 24 hours | ~1.49M txs: per-record payments + provenance proofs + quality challenges |
| Transactions must be meaningful | Every tx is a micropayment for work performed OR a provenance proof with unique record hash. No two txs are alike. |
| Agents discover each other via BRC-100 | Captain discovers specialists via `discover_agent(attributes)` + `verify_agent()` |
| Agents negotiate and exchange value | Price negotiation via MessageBox. BSV micropayments for every service. Quality disputes with economic stakes. |
| Solves a real-world problem | Verifiable content intelligence pipeline -- auditable AI research with on-chain provenance |
| Human-facing web UI | Mission Control: live pipeline view, payment flows, agent status, report links |
| Working demo | 24-hour live run producing real intelligence reports stored on NanoStore |
| On-chain transactions verifiable | Every tx on WhatsOnChain. OP_RETURN proofs. Payment txids. |
| Source code in public GitHub repo | This repository + bsv-worm dependency |

## License

MIT
