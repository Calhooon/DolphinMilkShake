# PLAN-C-SCALE — 1.5M Tx Scale-Out Plan (post-E18)

> **Hangs off [SHIP-PLAN-B.md](./SHIP-PLAN-B.md).** This file is the concrete
> scale-out plan from E18 baseline → 1.5M on-chain txs in 24h under
> $100-200/day. Read SHIP-PLAN-B.md for the "why" and day-by-day plan.
> Read the **2026-04-14 E17+E18** section of SHIP-PLAN-B for the baseline
> numbers PLAN-C builds on.
>
> **Created**: 2026-04-14. **Submission**: Friday 2026-04-17.
> **Baseline experiment**: E18 (`cycle-v2-2026-04-14T14-21-25-41ebadd8`).

---

## Target recap

- **1.5M on-chain data-plane proofs** in a 24h production run
- Under **$100-200/day**
- Valuable synthesis articles (not theater)
- No duplicate scraping across agents
- At the end: a UI that shows (a) all 1.5M tx's and (b) the fleet of
  agents working + sending messages, very basic

## Decisions (locked in 2026-04-14 after E18)

1. **Approach B** from the ultrathink: skinny-ish captain + aggressive
   amortization + hardcoded subreddit partition. NOT approach A (too
   tight on budget), NOT approach C (loses the 3-agent story for the
   video).
2. **`overlay_lookup` must run every captain cycle.** Captain stays
   gpt-5-mini. The lever we pull is **max_iterations = 1** for captain
   in the worker-only cycles: one iteration that does overlay_lookup +
   hand off to worker + done. ~40K sats/cycle instead of the observed
   121K at 3 iterations.
3. **Synthesis runs 1-in-25 cycles.** When it does run, captain can be
   allowed full 3 iterations for the richer analysis. Synthesis agent
   itself stays gpt-5-mini with full iter budget.
4. **Hardcoded subreddit partition.** Pick ~30 subs that are guaranteed
   (a) to have active content and (b) to never overlap each other. Each
   agent owns one sub. No dynamic partitioning. No cross-agent
   coordination needed for dedup.
5. **Per-agent LRU dedup** on Reddit post IDs. Small file, written after
   each successful proof batch, consulted before each scrape.
6. **UI is two surfaces**: fleet activity view (iframe grid fallback,
   issue #21) and a flat tx list view backed by a proof-index file
   every agent appends to.

## Scale math (confirmed)

**Captain 1-iter ≈ 40K sats** (from E18: 121,783 sats over 3 iters = 40.6K/iter)

| Cycle type | Captain | Worker | Synth | Total |
|---|---:|---:|---:|---:|
| Worker-only (24 of 25) | 40K | 14K | — | **54K** |
| Synthesis (1 of 25) | 121K (3 iter) | 14K | 297K | **432K** |

**25-cycle average** = (24 × 54K + 432K) / 25 = **69.1K sats/cycle**

### Daily throughput

- Target: 15,000 cycles/day cluster-wide (= 1.5M proofs at 100/cycle)
- Cost: 15,000 × 69.1K = 1.04B sats ≈ **$104/day** at $100k sats/USD
- Comfortably inside the $100-200 band with margin for LLM price drift
  and cycle-to-cycle variance.

### Wall clock / agent count

- E18 wall: 391s (worker-only cycle will be faster — no synthesis)
- Worker-only cycle expected wall: **~180-220s** (captain 1-iter skipped
  most of the iteration cost)
- Synthesis cycle wall: ~391s (unchanged)
- 25-cycle mean wall: ((24 × 200) + 391) / 25 ≈ **207s/cycle**
- Cycles/day per lane: 86400 / 207 ≈ **417 cycles/day**
- Lanes needed: 15,000 / 417 ≈ **36 lanes**
- **We need to provision closer to 36 agents, not 25-30.** The wall-clock
  constraint binds before the cost constraint does.
- **Alternative**: keep 25-30 agents and accept 1M-1.2M proofs instead of
  1.5M. Decide after E20 measures the actual worker-only wall.

## Partition design

30 hardcoded, non-overlapping subreddits. Each has ≥2K active subscribers
and regular new content. Below is a candidate list — **needs a pass to
verify each URL has recent activity and content policy**:

```
Tech news + discussion:
  r/technology, r/gadgets, r/hardware, r/buildapc, r/linux,
  r/programming, r/webdev, r/MachineLearning, r/cybersecurity, r/sysadmin

News + politics-adjacent:
  r/news, r/worldnews, r/UpliftingNews, r/geopolitics, r/Economics

Finance + crypto:
  r/Bitcoin, r/CryptoCurrency, r/stocks, r/investing, r/wallstreetbets

Science + future:
  r/science, r/Futurology, r/space, r/EverythingScience, r/environment

Biz + startups:
  r/startups, r/Entrepreneur, r/smallbusiness, r/marketing, r/SaaS
```

Rules for picking:
- No NSFW subs
- No meta/humor subs
- No subs with heavy crosspost traffic (causes dupes across our set)
- Each must produce ≥50 new posts/day OR we scrape comments too

## The uniqueness problem — RESOLVED by E19 (2026-04-14)

**E19 result**: r/technology/hot at 3-min cadence shows 0-2% churn.

```
iter  fetched  new  dupe  cumulative
   1      100  100     0         100
   2      100    2    98         102
   3      100    0   100         102
```

Posts-alone path is dead. The error in the original plan was treating
Reddit as a snapshot source when it's a stream. `/hot` is a ranking of
already-seen content. Over 9 minutes on one of the largest tech subs
we saw 2 new post IDs total. Extrapolated to 30 subs and 24h, we'd be
lucky to hit 200K unique records. Not 1.5M.

**Pivot (decided 2026-04-14 post-E19)**: cursor-paged comment firehose
+ shared work queue architecture. Comments are 10-100× more abundant
than posts, give a strong narrative ("witness layer for public
discourse"), and scale trivially as we add agents and subs.

See **"God-tier architecture"** section below for the replacement plan.

## God-tier architecture — cursor-paged firehose + work queue

**One cache feeder, many agents, zero dedup logic.**

### Components

1. **Feeder** (`scripts/reddit-cache-feeder.js`) — standalone Node
   process. Pulls `/r/<sub>/comments.json?before=<cursor>&limit=100`
   for every tracked sub in round-robin. Reddit's `before=` cursor
   returns only items newer than the fullname; dedup is handled at
   ingest by the cursor, not at runtime by agents.
2. **Per-sub work queue** — `/tmp/dolphinsense-firehose/<sub>/queue.jsonl`,
   append-only. New comments from the feeder land here as one line
   per record, canonical JSON, ready to hash.
3. **Per-sub cursor file** — `/tmp/dolphinsense-firehose/cursors/<sub>.cursor`,
   holds the newest-seen fullname. Survives feeder restarts.
4. **Per-sub watermark file** — `/tmp/dolphinsense-firehose/<sub>/queue.jsonl.claimed`,
   holds the byte offset of the last claimed record. Agents advance
   this atomically on claim.
5. **Agents** pop N records from the queue by reading from the
   watermark offset forward, writing a new watermark, and handing
   the claimed batch to `proof_batch.sh`. No Reddit calls from
   agents, no dedup logic, no cross-agent messaging.
6. **Health file** — `/tmp/dolphinsense-firehose/health.json` — feeder
   writes last-pull timestamps per sub, total queued, 429 counter,
   errors. UI reads this to show feeder alongside agents.

### Why this is god-tier

- **No dedup logic anywhere.** Cursors prevent ingest dupes. Watermarks
  prevent consume dupes. No LRU tables, no "have I seen this" checks.
- **Scales by addition.** Add a sub: edit feeder sub-list. Add an
  agent: point at queue dir, done. No partition rebalancing, no
  fleet coordination, no cross-agent ownership.
- **Crash-safe.** Feeder dies → cursor files on disk → restart resumes.
  Agent dies mid-batch → next agent reads watermark → claims next
  batch. 24h run survives restarts.
- **Content abundance.** r/worldnews alone does 5K+ comments/hour. 30
  subs easily push 30K-100K comments/hour. 1.5M/day becomes
  15-60% fleet idle, not a stretch target.
- **Narrative clarity for video**: "a witness layer for public discourse
  — every new comment on our watchlist is hashed and pinned to BSV
  within seconds of posting. No replays. No snapshots. The ledger
  grows as the conversation grows."
- **Clean generalization.** Swap Reddit for HackerNews, Bluesky, Mastodon,
  arXiv — replace the feeder. Agents don't change. Queue architecture
  is source-agnostic.

### Coexistence with the old scrape path

The existing `buildRecordsFile` in `test_cycle_v2.js` gets a queue-read
mode behind `QUEUE_MODE=1`. When on: reads from the shared queue
advancing the watermark. When off: original live scrape (preserved so
short local iterations still work without a running feeder).

E21+ all run with `QUEUE_MODE=1` and a live feeder. E18/E19a legacy
runs can still re-run against the live scrape path if needed.

## Experiment ladder (E18 → production)

### E19 — uniqueness ceiling (DONE 2026-04-14, PIVOTED)

Script: `tests/multi-worm/lab/e19_uniqueness.js` (pure scraping, free).

Result: r/technology/hot early-pivot gate fired at iter 3. See
"uniqueness problem" section above. Data file:
`test-workspaces/e19-uniqueness/e19-technology-2026-04-14T15-45-55.json`.

**Outcome**: pivoted to god-tier cursor-paged comment firehose.

### E19b — comment churn probe (DONE 2026-04-14, GO_BUILD_FEEDER)

Script: `tests/multi-worm/lab/e19b_comment_churn.js` (pure scraping, free).
10 iters × 3 subs × 60s cadence with `before=` cursor paging.

**Result** (steady-state, iters 2-10, bootstrap iter excluded):

| sub        | avg new/iter | min | max | steady-state/day | decision |
|---|---:|---:|---:|---:|---|
| worldnews  | 24.8 | 16 | 30 | ~36K/day | VIABLE |
| technology |  7.6 |  5 | 12 | ~11K/day | MARGINAL |
| news       |  5.9 |  4 |  9 | ~8.5K/day | MARGINAL |

Cursor paging is bulletproof: **zero cross-iter dupes** across all
30 per-sub pulls. Cursors advance by ~10 bytes/fullname, queue files
grow monotonically, `before=<fullname>` is Reddit-native and reliable.

**Architecture decision: GO_BUILD_FEEDER** — worldnews alone cleared
the ≥20/iter VIABLE threshold. Proceeding to the cache feeder + queue
integration.

**Volume implications for 1.5M target**: the current partition list
(30 subs mostly leaning small) would give ~650K/day at current rates.
To hit 1.5M we need to either (a) rebalance the sub list toward
known high-churn subs (AskReddit, politics, worldnews, news,
AmItheAsshole, gaming, videos — each sustains 50-200/min at peak),
(b) tighten the poll interval from 60s to 30s which roughly doubles
burst capture on busy subs, or (c) accept ~650K-1M/day. Noted as
follow-up; not blocking this session.

Data file:
`test-workspaces/e19b-comments/e19b-2026-04-14T16-17-01.json`

### Feeder + harness wiring (DONE 2026-04-14)

- `scripts/reddit-cache-feeder.js` — standalone Node process, round-robin
  `/r/<sub>/comments.json?before=<cursor>&limit=100`, writes per-sub
  queue.jsonl, cursor files, health.json, events.jsonl. Handles SIGTERM.
  Smoke-tested end-to-end against technology + worldnews: cursors
  persisted, queue appends correctly, bootstrap + incremental pulls
  both land.
- `tests/multi-worm/test_cycle_v2.js` — new `QUEUE_MODE=1` env var.
  When on, `buildRecordsFile` calls `claimFromQueue()` which reads
  from the per-sub queue.jsonl starting at the watermark offset
  (`queue.jsonl.claimed`), slices to `BATCH_CAP` lines, and advances
  the watermark atomically via tmp+rename. When off, the original
  live-scrape path runs unchanged. Unit-tested inline: two sequential
  claims yield non-overlapping batches, watermark advances correctly.

### E20 — skinny captain V1 "parallel tool calls" (DONE 2026-04-14)

Harness modified behind `SKINNY_CAPTAIN=1`. Captain prompt instructs
parallel emission of `overlay_lookup` + `delegate_task` in a single
assistant response with the worker identity pre-baked from the
cluster handle so there's no data dependency. `max_iterations=2`.

Also run against `QUEUE_MODE=1` so records flow
feeder → per-sub queue.jsonl → watermark claim → worker.

**Result** (`ae1eb5da`, 2026-04-14):

| component | sats | iters | notes |
|---|---:|---:|---|
| Captain (skinny parallel) | 104,164 | 2 | iter 1: 68K (both tools in parallel), iter 2: ~36K wrap-up |
| Worker (gpt-5-nano)       |  14,271 | 1 | 100/100 proofs, at-floor as before |
| Synthesis                 |       0 | — | disabled for this measurement |
| **Cycle total**           | **118,435** | | sats_per_proof: 1,184 |
| Cycle wall                | **142 s** | | vs PLAN-C projection of 200s — **better** |

QUEUE_MODE claim: 100 records in 4ms. Cursor paging + watermark
advance produced a clean 100/100 proof run.

**Assessment vs 45K captain target**: missed. The 45K target implicitly
assumed `max_iter=1`, but parallel tool-call designs still need an iter 2
wrap-up to satisfy the OpenAI tool_calls loop (the LLM returns
`finish_reason=tool_calls`, the runner executes the tools, and then
must send the results back for a final response). The real killer is
that `delegate_task` has to carry the *entire* opaque worker task
string through the captain, blowing completion tokens to 2.4K on
iter 1 and pushing iter 1 alone to 68K.

### E20 updated scale math (measured)

| metric | value |
|---|---:|
| cycle total (worker-only) | 118,435 sats |
| cycle wall (worker-only)  | 142 s |
| cycles/day per lane       | 608 |
| lanes needed for 1.5M/day | **25 lanes** (not 36) |
| 25-cycle avg with synthesis 1-in-25 | 131K sats |
| 15,000 cycles/day × 131K  | 1.96B sats ≈ **$196/day** |

**Inside cap but on the edge.** Saved significant wall clock vs
PLAN-C projection (142s vs 200s), which drops lane count from 36 to
25. Trades off against higher captain cost from the opaque-task
pass-through.

### E20b — liveness-only captain V2 (NEXT)

Rethink: the captain doesn't need to actually call delegate_task in
worker-only cycles. It just needs to **prove the overlay is alive**.
Drop delegate_task from the captain's tool-call scope entirely;
after the captain's session ends, the **harness** POSTs the worker
task directly to the worker's `/task` endpoint. This preserves the
parent-cert chain (worker still has a parent-issued cert, still
registers with overlay, still uses BRC-31 auth) and keeps the
overlay_lookup liveness check.

Projected impact:
- Captain iter 1: ~30-35K sats (single overlay_lookup tool call,
  minimal completion tokens — no opaque-task pass-through)
- Captain iter 2: ~30K sats (wrap-up response, similar to E18 iter 3)
- **Captain total: ~60-65K sats** (vs 104K today, vs 121K E18)
- Worker-only cycle: ~75K sats
- 25-cycle avg with 1-in-25 synthesis: ~89K/cycle
- 15,000 × 89K = 1.34B sats ≈ **$134/day**

Synthesis cycles (1-in-25) retain the FULL captain path — captain
explicitly calls `delegate_task` to synthesis agent because the
richer analysis justifies the cert/proof chain. Worker-only cycles
use the liveness-only short path.

Behind a new env var `SKINNY_CAPTAIN_MODE`:
- `parallel` — V1, opaque task through delegate_task
- `liveness` — V2, overlay_lookup only, harness direct-submits worker

### E20d — narrative-correct full pipeline (CHECKPOINT 2026-04-14)

**The hand-off run.** Full pipeline with `delegate_task` preserved +
synthesis on the new queue architecture. This validates every element
of the 1.5M-proof story in a single cycle:

- Overlay discovery ✓
- BRC-52 delegate_task paid handoff ✓
- BRC-33 messagebox delivery ✓
- On-chain delegation cert + revocation UTXO ✓
- Worker proof_batch 100/100 on-chain ✓
- Synthesis annotated-records read ✓
- NanoStore txid manifest upload (file_path stream) ✓
- NanoStore HTML article upload with cited txids ✓
- x402 payments all the way down ✓

**Liveness wallet fix**: synthesis wallet 3323 had drained to 261K
during E20 V1 / E20b / E20c runs. Funded via CLI through running
daemons (SQLite WAL handles concurrent DB access cleanly):

```
3322 → 3323: 15,000,000 sats  (txid bf2639b8...)  then split 10-way (1,526,119 sats/output)
3322 → 3324: 10,000,000 sats  (txid 21baefb0...)  then split 20-way on small UTXO pool
```

Post-funding balances: captain 381.65M, synthesis 15.26M (clean
10-output pool), worker 21.24M. Zero daemon touches, zero rekeys.

**E20d rerun result** (`306024bc`, 2026-04-14):

| component | sats | iters | notes |
|---|---:|---:|---|
| Captain (parallel, delegate_task) |  91,228 | 2 | iter 1: parallel overlay_lookup + delegate_task, iter 2: wrap-up |
| Worker (gpt-5-nano)               |  13,531 | 1 | 100/100 proofs on-chain, at floor |
| Synthesis (gpt-5-mini)            | 284,176 | 4 | full HTML + txid manifest via file_path stream |
| **Cycle total**                   | **388,935** | | sats_per_proof: 3,889 |
| Cycle wall                        | **299 s** | | vs E18's 391s — 24% faster |

**delegate_task commission (captain iter 1 tool_result):**

```
commission_id:        ca315656-88d7-4f07-b1ed-74a908772aef
amount_sats:          600,000  (paid handoff from captain to worker)
recipient:            026468a60d00ec36bc1dafafbd8992d12f40fb6a4740f278deb5ee94d346bd9722
delegation_cert_hash: sha256:7195522d138daaaedd6e4bef2a9c561685d3948144f82cef5aeb11bcb771891c
revocation_txid:      03c194ed916691990fef21a4117277cfb9f9edb231098b97a8fc6b4fd2378c3c
sent_message_id:      0e018d5d-f6b6-44f3-9594-f0c5d8b1579c  (BRC-33 messagebox)
```

**NanoStore URLs** (both verified via curl):

- HTML article: https://storage.googleapis.com/prod-uhrp/cdn/6bsYrg76eJMNHeLMkjjsqe
  - Title: *"Signals from r/technology: April snapshot of topics, tone, and trust"*
  - Valid HTML5, DOCTYPE, viewport meta, system font stack, cited blockquotes
- TXIDS manifest: https://storage.googleapis.com/prod-uhrp/cdn/97GQUbdRkWE8mauZhm6LGM
  - 100 lines, zero truncation markers, file_path streaming proven stable

**Updated scale math with E20d full-pipeline numbers:**

| scenario | avg sats/cycle | daily cost | 1.5M fits? |
|---|---:|---:|---|
| full every cycle           | 388,935 | $583/day  | ✗ theater budget |
| synthesis amortized 1-in-25 | ((24×104,759 + 388,935)/25) ≈ **116,326** | **$174/day** | ✓ inside cap |
| synthesis amortized 1-in-50 | ≈ 110,542 | $166/day | ✓ comfortable |
| synthesis amortized 1-in-100 | ≈ 107,604 | $161/day | ✓ comfortable |

(worker-only baseline = 104,759 sats: captain 91K + worker 14K)

At 25 lanes with 1-in-25 synthesis:
- 25 × (86400 / 299) × ((24 × 100) + (1 × 100)) / 25 = 25 × 289 × 100 = **722,500 proofs/day**
- Wait, that's worker-only wall. Full pipeline at 299s is the synth-cycle wall; worker-only is ~140s.
- 25 lanes × (24 × (86400/142) × 100 + 1 × (86400/299) × 100) / 25 ≈
  25 × (24 × 608 × 100 + 1 × 289 × 100) / 25 ≈ 25 × 59,818 ≈ **1.5M**

Hits target. Daily cost **~$174** at 1-in-25 amortization.

**This is the checkpoint.** All uncommitted work is ready to commit.

### E20b — liveness captain result (DONE 2026-04-14)

Run `f42cace0`, `SKINNY_CAPTAIN_MODE=liveness QUEUE_MODE=1 ENABLE_SYNTHESIS=0`:

| component | sats | iters | notes |
|---|---:|---:|---|
| Captain (liveness only)    |  70,908 | 2 | iter 1: 39,627 (overlay_lookup, 737 completion tokens), iter 2: ~31K wrap-up |
| Worker (gpt-5-nano, harness-direct) |  18,661 | 1 | 100/100 proofs, slight variance up from 14K baseline |
| Synthesis                  |       0 | — | disabled |
| **Cycle total**            | **89,569** | | sats_per_proof: **896** |
| Cycle wall                 | **142 s** | | unchanged from V1 |
| Captain prompt length      |    590c | | vs V1 2847c, vs V0 1500c |

Cross-run comparison:

| metric           | E18 baseline | E20 V1 parallel | **E20b liveness** | Δ vs E18 |
|---|---:|---:|---:|---:|
| Captain sats     | 121,783 | 104,164 |  **70,908** | **-42%** |
| Worker sats      |  14,411 |  14,271 |  18,661 | +30% (LLM variance) |
| Synthesis        | 297,211 | disabled | disabled | — |
| **Total cycle**  | 433,405 | 118,435 |  **89,569** | **-79%** |
| Wall (s)         |    391 |    142 |    **142** | **-64%** |
| Sats/proof       |  4,334 |  1,184 |     **896** | **-79%** |

### Scale math with measured E20b numbers

| scenario | avg sats/cycle | daily cost | 1.5M fits? |
|---|---:|---:|---|
| worker-only (no synthesis) |  89,569 | $134/day | ✓ well inside cap |
| 1-in-25 synthesis amortize | 103,322 | $155/day | ✓ comfortably in band |
| 1-in-50 synthesis amortize |  96,549 | $145/day | ✓ |
| 1-in-10 synthesis amortize | 120,333 | $180/day | ✓ edge |
| synthesis every cycle      | 386,780 | $580/day | ✗ way over |

**Sanity**: at 25 lanes, 608 cycles/day/lane × 100 proofs = 1.52M proofs/day.
Beats 1.5M target with one lane of headroom. Synthesis amortized
1-in-25 gives a ~30% cost margin against LLM price drift.

**Wallet degradation risk (still open)**: 60,800 createActions/day/lane.
Wallet 3324 showed degradation after ~700 createActions empirically,
but that was before toolbox 0.3.29+ broadcast-divergence fixes. We
don't have 24h-scale wallet durability data yet. Mitigations: run at
25 lanes not 36, provision ~35-40 wallets and rotate at 12h, or
detect degradation in-flight and hot-swap.

### E21 — 5-lane smoke test (45 min, ~$1)

5 agents on 5 distinct subs (r/technology, r/worldnews, r/science,
r/programming, r/Bitcoin). 10 cycles each. Measure:
- Cluster-wide unique proof rate
- Cluster-wide cost/hour
- Wallet degradation signs (any UTXO health warnings?)
- Reddit rate-limit errors (any 429s?)

**Gate for #18/#20 go-ahead.**

### E22 — 30-lane 1-hour soak (~$5)

Full 30-agent fleet, 1 hour, all 30 subs. Extrapolate to 24h. If
on-track for 1.5M at ≤$200/day wall, we're green for Thursday.

### Reddit pre-flight + persistent cache (BEFORE the 4h and 24h runs)

**This is for the production runs only. Do NOT touch the existing
scrape path for E19/E20/E21.**

The current `test_cycle_v2.js` harness already does its own
per-cycle live Reddit scrape (the `scrape r/technology hot...` step
at the start of each cycle) and that path is working — E17 and E18
both proved it. **Leave it alone**. E19, E20, and E21 all ride on
top of that same scrape path without modification, because at
1-5 agent scale, live scraping is fine.

The cache feeder described below is **NEW code**, a separate
background process, added specifically for the 25-30 agent long
runs where concurrent scraping from one IP becomes a real risk.
When the long runs come, the harness's scrape step will be
switched to read from the cache instead of calling Reddit — but
that switch is a separate, isolated change, not a rewrite of the
existing test harness. Everything the current harness does
continues to work.

**Why the two paths coexist**: short experiments need fresh,
up-to-the-second Reddit data to give honest uniqueness numbers.
Long runs need rate-limit insulation more than they need freshness.
Different constraints, different mechanisms, same project.

**Purpose**:
- Rule out Reddit rate limiting / IP throttling as a variable during
  the long runs.
- Rule out "this sub went dead mid-run" surprises.
- Decouple Reddit scraping throughput from agent throughput — a
  slow Reddit pull shouldn't stall a fast agent.
- Give us a confirmed, pre-validated data floor so we know every
  lane has fuel before we spend real sats.

**Design — persistent background scraper feeding a shared cache**:

1. One dedicated Node process (`scripts/reddit-cache-feeder.js`)
   runs continuously in the background, independent of the agent
   fleet.
2. It walks the 30 hardcoded subs in round-robin, pulling
   `/hot.json`, `/new.json`, `/rising.json` at a controlled rate
   (e.g., 1 sub every 10 seconds = 5 minutes to refresh all 30 subs
   once, well under any sane rate limit).
3. Each response is merged into a per-sub cache file:
   `/tmp/dolphinsense-cache/<sub>/posts.jsonl` — append-only, one
   line per unique post, keyed by Reddit post ID. De-duplicated at
   write time so old posts never re-enter.
4. Agents read from this cache instead of calling Reddit directly.
   The harness's Reddit-fetch step becomes a cache-read step.
5. The feeder emits its own event stream
   (`/tmp/dolphinsense-shared/events.jsonl`) with `scrape_start`,
   `scrape_done`, `cache_updated`, `cache_stale_warning`, so the UI
   sees the feeder alongside the agents.
6. The feeder also emits a health file
   (`/tmp/dolphinsense-cache/feeder-health.json`) with last-pull
   timestamps per sub, total posts cached, 429 counter, error log.
7. If the feeder falls more than N minutes behind on any sub, it
   emits a loud warning event so we see the problem before the
   agents run out of fresh content.

**Pre-flight validation step (run once, ~15 min before each long
run)**:

1. Start the feeder.
2. Let it run for ~15 minutes to populate the cache with one full
   round-robin pass.
3. Read `feeder-health.json` and confirm:
   - Every sub has ≥100 cached posts.
   - No 429s observed.
   - Posts/hour drift estimate is ≥ target (calculated from cycle
     demand: 100 records × N cycles/hour × per-lane share).
4. If any sub fails, swap it for a backup sub and let the feeder
   re-populate before proceeding.
5. Only then start the 25-30 agent fleet against the cache.

**Exit criteria** for pre-flight before a production run:
- Feeder has been running for ≥15 minutes with zero 429s.
- Every sub in the partition has ≥100 cached posts.
- Aggregate estimated new-posts/hour across all 30 subs is ≥ cycle
  demand with 2× safety margin.
- Feeder's health file is green.

**Fallback if the feeder can't keep up**: add comment streams to the
cache (r/xxx/comments.json) — comments refresh faster than posts
and give us much more unique content volume.

### Thursday — 24h production run (~$100-200)

Full production. Runs against the persistent Reddit cache (feeder
started ~15 min earlier for pre-flight). Thursday morning start →
Friday morning finish. Leave Friday for video + submission.

## UI plan — FUTURE, not now

**Do not start this yet.** The UI is a **brand new standalone project**,
NOT an extension of dolphin-milk's existing `/ui/`. It will be hacked
together specifically to watch the 24h production run happen live and
to display the 1.5M tx list after the fact. It exists to serve the video
+ submission, nothing else.

**Discussion timing**: after E19 (which tells us if we're pivoting to
comments) and before / during the 4-hour dry run. That's the natural
moment to decide what the UI needs to show, because by then we know:
- How many lanes we're actually running
- Whether we're proving posts, comments, or both
- What the real tx emission rate looks like
- What shape the shared proofs file takes (it has to exist before the
  UI can render anything)

**Requirements captured now** (so future-us has context when we open
this back up):
1. **Show all 1.5M tx's** — probably a paginated / virtualized list
   backed by a flat file every agent appends to (`proofs.jsonl` or
   similar). No database, no framework unless forced.
2. **Show all agents** with their names (captain/worker/synthesis per
   lane, 30 lanes), what they're doing right now, and the messages
   they're sending. "Very basic" per user spec — a grid of tiles or
   a log stream, not a polished dashboard.
3. **Standalone project**, not a new route inside dolphin-milk. Can
   be a single-file HTML + a tiny Node or Bun server, or a hacky
   static site served off the same box as the agents. Whatever is
   fastest.
4. **Designed to impress during the video**, so it should at minimum
   feel alive — a counter ticking up, log lines streaming in, tiles
   changing color when an agent emits a proof. Doesn't need to be
   pretty.

### The live-event vision (what user actually wants)

Yes — the UI reads from append-only files and reflects live state as
stuff happens. Tx's literally pile up on screen as proofs hit the
chain. Overlay lookups show "in progress" while they're running.
MessageBox sends flash across. NanoStore uploads show as progress
bars / tiles that resolve to public URLs.

The mechanism is dumb and reliable:

1. Every agent appends one line per event to a **shared event stream
   file** (`/tmp/dolphinsense-shared/events.jsonl`). Append is atomic
   for sub-PIPE_BUF writes on POSIX, so no locking needed for the
   short JSON lines we emit.
2. UI server (tiny Node/Bun process) does `fs.watch` or `tail -f`
   on that file, and for each new line broadcasts a
   **server-sent-event (SSE)** to any connected browsers.
3. Browser gets an `EventSource('/events')` stream, dispatches each
   event to the right tile based on `event.type` + `event.agent`.
4. Separate polling loop reads aggregate counters from `proofs.jsonl`
   (line count = total proofs) and updates the "1.5M counter" every
   second.

### Event taxonomy (locks in the shape agents write)

One file (`events.jsonl`), many event types. Every line is:
```json
{"ts": 1776176537.29, "agent": "captain-03", "lane": "r/technology",
 "type": "<event-type>", "data": { ... }}
```

Minimum set of event types the UI needs:

| Event type | Fired when | `data` fields | UI response |
|---|---|---|---|
| `cycle_start` | Harness starts a new cycle | `cycle_id`, `sub` | Lane tile flashes green |
| `scrape_start` | Reddit scrape begins | `sub`, `sort` | "Scraping r/xxx..." in tile |
| `scrape_done` | Reddit scrape finished | `record_count`, `ms` | Record count appears |
| `overlay_lookup_start` | Captain calls overlay_lookup | `query` | Spinner on "overlay" badge |
| `overlay_lookup_done` | overlay_lookup returned | `hit_count`, `ms` | Badge flashes + hit count |
| `think_start` | LLM call begins | `model`, `role` | "Thinking..." pulse |
| `think_done` | LLM call returned | `sats`, `ms`, `tokens_out` | Sats counter ticks |
| `proof_emitted` | Single proof broadcast | `txid`, `record_id` | **New row appears in tx list** |
| `proof_batch_done` | proof_batch tool finished | `count`, `first_txid`, `last_txid` | Batch summary in lane |
| `message_sent` | BRC-33 send | `to_agent`, `encrypted`, `signed` | Arrow animates from sender to recipient tile |
| `message_received` | BRC-33 inbox processed | `from_agent` | Recipient tile pulses |
| `nanostore_upload_start` | upload_to_nanostore begins | `bytes`, `content_type` | Progress bar appears |
| `nanostore_upload_done` | upload finished | `url`, `ms` | Bar fills, URL becomes clickable |
| `synthesis_article_published` | HTML article uploaded | `url`, `sub`, `cycle_id` | "Latest article" slot updates |
| `cycle_done` | Cycle complete | `total_sats`, `proofs`, `wall_ms` | Lane tile commits the row |
| `budget_warning` | Budget tracker flags | `used`, `limit`, `window` | Red tint on agent tile |
| `error` | Any failure | `where`, `reason` | Red flash + log entry |

**The event stream is the single source of truth for the UI.** The
`proofs.jsonl` / `messages.jsonl` / `agent-status.jsonl` files remain
as optional specialized aggregations if the UI wants a fast count
without replaying the whole stream, but strictly speaking, one
`events.jsonl` is enough.

### Where the events come from

- **Agents**: a small hook in each agent's runner that writes one
  line per hook event to `events.jsonl`. Dolphin-milk already has
  a hooks system — add an `events_jsonl` hook config.
- **Harness**: for `cycle_start`/`cycle_done`/`scrape_*`, the harness
  (test_cycle_v2.js / the production launch script) writes directly
  to the same file. Harness is already the orchestrator — no new
  plumbing.
- **proof_batch tool**: emits `proof_emitted` per tx and
  `proof_batch_done` at the end. This is the ONLY place we need to
  actually touch agent code.

### Pre-requisites we need in place BEFORE the UI project starts

1. Hook config on every agent that tees events to the shared file.
2. Harness emits `cycle_start`/`cycle_done`/`scrape_*`.
3. `proof_batch` tool emits `proof_emitted` per tx (otherwise we can
   only show batch-level counts, not the satisfying tx-by-tx pile-up).
4. `upload_to_nanostore` emits start/done events.
5. `overlay_lookup` emits start/done events.
6. `send_message` + inbox polling emit message events.

**E21 exit criteria should include**: "tail -f events.jsonl shows
all 16 event types firing during a 5-lane smoke test run." If that
passes, the UI is just a view over a data stream that already works.

### Why SSE and not WebSockets

One-way stream from server to browser. No client→server messages
needed. SSE is 6 lines of Node, auto-reconnects, works through
proxies, no framework. Nothing about this should be harder than it
needs to be.

**Deferred to the 4-hour-run conversation**:
- Framework choice (none preferred, vanilla HTML+JS most likely)
- Styling / layout
- Server vs pure static
- Whether to embed per-agent dolphin-milk `/ui/` pages at all, or
  build everything from the shared files

**Existing task #21** ("Mission Control UI — iframe grid fallback
first") is the closest match but is now superseded in spirit by this:
the user does NOT want iframes of the existing Lit UI, they want a
purpose-built hacky dashboard. Keep #21 open as a placeholder but
mentally treat the real UI work as a post-E19 greenfield project.

## Issue-level tasks

| # | Title | Status | Depends on |
|---|---|---|---|
| E19 | Uniqueness ceiling on r/technology | TODO | — |
| E20 | Skinny captain 1-iter + synthesis-amortized cycle | TODO | — |
| E21 | 5-lane smoke test | TODO | E19, E20, #18 partial |
| #18 | Wallet provisioning — 30 wallets, ports 3325-3354 | pending | — |
| #20 | Launch script for 30 agents + 5-agent smoke gate | pending | #18 |
| #21 | Mission Control iframe grid (deprecated in spirit) | pending | — |
| (new) | Shared proofs.jsonl / messages.jsonl / agent-status.jsonl writers | TODO | E20 |
| (FUTURE) | Standalone hacky UI project — discuss after E19 / before 4h dry run | DEFERRED | shared writers |
| E22 | 30-lane 1-hour soak | TODO | E21, #18, #20 |
| (day) | Thursday 24h production run | pending | E22 |
| (day) | Friday video + submission | pending | Thursday run |

## Open risks (still to verify)

1. **Uniqueness ceiling** — E19 decides whether we need comment
   expansion. If we do, that's ~half a day of work to add a comment
   scraper on top of the existing post scraper.
2. **Reddit rate limiting** — 30 agents scraping from the same IP.
   Plan: each agent uses its own Firefox UA + a small random jitter on
   scrape timing. If rate limited, rotate through `old.reddit.com`
   / `api.reddit.com` / `.json` endpoints.
3. **Wallet degradation** — 3324 degraded after ~700 createActions.
   Fresh wallets at ~480 createActions/day/lane sit right at that
   ceiling for 24h. Mitigation: provision 2× wallets and rotate at 12h,
   or provision 36 and run 30 + 6 hot-swap spares.
4. **Captain 1-iter enforcement** — the agent loop may refuse to finish
   in 1 iter if it sees more tool calls are "needed". E20 measures.
   Fallback: force by setting `max_iterations = 1` in the task config
   or via a tight prompt saying "you have ONE iteration".
5. **Proof-index file contention** — 30 agents all appending to one
   JSONL is racy. Either fsync-per-line (slow) or each agent writes
   its own file and a periodic merge script combines them for the UI.
   Merge-at-read is simpler.
6. **Three days to deadline** — if E19 pivots us to comment expansion,
   that eats most of Tuesday. Keep Wednesday as slack day.

## What happens NEXT (in order)

1. Run **E19** — uniqueness ceiling on r/technology, live Reddit
   scraping (short enough to not worry about rate limits). **~30 min,
   ~$0.20.**
2. Run **E20** — skinny captain rework + single-cycle validation.
   **~30 min, ~$0.10.**
3. If E19 says "pivot to comments" → add comment scraping to the
   harness (half day).
4. Start **#18 wallet provisioning** (30 wallets) in background
   while E21 preps.
5. Run **E21 smoke test** on first 5 provisioned wallets. Exit
   criterion includes "all 16 event types firing in events.jsonl".
6. Build the **Reddit cache feeder** + pre-flight validator. Run
   feeder briefly end-to-end to confirm it populates cleanly and
   agents can read from it. **~half day.**
7. Run **E22** — 30-lane 1-hour soak AGAINST THE CACHE. This is
   the first test that exercises the feeder under real fleet load.
8. **Pre-flight the 4h dry run**: start feeder, wait 15 min, confirm
   health, fire 4h run.
9. **Pre-flight the Thursday 24h run**: same pattern. Feeder runs
   alongside the fleet the entire 24h.
10. Friday: record video, write README, submit.

---

**Cross-reference**:
- [SHIP-PLAN-B.md](./SHIP-PLAN-B.md) — strategic plan, day-by-day
- [SHIP-PLAN-B.md#2026-04-14--e17--e18-full-pipeline-pass-txid-citations-working](./SHIP-PLAN-B.md)
  — E18 baseline numbers this plan extends
- E18 artifacts:
  - HTML: `https://storage.googleapis.com/prod-uhrp/cdn/4grXdPjWMGpNJgBjy8muzW`
  - TXIDS: `https://storage.googleapis.com/prod-uhrp/cdn/TaWffJP3VwdxcTCyt8SXoF`
  - Aggregate JSON: `~/bsv/rust-bsv-worm/test-workspaces/cycle-v2-2026-04-14T14-21-25-41ebadd8/aggregate.json`
