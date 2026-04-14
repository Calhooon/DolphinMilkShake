# SHIP-PLAN-B — God-Tier DolphinSense 24h Run

> **Target**: 1.5M on-chain provenance proofs under $200/day, with NanoStore
> deliverables that are genuinely valuable reads — not theater.
>
> **Approach**: Comment-level provenance + synthesis articles + single-Captain cycle.
> Staged over 4 days so we can fall back to Approach A if comment-expansion fails.
>
> **Created**: 2026-04-13 evening. **Submission**: Friday 2026-04-17.

---

## Why This Plan

E10 proved the mini-Captain + nano-Worker hybrid cycle works end-to-end at
batch=100 for **~222K sats per 100 tx**. Extrapolated to 1.5M tx/day that's
~$1,000/day — 5× over cap. Three compounding unlocks close the gap AND
differentiate the submission:

1. **Comment-level expansion** — 10-50× content multiplier, legitimate
   uniqueness (comments churn constantly), and real substrate for synthesis.
2. **Single-Captain cycle** — eliminate Captain T2 (the working_memory_set
   theater task); Captain T1 writes the memory entry itself. ~20% cost save.
3. **Synthesis tier** — new agent role. Reads last N worker cycles, writes a
   1500-word analysis article, pins to NanoStore with citation manifest mapping
   article claims to on-chain OP_RETURN txids of source comments. THIS is the
   pitch to judges — a cryptographically-grounded read, not a tx counter.

Combined: expected cycle cost ~150-175K sats, 3000 cycles/day × 25 agents,
~1.5M proofs, ~300 articles, target $100-160/day total.

---

## Go/No-Go Gates

Hard pivots to Approach A (post-level, no synthesis) if any of these fail:

| Gate | Threshold | Day |
|---|---|---|
| G1: comment expansion yields ≥10× hashes per scrape | measured | Day 1 |
| G2: mini synthesis at 500+ records produces readable article | human read | Day 2 |
| G3: single-Captain cycle cost ≤180K sats | measured | Day 1 |
| G4: parent wallet scales to 25 agents | empirical | Day 3 |

---

## Day 1 — Comment Expansion + Single-Captain

### E11: Comment-expansion POC (IN PROGRESS)

- [ ] Rewrite `proof_records.sh` to expand each post into post+top-30 comments
- [ ] Measure: wall clock for batch ≈500 records (post + comments)
- [ ] Measure: unique-hash count vs baseline batch=100 post-only
- [ ] Measure: re-scrape after 15 min, count how many hashes are new
- [ ] Success: ≥500 unique hashes per scrape, ≥50% new on re-scrape

### E12: Single-Captain cycle

- [ ] Refactor `buildFinalCaptainTemplate` → inline as Captain T1 post-work
- [ ] Captain T1 calls delegate_task → waits for Worker commission →
      calls `working_memory_set` itself → ends
- [ ] Eliminate reverse-delegate path entirely
- [ ] Measure: new cycle cost (target ≤180K sats)
- [ ] Measure: new wall clock (should drop — no auto-spawn overhead)

### Day 1 deliverables
- Updated `test_poc_23.js` running end-to-end with comment expansion
- Honest cost + hash-count numbers → this doc updated with G1/G3 results
- Decision: commit to Approach B or fall back to A

---

## Day 2 — Synthesis Agent + NanoStore Integration

### E13: Synthesis Agent scaffolding

- [ ] Add new agent role: `synthesis-agent` with capabilities
      `[memory_read, working_memory_get, upload_to_nanostore, web_fetch]`
- [ ] Define cluster.js agent config + BRC-52 caps
- [ ] Define synthesis task template: "Read last N worker records from
      shared memory. Write a 1500-word analysis article. Upload to NanoStore
      with a source manifest: {article: ..., sources: [{claim_hash, txid},
      ...]}. Report the NanoStore URL."

### E14: Synthesis quality gate (G2)

- [ ] Manual fire: pipe 500 real comments from E11 into a synthesis task
- [ ] Model: gpt-5-mini first (cheapest). Upgrade to gpt-5 or claude-sonnet
      ONLY if mini output is unreadable
- [ ] Human read the output. Is it a legit analysis? YES/NO
- [ ] Measure cost per article

### E15: NanoStore E2E via synthesis agent

- [ ] Drive the existing `upload_to_nanostore` tool from the synthesis agent
- [ ] Verify URL returned, content retrievable, manifest valid
- [ ] Measure: upload latency, cost per MB/year

### Day 2 deliverables
- One real synthesis article pinned to NanoStore with working citation manifest
- G2 decision: is synthesis legit or fall back to A
- Updated plan with actual synthesis costs

---

## Day 3 — Scale Infra

### #18 Wallet provisioning
- [ ] Spawn 23 new bsv-wallet-cli daemons on ports 3324-3346
- [ ] Fund each from parent (rough split of current parent balance)
- [ ] Document ports + which agent role each maps to
- [ ] **Do not touch 3322 / 3323 / 3324 which are already funded and persistent**

### #20 Launch script
- [ ] `launch-fleet.sh` — spawns 20 workers + 5 synthesis agents
- [ ] Health check gate (all 25 must respond within 120s)
- [ ] Tail all logs to `/tmp/fleet-{YYYYMMDD}/agent-N.log`
- [ ] Graceful shutdown via signal

### E16: 5-agent smoke test (G4)
- [ ] Bring up 5 of 25 agents, run 1 full hour
- [ ] Measure: parent wallet stress, cycle completion rate, any crashes
- [ ] If smoke test fails: debug, do not proceed to 25

### Day 3 deliverables
- 25 funded wallets + launch script + green 5-agent 1h run
- Parent wallet bottleneck either confirmed fine or mitigated

---

## Day 4 — Dry Run → Production

### E17: 4-hour dry run at half capacity
- [ ] 12 agents for 4 hours. Not 25. Surface problems early.
- [ ] Monitor: cost burn rate, cycle success rate, synthesis articles landed
- [ ] Post-mortem: fix whatever broke

### Thursday evening: 24h production run
- [ ] Full 25 agents
- [ ] Target: 1.5M on-chain proofs, 300 articles to NanoStore
- [ ] Monitoring: 15-min polling of global state (cost, cycle count, crashes)
- [ ] Kill switch: if burn rate exceeds $10/hr past hour 2, pause + diagnose

### Friday: submission
- [ ] Video: show one article, click citation, land on OP_RETURN in explorer
- [ ] Screenshots: total tx count, cost summary, sample article
- [ ] Write-up: architecture, cost math, why-BSV story
- [ ] Submit

---

## Parking Lot / Post-Submission

- Parallel bash (`xargs -P`) optimization — only needed if Day 1 cost math is tight
- Multi-source curation (approach C ideas) — not for this ship
- `extractWorkerProofResult` stale-task bug — harness fix, file in-flight
- Mission Control UI (#21) — iframe grid only if time
- Full replay-based verification of all 1.5M proofs — sampling only for submission

---

## Progress Log

_Update this section as we go. Reverse-chronological._

### 2026-04-13 late evening — plan created
- E10 results: mini+nano hybrid cycle works at 222K sats / 100 tx. Captain T1 143K, Captain T2 44K, Worker 35K.
- 100 real OP_RETURN txs landed on-chain, verified via sidecar file.
- Blocker at pure-nano Captain: nano collapses nested opaque-task-string pattern (E9 failure mode).
- Committed to Approach B staged plan. E11 is next.

### 2026-04-13 late evening — E11 GATE 1 BLOW-OUT PASS
Lab script: `tests/multi-worm/lab/e11_comment_expand.sh` (zero LLM cost, local).
- **Content multiplier: 63.4×** (50 r/technology posts → 3,172 unique hashable records)
- All 3,172 records were unique in a single scrape (no dedupe needed)
- Scrape+fetch wall clock: 40.9s (100 comments/post serial fetch)
- Per-createAction rate: **0.67s measured** (20 sample txs in 13.36s — 5× faster than E8's 3.3s/tx)
- **Projected batch=500 serial bash: 334s** — fits in 600s bash cap without parallelization
- On-chain proof landed cleanly: 20 sample txs via wallet 3324

**New target config**: batch=500, every 12 min per agent × 25 agents = 3,000 cycles/day × 500 = 1.5M tx.
**Projected cost at target** (single-Captain cycle = 175K sats): **~$160/day** at $30/BSV.

Gate 1 ✅ Gate 3 still pending E12. Gate 2 next.

### 2026-04-13 night — E12 GATE 3 PASS
New harness: `tests/multi-worm/test_cycle_v2.js` (single-Captain, no reverse-delegate).
Run: POSTS_ONLY=1, BATCH_CAP=100, model = mini Captain + nano Worker.

| Tier | Iter | Sats |
|---|---:|---:|
| Captain (mini, overlay_lookup + delegate_task) | 3 | **126,978** |
| Worker (nano, execute_bash + session_end report) | 2 | **13,117** |
| **Cycle total** | | **140,095** |

- **37% cost reduction** vs E10's 222K baseline
- Captain prompt: 2,469 chars (from ~5,000+ with nested inner template)
- Worker: 2 iterations only (no reverse-delegate theater); session_end result
  string is the full proof report
- 100 real OP_RETURN txs landed, 0 errors, manifest sha256 validated
- Cycle wall clock: 273 s at batch=100 (scrape + captain + worker + overhead)
- satsPerProof = 1401 (raw)

**Projected at batch=500 (E13 config)** assuming LLM cost stays ~flat:
- 3,000 cycles × 140K = 420M sats/day
- **~$126/day** at $30/BSV
- Plus synthesis ~$5/day
- **Total projected: ~$131/day — WELL IN THE $200 CAP**

Gates ✅: G1 (63× multiplier), G3 (≤180K cycle). G2 (synthesis quality) next — that's Day 2.

Harness fixes applied: `handle.stop()` (not `stopCluster()`), worker sats read
from session.jsonl (authGet to worker port 8083 wasn't returning during stop).

### 2026-04-14 — next: E13 comment expand + batch=500
- [ ] Re-run test_cycle_v2.js with POSTS_ONLY=0 BATCH_CAP=500
- [ ] Measure: new wall clock (target ≤ 720s to fit 12-min cadence)
- [ ] Measure: new cycle cost (target ≤ 160K — some Captain cost from bigger worker prompt)
- [ ] Confirm bijection on 500 hashes

### 2026-04-14 (early AM) — E13/E14 wallet throughput findings
- E13 (batch=500 serial bash): 497/500 proofs landed before 600s bash timeout. Sustained warm rate ~1.27 s/tx. Cycle cost 124K sats. **Cost-per-proof improved to 250 sats** (from 1401 at batch=100). Cycle wall 740s — slightly over the 720s target.
- E14 (xargs -P 8 parallel): wallet contention disaster. **13/50 proofs succeeded (74% failure)** when running 8 concurrent createActions. Single serial calls work fine; the wallet's internal UTXO locking can't handle sustained P=8.
- **Conclusion**: cannot parallelize wallet calls. Realistic sustained serial rate ~1.5 s/tx.
- **Architecture decision**: at 25 agents with overlay_lookup mandatory + batch~380 serial, we hit ~1.3M tx/day ($157/day). To clear 1.5M, need **30 agents** (~$188/day, still in cap).

### 2026-04-14 (early AM) — E15 full-pipeline POC built
Refactored test_cycle_v2.js into a soak-loop harness with the COMPLETE production
flow: 3 agents (Captain mini + Worker nano + Synthesis mini), shared records dir
at `/tmp/dolphinsense-shared/cycle-{nonce}`, per-cycle manifest.json, NanoStore
upload via the deferred `upload_to_nanostore` x402 tool, and aggregate per-cycle
table for rate-stability inspection.

Pipeline per cycle:
1. Harness scrapes Reddit, builds records.jsonl in shared dir
2. Captain (mini) overlay_lookup + delegate_task to scraping worker
3. Worker (nano) execute_bash proof_batch.sh → N OP_RETURN txs
4. Harness writes manifest.json from worker proof report
5. Synthesis (mini) file_read records → write 1000-1500 word markdown analysis →
   upload_to_nanostore (~730 sats/MB/yr) → return public URL
6. Aggregate: cycleSummary with all costs, txids, NanoStore URL

E15 = first end-to-end fire (1 cycle, batch=100, posts only) to validate before
soak runs. Wallets: captain=3322, worker=3324, synthesis=3323 (all funded).

### 2026-04-14 — E15 GATE 2 PASS (synthesis quality is real)
Full pipeline ran end-to-end on 1 cycle. Result:

| Tier | Sats | Notes |
|---|---:|---|
| Captain (mini) | 183,741 | 4 iter (variance — usually ~140K) |
| Worker (nano) | 14,985 | 2 iter — only 4/100 proofs landed (wallet contention at xargs P=8) |
| Synthesis (mini) | 199,797 | upload_to_nanostore ran cleanly, returned URL |
| **Cycle total** | **383,538** | with synthesis enabled |

**NanoStore article**: <https://storage.googleapis.com/prod-uhrp/cdn/L9GyQCM39pckkRqHNMP4X>
- 1,101 words, real markdown
- Title: "Discordant Threads: A Week Where AI Hype, Security Fallout, and Sovereign IT Choice Collide"
- Quotes named users + vote counts + post titles verbatim
- Five sections: Key Themes, Notable Discussions, Sentiment & Context, Analysis, Provenance Note
- Provenance Note states the manifest sha256 + run nonce + on-chain proof claim
- Reads like a publishable tech essay, not theater. **The judge-facing pitch is real.**

**Issues found**:
1. xargs P=8 still kills wallet 3324 (96/100 createAction failures). Confirmed not viable.
2. `extractWorkerProofResult` raced `session_end` — worker sats parsed as 0. Fix: also wait for `session_end` before reading sats.
3. Captain at 184K sats / 4 iter (vs E12's 127K / 3 iter) — variance, will recompute on E16.

**Fixes for E16**:
- PROOF_SCRIPT default parallelism: `8 → 1` (serial confirmed safe)
- Harness now polls for `session_end` after finding `tool_result`
- Re-fire 1 cycle to confirm 100/100 proofs + correct cost numbers

Gates ✅: G1 (63× content multiplier), G3 (single-Captain ≤180K — depends on which run), **G2 (synthesis = legit valuable read)**.

---

## 2026-04-14 — broadcast stack properly fixed (BUG-005)

**Root cause**: toolbox `post_raw_tx` classified `ANNOUNCED_TO_NETWORK`,
`RECEIVED`, `REQUESTED_BY_NETWORK`, `SENT_TO_NETWORK`, and `QUEUED` as
broadcast success. Combined with `PostBeefMode::UntilSuccess`, that meant
the provider loop broke on the first ARC to ACCEPT a POST — even if that
ARC was silently failing to federate. In production: GorillaPool accepted
~200 txs with `ANNOUNCED_TO_NETWORK` and never propagated them; the wallet
never tried TAAL / Bitails / WoC.

**Fix — published in 3 releases**:
1. **bsv-wallet-toolbox-rs 0.3.37** — reordered `post_beef` providers so
   TAAL is first (GorillaPool demoted to fallback), and `with_arc` /
   `with_gorillapool` accept per-provider `ArcConfig` for auth headers.
2. **bsv-wallet-cli 0.1.19** — added `MAIN_TAAL_API_KEY` env var. When
   set, passes the TAAL API key via `Authorization: <key>` (no `Bearer`
   prefix, as TAAL expects) via `ArcConfig.additional_headers`.
3. **bsv-wallet-toolbox-rs 0.3.38** (+ wallet-cli 0.1.20) — in
   `arc.rs::post_raw_tx`, only `SEEN_ON_NETWORK` / `STORED` / `MINED`
   are treated as real success. Anything else (ANNOUNCED_TO_NETWORK,
   RECEIVED, etc.) is returned as `status: "error"` + `service_error:
   true` so the UntilSuccess loop keeps trying downstream providers
   until ONE of them confirms actual network propagation. Adds test
   `test_post_beef_soft_pass_statuses_are_service_error`.

All three binaries published to crates.io + tagged in git. `rust-bsv-worm`
bumped its `bsv-wallet-toolbox-rs` dep to 0.3.38 in `embedded-wallet`.

**Recovery**:
- 193 txs stuck in wallet 3324 were manually re-broadcast to TAAL via
  `/v1/tx` with auth header. 182 reached `SEEN_ON_NETWORK`.
- After BSV mined 2 new blocks (944770, 944771) the wallet's
  `check_for_proofs` monitor synchronized 188 of them automatically
  to `completed`, unlocking the trapped inputs. 12 remain `unmined`
  (mostly double-spends from the poisoned chain period).
- Proven recovery end-to-end: test tx from 3324 on v0.1.20 → WoC HTTP
  200 + Bitails HTTP 200 within 15s, GorillaPool doesn't even have
  the tx (correctly fell through via the new classification).

## 2026-04-14 — wallet inventory + secrets hygiene

Lost wallet 3323's ROOT_KEY while killing PID 44262 without dumping env
(key was only in-memory from a Saturday launch). Created a fresh
`synthesis-3323` wallet at `~/bsv/wallets/synthesis-3323.db`, funded 2M
sats from 3322, split into 4 outputs. Orphan DB saved at
`/tmp/dm-e2e/data/wallet.db.ORPHAN-no-rootkey-*` in case key ever
surfaces.

Created `~/bsv/rust-bsv-worm/secrets.md` (gitignored) as a single source
of truth for:
- Wallet ports → DB paths → env files → identity keys → ROOT_KEYs
- TAAL API key (`mainnet_9596...`)
- Start commands for all 3 daemons

## 2026-04-14 — wallet state post-fix

- 3322 captain: 409.8M sats, running 0.1.20 + TAAL auth
- 3323 synthesis (NEW): 2M sats, 4 outputs, running 0.1.20 + TAAL auth
- 3324 worker: 8.9M sats, 20 outputs (split for concurrency), running 0.1.20 + TAAL auth
- All three broadcast cleanly via TAAL → WoC/Bitails verified

## 2026-04-14 — E17 setup (next fire)

Updated `test_cycle_v2.js` synthesis pipeline:
- Harness builds `records-annotated.jsonl`: each line is
  `{"txid":"...","record":{...}}` so synthesis can cite records with
  their on-chain txids without juggling two files.
- `buildSynthesisTask()` now takes the annotated path and instructs
  the synthesis agent to do THREE tool calls:
  1. `file_read` the annotated file
  2. `upload_to_nanostore` a plaintext txid manifest (newline-joined)
  3. `upload_to_nanostore` the HTML article with ≥4 inline
     `<blockquote>` citations each carrying a real `<code>` txid, plus
     a Provenance Note linking to the manifest URL
- Synthesis reports BOTH `TXIDS_URL:` and `NANOSTORE_URL:` in session_end.
- `extractSynthesisResult` + `cycleSummary` capture both.

**Cost expected**: synthesis adds one extra NanoStore upload (~tiny
cost for a ~7KB plaintext file) but the article becomes properly
anchored — every quote has a clickable on-chain proof.

**E17 goal**: fire full pipeline (Captain + Worker + Synthesis) with
batch=100, 1 cycle, get cost + HTML + txid-list + deep transcript
inspection. If the synthesis quality holds with citations, unblock
soak runs + #18 wallet provisioning.

### 2026-04-14 — E16 FULL PIPELINE PASS (HTML + 100/100 proofs)
Three fixes from E15:
1. PROOF_SCRIPT default parallelism: 8 → 1 (serial — wallet rejects parallel)
2. Harness polls for `session_end` after `tool_result` (was racing iter-2)
3. Synthesis prompt now asks for full standalone HTML5 document with inline CSS

Result: **100/100 proofs landed, 0 errors, real numbers, real HTML article.**

| Tier | Sats | Iter |
|---|---:|---:|
| Captain (mini) | 142,777 | 3 |
| Worker (nano) | 12,849 | 2 |
| Synthesis (mini) | 191,542 | — |
| **Cycle total** | **347,168** | |

NanoStore HTML article: <https://storage.googleapis.com/prod-uhrp/cdn/EXvNJNvbqW3dv8SwmisiKS>

The HTML doc is **production deliverable quality**:
- 7,847 bytes, valid HTML5 (DOCTYPE, lang, viewport meta, charset)
- Inline CSS with system font stack, 720px max-width, light/dark scheme aware,
  mobile breakpoint at 420px, styled blockquotes, provenance footer card
- Title: "Forks, Clones, and Contention: What 100 r/technology Records Say About Tech in April 2026"
- Five sections: Key Themes / Notable Discussions / Sentiment & Context / Analysis / Provenance Note
- Quotes Reddit users by handle (u/Amentet, u/Hrmbee, u/yourbasicgeek, u/MarvelsGrantMan136)
- Provenance footer with manifest sha256 + run nonce + on-chain claim
- Opens cleanly in any browser, reads like a published tech essay

**ALL GATES GREEN** (G1, G2, G3, full pipeline ✓).

### Cost reality check at E16 numbers
- Per cycle with synthesis: 347K sats / 100 proofs = 3,472 sats/proof
- For 1.5M proofs/day: 5.2B sats ≈ **$156/day** at $30/BSV — IN CAP
- **BUT** wall clock per cycle was 794s (worker bash 4.7 s/tx — wallet 3324 is
  badly degraded after E11-E15 cumulative load).
- 25 agents × (3600/794) × 100 = **272K proofs/day** at this wall rate. **5.5×
  short of 1.5M.** Need fresh wallets to clear the gate.
- E11 lab on a freshly-warmed wallet measured 0.67 s/tx serial. If production
  wallets sustain ~1.0 s/tx, batch=100 cycle wall = ~220 s, and
  25 × (3600/220) × 100 = 980K/day per agent-fleet — still short at 25 agents.
- At 30 agents (the path we already committed to) with cleaner wallets:
  30 × 16 × 60 × 60/220 × 100 ≈ 2.4M/day. **Hits 1.5M with margin.**

### Synthesis amortization (key cost win)
- Synthesis runs every Nth cycle, not every cycle. At N=25:
  - 24 worker-only cycles: 155K each
  - 1 synthesis cycle: 347K
  - Average per cycle: (24×155K + 347K)/25 = ~162K sats
- 30 agents × 96 cycles/day × 162K = 467M sats ≈ **$140/day**
- 30 agents × 96 cycles × 100 proofs = **288K proofs/day** — short
- Need cycles/day per agent ≈ 500 to hit 1.5M at 30 agents. That requires
  cycle wall ≈ 173 s, which means worker bash ≤ ~120 s, which means batch=100
  at ≤ 1.2 s/tx serial. **A fresh wallet in production should hit this.**

### Open question: production wallet throughput
- We do NOT yet know whether 25-30 fresh wallets sustained at 1 cycle every
  ~3 minutes (each wallet doing ~480 createActions/day) will degrade like
  3324 did, or stay fast.
- Wallet 3324 took ~700 createActions before noticeably degrading. At 480/day
  it would degrade after ~1.5 days. The 24h run finishes BEFORE the predicted
  degradation point — but only barely.
- **Mitigation**: provision 30 wallets, run them in shifts of 15 (each doing
  half the day), giving each wallet ~3.5 hours of rest mid-run.
- Or: detect degradation in-flight and rotate.

### Next steps
- [ ] **E17**: 3-cycle soak on the same cluster to measure rate-stability
      (does cycle 2 cost more than cycle 1? does wall clock grow?). Use the
      degraded wallet 3324 as a worst-case stress baseline.
- [ ] Move to #18 (provision 27 new wallets, ports 3325–3351, leaving
      3322/3323/3324 alone)
- [ ] Build #20 launch script with rotating-shift design

## 2026-04-14 — E17 + E18 full pipeline PASS (txid citations working)

**HUGE CHECKPOINT.** End-to-end POC is GREEN on the reworked broadcast stack
and the reworked synthesis flow. Articles read like real publications,
citations are real on-chain txids, and we have hard numbers for the 1.5M math.

### E17 (first clean post-broadcast-fix run, 2026-04-14 10:08)
- Captain (gpt-5-mini, 3 iter):   130,457 sats
- Worker  (gpt-5-nano):             14,250 sats  (100/100 proofs, 0 errors)
- Synthesis (gpt-5-mini, 3 iter):  270,162 sats
- **Cycle total: 414,869 sats (~$0.041)** in **415 s (6.9 min)**
- Sats per proof: **4,149**
- HTML article: `https://storage.googleapis.com/prod-uhrp/cdn/43eFTqb1fWvv26hK8E2AzA`
- Artifact quality: real Reddit citations, named subreddits, quoted handles,
  provenance footer with manifest sha256 + on-chain claim.
- **ONE BUG**: synthesis agent cheaped out on the txid manifest upload.
  Instead of uploading all 100 txids, it wrote 8 txids plus a literal
  `... (remaining txids... total 100 lines) ...` placeholder. Mini-class
  model saw "100 items" and self-summarized, breaking the provenance chain.

### E18 (txid manifest truncation fix verified, 2026-04-14 10:27)
- Captain (gpt-5-mini, 3 iter):   121,783 sats
- Worker  (gpt-5-nano):             14,411 sats  (100/100 proofs, 0 errors)
- Synthesis (gpt-5-mini, 4 iter):  297,211 sats
- **Cycle total: 433,405 sats (~$0.043)** in **391 s (6.5 min)**
- Sats per proof: **4,334**
- HTML article: `https://storage.googleapis.com/prod-uhrp/cdn/4grXdPjWMGpNJgBjy8muzW`
- **TXIDS manifest: `https://storage.googleapis.com/prod-uhrp/cdn/TaWffJP3VwdxcTCyt8SXoF`**
  - 6,500 bytes, **100 lines, every line a valid 64-char hex txid, zero truncation markers**.
  - First/last txid match aggregate.json firstTxid/lastTxid.

### The txid truncation fix
`upload_to_nanostore` supports a `file_path` parameter that streams bytes
directly from disk — the LLM never loads the content into its context.
The harness already builds `records-annotated.jsonl` (record+txid pairs)
after worker proof_batch completes, and writes the plain txid list to
`records.jsonl.txids`. Synthesis task was reworked so STEP 2 receives the
absolute path and uploads it as-is via `file_path`. No LLM composition
of the manifest. Deterministic, cheap, non-truncatable.

Code change: `tests/multi-worm/test_cycle_v2.js`
- `buildSynthesisTask(absAnnotatedPath, absTxidsPath, runNonce, proofsCreated, manifestSha)`
  (added `absTxidsPath` parameter)
- STEP 2 prompt rewritten to say "DO NOT compose this yourself, upload
  via file_path", with concrete `file_path: "<absTxidsPath>"` in the prompt.
- Call site in `runCycle` passes `path.resolve(workerProof.result.txid_file)`
  as the new arg.

### Transaction accounting for E18
On-chain tx count per 100-record cycle (measured from transcripts + BEEF files):
- **Data-plane OP_RETURN proofs (worker batch): 100** (1 tx per Reddit post)
- **Control-plane BRC-18 proofs** (agent lifecycle across all 3 agents): **23**
  - captain 7: 3 decision + task_completion + budget_snapshot + custody + conversation_integrity
  - worker  6: 2 decision + task_completion + budget_snapshot + custody + conversation_integrity
  - synth  10: 4 decision + 2 capability_proof + task_completion + budget_snapshot + custody + conversation_integrity
- **x402 payment BEEF receipts** (LLM inference + NanoStore uploads): **52**
  - captain 23, worker 15, synthesis 14
- **TOTAL: ~175 on-chain txs per cycle**
- Sats per *any* on-chain tx: **433,405 / 175 ≈ 2,480 sats/tx ≈ $0.00025/tx**
- Sats per data-plane proof specifically: 4,334

### 1.5M math with measured E18 numbers
Baseline: 433,405 sats/cycle (synthesis EVERY cycle — worst case).

Target: 1.5M data-plane proofs/day. That's 15,000 cycles/day cluster-wide.
- 15,000 × 433,405 sats = 6.5B sats ≈ **$650/day** — OVER CAP.

With synthesis amortized 1-in-25 cycles:
- 24 worker-only cycles ≈ (121K + 14K) ≈ 136K each
- 1 synthesis cycle ≈ 433K
- Average per cycle: (24×136K + 433K)/25 = **~147K sats**
- 15,000 × 147K = 2.2B sats ≈ **$220/day** — AT CAP EDGE.

With synthesis amortized 1-in-100:
- Average: (99×136K + 433K)/100 = **~139K sats**
- 15,000 × 139K = 2.08B sats ≈ **$208/day** — still at edge.

Wall clock:
- 391 s/cycle at batch=100 = **~920 cycles/day per agent-lane**
- 15,000 cycles/day / 920 = **16.3 agent-lanes needed**
- 25 agent provisioning target has room. 30 is comfortable.

**Verdict**: the pipeline works, the content is genuinely valuable, the
manifest is deterministic, and the math is tight-but-feasible. Two remaining
levers to stay inside $100-200/day:
1. Amortize synthesis 1-in-N (25 to 50)
2. Squeeze captain LLM cost — currently 121K-130K sats, fatter target than
   worker which is already near-floor at 14K sats/100 proofs.

### Next
- [ ] Deep-read the E18 HTML article side-by-side with the txid manifest —
      spot-check 5 random citations resolve to real Reddit posts.
- [ ] Decide: dedicated "captain LLM tamer" pass to trim those 121K sats,
      or defer post-POC?
- [ ] **#18 wallet provisioning**: 23 new wallets, ports 3325-3347.
- [ ] **#20 launch script** for 25 agents + 5-agent smoke test gate.
- [ ] 4-hour dry run Tuesday evening, 24-hour production Thursday,
      submission Friday 2026-04-17.

<!-- NEXT LOG ENTRIES GO HERE -->
