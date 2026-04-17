# Dolphinsense — Architecture

Technical deep-dive. For the judge-facing overview see [README.md](README.md).

## The shape

30 parallel **lanes**, each assigned a tenant source (Bluesky language
cluster or Wikipedia stream). Each lane runs 3 **agents**:

```
lane: bsky-en-16  (bluesky, English)
  ├── captain-bsky-en-16      port 8124, wallet 3424
  │   model: gpt-5-mini
  │   role: orchestrate the cycle, delegate to worker + synthesis
  ├── worker-bsky-en-16       port 8125, wallet 3425
  │   model: gpt-5-nano
  │   role: hash 100 source records, emit OP_RETURN proofs, broadcast
  └── synthesis-bsky-en-16    port 8126, wallet 3426
      model: gpt-5-mini
      role: every Nth cycle, write an article citing the proofs,
            upload to NanoStore
```

Multiply by 30. That's 90 agents, 90 BRC-100 wallets, 90 on-chain
identities, 0 humans.

## One cycle, step by step

```
┌────────────────────────────────────────────────────────────────┐
│  QUEUE_MODE: claim next 100 records from feeder queue         │
│    /tmp/dolphinsense-firehose/<lane>/queue.jsonl              │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  STEP 1 — startCluster (3 agents spawned sequentially)        │
│    - spawn `dolphin-milk serve` on agent port                  │
│    - verify wallet daemon reachable via DOLPHIN_MILK_WALLET_URL│
│    - BRC-52 cert audit: agent fetches its cert from parent     │
│      wallet (3321), verifies caps match declared capabilities  │
│    - BRC-56 overlay registration: agent publishes itself       │
│    - supervisor kicks in (SUPERVISE=1 respawns on crash)       │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  STEP 2 — CAPTAIN iterates (x402 LLM, BRC-18 decision proofs)  │
│    - captain LLM call → 402 Payment Required                   │
│    - captain creates BRC-29 payment tx, attaches as header     │
│    - LLM proxy broadcasts payment, returns completion          │
│    - captain emits BRC-18 decision proof (OP_RETURN)           │
│    - repeat iter × max_iterations (typically 2)                │
│    - captain uses overlay_lookup(capability="scraping") to     │
│      find its worker, delegate_task via MessageBox             │
└────────────────────────────────────────────────────────────────┘
                             │ delegated via MessageBox (BRC-33)
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  STEP 3 — WORKER processes the 100 records                    │
│    - proof_batch.sh with xargs -P 8: per-record parallelism   │
│    - each record → sha256 → OP_RETURN locking script           │
│    - createAction via its own wallet → tx broadcast via ARC    │
│    - records.jsonl.txids grows one line per success            │
│    - ~14k sats worker cost, ~100 mainnet txs per cycle         │
└────────────────────────────────────────────────────────────────┘
                             │ (every Nth cycle)
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  STEP 4 — SYNTHESIS writes + uploads the article              │
│    - reads records-annotated.jsonl (the 100 proof→record       │
│      pairs worker just produced)                                │
│    - iterates LLM to compose HTML article citing the txids     │
│    - uploads to NanoStore via x402 (BRC-54 UHRP advertisement) │
│    - aggregate.json records the NanoStore URL + txids manifest │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  STEP 5 — aggregate + teardown                                │
│    - per-cycle aggregate.json emitted to                        │
│      test-workspaces/fleet/<lane>/cycle-<stamp>/                │
│    - cluster.js stops all 3 agents                             │
│    - next cycle begins unless SOAK_CYCLES exhausted            │
└────────────────────────────────────────────────────────────────┘
```

Typical cycle wall time: **~7-8 minutes** (captain LLM 1-2 min, worker
proof batch 3-5 min, synthesis 2-3 min when it triggers). Typical cycle
sats: **~100k without synthesis, ~650k when synthesis runs**.

## Agent discovery (BRC-56 + BRC-100)

Every agent registers itself on the [x402agency.com overlay](https://x402agency.com)
at boot:

```
1. Agent creates a PushDrop token:
     [AGENT, identity_key, certifier_key, name, capabilities, signature]

2. Submits to overlay via POST /submit with x-topics: tm_agent

3. Other agents discover via:
     overlay_lookup(capability="scraping")
     → returns every agent whose cert includes 'scraping' capability

4. Agents verify each other via BRC-52 cert chain:
     - must be parent-signed
     - must not be revoked (is_revoked() check via on-chain lookup)
```

No hardcoded addresses, no central directory — trustless discovery.

## Governance (BRC-52 parent certs)

```
MetaNet Client (parent wallet, port 3321)
      │
      │ issues certs with capability set per role:
      │   captain:    [llm, memory, messaging, orchestration,
      │                schedule, synthesis, tools, wallet, x402]
      │   worker:     [llm, memory, messaging, orchestration,
      │                schedule, scraping, tools, wallet, x402]
      │   synthesis:  [llm, memory, messaging, orchestration,
      │                schedule, synthesis, tools, wallet, x402]
      │
      ▼
  90 agents, each bearing a BRC-52 cert.
  Cert check happens every iteration.
  If parent broadcasts a revocation tx, the agent's next iteration
  fails the cert check and refuses to act.

  → Governance is on-chain authorization, not code updates.
```

## Data flow between agents

| Mechanism | Purpose |
|---|---|
| **MessageBox** (BRC-33) | Task delegation, results. Encrypted P2P via recipient's mailbox. |
| **NanoStore** (BRC-54 UHRP + x402) | Large artifacts (synthesis articles, txid manifests). Content-addressed. |
| **memory_store / memory_search** | Per-agent local recall (tantivy BM25 + optional vector). |
| **overlay_lookup** | Discovery by capability. |

Every handoff is a **MessageBox task + BRC-29 payment + BRC-18 decision
proof**. That's where the transactions come from: not artificially
batched, not synthetic volume — the natural proof loop of autonomous
agents that have to pay for their own thoughts.

## Transaction breakdown per 24h at full fleet

BSV at ~$16.50 per 100M sats.

| Source | Volume | Sats | USD |
|---|---|---|---|
| LLM inference payments (x402) | ~7,000 | ~250M (2.5 BSV) | ~$41 |
| Scrape proofs (BRC-18 OP_RETURN, ~200 sats each) | ~1,500,000 | ~300M (3 BSV) | ~$49 |
| BRC-48 task + budget state tokens | ~100,000 | ~20M | ~$3 |
| MessageBox delegation proofs | ~5,000 | ~10M | ~$2 |
| NanoStore uploads + capability proofs | ~500 | ~5M | ~$1 |
| **Total** | **~1,612,000** | **~585M (~5.85 BSV)** | **~$96** |

Every arrow in the cycle diagram contributes txs; nothing is fabricated.
Scale this by running Opus instead of gpt-5-mini — the architecture is
identical, only the thinking cost changes.

## Hardware footprint (single M1 Max, 32 GB RAM)

| Resource | Used at full 30-lane × 3-agent fleet |
|---|---|
| RAM | ~6-10 GB (30 lanes × ~200 MB combined agents) |
| CPU | ~3 cores average (spikes during parallel worker phases) |
| Disk (logs + tx-data + test-workspaces) | ~2-3 GB per full demo run |
| Network | Jetstream WebSocket + LLM proxy + ARC broadcaster |

Scales down to a laptop; scales up horizontally by adding more lanes.

## Key directories at runtime

| Path | Purpose |
|---|---|
| `/tmp/dolphinsense-firehose/<lane>/queue.jsonl` | Feeder queues — scraped source records awaiting proofs |
| `/tmp/dolphinsense-shared/<lane>/cycle-*/` | Per-cycle proof artifacts (records, txids, manifests, proof_batch.sh) |
| `~/bsv/dolphin-milk/test-workspaces/fleet/<lane>/` | Per-agent task transcripts + per-cycle aggregate.json + cluster-state.json |
| `~/bsv/wallets/fleet/` | 90 wallet `.db` files + 90 `.env` files with ROOT_KEYs (local-only, never committed) |

For the demo replay, `demo-evidence/tx-data/` shadows
`/tmp/dolphinsense-shared/` and `demo-evidence/cycles/` shadows the
per-cycle aggregates — see [README.md § Reproduce the dashboard](README.md#reproduce-the-dashboard-in-30-seconds).

## What makes this different from "AI agent + wallet"

Lots of projects can put an LLM behind a BRC-100 wallet. Dolphinsense
proves three harder things:

1. **Economic pressure is real.** Kill a captain's terminal — if its
   wallet still has sats, it'll keep running; if sats run out, it
   stops. No supervisor, no restart logic papering over bankruptcy.
2. **Zero-trust coordination.** 90 agents never share a secret, never
   trust a common identity. Discovery is on-chain, authorization is
   on-chain, messaging is encrypted P2P. Every interaction is a
   transaction any third party can audit.
3. **Every claim is evidence.** An article written by a synthesis
   agent cites its sources by on-chain txid. Those txids reference
   the exact bytes that were hashed by the worker. You can
   reconstruct any claim back to the moment a real Bluesky post was
   seen and committed.
