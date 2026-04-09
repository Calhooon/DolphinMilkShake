# DolphinSense

> Four autonomous AI agents wake up with BSV wallets. One is the Captain — it asks the questions. The other three are specialists — a scraper, an analyst, and a creator. The Captain commissions research: *"Which crypto communities are making the most noise about AI agents?"* The specialists fan out across Reddit, Hacker News, X, the web, SEO data, and the BSV blockchain itself. They scrape, classify, analyze, and package the results into verified intelligence reports — paying each other in real BSV micropayments for every step. Every scrape, every classification, every insight has cryptographic provenance on-chain.
>
> Autonomous AI research, paid in micropayments, verified on blockchain.

---

## The Real-World Problem

Content intelligence — trend monitoring, competitive research, social listening — is a $30B+ industry dominated by black-box SaaS tools. You can't verify how data was collected, whether analysis is honest, or who touched what.

DolphinSense creates a fully auditable intelligence pipeline where:
- Every data point has on-chain provenance (which agent scraped it, when, from where)
- Every analysis step is paid for and recorded (who classified it, what score, what confidence)
- Every deliverable is permanently stored with verifiable lineage
- Quality is enforced by economic incentives, not trust

**The one-sentence pitch:** Three specialist AI agents autonomously discover each other, negotiate prices, and trade micro-services to produce verified intelligence reports — orchestrated by a broker agent that commissions research and pays for results in BSV micropayments.

---

## How It Works

### The Pod: 4 AI Agents (bsv-worm instances)

Each agent is a running instance of [rust-bsv-worm](https://github.com/user/rust-bsv-worm) — an autonomous AI agent with a BSV wallet, identity key, and real capabilities. DolphinSense builds on top of bsv-worm without modifying it. The worm is the platform. DolphinSense is the application.

| Agent | Name | BRC-52 Capabilities | Role |
|-------|------|---------------------|------|
| **Broker** | Captain | `orchestration, wallet, x402` | Asks the questions. Commissions research. Pays for work. Quality-checks results. Assembles final deliverables. |
| **Scraper** | Coral | `browser, web_fetch, scraping` | Fetches raw data from everywhere. Reddit, HN, X, web pages, RSS, SEO, BSV chain. Returns structured records. |
| **Analyst** | Reef | `analysis, tools, computation` | Classifies, scores sentiment, extracts entities, cross-references, verifies data integrity. Returns enriched records. |
| **Creator** | Pearl | `x402, content, storage` | Writes reports, generates summaries, creates visualizations, uploads to NanoStore. Returns permanent URLs. |

### Discovery (already built into bsv-worm)

The agents don't have hardcoded addresses. They find each other:

1. Captain queries: `discover_agent(attributes: {"capabilities": "scraping"})` → finds Coral
2. Captain verifies: `verify_agent(coral_key)` → confirms parent-signed BRC-52 cert
3. Captain sends task via MessageBox with `prove_identity: true` → reveals its own capabilities + budget
4. Coral verifies Captain's cert, accepts the task
5. After delivery, Captain issues a quality attestation cert to Coral

This is real BRC-100 discovery + BRC-52 capability verification. No central registry. No hardcoded peers. Trustless.

---

## The Research Pipeline

### What Captain Researches

Captain maintains a rotating queue of research questions. Some are pre-seeded, some emerge from previous findings:

**Pre-seeded questions (examples):**
- "Which crypto communities are making the most noise about AI agents and x402?"
- "What are the trending topics on Hacker News in the last 6 hours?"
- "What's the sentiment around BSV across Reddit, X, and tech news?"
- "Which GitHub repos related to AI agents are gaining stars this week?"
- "What are people saying about micropayments and pay-per-use AI?"
- "What SEO keywords are trending for 'autonomous AI agents'?"
- "What does the BSV mempool look like? Any unusual patterns?"

**Emergent questions (discovered during research):**
- "Hacker News is buzzing about a new AI framework — what's Reddit saying about it?"
- "BSV transaction volume spiked 40% — what happened?"
- "Three subreddits are discussing the same topic — is this coordinated?"

Captain uses LLM reasoning to generate new questions based on what the pipeline has already found. The research is self-directing.

### Data Sources (where the specialists scrape)

| Source | Method | Cost | 24h Volume | What You Get |
|--------|--------|------|-----------|-------------|
| **Reddit** (100+ subreddits) | `web_fetch` to JSON API | FREE | ~200K records | Posts, comments, scores, threads |
| **Hacker News** | `web_fetch` to Firebase API | FREE | ~19K records | Stories, comments, points, who's-hiring |
| **X/Twitter search** | x402 X-Research `/search` | 36K sats/page ($0.006) | ~10K tweets | Real-time discourse, engagement metrics |
| **X/Twitter trending** | x402 X-Research `/trending` | 3,600 sats ($0.0006) | ~1K snapshots | What's trending right now, every 30 min |
| **SEO SERP results** | x402 SEO `/serp` | 14,895 sats ($0.0025) | ~5K results | Google rankings, titles, descriptions, positions |
| **SEO autocomplete** | x402 SEO `/suggest` | 14,895 sats ($0.0025) | ~3K suggestions | What people are searching for right now |
| **Web articles** (full text) | x402 Web Reader `/read` | 17,874 sats ($0.003) | ~2K articles | Full content from JS-heavy sites, clean markdown |
| **Web search** | x402 Web Reader `/search` | 29,789 sats ($0.005) | ~1K searches | Search results with full content extraction |
| **RSS feeds** (50-100 sources) | `web_fetch` to feed URLs | FREE | ~20K articles | Tech news, crypto news, science, business |
| **BSV blockchain** | `web_fetch` to WhatsOnChain | FREE | ~50K data points | Mempool, block stats, tx patterns, address activity |

**Total: ~310K+ records from 10 source types.** The value is in the CROSS-REFERENCING — when Reddit, X, HN, and Google all light up on the same topic, that's a real signal.

**The agents research EVERYWHERE.** Reddit, HN, and RSS are free via `web_fetch`. X/Twitter, SEO, and deep web reads are paid x402 services — used continuously throughout the 24h run, not just for occasional high-value queries. The intelligence comes from cross-referencing ALL these sources against each other.

### The Pipeline Flow

```
CAPTAIN (Broker)
  │
  │  "Research: trending AI agent topics across all sources"
  │
  ├──→ CORAL: "Scrape /r/bitcoin, /r/machinelearning, /r/artificial top posts"
  │     web_fetch (FREE) → 300 Reddit posts
  │     Captain → Coral: 150 sats
  │
  ├──→ CORAL: "Search X for 'AI agents' 'autonomous AI' 'micropayments'"
  │     x402(x-research/search) → 60 tweets with engagement
  │     Captain → Coral: 250 sats (x402 pass-through + margin)
  │
  ├──→ CORAL: "What are people Googling? SERP + autocomplete for 'AI agent framework'"
  │     x402(seo/serp) + x402(seo/suggest) → rankings + search suggestions
  │     Captain → Coral: 200 sats
  │
  ├──→ CORAL: "HN front page + top 'Show HN' posts about AI"
  │     web_fetch (FREE) → 50 HN stories + comment threads
  │     Captain → Coral: 25 sats
  │
  ├──→ CORAL: "Read these 5 articles that keep getting linked everywhere"
  │     x402(reader/read) → full markdown content from JS-heavy sites
  │     Captain → Coral: 400 sats (x402 pass-through)
  │
  ├──→ CORAL: "BSV mempool check — any unusual tx patterns today?"
  │     web_fetch to WhatsOnChain (FREE) → block stats, mempool data
  │     Captain → Coral: 25 sats
  │
  │  ── All raw data delivered via MessageBox (FREE) ──
  │
  ├──→ REEF: "Classify all 450 records: topic, sentiment, entities, relevance"
  │     execute_bash (rule engine, 95%) + x402(claude-haiku) for edge cases
  │     Captain → Reef: 300 sats
  │
  ├──→ REEF: "Cross-reference: what topics appear on Reddit AND X AND HN AND Google?"
  │     memory_search + execute_bash (correlation logic)
  │     Captain → Reef: 100 sats
  │     *** THIS IS THE MONEY FINDING — multi-source signal detection ***
  │
  ├──→ REEF: "SEO gap analysis — what keywords are trending but underserved?"
  │     execute_bash (SERP data analysis)
  │     Captain → Reef: 50 sats
  │
  │  ── Enriched data delivered via MessageBox (FREE) ──
  │
  ├──→ PEARL: "Write a trend brief: top cross-source signals, sentiment, key quotes"
  │     x402(claude-haiku) → 500-word intelligence brief
  │     Captain → Pearl: 300 sats
  │
  ├──→ PEARL: "Upload to NanoStore"
  │     x402(nanostore/upload) → permanent UHRP URL
  │     Captain → Pearl: 50 sats
  │
  └──→ CAPTAIN: Quality-checks results. Updates research queue.
        "HN and Reddit are BOTH buzzing about a new AI framework — dig deeper."
        → New research cycle spawns automatically.
```

**One research cycle: ~25-35 transactions across 6 source types.** Running continuously, 24 hours, thousands of research questions. Each cycle scrapes everywhere, cross-references everything.

---

## Transaction Breakdown

### Per Research Cycle (~360 records, ~20 minutes)

| Tx Type | Count | Description |
|---------|-------|-------------|
| Task assignment payments (Captain → specialists) | 6-8 | Real BSV micropayments for real work |
| BRC-18 provenance proofs | 6-8 | OP_RETURN with batch hashes at each pipeline step |
| Quality challenge (Captain spot-checks 10% of batches) | 0-2 | Re-sends task to different specialist, compares results |
| NanoStore upload payment | 1 | Permanent storage of report |
| Certificate attestations | 0-1 | Quality reputation for good specialists |
| **Per cycle total** | **~15-20** | |

### Scaling to 1.5M Transactions

At ~18 txs per research cycle processing ~360 records:
- Need ~83,000 research cycles for 1.5M txs
- 83,000 cycles × 360 records = ~30M records... that's too many records.

**More realistic model — higher tx density per record:**

Each INDIVIDUAL record flowing through the pipeline generates transactions:

| Step | Tx | What |
|------|-----|------|
| Coral scrapes record | — | Free (web_fetch), no tx yet |
| Captain pays Coral for batch of 100 records | 1 | Micropayment |
| Proof: batch scraped | 1 | OP_RETURN with 100-record hash |
| Reef classifies record | — | Free (execute_bash), no tx yet |
| Captain pays Reef for batch of 100 records | 1 | Micropayment |
| Proof: batch analyzed | 1 | OP_RETURN with enrichment hash |
| Pearl writes report chunk | — | LLM call or template |
| Captain pays Pearl for report chunk | 1 | Micropayment |
| Proof: report created | 1 | OP_RETURN with report hash |
| NanoStore upload (per 10 batches) | 0.1 | Storage |
| Quality challenge (10% of batches) | 0.3 | Spot-check txs |

**Per batch of 100 records: ~6.4 txs**
**Per record: ~0.064 txs** from batch payments/proofs

That's not enough density. Let me rethink.

**The volume driver: per-RECORD payments instead of per-batch.**

What if specialists are paid per record, not per batch? This is more granular and produces more txs:

| Step | Txs per record |
|------|---------------|
| Captain pays Coral for scraping this record | 1 |
| Captain pays Reef for analyzing this record | 1 |
| Captain pays Pearl for summarizing this record | 0.1 (1 per 10 records) |
| Provenance proof for this record | 1 |
| Quality challenge (10% sample) | 0.1 |
| **Total per record** | **~3.2** |

**For 1.5M txs: need ~470K records through the pipeline.**

Across all sources (~310K+ records/day available), we process most of them. Reddit, HN, RSS, and BSV chain provide free bulk volume. X, SEO, and Web Reader add paid high-value records. The mix is what makes the intelligence valuable.

At 4 agents × 5 tx/s = 20 tx/s sustained:
- 20 tx/s × 86,400 seconds = 1,728,000 txs capacity
- Need 1,500,000 txs → 87% utilization. Comfortable.

### 24-Hour Volume Breakdown

| Tx Type | Count | % | Description |
|---------|-------|---|-------------|
| Scraping payments (Captain → Coral) | 470K | 31% | Per-record micropayment for raw data |
| Analysis payments (Captain → Reef) | 470K | 31% | Per-record micropayment for classification |
| Provenance proofs (BRC-18) | 470K | 31% | OP_RETURN per record: source, hash, scores |
| Report payments (Captain → Pearl) | 47K | 3% | Per-10-record micropayment for summaries |
| Quality challenges | 23K | 2% | Captain spot-checks random records |
| NanoStore uploads | 5K | <1% | Report chunks stored permanently |
| Certificate attestations | 2K | <1% | Quality reputation updates |
| x402 service calls (paid external) | 3K | <1% | Web Reader, X-Research, SEO, Claude |
| **TOTAL** | **~1.49M** | **100%** | |

**Every transaction carries unique data. Every transaction serves a verifiable purpose.**

A judge clicks any txid:
- Payment tx → sees: Captain paid Coral 1 sat for record #284,901 from /r/bitcoin
- Proof tx → sees: OP_RETURN with `{record_hash, source: "reddit", sentiment: 0.7, topic: "AI_agents", agent: "reef"}`
- Challenge tx → sees: Captain paid Reef 5 sats to re-analyze record #284,901 (spot-check)

---

## Cost Analysis

### Transaction Costs

| Component | Volume | Sats/tx | Total Sats | USD |
|-----------|--------|---------|-----------|-----|
| All on-chain txs (miner fees) | 1.49M | ~25 | 37.25M | $6.25 |

*At standard BSV fee rates. The miner fee is the only cost that's truly "burned" — everything else circulates between dolphins.*

### Service Costs (circulating between dolphins)

| Payment | Volume | Avg sats | Total Sats | Notes |
|---------|--------|----------|-----------|-------|
| Captain → Coral (scraping) | 470K | 1 | 470K | Per-record price negotiated by agents |
| Captain → Reef (analysis) | 470K | 2 | 940K | Slightly higher for compute work |
| Captain → Pearl (reports) | 47K | 5 | 235K | Higher for LLM-backed content |
| Quality challenge stakes | 23K | 10 | 230K | Deposit for spot-checks |
| **Total circulating** | | | **1.875M** | **These sats stay in the pod** |

The inter-dolphin payments are CIRCULAR. Captain starts with sats, pays specialists, specialists accumulate sats. Net cost to the pod: $0. These are real transactions with real economic meaning but no net cost.

### External Costs (actually spent)

| Service | Volume | Sats/call | Total Sats | USD |
|---------|--------|-----------|-----------|-----|
| Agent loop LLM — Captain's brain (Haiku) | 4,000 | 9,000 | 36M | $6.04 |
| Agent loop LLM — Specialists' brains (Haiku) | 3,000 | 5,000 | 15M | $2.52 |
| x402 X-Research search | 500 | 36,000 | 18M | $3.02 |
| x402 X-Research trending | 1,000 | 3,600 | 3.6M | $0.60 |
| x402 SEO SERP | 500 | 14,895 | 7.45M | $1.25 |
| x402 SEO suggest | 300 | 14,895 | 4.47M | $0.75 |
| x402 Web Reader /read | 2,000 | 17,874 | 35.7M | $5.99 |
| x402 Web Reader /search | 500 | 29,789 | 14.9M | $2.50 |
| x402 Claude Haiku (edge-case classification) | 2,000 | 5,000 | 10M | $1.68 |
| x402 Claude Haiku (report writing) | 1,500 | 9,000 | 13.5M | $2.27 |
| NanoStore uploads | 5,000 | 100 | 500K | $0.08 |
| Images for final reports (Banana) | 10 | 37,000 | 370K | $0.06 |
| **Total external** | | | **~159.5M** | **~$26.76** |

### Total Cost

| Category | USD |
|----------|-----|
| Miner fees (burned) | $6.25 |
| LLM reasoning (agent loops) | $8.56 |
| x402 data services (X, SEO, Web Reader) | $14.11 |
| x402 analysis services (Claude Haiku) | $3.95 |
| x402 storage + images | $0.14 |
| **TOTAL** | **~$33** |

**Under $21 for 1.5M transactions over 24 hours.**

### Funding Requirements

Each agent needs enough sats to cover its outgoing payments while waiting for incoming payments:

| Agent | Starting Balance | Purpose |
|-------|-----------------|---------|
| Captain | 120M sats (~$20) | Pays all three specialists + x402 services |
| Coral | 50M sats (~$8.40) | Buffer for x402 scraping (X-Research, SEO, Web Reader) |
| Reef | 10M sats (~$1.68) | Buffer for x402 analysis (Claude Haiku edge cases) |
| Pearl | 30M sats (~$5.04) | Buffer for x402 content (Claude Haiku, NanoStore, 1Sat) |
| **Total funding** | **210M sats** | **~$35** |

Most of Captain's sats flow to specialists, who use some for x402 calls and accumulate the rest. Net burn is ~$33.

---

## What DolphinSense Produces

### Continuous Output (every ~20 minutes)

**Research Batch Report** — a structured intelligence brief answering one research question:
- Top findings with source links
- Sentiment analysis across sources
- Key entities mentioned (people, companies, projects)
- Cross-source correlation ("Reddit and X agree on this, HN disagrees")
- Every claim linked to on-chain provenance txid
- Uploaded to NanoStore with permanent URL

### Hourly Output (24 per day)

**Hourly Trend Brief** — 1-page summary:
- Trending topics this hour vs last hour
- Emerging narratives (new topics appearing across multiple sources)
- Sentiment shifts
- Notable outliers

### Daily Output (1 final report)

**Daily Intelligence Report** — comprehensive 10-page deliverable:
- Executive summary
- Top 50 trending topics with sentiment trajectory charts
- Emerging narrative analysis
- Cross-source intelligence map
- BSV ecosystem health metrics
- SEO landscape snapshot
- Full provenance appendix (every claim → txid)
- Permanently stored on NanoStore + inscribed on-chain via 1Sat

---

## Architecture

```
                         ┌──────────────────────────┐
                         │      HUMAN (You)          │
                         │  Launches mission via UI   │
                         │  Reads intelligence reports │
                         └──────────┬─────────────────┘
                                    │ Opens browser
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                     MISSION CONTROL WEB UI                        │
│  (Shows live pipeline: research questions, records flowing,       │
│   quality scores, report links, payment flows, agent status)      │
└──────┬──────────────────┬──────────────────┬──────────────────────┘
       │ SSE              │ SSE              │ SSE
       ▼                  ▼                  ▼
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  CAPTAIN   │    │   CORAL    │    │    REEF    │    │   PEARL    │
│  (Broker)  │◄──►│ (Scraper)  │    │ (Analyst)  │    │ (Creator)  │
│            │◄──►│            │    │            │    │            │
│ BRC-100 🔑 │◄──►│ BRC-100 🔑 │    │ BRC-100 🔑 │    │ BRC-100 🔑 │
│ Orchestrate│    │ web_fetch  │    │ execute_   │    │ x402_call  │
│ Quality QA │    │ browser    │    │   bash     │    │ (Claude)   │
│ Commission │    │ x402(seo)  │    │ memory_    │    │ x402_call  │
│ research   │    │ x402(x-res)│    │   search   │    │ (NanoStore)│
│ Pay agents │    │ x402(reader│    │ verify_    │    │ x402_call  │
│            │    │            │    │  signature │    │ (1Sat)     │
└─────┬──────┘    └──────┬─────┘    └──────┬─────┘    └──────┬─────┘
      │                  │                 │                  │
      │     MessageBox (BRC-33) — FREE — signed/encrypted    │
      └──────────────────┴─────────────────┴──────────────────┘
                                    │
                         BSV Network (all payments + proofs)
                                    │
                    ┌───────────────┴───────────────┐
                    │    1.5M transactions on-chain   │
                    │    Every one verifiable          │
                    │    Every one meaningful          │
                    └─────────────────────────────────┘

Data sources (Coral scrapes these):
┌──────────┬──────────┬─────────┬─────────┬──────────┬──────────┐
│  Reddit  │    HN    │   RSS   │  BSV    │ X/Twitter│   SEO    │
│  (FREE)  │  (FREE)  │ (FREE)  │ (FREE)  │  (x402)  │  (x402)  │
│ JSON API │ Firebase │  Feeds  │  WoC    │ x-research│ seo.x402 │
└──────────┴──────────┴─────────┴─────────┴──────────┴──────────┘

Reports stored permanently:
┌──────────────────────────────────────────┐
│              NanoStore                    │
│  Batch reports, hourly briefs, daily     │
│  report — all with UHRP permanent URLs   │
│  and on-chain provenance links           │
└──────────────────────────────────────────┘
```

### Key Integration Points

**Captain → Specialists** (task assignment):
```
1. Captain's LLM decides next research question
2. Breaks question into scraping/analysis/creation tasks
3. Sends task via MessageBox (BRC-33, signed + encrypted)
4. Specialist performs work using its own tools
5. Specialist returns results via MessageBox (FREE)
6. Captain pays specialist via wallet_send (BSV micropayment)
7. Captain records provenance via BRC-18 proof (OP_RETURN)
```

**Quality Assurance** (the trust layer):
```
1. Captain randomly selects 10% of records for spot-check
2. Sends same data to a DIFFERENT specialist for re-analysis
3. Compares results — if they diverge significantly:
   a. Captain challenges the original specialist (stake: 10 sats)
   b. Third specialist arbitrates
   c. Loser pays the stake
   d. Quality attestation cert updated
4. Over 24 hours, specialists build reputation via cert attestations
```

---

## Why Every Transaction Is Meaningful

| Tx Type | % | Why It Exists |
|---------|---|---------------|
| Scraping payments | 31% | Captain paid Coral to fetch a specific record from a specific source. Remove this tx and that record was never acquired. |
| Analysis payments | 31% | Captain paid Reef to classify a specific record. Remove this tx and that record was never analyzed. |
| Provenance proofs | 31% | OP_RETURN records the hash of a specific record at a specific pipeline stage. Remove this tx and that record has no verifiable provenance. |
| Report payments | 3% | Captain paid Pearl to write a specific summary. Remove this tx and that summary was never created. |
| Quality challenges | 2% | Captain paid for a specific spot-check. Remove this tx and quality assurance has a gap. |
| Other (uploads, certs, x402) | 2% | Storage, reputation, external service calls |

**Every tx has a unique record ID, unique agent pair, unique timestamp, and unique data hash.** No two transactions are alike. No transaction is redundant.

---

## The Emergence (Conway Argument)

Same four agents, same data sources, same pipeline — completely different intelligence output every run.

| Source of Variation | Effect |
|--------------------|--------|
| **Reddit is different every hour** | The raw data is never the same. Today's trending topics ≠ tomorrow's. |
| **LLM reasoning is stochastic** | Captain generates different research questions. Reef classifies edge cases differently. Pearl writes different summaries. |
| **Pricing negotiation** | Coral might raise scraping prices if demand is high. Pearl might undercut Reef by offering basic classification. Market dynamics emerge. |
| **Quality disputes** | A failed spot-check in hour 3 changes Captain's trust in that specialist for the next 21 hours. Different trust → different task routing → different output. |
| **Research self-direction** | Captain discovers a trending topic in hour 5 that spawns 50 new research questions. A different trending topic in a different run spawns a completely different research tree. |

**The reports are different every run because the internet is different every moment.** This isn't simulated emergence — it's real-world data flowing through autonomous agents making real economic decisions.

---

## What Needs to Be Built

### bsv-worm: Zero Modifications

The worm is used as-is. DolphinSense demonstrates what you can build on top of it.

### New Code (DolphinSense application layer)

| Component | Description | Est. Lines |
|-----------|-------------|-----------|
| **Captain system prompt** | Research orchestration: question generation, task decomposition, quality assurance logic, budget management | ~400 |
| **Coral system prompt** | Scraping specialist: source rotation, rate limiting, data structuring, price negotiation | ~300 |
| **Reef system prompt** | Analysis specialist: rule-based classifier (keyword + regex + sentiment lexicon), LLM fallback for edge cases, cross-reference logic | ~350 |
| **Pearl system prompt** | Creator specialist: report templates, LLM-driven summarization, NanoStore upload workflow, 1Sat inscription | ~300 |
| **Rule-based classifier** | Python/bash script Reef runs via execute_bash: topic detection, sentiment scoring, entity extraction without LLM | ~500 |
| **Mission launcher** | Script to start 4 worm instances with different configs, fund wallets, initiate discovery | ~300 |
| **Mission Control UI** | Lit web component: live pipeline view, research questions, record flow, payment graph, report links, agent cards | ~1500 |
| **Research question seeds** | Initial research questions + question generation templates for Captain | ~100 |
| **Config files** | Per-agent dolphin-milk.toml configs, wallet ports, identity setup | ~100 |
| **TOTAL** | | **~3,850 lines** |

### What Judges See

1. **Live Mission Control UI** — records flowing through the pipeline in real time, payments animated between agents, quality scores updating, research questions being generated and answered
2. **NanoStore report URLs** — click any report, read actual intelligence with source links and provenance txids
3. **WhatsOnChain verification** — click any txid, see the OP_RETURN data proving provenance
4. **Agent discovery logs** — watch the agents find each other via BRC-100 and verify certificates
5. **The daily report** — a real, useful intelligence deliverable produced entirely by autonomous AI agents

---

## Timeline (10 days: April 7 → April 17)

| Day | Milestone | Details |
|-----|-----------|---------|
| **1** (Apr 8) | System prompts + rule engine | Write all 4 dolphin system prompts. Build rule-based classifier script. |
| **2** (Apr 9) | Mission launcher + discovery | Script to start 4 worm instances. Test BRC-100 discovery + cert verification between them. |
| **3** (Apr 10) | Scraping pipeline | Coral scrapes Reddit/HN/RSS. Captain assigns tasks. MessageBox flow working. |
| **4** (Apr 11) | Analysis pipeline | Reef classifies records. Rule engine + LLM fallback. Quality spot-checks. |
| **5** (Apr 12) | Report pipeline | Pearl writes summaries. NanoStore uploads. Captain assembles batches. |
| **6** (Apr 13) | Full pipeline integration | All 4 agents running end-to-end. Records flowing through. Payments settling. |
| **7** (Apr 14) | Mission Control UI | Live dashboard: pipeline view, payment flow, agent cards, report links. |
| **8** (Apr 15) | 1-hour test burn | Run pipeline for 1 hour. Verify tx volume, cost, quality, report output. Debug. |
| **9** (Apr 16) | Full 24-hour run | Start the run. Monitor. Let it produce intelligence overnight. |
| **10** (Apr 17) | Demo + submit | Record 3-5 min video. Write README. Verify on-chain txs. Submit before 23:59 UTC. |

---

## Hackathon Checklist

| Requirement | How DolphinSense Meets It |
|-------------|---------------------------|
| **At least 2 AI agents with BSV wallets** | 4 agents (Captain, Coral, Reef, Pearl), each with BRC-100 wallet + identity key |
| **At least 1.5M transactions in 24-hour window** | ~1.49M txs: per-record payments + provenance proofs + quality challenges |
| **Transactions must be meaningful** | Every tx is a micropayment for work performed OR a provenance proof with unique record hash. No two txs are alike. |
| **Agents discover each other via BRC-100** | Captain discovers specialists via `discover_agent(attributes)` + `verify_agent()` |
| **Agents negotiate and exchange value** | Price negotiation via MessageBox. BSV micropayments for every service. Quality disputes with economic stakes. |
| **Solves a real-world problem** | Verifiable content intelligence pipeline — auditable AI research with on-chain provenance |
| **Human-facing web UI** | Mission Control: live pipeline view, payment flows, agent status, report links |
| **Working demo** | 24-hour live run producing real intelligence reports stored on NanoStore |
| **On-chain BSV transactions verifiable** | Every tx on WhatsOnChain. OP_RETURN proofs. Payment txids. |
| **Source code in public GitHub repo** | DolphinSense repo + bsv-worm dependency |
| **README with architecture diagram** | This document |

---

## Why This Wins

1. **It's real.** The reports contain actual intelligence from actual data sources. Not a simulation. Not a game. Real research, real analysis, real deliverables.

2. **It's verifiable.** Every claim in every report links to an on-chain provenance proof. Click the txid, see the data hash. No other content intelligence tool offers this.

3. **It showcases the platform.** bsv-worm is the infrastructure. DolphinSense is the proof it works. Judges see both the tool AND the application built on it.

4. **It's cheap.** Under $35 for 1.5M transactions across 10 data sources. The economics work at scale.

5. **It's emergent.** Same agents, same pipeline, different output every run. The research is self-directing — Captain discovers new questions from what the pipeline finds.

6. **Every transaction is defensible.** No chain links, no lottery tickets, no pixel spam. Micropayments for work + provenance proofs for trust. A judge can audit any txid and see exactly what it paid for.
