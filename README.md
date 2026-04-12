# DolphinSense

> 25 autonomous AI agents organized in a 3-layer pyramid. Captains orchestrate, coordinators dispatch, workers execute. Every action is paid in BSV micropayments and proofed on-chain. The output: verified intelligence reports where every claim is traceable through all 3 layers to its original source.
>
> **$45 total. 1.5 million transactions. Every one verifiable.**

## The Problem

Content intelligence -- trend monitoring, competitive research, social listening -- is a $30B+ industry dominated by black-box SaaS tools. You cannot verify how data was collected, whether analysis is honest, or who touched what.

DolphinSense creates a fully auditable intelligence pipeline where:
- Every data point has on-chain provenance (which agent scraped it, when, from where)
- Every analysis step is paid for and recorded (who classified it, what score, what confidence)
- Every deliverable is permanently stored with verifiable lineage
- Quality is enforced by economic incentives, not trust

## Architecture

```
                    +----------------------+
    Layer 1         |    CAPTAINS (2)      |   Opus -- orchestrate, produce final deliverables
    (Top)           |   Alpha  .  Beta     |
                    +----------+-----------+
                               | commission + pay
              +----------------+------------------+
              v                v                  v
    +--------------+  +--------------+  +--------------+
    | SCRAPE COORD |  |ANALYSIS COORD|  | REPORT COORD |
    |              |  |              |  |              |   Layer 2
    |  routes to   |  |  routes to   |  |  assembles   |   (Middle)
    |  scrapers by |  |  classifiers |  |  writer      |   5 coordinators
    |  source type |  |  & cross-ref |  |  outputs     |   + Quality Lead
    +--------------+  +--------------+  +--------------+   + Data Broker
           |                 |                  |
           v                 v                  v
  +-----------------------------------------------------+
  |                    WORKERS (18)                       |   Layer 3
  |                                                      |   (Bottom)
  |  Scrapers (9)  .  Classifiers (3)  .  Cross-Ref (2) |   Haiku/GPT-5-mini
  |  Writers (2)   .  Auditors (2)                       |
  +------------------------------------------------------+
```

Every arrow is **MessageBox task + BSV payment + BRC-18 proof**. Data flows up through 3 layers, generating transactions at each handoff.

## 25 Agents

| Layer | # | Role | LLM | What |
|-------|---|------|-----|------|
| **Top** | 2 | Captains | claude-opus-4-6 | Set research agenda, commission work, assemble final reports |
| **Mid** | 1 | Scrape Coordinator | gpt-5-mini | Route scraping tasks by source type |
| **Mid** | 1 | Analysis Coordinator | gpt-5-mini | Route classification + cross-ref tasks |
| **Mid** | 1 | Report Coordinator | gpt-5-mini | Assemble writer outputs, manage uploads |
| **Mid** | 1 | Quality Lead | claude-sonnet-4-6 | Spot-check random work, score agents |
| **Mid** | 1 | Data Broker | gpt-5-mini | Buy/sell intermediate data between tracks |
| **Bottom** | 9 | Scrapers | gpt-5-mini | Reddit (2), HN, X/Twitter (2), SEO, Web Reader (2), RSS |
| **Bottom** | 3 | Classifiers | gpt-5-mini | Rule engine + LLM fallback for topics, sentiment, entities |
| **Bottom** | 2 | Cross-Referencers | gpt-5-mini | Multi-source signal detection, trend tracking |
| **Bottom** | 2 | Writers | claude-sonnet-4-6 | Batch briefs, deep dives, daily report sections |
| **Bottom** | 2 | Quality Auditors | claude-sonnet-4-6 | Spot-check scraped data and analysis |
| | **25** | | **2 Opus + 5 Sonnet + 18 fast** | |

## How Agents Discover Each Other

All 25 register on the **same overlay** ([rust-overlay](https://rust-overlay.dev-a3e.workers.dev)) at startup using BRC-100 + BRC-56:

1. Each agent creates a PushDrop with `[AGENT, identity_key, certifier_key, name, capabilities, signature]`
2. Submits to overlay via `POST /submit` with `x-topics: tm_agent`
3. Other agents discover via `overlay_lookup(findByCapability: "scraping")` -- returns all 9 scrapers
4. Agents verify each other's BRC-52 certificates -- same parent = same pod = trusted

No hardcoded addresses. No central registry. Trustless discovery.

## How Data Flows Between Agents

Agents have isolated workspaces. Data moves via:

| Mechanism | Use |
|-----------|-----|
| **MessageBox** (BRC-33) | Task assignments, results, summaries (small-medium data) |
| **NanoStore** (x402 upload) | Large datasets, reports -- upload once, share UHRP URL |
| **memory_store / memory_search** | Per-agent recall -- what I've done, what I know |

Captain stores structured memories with tags, NanoStore URLs, and provenance txids. When assembling the daily report: `memory_search("top signals across all hours")` returns everything needed.

## Transaction Breakdown

Transactions come from the worm's **natural proof loop** -- no artificial inflation:

| Source | 24h Volume | How |
|--------|-----------|-----|
| LLM inference payments (x402) | ~169K | Every iteration pays for thinking |
| BRC-18 Decision proofs | ~169K | Every iteration records what happened |
| BRC-48 Budget tokens | ~338K | Every iteration updates budget state (spend + create) |
| Inter-agent messages | ~125K | MessageBox task delegation up/down the pyramid |
| Task lifecycle tokens | ~150K | Setup + teardown per task |
| x402 external services | ~63K | X-Research, SEO, Web Reader, NanoStore |
| Quality challenges + certs | ~22K | Spot-checks and reputation |
| **TOTAL** | **~1.5M** | All from built-in worm mechanics |

Every tx is a real payment, proof, token, or message proof. No batch scripts. No artificial volume.

## Cost

| Category | USD |
|----------|-----|
| LLM inference (Opus + Sonnet + Haiku) | $21 |
| x402 data services (X, SEO, Web Reader) | $18 |
| Miner fees (1.5M txs) | $6 |
| **TOTAL** | **~$45** |

Initial funding: ~290M sats (~$49) across 25 wallets. Most sats circulate between agents.

## Hardware

Runs on a single machine:

| Resource | Used | Available |
|----------|------|-----------|
| RAM | 10.25 GB (measured) | 32 GB |
| CPU | ~1.5 cores avg | 10 cores (M1 Max) |
| Disk | ~3 GB | 500+ GB |

Per agent: ~80 MB (worm) + ~90 MB (wallet) = 170 MB. Measured with live processes.

## Output

**Every ~20 minutes**: Batch research report -- top findings, cross-source signals, sentiment, provenance links. Stored on NanoStore.

**Every hour (24/day)**: Hourly trend brief -- what's trending now vs last hour, emerging narratives.

**4-6 per day**: Deep dives -- when cross-source signals converge, Captain commissions a deep investigation.

**End of run**: Daily intelligence report -- 10-page deliverable with executive summary, top 50 trending topics, full provenance appendix.

### Provenance traceability (3 layers deep)

A judge reads a claim in the daily report and clicks the provenance link:

```
Daily Report (Captain Alpha)
  +-- claim cites: Hourly Brief #14 (Writer-A, txid: abc123...)
      +-- based on: Cross-reference batch #47 (CrossRef-A, txid: def456...)
          +-- classified by: Classifier-B (txid: ghi789...)
              +-- scraped by: Reddit-A (txid: jkl012...)
                  +-- source: reddit.com/r/machinelearning, 2026-04-16T14:32:00Z
```

Every layer has an on-chain proof. Every handoff has a payment txid.

## Data Sources

| Source | Method | Cost | 24h Volume |
|--------|--------|------|-----------|
| Reddit (100+ subs) | web_fetch JSON API | FREE | ~200K records |
| Hacker News | web_fetch Firebase API | FREE | ~19K records |
| RSS feeds (50+ sources) | web_fetch | FREE | ~20K articles |
| BSV blockchain | web_fetch WhatsOnChain | FREE | ~50K data points |
| X/Twitter | x402 X-Research | 36K sats/page | ~10K tweets |
| SEO (SERP + suggest) | x402 SEO service | 15K sats/call | ~8K results |
| Web articles | x402 Web Reader | 18K sats/call | ~3K articles |

## Project Structure

```
DolphinMilkShake/
+-- agents/                 # Per-agent dolphin-milk.toml configs (25 files)
+-- prompts/                # System prompts by role (~7 templates)
|   +-- captain.md          # Research orchestration + report assembly
|   +-- coordinator.md      # Task dispatch + aggregation
|   +-- scraper.md          # Source-specific scraping
|   +-- classifier.md       # Rule engine + LLM fallback
|   +-- crossref.md         # Multi-source correlation
|   +-- writer.md           # Report writing + NanoStore uploads
|   +-- auditor.md          # Spot-check + quality scoring
+-- seeds/
|   +-- questions.json      # Pre-seeded research questions
+-- tools/
|   +-- classifier.py       # Rule-based classifier (95% coverage)
+-- scripts/
|   +-- launch.sh           # Start/stop/status all 25 agents
|   +-- provision.sh        # Spin up 25 wallets + fund + certify
+-- ARCHITECTURE.md         # Full technical design (agent roster, tx math, hardware)
+-- DOLPHINSENSE.md         # Original 4-agent design doc
+-- CLAUDE.md
+-- README.md
```

## Quick Start

```bash
# 1. Provision wallets (23 new wallets + fund from parent)
./scripts/provision.sh

# 2. Launch all 25 agents
./scripts/launch.sh

# 3. Open Mission Control
open http://localhost:4000

# 4. Watch agents discover each other, start researching, produce reports
```

## Dependencies

- [rust-bsv-worm](https://github.com/Calgooon/rust-bsv-worm) -- autonomous agent framework. Each agent is an unmodified worm instance with a system prompt.
- [rust-overlay](https://github.com/Calgooon/rust-overlay) -- BSV overlay services for agent discovery. Deployed at https://rust-overlay.dev-a3e.workers.dev

## Hackathon Requirements

| Requirement | How |
|-------------|-----|
| 2+ AI agents with BSV wallets | 25 agents, each with own BRC-100 wallet |
| 1.5M meaningful txs in 24h | ~1.5M from natural worm proof loop. No inflation. |
| Discover via BRC-100 + identity | overlay_lookup by capability + BRC-52 cert verification |
| Transact autonomously | MessageBox P2P + BSV micropayments + x402 services |
| Solve a real problem | Verifiable content intelligence with on-chain provenance |
| Human-facing web UI | Mission Control: 25 agent cards, pipeline flow, report feed |

## License

MIT
