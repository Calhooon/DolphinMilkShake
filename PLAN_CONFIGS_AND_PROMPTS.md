# Plan: 25-Agent Configs & Prompts (#19) + Memory Recall Prep (#15)

## 1. Overview

Write 4 new system prompt templates, update the 4 existing prompts for the 3-layer pyramid, and create all 25 TOML agent configs. Then prep the memory recall POC (#15) test against a live worm.

## 2. Current State

**Prompts (4 exist, 4 new needed):**
- `captain.md` — exists, 210 lines. References flat 4-agent structure (Coral/Reef/Pearl directly). Needs update for Opus model, coordinator layer, 25-agent discovery.
- `coral.md` — exists, 227 lines. Detailed scraping instructions per source. Good template for all 9 scrapers. References Captain directly — needs to reference Scrape Coordinator instead.
- `reef.md` — exists, 198 lines. Classification pipeline + cross-reference. Needs splitting — classifiers vs cross-referencers are now separate roles.
- `pearl.md` — exists, 208 lines. Report writing + NanoStore uploads. Good template for writers. References Captain — needs to reference Report Coordinator.
- `coordinator.md` — **DOES NOT EXIST.** Core new template: dispatch tasks to workers, aggregate results, report to Captain.
- `crossref.md` — **DOES NOT EXIST.** Extracted from reef.md's cross-reference section.
- `auditor.md` — **DOES NOT EXIST.** Quality spot-checks: re-scrape or re-classify, compare, report discrepancies.
- `broker.md` — **DOES NOT EXIST.** Data brokering: buy/sell intermediate data between research tracks.

**Configs (4 exist, 21 new needed):**
- `captain.toml` — exists, 93 lines. Port 3001, wallet 3322, Sonnet model. Needs update: Opus model, new capabilities string.
- `coral.toml`, `reef.toml`, `pearl.toml` — exist. Need port/wallet/name updates for specific agent instances.
- 21 new configs needed, but they're mostly copy-paste with different: port, wallet port, name, capabilities, model, budget, system_prompt_file.

**Config schema** (from `src/config/schema.rs`): DmConfig has ~22 sections. Key ones for per-agent variation: wallet.url, llm.default_model, budget.*, heartbeat.inbox_poll_secs, certificates.agent_name, overlay.capabilities, overlay.agent_name, system_prompt_file.

## 3. Proposed Approach

### Prompts: Hierarchy Update

The key change from 4-agent to 25-agent is the **communication pattern**:

```
OLD (flat):     Captain ←→ Coral/Reef/Pearl directly
NEW (pyramid):  Captain ←→ Coordinators ←→ Workers
```

Workers no longer talk to Captain. They talk to their coordinator. Coordinators aggregate and report up. This means:

- **Captain prompt**: Discovers COORDINATORS (not workers). Sends research questions to Scrape Coord, gets aggregated results from Analysis Coord, commissions reports via Report Coord.
- **Coordinator prompts**: Discovers WORKERS by capability. Dispatches tasks, collects results, aggregates, reports to Captain.
- **Worker prompts**: Receives tasks from coordinator. Does work. Returns results to coordinator. Never talks to Captain.

### Prompts: Template Strategy

| Template | Used by | Variation per instance |
|----------|---------|----------------------|
| `captain.md` | Captain Alpha, Captain Beta | Alpha = real-time track, Beta = deep research track |
| `coordinator.md` | Scrape Lead, Analysis Lead, Report Lead, Quality Lead, Data Broker | Different dispatch logic per coordinator type. Could be one template with sections, or 3 variants. |
| `scraper.md` (renamed coral.md) | 9 scrapers | Source-specific instructions injected via config or prompt header |
| `classifier.md` (renamed reef.md) | 3 classifiers | Identical — just load-balanced |
| `crossref.md` | 2 cross-referencers | Identical — topic correlation vs trend tracking |
| `writer.md` (renamed pearl.md) | 2 writers | Writer-A = batch briefs, Writer-B = deep dives |
| `auditor.md` | 2 auditors | Auditor-A = scrape spot-checks, Auditor-B = analysis spot-checks |

**Decision: coordinator.md as one template with role-specific sections, or separate files?**

Recommendation: **One `coordinator.md` with 3 modes** (scrape/analysis/report) selected by a `coordinator_role` field injected at the top. Quality Lead and Data Broker get separate short prompts since their behavior is quite different.

Actually, simpler: **5 coordinator variants**:
- `coordinator-scrape.md` — dispatch to scrapers, aggregate raw data
- `coordinator-analysis.md` — dispatch to classifiers + cross-referencers, aggregate enriched data
- `coordinator-report.md` — dispatch to writers, assemble final deliverables
- `coordinator-quality.md` — random spot-checks across layers
- `broker.md` — data brokering

### Configs: Template Strategy

All 25 configs share 90% of their content. Differences:

| Field | Varies per agent |
|-------|-----------------|
| `data_dir` | `~/.dolphin-milk-{name}` |
| `wallet.url` | `http://localhost:{3322-3346}` |
| `budget.*` | Captains: high. Coordinators: medium. Workers: low. |
| `llm.default_model` | Opus / Sonnet / gpt-5-mini |
| `heartbeat.inbox_poll_secs` | Workers: 15s. Coordinators: 30s. Captains: 60s. |
| `heartbeat.max_concurrent_tasks` | Workers: 3. Coordinators: 5. Captains: 5. |
| `certificates.agent_name` | Unique per agent |
| `overlay.capabilities` | Per role |
| `overlay.agent_name` | Display name |
| `overlay.endpoint` | `http://localhost:{3001-3025}` |
| `system_prompt_file` | Points to role template |

Everything else (logging, memory, compliance, server, tools, messagebox, browser=false, etc.) is identical.

**Approach**: Write a base template, then generate 25 configs with a script or by hand. Since the user needs to review each one, hand-authoring is better — but with heavy copy-paste.

## 4. Steps

### Step 1: Update captain.md for 25-agent pyramid

Changes:
- Model reference: Opus instead of Sonnet
- Startup: Discover COORDINATORS (scrape, analysis, report, quality), not individual workers
- Research cycle: Send to Scrape Coord (not Coral directly), receive from Analysis Coord, commission via Report Coord
- Budget: Updated for 25-agent cost structure
- Remove all direct references to Coral/Reef/Pearl as individual agents
- Add coordinator management section
- Add hourly/daily report assembly via memory_search

### Step 2: Write coordinator-scrape.md

New template (~200 lines). Responsibilities:
- Discover scrapers via `overlay_lookup(findByCapability: "scraping")`
- Receive research task from Captain
- Break into source-specific sub-tasks
- Dispatch to appropriate scrapers (Reddit tasks → Reddit scrapers, etc.)
- Collect results from all scrapers
- Aggregate into unified dataset
- Send aggregated results back to Captain (or upload to NanoStore + send URL)
- Track scraper performance (response time, record count, failure rate)

### Step 3: Write coordinator-analysis.md

New template (~180 lines). Responsibilities:
- Discover classifiers and cross-referencers
- Receive raw data from Captain (forwarded from Scrape Coord)
- Dispatch classification tasks to classifiers (load-balanced)
- Dispatch cross-reference tasks to cross-referencers
- Aggregate enriched data
- Send back to Captain

### Step 4: Write coordinator-report.md

New template (~150 lines). Responsibilities:
- Discover writers
- Receive report commissions from Captain
- Dispatch batch briefs to Writer-A
- Dispatch deep dives to Writer-B
- Handle NanoStore upload coordination
- Send NanoStore URLs back to Captain

### Step 5: Write coordinator-quality.md

New template (~150 lines). Responsibilities:
- Roaming quality auditor at coordinator level
- Randomly sample work from any layer
- Commission re-analysis from Auditor workers
- Compare original vs re-analysis
- Report quality scores to Captain
- Manage reputation/trust scoring

### Step 6: Write broker.md

New template (~120 lines). Responsibilities:
- Facilitate data exchange between research tracks (Alpha vs Beta)
- When Captain Alpha finds something Captain Beta should know, broker relays
- Manages cross-track data requests
- Price negotiation (simple: fixed per-record rates)

### Step 7: Write crossref.md (extracted from reef.md)

New template (~120 lines). The cross-reference section of reef.md, expanded:
- Receive classified records from Analysis Coordinator
- memory_search for records across all recent cycles
- Group by topic, score signal strength
- Multi-source signal detection (Reddit + X + HN = strong signal)
- Trend tracking: compare current hour vs previous hours
- Anomaly detection: unusual spikes, sentiment reversals
- Return cross-reference report

### Step 8: Write auditor.md

New template (~100 lines). Responsibilities:
- Receive spot-check tasks from Quality Lead
- For scrape audits: re-scrape the same URL, compare records
- For analysis audits: re-classify the same record, compare results
- Return comparison report: match/diverge, confidence delta
- Never look up the original result — classify fresh

### Step 9: Update scraper.md (rename coral.md)

Changes from coral.md:
- Remove "Captain" references → "your coordinator" or "Scrape Coordinator"
- Keep all source-specific scraping instructions (these are gold)
- Add: "You receive tasks from your coordinator, not from Captain"
- Add: "Return results to your coordinator via send_message"
- Per-instance variation: handled by a header comment in the TOML pointing to the same prompt, with the agent's specific source responsibility defined by its overlay capabilities and TOML `overlay.capabilities`

### Step 10: Update classifier.md (rename reef.md)

Changes from reef.md:
- Remove cross-reference section (now in crossref.md)
- Remove "Captain" references → "Analysis Coordinator"
- Keep classification pipeline (rule engine + LLM fallback)
- Keep quality challenge protocol

### Step 11: Update writer.md (rename pearl.md)

Changes from pearl.md:
- Remove "Captain" references → "Report Coordinator"
- Keep report writing process, NanoStore upload, provenance links
- Writer-A focuses on batch briefs + hourly summaries
- Writer-B focuses on deep dives + daily report sections

### Step 12: Create 25 TOML configs

Based on ARCHITECTURE.md roster. One file per agent in `agents/`:

```
agents/
├── captain-alpha.toml      # Port 3001, Wallet 3322, Opus
├── captain-beta.toml       # Port 3002, Wallet 3323, Opus
├── scrape-coord.toml       # Port 3003, Wallet 3324, gpt-5-mini
├── analysis-coord.toml     # Port 3004, Wallet 3325, gpt-5-mini
├── report-coord.toml       # Port 3005, Wallet 3326, gpt-5-mini
├── quality-lead.toml       # Port 3006, Wallet 3327, Sonnet
├── data-broker.toml        # Port 3007, Wallet 3328, gpt-5-mini
├── reddit-a.toml           # Port 3008, Wallet 3329, gpt-5-mini
├── reddit-b.toml           # Port 3009, Wallet 3330, gpt-5-mini
├── hn.toml                 # Port 3010, Wallet 3331, gpt-5-mini
├── twitter-a.toml          # Port 3011, Wallet 3332, gpt-5-mini
├── twitter-b.toml          # Port 3012, Wallet 3333, gpt-5-mini
├── seo.toml                # Port 3013, Wallet 3334, gpt-5-mini
├── webreader-a.toml        # Port 3014, Wallet 3335, gpt-5-mini
├── webreader-b.toml        # Port 3015, Wallet 3336, gpt-5-mini
├── rss.toml                # Port 3016, Wallet 3337, gpt-5-mini
├── classifier-a.toml       # Port 3017, Wallet 3338, gpt-5-mini
├── classifier-b.toml       # Port 3018, Wallet 3339, gpt-5-mini
├── classifier-c.toml       # Port 3019, Wallet 3340, gpt-5-mini
├── crossref-a.toml         # Port 3020, Wallet 3341, gpt-5-mini
├── crossref-b.toml         # Port 3021, Wallet 3342, gpt-5-mini
├── writer-a.toml           # Port 3022, Wallet 3343, Sonnet
├── writer-b.toml           # Port 3023, Wallet 3344, Sonnet
├── auditor-a.toml          # Port 3024, Wallet 3345, Sonnet
└── auditor-b.toml          # Port 3025, Wallet 3346, Sonnet
```

Delete old files: `captain.toml`, `coral.toml`, `reef.toml`, `pearl.toml` (replaced by new names).

### Step 13: Prep POC #15 — Memory Recall Test

Test against the running worm on port 8085 (wallet 3322).

**Setup**: Submit a task to the worm that:
1. Stores 50+ structured memories via `memory_store` simulating 24-hour run data
2. Searches via `memory_search` with broad and narrow queries
3. Verifies correct results returned

**Approach**: Write a test script (`poc/memory-recall-test.sh`) that:
1. Uses the worm's HTTP API to submit a task with a prompt that instructs the agent to store and search memories
2. Polls for completion
3. Inspects the transcript for memory_store and memory_search tool calls + results

**Alternative**: Use a second wallet/worm instance on 3323/another port if we don't want to pollute the existing worm's memory. The worm on 8085 already has state from previous work.

**Recommendation**: Use a fresh worm instance on a different port (e.g., 8086) with wallet on 3323 for a clean test. This avoids contaminating the existing worm and also tests that we can spin up additional instances.

## 5. Risks/Considerations

1. **Prompt length vs context window.** Existing prompts are 200+ lines each. Coordinator prompts add 4-5 more. Total system prompt per agent stays well under context limits (200K tokens for Opus, 128K for GPT-5-mini), but longer prompts = more tokens spent per iteration = higher cost. Keep new prompts concise.

2. **Coordinator prompts are the riskiest.** They don't exist yet and define the core orchestration layer. If coordinators can't reliably dispatch + aggregate, the pyramid breaks. The 3-layer cascade POC (#13) will validate this — but that requires BUG-006 to land first.

3. **Source-specific scraper variation.** 9 scrapers using the same prompt template but different source configs. The prompt tells them all sources; the overlay capabilities tell them which one they handle. Risk: an LLM might try to scrape ALL sources instead of just its assigned one. Mitigation: strong first-line instruction like "You are the Reddit-A scraper. You ONLY scrape Reddit. Do not scrape other sources."

4. **Old 4-agent prompts vs new.** Renaming coral.md → scraper.md etc. breaks the old `system_prompt_file` references in old configs. Since we're replacing all configs, this is fine — but don't delete the old files until the new ones are validated.

5. **Memory recall test may reveal search quality issues.** If tantivy BM25 can't find structured entries reliably, Captain can't assemble reports. This is a foundational risk — better to discover it now than during the 24-hour run.

6. **25 TOML files is a lot of copy-paste.** Error-prone. Consider generating them with a script, but hand-review each one. A single wrong port assignment breaks an agent.

## 6. Success Criteria

- [ ] 8 prompt templates cover all 25 agent roles (captain, 4 coordinator variants, scraper, classifier, crossref, writer, auditor, broker)
- [ ] Each prompt correctly references its layer (workers → coordinator, coordinators → captain)
- [ ] No prompt references tools that don't exist in the worm (e.g., `create_provenance` — verify this tool name is correct)
- [ ] 25 TOML configs with unique port/wallet/name assignments matching ARCHITECTURE.md roster
- [ ] Each config's `system_prompt_file` points to the correct prompt template
- [ ] Each config's `overlay.capabilities` matches the ARCHITECTURE.md capability strings
- [ ] POC #15 prep: test script ready, fresh worm instance plan documented
- [ ] Old 4-agent config files removed (or moved to `archive/`)

## 7. Estimated Effort

| Item | Effort | Notes |
|------|--------|-------|
| Update captain.md | 30 min | Substantial rewrite for pyramid |
| 4 coordinator prompts | 2 hours | Most complex new work — define dispatch/aggregate patterns |
| crossref.md | 20 min | Extracted from reef.md |
| auditor.md | 20 min | Simple: re-do work, compare, report |
| broker.md | 15 min | Simplest new prompt |
| Update scraper/classifier/writer | 30 min | Mostly find-replace Captain → Coordinator |
| 25 TOML configs | 1.5 hours | Repetitive but must be precise |
| POC #15 prep | 30 min | Test script + fresh worm instance |
| **Total** | **~5.5 hours** | |

Parallelizable: TOML configs can be done while prompts are being reviewed. POC #15 prep is independent.
