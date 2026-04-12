# POC #15: Memory Recall Results

**Date**: 2026-04-12
**Model**: claude-haiku-4-5
**Wallet**: Fresh wallet on 3340 (daemon mode), 5M sats, pre-split 10 UTXOs
**Memories stored**: 25 structured entries (10 hourly, 5 reports, 3 quality, 3 budget, 4 signals)

## Key Finding: `limit=50` fixes everything

The default memory_search limit is **5**. With limit=50, all 6 searches returned correct results.

## Results

| # | Query | Limit | Count | Correct? | Notes |
|---|-------|-------|-------|----------|-------|
| 1 | "hour results signals" | 50 | 22 | **YES** | All 10 hourly entries found + related entries |
| 2 | "report batch url nanostore" | 50 | 23 | **YES** | All 5 batch reports at top, URLs present |
| 3 | "quality pass rate" | 50 | 8 | **YES** | All 3 quality entries at top |
| 4 | "hour-14-results" | 50 | 2 | **YES** | Exact match, #1 result |
| 5 | "budget-hour-20" | 50 | 2 | **YES** | Exact match, #1 result |
| 6 | "signal strong ai_agents" | 50 | 22 | **YES** | All 4 signals at top |

## What works well

- **Exact prefix queries**: "hour-14-results" and "budget-hour-20" return exactly the right entry as #1 result
- **Keyword queries with limit=50**: "quality pass rate" finds all quality entries, "signal strong ai_agents" finds all signal entries
- **BM25 ranking is good**: correct entries rank at the top, noise sinks to bottom
- **Tags are indexed**: entries stored with tags like ["signal", "strong", "ai_agents"] are found by those keywords

## Issues found

1. **Duplicate entries**: Some entries stored twice (probably from a failed/retried test run). The dedup system warned about syntax errors on structured content with colons/parens but still stored the data.
2. **Session summaries leak in**: The worm stores session summaries as memories. They appear in search results as noise. LLM can filter these but it wastes context.
3. **Broad queries return many results**: "hour results signals" returned 22 entries including budgets, signals, and hourly. Good coverage but noisy. Captain needs to filter in context.

## Prompt recommendations for Captain

1. **ALWAYS use limit=50** on memory_search calls
2. **Use exact prefixes for specific entries**: "hour-14-results", "budget-hour-20", "report-cycle-14"
3. **Use keyword combinations for categories**: "quality pass rate", "signal strong", "report batch url"
4. **Store with consistent prefix patterns**: `hour-NN-results:`, `report-cycle-NN:`, `budget-hour-NN:`, `signal-strong-N:`
5. **Include good tags**: `["hour", "results", "hour-14", "ai_agents"]` — tags ARE searchable via BM25

## Wallet findings (from this POC session)

1. **MUST use `bsv-wallet daemon` not `serve`** — serve mode has no monitor, txs stay unproven, chains grow deep, eventually double-spend errors crash the agent
2. **Pre-split UTXOs**: `bsv-wallet split --count 10` creates parallel UTXOs for concurrency
3. **Fund via AtomicBEEF from existing wallet** — WhatsOnChain BEEF is not AtomicBEEF format, use wallet createAction → internalize flow

## Verdict

**PASS** — memory recall is reliable with limit=50 and structured prefixes. No worm code changes needed. Captain prompts updated with these patterns.

## Cost

- 25 memory_store iterations (gpt-5-mini): ~750K sats
- 6 memory_search iterations (haiku): ~300K sats  
- Total test cost: ~1.05M sats (~$0.18)
