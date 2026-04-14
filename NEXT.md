# NEXT — post-E20d roadmap to Friday submission

> **Created**: 2026-04-14 late afternoon, immediately after E20d checkpoint.
> **Submission**: Friday 2026-04-17.
> **Reference**: [PLAN-C-SCALE.md](PLAN-C-SCALE.md) for the full architecture + scale math.
> **Checkpoint commit**: `rust-bsv-worm@f47c0c3` — dolphin-milk binary is now
> feature-frozen from dolphinmilkshake's perspective. All remaining work
> happens in THIS repo.

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
