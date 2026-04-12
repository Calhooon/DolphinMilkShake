# POC #15 Prep: Memory Recall Test

## Goal

Verify that an agent can store 50+ structured memories and reliably search/recall them — the foundation for Captain's daily report assembly.

## Test Environment

- **Worm**: Running on port 8085, wallet on 3322
- **Alternative**: Spin up fresh instance on 8086 with wallet 3323 for clean slate (recommended)

## Test Approach

Submit a task to the worm that instructs it to:

1. **Store 50 structured memories** simulating 24 hours of DolphinSense data:
   - 24 hourly results (one per hour): topics, sentiment, signals, nanostore URLs
   - 10 batch report URLs with topics and confidence
   - 6 quality check results with pass rates
   - 5 budget snapshots with spending rates
   - 5 cross-source signals with strength scores

2. **Search with broad queries**:
   - "top signals across all hours" → should return multiple hourly entries
   - "all reports from today" → should return report entries
   - "quality check results" → should return quality entries

3. **Search with narrow queries**:
   - "sentiment for hour 14" → should return the specific hour-14 entry
   - "nanostore urls for batch reports" → should return report entries with URLs
   - "budget snapshot hour 20" → should return near-end-of-run budget data

4. **Verify results**: Check that memory_search returns the RIGHT entries (not random ones)

## Task Prompt

Submit this as a task to the worm via its HTTP API:

```
Store exactly 50 memories simulating a 24-hour DolphinSense intelligence run, then test recall.

PHASE 1 - STORE (do all 50 first):

Store 24 hourly results (memory_store each one):
- "hour-1-results: topics=ai_agents,crypto sentiment=0.45 signals=1_strong,3_moderate nanostore=uhrp://hour1 sources=reddit(50),hn(20)"
- "hour-2-results: topics=micropayments,bsv sentiment=0.52 signals=2_strong,2_moderate nanostore=uhrp://hour2 sources=reddit(60),x(30)"
- ... (continue pattern for hours 3-24, vary topics and sentiments realistically)

Store 10 batch reports:
- "report-batch-3: type=batch_brief url=uhrp://report3 topics=ai_agents confidence=high word_count=420"
- ... (10 total)

Store 6 quality results:
- "quality-hour-4: samples=38 pass_rate=0.94 scrape_pass=0.95 classify_pass=0.89"
- ... (6 total)

Store 5 budget snapshots:
- "budget-hour-5: balance=42M spent=8M rate=1.6M/hr on_track=yes"
- ... (5 total)

Store 5 cross-source signals:
- "signal-strong-1: topic=ai_agents sources=reddit,hn,x strength=0.85 sentiment=0.72 trend=rising"
- ... (5 total)

PHASE 2 - SEARCH AND REPORT:

After storing all 50, run these searches and report what you find:

1. memory_search("top signals across all hours") — how many results? Do they contain hourly entries?
2. memory_search("all batch reports") — how many? Do they contain nanostore URLs?
3. memory_search("quality check results") — how many? Do they contain pass rates?
4. memory_search("sentiment for hour 14") — does it return hour-14 specifically?
5. memory_search("budget snapshot hour 20") — does it return the right budget entry?
6. memory_search("cross source signals strength") — does it find the strong signals?

Report: for each search, list (a) number of results, (b) whether the RIGHT entries were returned, (c) any false positives or missing entries.
```

## How to Run

Option A — via curl to worm API:
```bash
curl -X POST http://localhost:8085/task \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:8085' \
  -d '{"message": "...<the prompt above>...", "max_iterations": 30}'
```

Option B — via the worm's web UI at http://localhost:8085/ui/

## Pass Criteria

- [ ] All 50 memory_store calls succeed
- [ ] Broad queries return multiple relevant entries (not empty, not random)
- [ ] Narrow queries return the specific entry requested
- [ ] No false negatives on critical queries (data exists but search misses it)
- [ ] Search latency acceptable (agent doesn't stall on memory_search)

## Notes

- The worm on 8085 may already have memories from previous work. A fresh instance on 8086 would give a cleaner test.
- memory_search uses tantivy BM25 — it's keyword-based, not semantic. Structured entries with consistent tags ("hour-N-results:", "report-batch-N:") should search well.
- If BM25 struggles with our query patterns, we may need to adjust how Captain tags entries in the prompt.
