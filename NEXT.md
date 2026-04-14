# NEXT — post-E20d roadmap to Friday submission

> **Created**: 2026-04-14 late afternoon, immediately after E20d checkpoint.
> **Submission**: Friday 2026-04-17.
> **Reference**: [PLAN-C-SCALE.md](PLAN-C-SCALE.md) for the full architecture + scale math.
> **Checkpoint commit**: `rust-bsv-worm@f47c0c3` — dolphin-milk binary is now
> feature-frozen from dolphinmilkshake's perspective. All remaining work
> happens in THIS repo.
>
> ✅ **Session checkpoint (2026-04-14 evening, post-E21-0)**: 5-lane fleet
> cycle passed with 500 on-chain proofs + 4 NanoStore articles published.
> Split-outputs bug fixed in bsv-wallet-cli v0.1.21 (published to crates.io).
> 15 fleet wallets repaired via DB surgery. Single-lane synthesis validated.
> See [experiments/E21-0-stage.md](experiments/E21-0-stage.md) for the
> forensic record of the funding saga and the root-cause fix.
>
> **Next ship target**: 1-hour E21 soak with synthesis amortized 1-in-25.

---

## 🎉 E21-0 checkpoint — we're inside budget and on the right path

**This was the moment the fleet became real.** First true parallel 5-lane
fleet cycle, full synthesis pipeline, post-repair wallets, 500 on-chain
proofs, 4 published NanoStore HTML articles with on-chain-cited
blockquotes, all in a single ~385-second wall-clock window.

### Per-lane tx accounting (what actually hit the chain)

For each **full-synth** lane (worldnews / politics / gaming / movies):

| tx type | count | source |
|---|---:|---|
| Data-plane OP_RETURN proofs | 100 | worker `proof_batch.sh` |
| Captain BRC-18 control proofs |  ~6 | decision × 2, budget_snapshot, conversation_integrity, custody, task_completion |
| Worker BRC-18 control proofs  |  ~6 | same set |
| Synthesis BRC-18 control proofs | ~10 | decision × 4, capability_proof × 2, budget_snapshot, conversation_integrity, custody, task_completion |
| x402 payment BEEFs | ~30 | captain + worker + synthesis LLM calls + NanoStore uploads |
| **per-lane total** | **~152** | |

askreddit (partial synthesis — no NanoStore uploads) landed **~120 txs**
instead of ~152.

**Fleet E21-0 total**: 4 × 152 + 120 = **~728 on-chain txs** for
**1,800,259 sats** = **~2,470 sats per tx ≈ $0.000247 per tx**.

### Scale math with full tx accounting

The earlier PLAN-C-SCALE math counted only data-plane proofs (100/cycle).
The real tx count per cycle is ~120-152 depending on whether synthesis
runs. That changes everything — per-tx cost drops from ~3,600 sats to
**~2,470 sats**, and fewer lanes are needed to hit 1.5M txs/day.

With synthesis amortized **1-in-25** cycles (24 worker-only + 1 synth):

- Worker-only cycle: ~130K sats, ~120 txs on-chain
- Synthesis cycle: ~410K sats, ~152 txs on-chain
- 25-cycle average: **~141K sats, ~121 txs/cycle**
- Per-lane-per-day: 86400s ÷ ~148s/cycle = 584 cycles × 121 = **~70,664 txs/day/lane**

### Lane-count options

| scenario | lanes | daily on-chain txs | daily cost | verdict |
|---|---:|---:|---:|---|
| 22 lanes, 1-in-25 synth | 22 | ~1,554,600 | **$181/day** | ✅ inside $200 cap with 9% margin |
| 25 lanes, 1-in-25 synth | 25 | ~1,766,600 | $206/day | ❌ just over cap |
| 22 lanes, 1-in-50 synth | 22 | ~1,554,600 | **$174/day** | ✅ comfortable |
| 20 lanes, 1-in-25 synth | 20 | ~1,413,280 | **$164/day** | ✅ but 6% short of 1.5M |

**Target config: 22 lanes × 1-in-25 synthesis amortization ≈ 1.55M on-chain
txs/day for ~$181/day.** That's inside the $100-200 cap with ~9% headroom
for wallet degradation, cycle jitter, and synthesis cost variance.

If we want more safety margin, 22 lanes × 1-in-50 synthesis = ~$174/day
and still clears 1.5M.

### Why this matters

Before E21-0, the fleet-mode overhead vs single-lane E20d looked scary
(captain was 98-120K across the lanes vs E20d's 91K — implying the fleet
was ~15% more expensive per cycle). That made the $/day projection creep
toward the edge of the cap.

Counting ALL txs (not just data-plane proofs) reveals that the per-tx
cost actually dropped from E18's 4,334 sats/proof to **~2,470 sats/tx**
— a 43% improvement — because the cost is spread across 120-152
transactions per cycle instead of 100.

**We're not edge-of-cap anymore. We're comfortably inside.** Fleet-mode
overhead was a red herring; the real lens is cost-per-on-chain-tx,
and that lens says we're shipping strong.

Source of the E21-0 numbers: `experiments/E21-0-stage.md` and the per-lane
aggregate JSON files at `test-workspaces/fleet/<lane>/cycle-2026-04-14T21-03-*/`.

---

## 🎯 The todo list (ordered, current)

### 1. Scale math: 1.5M target check-in
Pull the E21-0 measured numbers into concrete daily/cycle projections.
Answer: at these numbers, how many lanes and how many cycles/day are
required to hit 1.5M proofs in 24h at ≤$200/day? Synthesis amortized
1-in-25. Compare against PLAN-C-SCALE.md's earlier projections.
Should result in an updated scale section in PLAN-C-SCALE.md and a
concrete "we need N lanes" answer. **~20 min, no run.**

### 2. askreddit synthesis partial (non-blocking investigation)
E21-0 run produced 4/5 synthesis articles. askreddit's synthesis ran
for only 37,427 sats (normal is ~280K) and returned no NanoStore URLs.
Read synthesis-askreddit's session.jsonl from the cycle workspace,
identify what went wrong (likely max_iterations hit before HTML
composed, OR tool_call error, OR input records had some edge case).
Fix or document as known flakiness. **~20 min, no run.**

### 3. Synthesis amortization (gating the E21 soak)
Currently lane-cycle.js runs synthesis on EVERY cycle when
`ENABLE_SYNTHESIS=1`. For the 1-hour soak at SOAK_CYCLES=~15, that'd
be 15 synthesis runs per lane × 5 lanes = 75 synthesis runs = ~21M
sats = $21. That's expensive and not what PLAN-C-SCALE.md says to do.

Per PLAN-C, synthesis should amortize **1-in-25 cycles** per lane
(24 worker-only cycles between each synthesis cycle). Need to add a
`SYNTHESIS_EVERY_N=25` env var to lane-cycle.js:
- Env var default: `SYNTHESIS_EVERY_N=25` (or 0 = every cycle like today)
- Logic: inside the cycle loop, skip the synthesis block unless
  `cycleIdx % SYNTHESIS_EVERY_N === 0`
- For the 1-hour soak at 15 cycles × 1-in-25 amortization, synthesis
  only runs on cycle 0 of each lane (= 5 synthesis total for the run)
- Expected cost: 5 × 285K = 1.4M synthesis sats + 15 × 5 × (captain
  110K + worker 14K) = 9.3M other sats ≈ 10.7M sats ≈ **~$1.07 for
  the hour soak**

**~15 min work, gates task #4.**

### 4. E21 1-hour soak
Run `SOAK_CYCLES=15 ENABLE_SYNTHESIS=1 SYNTHESIS_EVERY_N=25
LAUNCH_STAGGER_SEC=15 ./scripts/fleet-cycle.sh`. Expected:
- 5 lanes × 15 cycles = 75 worker-only cycles + 5 synthesis cycles
- ~7500 on-chain proofs
- ~5 NanoStore articles
- ~$1-1.50 total
- ~1h wall clock per lane (stagger makes fleet-wall ~75 min total)

**Budget check before firing**: each lane wallet needs enough UTXOs
to cover 15 cycles of x402 churn. Current captain wallets have ~10M
sats after E21-0, synthesis has ~5M, worker has ~5M. At 110K sats/
cycle for captain = 1.65M for 15 cycles, fine. At 14K worker = 210K,
fine. At 285K synthesis × 1 cycle = 285K, fine. **Budget OK without
topups.** Verify with preflight before firing.

### 5. Mission Control UI (task #13)
Tiny Node server tailing:
- `/tmp/dolphinsense-firehose/events.jsonl` (feeder stream)
- `/tmp/dolphinsense-firehose/health.json` (feeder health)
- Per-lane session.jsonl files (for live think/tool events)
- Per-cycle records-annotated.jsonl (for txid list)
SSE to browser, vanilla HTML dashboard (no framework). Lane tile grid,
rolling tx counter, live article feed. Budget: ~2-3 hours for a
functional-but-ugly version that's demo-ready.

---

## Gating notes

- **Task #1 → #2 → #3 → #4**: strictly sequential. Task #1 (math) gives
  us the target cost/cycle budget. Task #2 (askreddit) might surface
  an LLM / synthesis bug worth fixing before any soak. Task #3 is the
  prerequisite code change for #4 being affordable.
- **Task #5 (UI)** can happen in parallel with any of #1-#4, but is
  probably best to do AFTER #4 so we have real soak data to render.

## What's NOT on this list (consciously deferred)

- 30-wallet expansion (only needed if scale math says so after task #1)
- 24h production run (Thursday)
- Video + submission (Friday)
- Anything post-submission

---

## What E20d proved (2026-04-14)

**The full pipeline works end-to-end on the new queue architecture with the
narrative-correct delegation flow.**

| component | sats | iters | notes |
|---|---:|---:|---|
| Captain (parallel `delegate_task`) |  91,228 | 2 | overlay_lookup + delegate_task in single iter |
| Worker (gpt-5-nano)                |  13,531 | 1 | 100/100 proofs on-chain |
| Synthesis (gpt-5-mini)             | 284,176 | 4 | full HTML + txid manifest via `file_path` stream |
| **Cycle total**                    | **388,935** | | **sats_per_proof: 3,889** |
| Cycle wall                         | **299 s** | | 24% faster than E18's 391s |

**`delegate_task` commission** (captain iter 1 tool_result):

```
commission_id:        ca315656-88d7-4f07-b1ed-74a908772aef
amount_sats:          600,000  (paid handoff captain → worker)
delegation_cert_hash: sha256:7195522d138daaaedd6e4bef2a9c561685d3948144f82cef5aeb11bcb771891c
revocation_txid:      03c194ed916691990fef21a4117277cfb9f9edb231098b97a8fc6b4fd2378c3c
sent_message_id:      0e018d5d-f6b6-44f3-9594-f0c5d8b1579c   (BRC-33 messagebox)
recipient:            026468a60d00ec36...                     (worker identity)
```

**NanoStore URLs** (both verified live, both survived `curl`):

- HTML article: https://storage.googleapis.com/prod-uhrp/cdn/6bsYrg76eJMNHeLMkjjsqe
  > "Signals from r/technology: April snapshot of topics, tone, and trust"
- TXIDS manifest: https://storage.googleapis.com/prod-uhrp/cdn/97GQUbdRkWE8mauZhm6LGM
  > 100 lines, zero truncation markers, `file_path` streaming stable

**Every element of the story works in a single cycle**: discovery → paid BRC-52
delegation cert with on-chain revocation UTXO → BRC-33 messagebox delivery →
600K sats commission → worker `proof_batch.sh` emits 100 OP_RETURNs → synthesis
reads annotated records → NanoStore uploads (txid manifest + HTML article) →
x402 payments recorded at every step.

---

## What's LOCKED IN (decisions already made, don't relitigate)

1. **Cursor-paged Reddit /comments firehose** — standalone feeder writes to
   per-sub `queue.jsonl`, agents consume via atomic watermark. Zero dedup
   logic in agents. See [PLAN-C-SCALE.md §god-tier architecture](PLAN-C-SCALE.md).
2. **Parallel skinny captain** (`SKINNY_CAPTAIN_MODE=parallel`) is the
   production captain mode. Worker identity pre-baked from cluster handle,
   `overlay_lookup` + `delegate_task` emitted as parallel tool_calls in one
   iter, `max_iterations=2`.
3. **Synthesis amortized 1-in-25 cycles** — 24 worker-only cycles then 1
   synthesis cycle. At measured E20d numbers this lands at ~$174/day for
   1.5M proofs. Inside the $100-200 cap with 13% margin.
4. **25 lanes, not 30-36** — wall-clock math ended up favorable (worker-only
   cycles are 142s not 200s). 25 lanes × 608 cycles/day × 100 proofs =
   1.52M/day. Leaner fleet = easier provisioning.
5. **DolphinSense User-Agent for Reddit** — `DolphinSense/0.1 (+https://...; contact: ops@...)`.
   Reddit rate-limits by (IP, UA) pair. Descriptive UA unblocks us from 429s
   AND is Reddit's documented preference.
6. **3 wallets per lane OR pooled wallets** — still open. See "open risks" below.
7. **dolphin-milk is feature-frozen from here** — dolphinmilkshake is the only
   moving repo. Pinned dep commit: `rust-bsv-worm@f47c0c3`.

---

## Dependency on rust-bsv-worm

dolphinmilkshake treats `~/bsv/rust-bsv-worm` as an **external binary
dependency**. We do not import its Rust types, we do not modify its source,
we invoke `target/release/dolphin-milk` at runtime and feed it via files,
HTTP, and env vars.

**Pinned commit**: `f47c0c3` (2026-04-14) — "dolphinsense: cursor-paged
comment firehose + queue-mode harness + skinny captain — E20d full pipeline
validated". This commit contains:
- `scripts/reddit-cache-feeder.js` (referenced + copied in this repo at `feeder/`)
- `tests/multi-worm/test_cycle_v2.js` — the test-harness driver that
  cycles a 3-agent cluster against the queue (this is the shape we
  adapt for fleet launch, not consumed directly)
- `SKINNY_CAPTAIN_MODE` + `QUEUE_MODE` env-gated paths in the binary's
  test harness

**What this repo DOES**: prompts, configs, fleet launch scripts, wallet
ops, feeder ops, experiment archives, mission-control UI, submission
artifacts.

**What this repo DOES NOT DO**: modify rust-bsv-worm source, rebuild
dolphin-milk, touch wallet internals.

---

## What's left before Thursday 24h production run

### Day 1 — Tuesday 2026-04-15 (wallet fleet + sub list)

- [ ] **#18 wallet provisioning** — provision 30 wallets on ports 3325-3354.
      Use `scripts/fund-wallet.sh` to bootstrap each from 3322. Target ~100
      UTXOs per worker wallet, ~20 per captain, ~20 per synthesis. See
      [WALLETS.md](WALLETS.md) for the recipe.
- [ ] **Sub list rebalance** — E19b showed worldnews = 25/min, technology/news
      = 5-7/min. Current 30-sub list averages ~10/min which projects to
      ~650K/day. Swap in high-churn subs (AskReddit, politics, gaming,
      videos, AmItheAsshole) to lift average to 35/min → 1.5M/day.
      Edit `feeder/subs.json` (or equivalent) + re-probe with `e19b`.
- [ ] **Feeder hardening** — add 429 backoff, cursor persistence under
      restart, health-file alert threshold (queue depth below N = warning).
      The rust-bsv-worm version of the feeder is fine for short runs but
      needs production polish for 24h.

### Day 2 — Wednesday 2026-04-16 (fleet launch + events taxonomy + UI skeleton)

- [ ] **Fleet launch script** — `scripts/fleet-launch.sh`. Spawns N
      dolphin-milk cluster triples (captain/worker/synthesis) on assigned
      ports, wires each worker to its own sub from the sub list, starts
      the feeder, runs a preflight check (all wallets healthy, queue
      populated, certs issued), and enters the production cycle loop.
      Borrow structure from the existing `scripts/launch.sh` which handles
      the 4-agent case.
- [ ] **Event taxonomy wiring** — implement the 16-event `events.jsonl`
      stream from PLAN-C-SCALE.md §event-taxonomy. Harness writes
      `cycle_start`, `cycle_done`, `scrape_*`, `cycle_total`. Feeder already
      writes `scrape_start`, `scrape_done`, `error`. Agents need
      `think_start`, `think_done`, `proof_emitted`, `proof_batch_done`,
      `message_sent`, `nanostore_upload_*`, `overlay_lookup_*`,
      `synthesis_article_published`.
- [ ] **UI skeleton** — single-file HTML + tiny Node SSE server tailing
      `events.jsonl`. Live tile grid (one per lane) + rolling tx counter +
      article feed. 4-hour build, not a polished dashboard.
- [ ] **4h dry run preflight** — start feeder 15 min ahead, verify queue
      populated, fire 4h run, monitor health file + events stream.

### Day 3 — Thursday 2026-04-16 (24h production)

- [ ] Morning: preflight + start 24h production run
- [ ] Afternoon/evening: monitor, hot-swap any degraded wallets
- [ ] Night: production run running unattended

### Day 4 — Friday 2026-04-17 (finish + submit)

- [ ] Morning: production run finishes → collect final aggregate
- [ ] Verify final NanoStore URLs + txid manifest + HTML article count
- [ ] Record video demo (captain delegation + live tx ticker + example article)
- [ ] Write final README with links + reproduction instructions
- [ ] Submit

---

## Open risks (unresolved)

1. **Sub-list uniqueness at 30 subs** — current list projects to ~650K/day
   not 1.5M. Needs rebalance (Day 1). Worst case: accept 1M/day, story stays
   strong.
2. **Wallet degradation at 60K createActions/day/lane** — pre-toolbox-0.3.29
   wallet 3324 degraded after ~700 createActions. Post-fix we have no
   24h-scale data. Mitigations: provision 35-40 wallets (spares for
   hot-swap), or 12h rotation shifts, or detect-and-swap in flight.
3. **Feeder rate-limit handling at 30 subs** — tested at 1-3 subs. Round-
   robin over 30 subs at 1-req/sec = full rotation every 30s, well under
   Reddit's 60/min unauth cap with the DolphinSense UA. Untested at scale.
4. **Parallel createAction contention on fresh wallets** — E15 observed
   96/100 rejection at P=8 on old wallet 3324. Production wallets are
   fresh. Start at P=1 (known safe) and only bump if measurements permit.
5. **The UI is un-built** — we need something to run during the video.
   See [PLAN-C-SCALE.md §UI plan FUTURE](PLAN-C-SCALE.md).

---

## First 3 things to work on when you next sit down

1. **Start `scripts/fleet-launch.sh`** — copy the 25-agent launch script
   pattern, adapt for 25 × 3-agent-triple (captain+worker+synthesis per
   lane), drive it with a lane-config JSON that maps lane → sub name →
   wallet ports. Dry-run it against 2-3 lanes first.
2. **Rebalance the sub list** — edit the feeder's DEFAULT_SUBS or pass
   a `SUBS=...` env var with ~30 high-churn sub names, re-run `e19b` to
   confirm aggregate churn ≥35/min, lock the list into `feeder/subs.json`.
3. **Write `scripts/fund-wallet.sh`** — it's already written in this same
   commit. Test it by running `./scripts/fund-wallet.sh 3322 3323 5000000 10`
   (send 5M from 3322 to 3323, split into 10 outputs). Verify the whole
   pipeline: send → capture BEEF → fund --vout 0 on receiver → split.

---

## Hand-off context

- **rust-bsv-worm pinned commit**: `f47c0c3` (on `main` at github.com/Calgooon/rust-bsv-worm)
- **E20d run artifacts**: `~/bsv/rust-bsv-worm/test-workspaces/cycle-v2-2026-04-14T17-10-38-fab9473c/aggregate.json`
  and the rerun at `cycle-v2-2026-04-14T17-23-45-306024bc/` (if still on disk)
- **Feeder state (transient)**: `/tmp/dolphinsense-firehose/` — wiped
  between runs during development
- **Wallet inventory**: rust-bsv-worm/secrets.md (gitignored) — 3322 captain,
  3323 synthesis (now 15.26M after top-up), 3324 worker (now 21.24M after
  top-up), plus an orphan DB with lost ROOT_KEY
- **Full experiment ladder**: PLAN-C-SCALE.md §experiment ladder
- **What NOT to touch**: dolphin-milk binary source code, the existing
  `scripts/launch.sh` and `scripts/register.sh` (4-agent design kept for
  reference), 25-agent TOML configs in `agents/`, role prompts in `prompts/`
