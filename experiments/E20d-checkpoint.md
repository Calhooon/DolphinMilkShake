# E20d — full pipeline checkpoint (2026-04-14)

**Run nonce**: `306024bc`
**Timestamp**: 2026-04-14 afternoon
**Harness**: `rust-bsv-worm@f47c0c3:tests/multi-worm/test_cycle_v2.js`
**Flags**: `SKINNY_CAPTAIN_MODE=parallel QUEUE_MODE=1 ENABLE_SYNTHESIS=1`

This is **the narrative-correct full pipeline run** — the one that
validates every element of the DolphinSense story in a single cycle on
the new queue architecture with `delegate_task` preserved.

## The story it tells (in one cycle, ~5 minutes)

1. **Reddit feeder** pulls `/r/technology/comments.json?before=<cursor>` and
   writes 100 new comments to `/tmp/dolphinsense-firehose/technology/queue.jsonl`.
2. **Harness claims** 100 records from the queue, advances the per-sub
   watermark atomically. 4ms. No network calls.
3. **Captain** (gpt-5-mini, 2 iters, 91,228 sats) calls `overlay_lookup` and
   `delegate_task` **in parallel** in a single assistant response. Worker
   identity key is pre-baked from the cluster handle so there's no runtime
   dependency between the two calls.
4. `delegate_task` creates a **BRC-52 delegation cert with on-chain
   revocation UTXO**, sends a **BRC-33 messagebox message** to the worker
   with the opaque task, and returns a commission with **600,000 sats paid
   forward** from captain to worker.
5. **Worker** (gpt-5-nano, 13,531 sats) receives the commission, runs
   `execute_bash` to invoke `proof_batch.sh`, which creates **100
   OP_RETURN transactions** via wallet `createAction` — one per Reddit
   comment, each containing the SHA-256 of the canonical JSON.
6. **Harness** pairs each record with its txid (`records-annotated.jsonl`)
   and submits a synthesis task.
7. **Synthesis** (gpt-5-mini, 4 iters, 284,176 sats) reads the annotated
   file, uploads the txid manifest to NanoStore via `file_path` streaming,
   composes a 1000-1500 word HTML article with 4+ cited `<blockquote>`
   elements each carrying a real on-chain txid, uploads the HTML.
8. **All payments** along the way flow through **x402** — captain's LLM
   calls, worker's LLM calls, synthesis's LLM calls, and both NanoStore
   uploads. ~30 x402 payment BEEFs recorded on top of the data-plane.

## Results

| component | sats | iters | notes |
|---|---:|---:|---|
| Captain (parallel, delegate_task) |  91,228 | 2 | iter 1: parallel tool_calls, iter 2: wrap-up |
| Worker (gpt-5-nano)                |  13,531 | 1 | 100/100 proofs on-chain, at floor |
| Synthesis (gpt-5-mini)             | 284,176 | 4 | full HTML + file_path txid manifest |
| **Cycle total**                    | **388,935** | | **sats_per_proof: 3,889** |
| Cycle wall                         | **299 s** | | 24% faster than E18's 391s |

## On-chain tx accounting

| type | count | notes |
|---|---:|---|
| Data-plane OP_RETURN (worker `proof_batch`) | 100 | 1 per Reddit comment |
| Control-plane BRC-18 proofs (captain) | 6 | decision×2, budget_snapshot, conversation_integrity, custody, task_completion |
| Control-plane BRC-18 proofs (worker) | 6 | same set |
| Control-plane BRC-18 proofs (synthesis) | ~10 | decision×4, capability_proof×2, budget_snapshot, conversation_integrity, custody, task_completion |
| x402 payment BEEF receipts (all 3 agents) | ~30 | LLM inference + NanoStore uploads |
| **Total on-chain txs per cycle** | **~152** | |

At 1.5M data-plane target: **~2.28M total txs on-chain in 24h**.

## Captain's `delegate_task` commission (audit trail)

Extracted from `rust-bsv-worm/test-workspaces/cycle-v2-captain/tasks/<captain-task-id>/session.jsonl`,
iter 1 tool_result:

```json
{
  "success": true,
  "commission_id":         "ca315656-88d7-4f07-b1ed-74a908772aef",
  "amount_sats":           600000,
  "recipient":             "026468a60d00ec36bc1dafafbd8992d12f40fb6a4740f278deb5ee94d346bd9722",
  "delegation_cert_hash":  "sha256:7195522d138daaaedd6e4bef2a9c561685d3948144f82cef5aeb11bcb771891c",
  "revocation_txid":       "03c194ed916691990fef21a4117277cfb9f9edb231098b97a8fc6b4fd2378c3c",
  "sent_message_id":       "0e018d5d-f6b6-44f3-9594-f0c5d8b1579c"
}
```

- `commission_id`: the captain's paid handoff to the worker, 600K sats
- `delegation_cert_hash`: BRC-52 certificate hash on-chain (sha256)
- `revocation_txid`: the on-chain UTXO that, if spent, revokes this commission
- `sent_message_id`: BRC-33 messagebox envelope ID delivered to the worker

Every element of BRC-52 + BRC-33 + x402 is exercised in one cycle.

## NanoStore URLs (both verified live with `curl`)

### HTML article

https://storage.googleapis.com/prod-uhrp/cdn/6bsYrg76eJMNHeLMkjjsqe

- Title: *"Signals from r/technology: April snapshot of topics, tone, and trust"*
- Valid HTML5 (DOCTYPE, lang, viewport meta)
- Inline `<style>` with system font stack, 720px max-width, responsive
- 4+ `<blockquote>` citations with real on-chain txids
- Provenance footer card with manifest sha256 + run nonce + on-chain claim
- Opens cleanly in any browser, reads like a published tech essay

### TXIDS manifest

https://storage.googleapis.com/prod-uhrp/cdn/97GQUbdRkWE8mauZhm6LGM

- **100 lines, zero truncation markers**
- Each line: one 64-char hex txid
- Uploaded via `upload_to_nanostore`'s `file_path` parameter — bytes
  streamed directly from disk, LLM never loads into context
- **Proves the truncation fix** originally landed in E18 still works on
  the new queue-backed annotated records file

## Scale math with measured numbers

| scenario | avg sats/cycle | daily cost @ 15K cycles | 1.5M fits? |
|---|---:|---:|---|
| full every cycle            | 388,935 | $583/day  | ✗ (synthesis theater) |
| synthesis 1-in-25 amortize  | **116,326** | **$174/day** | ✓ inside cap |
| synthesis 1-in-50 amortize  |  ≈110,542 | $166/day   | ✓ comfortable |
| synthesis 1-in-100 amortize |  ≈107,604 | $161/day   | ✓ comfortable |

Mixed-wall-clock math at 25 lanes:
- 24 worker-only cycles @ 142s wall
- 1 synthesis cycle @ 299s wall
- Per-lane avg ~148s/cycle
- 25 lanes × 86400s/day ÷ 148s/cycle × 100 proofs/cycle ≈ **1.46M proofs/day**

Drop to 148s avg (good luck) → 1.5M exact. At 160s avg → 1.35M. Cushion is
thin; sub list rebalance and wall-clock optimization are Day 1 priorities.

## Funding detour that unblocked this run

Synthesis wallet 3323 had drained to 261K sats across E20 V1 / E20b / E20c
runs. The run before this one (E20d first attempt) failed mid-synthesis with
`Insufficient funds: need 301737, have 263150`. Funded via CLI through
running daemons:

```
3322 → 3323:  15,000,000 sats  (txid bf2639b8...)  → split 10-way (1.526M/output)
3322 → 3324:  10,000,000 sats  (txid 21baefb0...)  → split 20-way on small UTXO pool
```

SQLite WAL + `--db <path>` + `ROOT_KEY` env sourcing makes the CLI safe to
run alongside a live daemon. Zero daemon touches, zero rekeys. This is now
codified in [WALLETS.md](../WALLETS.md) + [scripts/fund-wallet.sh](../scripts/fund-wallet.sh).

## What this checkpoint tells us about the remaining work

### ✓ Locked in (don't revisit)

- Cursor-paged comment firehose architecture
- Queue + watermark agent consumption
- Parallel skinny captain with pre-baked worker identity
- Synthesis via `file_path` streaming for non-truncated manifests
- Wallet funding via CLI against running daemons
- DolphinSense-branded Reddit User-Agent

### ⚠ Still open

- Sub-list rebalance (current list projects ~650K/day, need ~35 new/min
  aggregate churn to hit 1.5M)
- 30-wallet provisioning + 12-hour rotation strategy for 24h durability
- Fleet launch script (currently only the 4-agent `scripts/launch.sh`
  exists)
- Events stream wiring (agents don't yet emit the 16-event taxonomy)
- Mission Control UI (post-E19 conversation, before 4h dry run)
- Full dolphin-milk system-prompt loading from `prompts/cycle-v2/*.md`
  files instead of inline string builders

### The critical path to Friday submission

1. **Day 1 (2026-04-15)**: sub-list rebalance + 30-wallet bootstrap + feeder hardening
2. **Day 2 (2026-04-16)**: fleet launch script + events stream wiring + UI skeleton + 4h dry run
3. **Day 3 (2026-04-16/17 overnight)**: 24h production run
4. **Day 4 (2026-04-17)**: video + README + submission

See [../NEXT.md](../NEXT.md) for the full task list.

## Related artifacts

- Full aggregate: `~/bsv/rust-bsv-worm/test-workspaces/cycle-v2-2026-04-14T17-23-45-306024bc/aggregate.json`
  *(may be gc'd — the canonical data is in this file + the uploaded NanoStore URLs)*
- Captain session: `~/bsv/rust-bsv-worm/test-workspaces/cycle-v2-captain/tasks/521fd8c9-ca52-4599-94e6-36184fb6e6a9/session.jsonl`
- Worker session: `~/bsv/rust-bsv-worm/test-workspaces/cycle-v2-worker/tasks/eb924683-6aaf-4dd8-b185-a5a76665cb38/session.jsonl`
- Synthesis session: `~/bsv/rust-bsv-worm/test-workspaces/cycle-v2-synthesis/tasks/2f7a07fc-b508-4534-a5cb-8b506575c86a/session.jsonl`
- Captain/worker/synthesis prompts (extracted): [../prompts/cycle-v2/](../prompts/cycle-v2/)
- Reddit cache feeder: [../feeder/reddit-cache-feeder.js](../feeder/reddit-cache-feeder.js)
