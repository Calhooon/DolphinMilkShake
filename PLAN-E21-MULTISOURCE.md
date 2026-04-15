# PLAN-E21-MULTISOURCE — Bluesky + Wikipedia firehose adapters

**Status:** PLAN. Nothing touched yet beyond probes + audit.
**Date:** 2026-04-14 evening.
**Motivation:** Reddit's ~100-req IP budget kills sustained scraping.
Reddit OAuth is unavailable. The 1.5M-tx/24h goal requires a source that
cannot rate-limit us. Bluesky jetstream (51/sec real, no auth) and
Wikipedia EventStreams (36/sec real, no auth) both clear that bar.

## Goal

Fire a **5-lane 15-cycle soak** tonight on the existing fleet harness,
using 4× Bluesky lanes + 1× Wikipedia lane, without touching
`lane-cycle.js`, the runner, or the UI contract. This soak is simultaneously
the "we're alive" milestone AND the 24h architecture load test. If 5 lanes
sustain through 15 cycles on these sources, the 24h big-daddy run is
mechanically identical — just longer.

## Non-goals

- No refactor of the record schema.
- No refactor of the agent prompt architecture.
- No removal of Reddit code paths (they stay as dead code / historical).
- No OAuth workaround for Reddit.
- No Wikipedia narrative polish tonight — functional is enough.

## Probe findings (2026-04-14, 60s each, parallel)

| Source | Raw events/60s | Usable events/60s | Rate | 24h projection |
|---|---|---|---|---|
| **Bluesky jetstream** | 3238 | 3098 (96% = create:app.bsky.feed.post with text) | **51.6/sec** | **4.5M** |
| Bluesky English-only | — | ~1500 | ~25/sec | 2.1M |
| **Wikipedia EventStreams** | 2198 | 1292 (enwiki+commonswiki+wikidata edits+categorize) | 21.5/sec | 1.8M |
| Wikipedia enwiki:edit only | — | 134 | 2.2/sec | 192k |

**Both sources individually exceed the 1.5M/24h goal.** The scaling problem
is fully solved at the data-source layer. The remaining bottleneck is
agent throughput (can the fleet broadcast ~17 txs/sec sustained?), which is
an orthogonal issue.

## Architecture — the lego-block contract

Approach A (record-envelope adapter). Each new feeder writes to
`/tmp/dolphinsense-firehose/<lane>/queue.jsonl` in the **same Reddit-shaped
envelope** the existing harness reads. Downstream (claim, lane-cycle,
agent, synthesis) cannot distinguish source.

### Target record shape (matches Reddit child envelope)

```json
{
  "kind": "t1",
  "data": {
    "id": "<source-native record id>",
    "body": "<text content>",
    "author": "<handle / did / user>",
    "subreddit": "<lane id — e.g. bsky-en, wiki-en>",
    "created_utc": 1776212000,
    "permalink": "<canonical path — e.g. /bluesky/did/rkey>",
    "score": 0,
    "title": "<title or empty string>",
    "_source": "bluesky|wikipedia"
  }
}
```

**Minimum required fields** (consumed by synthesis prompt):
`data.id`, `data.body`, `data.author`.
Other fields are populated with sensible defaults so the LLM prompt
stays stable.

**Why `_source` sidecar**: lets log lines and debug tools identify
origin without polluting fields the LLM reads. It's a sidecar, not a
schema break.

### Per-source adapter mapping

#### Bluesky (jetstream → Reddit envelope)

Filter: `kind=="commit" && commit.operation=="create" && commit.collection=="app.bsky.feed.post" && commit.record.text != null`.
Further filter per-lane by `commit.record.langs` (e.g. `"en"`, `"es"`).

| Target field | Source expression |
|---|---|
| `data.id` | `commit.rkey` |
| `data.body` | `commit.record.text` |
| `data.author` | `did` (full did:plc:... — handle resolution deferred) |
| `data.subreddit` | lane id (e.g. `"bsky-en"`) |
| `data.created_utc` | `Math.floor(time_us / 1e6)` |
| `data.permalink` | `"/bluesky/" + did + "/" + rkey` |
| `data.score` | `0` |
| `data.title` | `""` |
| `data._source` | `"bluesky"` |

#### Wikipedia (EventStreams → Reddit envelope)

Filter: `type=="edit" && wiki in ["enwiki","commonswiki","wikidatawiki"]`.
Optional: exclude `bot:true` to favor human edits.

| Target field | Source expression |
|---|---|
| `data.id` | `"rev_" + revision.new` |
| `data.body` | `comment || ""` (edit summary) |
| `data.author` | `user` |
| `data.subreddit` | lane id (e.g. `"wiki-en"`) |
| `data.created_utc` | `timestamp` |
| `data.permalink` | `notify_url` |
| `data.score` | `(length.new - length.old) || 0` (byte delta as pseudo-score) |
| `data.title` | `title` |
| `data._source` | `"wikipedia"` |

## Required code changes (tonight)

| File | Change | Lines | Reversible? |
|---|---|---|---|
| `feeder/bluesky-jetstream-feeder.js` | NEW — WebSocket consumer, 5-lane fanout by `langs`, writes Reddit-envelope | ~180 | yes (new file) |
| `feeder/wikipedia-stream-feeder.js` | NEW — SSE consumer, 1-lane merged write, Reddit-envelope | ~120 | yes (new file) |
| `fleet/lanes.json` | EDIT — add bsky-en, bsky-es, bsky-ja, bsky-pt, wiki-en | ~40 | yes (git revert) |
| `scripts/lane-cycle.js:677` | EDIT — 1 line: `"Each line is a real Reddit post or comment"` → source-aware label | 1 | yes (1 line) |
| `prompts/cycle-v2/synthesis-html.md` | EDIT — mirror the above for documentation | 2 | yes |
| `ui/index.html` + `ui/server.js` | AUDIT — verify no hardcoded `r/` prefixes break on non-Reddit lanes | 0-5 | yes |

**Not touched:**
- `lane-cycle.js` claim path, agent spawning, tool loop, budget accounting
- `runner/` or any Rust code
- Cluster orchestration scripts (`scripts/lib/cluster.js`, auth.js)
- Reddit cache feeder (left running if desired, or stopped — no code change)

## 5-lane config for tonight's soak

| # | lane id | source | filter | wallet port | server port |
|---|---|---|---|---|---|
| 1 | `bsky-en` | bluesky | `langs[]="en"` | 3400 | 8100 |
| 2 | `bsky-es` | bluesky | `langs[]="es"` | 3401 | 8101 |
| 3 | `bsky-ja` | bluesky | `langs[]="ja"` | 3402 | 8102 |
| 4 | `bsky-pt` | bluesky | `langs[]="pt"` | 3403 | 8103 |
| 5 | `wiki-en` | wikipedia | `wiki in [enwiki,commonswiki,wikidatawiki]` | 3404 | 8104 |

Wallet ports are the existing 5-lane set from earlier soaks. No
provisioning needed — these wallets are funded and persistent.

## Execution order

### Phase 1 — Plan + audit (done before this doc was written)
- ✅ Bluesky volume probe (51/sec verified)
- ✅ Wikipedia volume probe (21.5/sec verified for merged edits)
- ✅ Record sample analysis for both sources
- ✅ Prompt-coupling audit (1 live edit required, rest is dead code or cosmetic)
- ✅ This plan doc

### Phase 2 — Feeders (~2 hours, can parallelize)
1. Write `feeder/bluesky-jetstream-feeder.js` with WS reconnect + 5-lane fanout
2. Write `feeder/wikipedia-stream-feeder.js` with SSE reconnect + filter
3. Update `fleet/lanes.json` with the 5 new lane entries
4. Edit `lane-cycle.js:677` + `synthesis-html.md` for source-aware prompt
5. Audit UI for hardcoded `r/` — fix if found

### Phase 3 — Canary (~20 min)
1. Start bluesky feeder — verify one lane (`bsky-en`) accumulates records
2. Start wikipedia feeder — verify `wiki-en` accumulates records
3. Inspect `queue.jsonl` samples manually — verify envelope shape matches
4. Run `lane-cycle.js` for 1 cycle on `bsky-en` — verify it produces at least 1 proof
5. Run `lane-cycle.js` for 1 cycle on `wiki-en` — verify same
6. Verify UI renders both lanes without hardcoded-prefix breakage

### Phase 4 — 5-lane soak (~75 min wall)
1. Start all 5 lanes via existing cluster orchestration
2. Run 15 cycles per lane
3. Watch UI live (counters, message_flow, article emission)
4. If any lane fails, capture transcripts but do NOT auto-restart — we
   need to see the failure mode for the 24h run

### Phase 5 — 24h big-daddy prep (deferred to tomorrow)
- Review soak results
- Decide on lane count + filter diversity for 24h
- Fixed feeder bugs found in Phase 4
- Harden restart/reconnect logic if needed
- Fire 24h run with checkpoint / resume policy

## Risks

### High
- **Agent prompt "source awareness" lie**: if we don't edit lane-cycle.js:677,
  articles about Bluesky will claim to be about "Reddit posts". One 1-line
  edit fixes it; forgetting is the risk.
- **Bluesky jetstream disconnect**: WebSocket drops are real at 24h timescale.
  Feeder needs reconnect-with-backoff. For tonight's 75-min soak, a single
  reconnect is survivable; for the 24h run, backoff + last-seq replay is
  mandatory.
- **Wikipedia SSE disconnect**: same story, EventStreams supports
  `Last-Event-ID` header for resume. Implement in Phase 2.

### Medium
- **Handle vs DID**: Bluesky authors come through as `did:plc:...` strings.
  The LLM will quote them verbatim in `<footer>— @did:plc:xxx</footer>`
  which is ugly. Two options: (a) accept the ugliness for tonight,
  (b) add async handle resolution cache in feeder. Option (a) for
  tonight; (b) tomorrow.
- **`_source` sidecar field visible to LLM**: the annotated `record`
  object includes `_source`, which means the LLM sees it in the prompt.
  This leaks the "we're lying about field names" secret but the LLM
  will ignore it unless we tell it to care. Acceptable.
- **Queue file growth**: at 51/sec Bluesky fills `queue.jsonl` at ~12 MB/min =
  ~720 MB/hour per lane. Over 75 min × 4 lanes = 3.6 GB. Not tonight's
  problem, IS a tomorrow problem. Mitigation: queue file rotation or
  sliding-window sampler.
- **Record dedup**: Bluesky doesn't emit dupes naturally, but jetstream
  reconnects can replay. Feeder must dedupe by `rkey` via in-memory LRU
  set (~100k entries, O(10MB) RAM). Wikipedia dedups by `id`.

### Low
- **Empty `data.body` in Wikipedia**: some edits have empty comments.
  Filter out at feeder level to avoid feeding the LLM nothing.
- **Title-length for Wikipedia**: some Wikidata Q-numbers are opaque.
  Acceptable — LLM can note this in synthesis.
- **Cursor/resume state collision**: each source gets its own cursor
  namespace in `/tmp/dolphinsense-firehose/cursors/bluesky/*` and
  `/tmp/.../cursors/wikipedia/*`. No collision with existing Reddit cursors.

## Unknowns

- Real cycle wall-clock at 5-lane mixed load (we'll measure during canary)
- Whether bsky-es / bsky-ja / bsky-pt lanes have enough volume to sustain
  15 cycles without backpressure (prediction: yes, based on 25% / 10% / 5%
  language shares of the 51/sec total)
- Whether the UI progress-bar math handles new lane names correctly
- Whether jsonl growth rates choke `scanHistoricalState()` (deferred)

## Rollback plan

If Phase 2 drags or Phase 3 canary fails:
1. Revert `lane-cycle.js:677` edit (1 line, `git diff | git apply -R`)
2. Revert `lanes.json` to the 5 Reddit lanes
3. Delete new feeder files (they're additive, no coupling)
4. Fall back to "3-lane Reddit residual soak" from earlier plan
   (worldnews + AskReddit + movies, 15 cycles each, ~45 cycle-runs)

Reddit residual queues remain on disk through this entire plan —
nothing deletes them.

## Success criteria (soak green light)

- All 5 lanes produce ≥1 proof in cycle 1
- All 5 lanes reach cycle 15 without unrecoverable failure
- UI shows lifetime + live counters climbing, no stuck lanes
- At least 3 synthesis articles produced (1 per 5 cycles amortization)
- No prompt-leaked source weirdness in articles (we read 1-2 to confirm)
- Transcript sats_effective totals match UI live-counter deltas
- **Stretch**: transcripts contain at least one explicit `_source: bluesky`
  and one `_source: wikipedia` annotated record (proves adapter works)
