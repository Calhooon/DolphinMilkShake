# Dolphinsense (DolphinMilkShake)

Hackathon submission for the Open Run Agentic Pay event. 90 autonomous AI agents across 30 parallel lanes, each with its own BRC-100 wallet, paying each other in BSV micropayments and proofing every thought on-chain. **1.6M+ mainnet transactions. ~$96 total cost.**

For the judge-facing overview see [README.md](README.md). For technical depth see [ARCHITECTURE.md](ARCHITECTURE.md). This file is Claude Code orientation.

## Architecture at a glance

30 lanes. Each lane is a tenant (Bluesky language cluster or a Wikipedia stream). Each lane runs 3 agents:

- **captain** — LLM orchestrator (gpt-5-mini). Pays for inference via x402. Delegates to worker + synthesis via MessageBox.
- **worker** — proof creator (gpt-5-nano). Hashes 100 source records per cycle, broadcasts each as an OP_RETURN transaction.
- **synthesis** — article writer (gpt-5-mini). Every Nth cycle, composes an HTML article citing the worker's txids, uploads to NanoStore via UHRP.

All 90 agents discover each other through the BSV overlay (BRC-56). Authorization is via parent-signed BRC-52 certificates — revocable on-chain, not by code push. Every inter-agent handoff is a BRC-18 decision proof + BRC-29 payment + BRC-33 MessageBox relay, which is where the natural 1.6M transaction volume comes from.

## Related repos

| Repo | Role |
|---|---|
| [calhooon/dolphin-milk](https://github.com/calhooon/dolphin-milk) | Autonomous agent framework. Each of the 90 agents is a `dolphin-milk serve` instance with a role-specific system prompt. |
| [calhooon/bsv-wallet-cli](https://github.com/calhooon/bsv-wallet-cli) | BRC-100 wallet daemon. One instance per agent. |
| **DolphinMilkShake** (this repo) | Application layer — lane config, system prompts, fleet orchestration scripts, Mission Control UI, judge-reproducible demo snapshot. |
| [rust-overlay](https://rust-overlay.dev-a3e.workers.dev) | BSV overlay for agent discovery (tm_agent topic). Cloudflare Worker. |

On the author's machine the dolphin-milk source still lives at `~/bsv/rust-bsv-worm/` for legacy reasons; scripts and docs reference that path. A fresh clone of dolphin-milk at `~/bsv/dolphin-milk/` is equivalent.

## File layout

```
DolphinMilkShake/
├── README.md              # Judge-facing overview + clone-and-run
├── ARCHITECTURE.md        # Technical deep-dive (cycle flow, BRCs, data paths)
├── CLAUDE.md              # (this file)
│
├── demo-evidence/         # Judge-reproducible snapshot — DO NOT edit by hand
│   ├── tx-data/           # /tmp/dolphinsense-shared copy (1.5M+ txids, ~344 MB)
│   ├── cycles/            # per-cycle aggregate.json + cluster-state.json
│   ├── inventory-public.json  # 90 wallets, public fields only (no root keys)
│   └── README.md          # judge-verification how-to
│
├── fleet/
│   └── lanes.json         # 30-lane config: tenant, source, agents, ports, models
│
├── scripts/               # Fleet orchestration
│   ├── fleet-cycle.sh     # Run N cycles across M lanes in parallel (SOAK_CYCLES=20)
│   ├── lane-cycle.js      # One lane's cycle: captain → worker → synthesis → aggregate
│   ├── lib/cluster.js     # Boots/stops the 3-agent cluster for one lane
│   ├── preflight-certs.sh # Boots all agents, verifies BRC-52 certs, tears down
│   ├── start-fleet-daemons.sh  # Start/stop/status for 90 bsv-wallet daemons
│   ├── fund-fleet-wallets.sh   # Bootstrap fleet from master wallet
│   ├── fund-wallet.sh     # Send+internalize+split recipe for one wallet
│   ├── wallet-watchdog.js # Background topup daemon (captain/synthesis < 1M)
│   ├── keep-alive.sh      # Supervisor: restart dead wallet daemons + feeders
│   ├── proof-chain.js     # Alternate: high-throughput OP_RETURN chain builder
│   └── proof-only-cycle.js # Alternate: wallet createAction proof loop
│
├── feeder/
│   ├── bluesky-jetstream-feeder.js  # WebSocket → per-lane queue.jsonl
│   ├── wikipedia-stream-feeder.js   # SSE → per-lane queue.jsonl
│   └── reddit-cache-feeder.js       # Legacy Reddit feeder (not used for 30-lane demo)
│
├── prompts/
│   └── cycle-v2/          # Active prompts used by lane-cycle.js
│       ├── captain-parallel.md    # Captain: overlay_lookup + delegate as parallel tool calls
│       ├── captain-liveness.md    # Captain: liveness check variant
│       ├── worker-proof.md        # Worker: 100-record proof batch
│       ├── synthesis-html.md      # Synthesis: write HTML article + NanoStore upload
│       └── README.md
│
├── ui/                    # Mission Control dashboard (vanilla Node, zero build)
│   ├── server.js          # 30-lane SSE server. Path resolution: live (/tmp + ~/bsv) → demo-evidence fallback
│   ├── index.html         # / — Dashboard
│   ├── pages/
│   │   ├── tx-explorer.html   # /tx — paginated 1.6M txids
│   │   ├── articles.html      # /articles — synthesis articles gallery
│   │   ├── fleet.html         # /fleet — 90-wallet inventory
│   │   └── lane-detail.html   # /lane/:id — per-lane dossier
│   ├── shared/nav.html + footer.html
│   ├── shared.css
│   └── PAGE-AGENT-SPEC.md
│
├── seeds/questions.json       # Reserved for prompt seeding (not currently wired)
├── tools/classifier.py        # Reserved rule-based classifier (not currently wired)
└── .gitignore                 # Hardened: *.env, *.db*, *.sqlite*, *.key, ROOT_KEY, etc.
```

## Runtime data (not in repo — operator's machine only)

| Path | Purpose |
|---|---|
| `/tmp/dolphinsense-firehose/<lane>/queue.jsonl` | Feeder queues — scraped source records awaiting proofs |
| `/tmp/dolphinsense-shared/<lane>/cycle-*/` | Per-cycle proof artifacts (records, txids, manifests, proof_batch.sh) — 1.6M+ files |
| `~/bsv/rust-bsv-worm/test-workspaces/fleet/` | Per-agent task transcripts + per-cycle aggregates |
| `~/bsv/wallets/fleet/` | 90 wallet `.db` files + 90 `.env` with ROOT_KEYs — NEVER committed |
| `~/.dolphin-milk/wallet.db` | Stale isolation-poisoner (see known bugs) — moved aside to `.isolation-poisoner-<TS>` |

## Running the demo replay (judge flow)

```bash
node ui/server.js
open http://localhost:7777
```

Server.js auto-detects that live `/tmp/dolphinsense-shared/` etc. don't exist and falls back to `demo-evidence/`. Startup log labels each path as `live:*` or `demo-evidence`.

## Running the live fleet (operator flow)

```bash
# One-time: fund 90 wallets from master
./scripts/fund-fleet-wallets.sh

# Boot all 90 wallet daemons (ports 3400–3489)
./scripts/start-fleet-daemons.sh start

# Cert audit (zero-cost, ~5 min for 30 lanes)
./scripts/preflight-certs.sh

# Full fleet cycle (10 lanes × 20 cycles, synthesis every 15)
ONLY_LANES="bsky-en,bsky-multi,bsky-ja,bsky-pt,wiki-en,bsky-en-2,bsky-en-3,bsky-en-4,bsky-en-5,wiki-en-2" \
  SOAK_CYCLES=20 SYNTHESIS_EVERY_N=15 ENABLE_SYNTHESIS=1 \
  QUEUE_MODE=1 SKINNY_CAPTAIN_MODE=parallel SUPERVISE=1 \
  ./scripts/fleet-cycle.sh
```

Feeders must be running first:

```bash
BSKY_EN_TENANTS="bsky-en,bsky-en-2,…,bsky-en-21" BSKY_JA_TENANTS=… BSKY_PT_TENANTS=… BSKY_MULTI_TENANTS=bsky-multi \
  nohup node feeder/bluesky-jetstream-feeder.js > /tmp/feeder-bsky.log 2>&1 &

WIKI_TENANTS="wiki-en,wiki-en-2,wiki-en-3,wiki-en-4" \
  nohup node feeder/wikipedia-stream-feeder.js > /tmp/feeder-wiki.log 2>&1 &
```

## Known bugs + mitigations

### 1. Embedded wallet isolation auto-spawn (FIXED by moving stale db aside)

`dolphin-milk`'s `ensure_own_wallet_url()` auto-spawns a child `bsv-wallet daemon` pointing at `~/.dolphin-milk/wallet.db` if that file exists and its identity doesn't match the URL configured via `DOLPHIN_MILK_WALLET_URL`. When it fires, every agent ends up talking to the same shared wallet instead of its own fleet wallet. Symptom: "insufficient funds" errors while the configured fleet wallet sits at full balance.

**Mitigation**: on the operator's machine, `~/.dolphin-milk/wallet.db` has been moved aside to `wallet.db.isolation-poisoner-<TS>`. Do not restore it. Upstream fix: cluster.js should set a per-agent `DOLPHIN_MILK_DATA_DIR`.

### 2. Cert template tail-of-batch mis-issuance (unresolved — limits concurrency)

Parent wallet (3321) mis-templates the cert for the last ~8 workers in any staggered preflight batch (returns a synthesis-role cert when worker declared `scraping`). MetaNet restart temporarily clears the state, then re-contaminates after ~20 successful issuances.

**Mitigation**: don't run more than ~10 concurrent lanes until fixed. The demo was shipped with 10 lanes to stay safely inside the clean zone.

### 3. Agent process identity shared across roles

All 3 agents in a lane (captain/worker/synthesis) report the same `identity 025014145b039925...` at startup. This is the dolphin-milk **process** identity, separate from the wallet identity. The cert issuer correctly keys by wallet identity; this is cosmetic.

## Safety rules for this repo

1. **Never commit `.env`, `.db`, `.sqlite`, `.key`** — `.gitignore` blocks them aggressively. Always `git diff --cached --name-only | grep -E '\.(env|db|sqlite|key)$'` before committing.
2. **Never use `git add .` or `git add -A`** — always stage explicit files.
3. **Never delete `/tmp/dolphinsense-shared/`** — 1.6M txid files, UI source of truth. Backed up at `~/bsv/DEMO-SAFE-2026-04-17/`.
4. **Never delete `~/bsv/wallets/fleet/*.env`** — ROOT_KEYs. Losing these = losing real BSV on-chain.
5. **Never delete `demo-evidence/` contents** — the judge-reproducible snapshot.

## Key protocol IDs

- BRC-18 — OP_RETURN decision proofs
- BRC-29 — x402 payments
- BRC-31 — Authrite API auth
- BRC-33 — MessageBox
- BRC-48 — PushDrop task/budget tokens
- BRC-52 — Agent certificates
- BRC-54 — UHRP distributed storage
- BRC-56 — Peer discovery
- BRC-100 — Wallet API
