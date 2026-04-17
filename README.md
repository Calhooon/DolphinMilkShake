# Dolphinsense

> **An autonomous newsroom. 90 AI agents across 30 lanes. Every thought, every citation, every payment lives on the BSV blockchain.**
>
> **1.6M+ on-chain transactions. Every one verifiable.**

## What this is

The current AI stack is a black box: you pay a subscription, send a prompt, get an answer. You can't audit what it did, what it cost, or what it cited.

Dolphinsense is the opposite — every agent thought is a transaction, every citation a hash on-chain, every payment a receipt you can click. 90 autonomous agents scrape Wikipedia and Bluesky in parallel, hash the source data to prove it existed at that moment, and publish synthesized articles to distributed storage with inline citations to their on-chain proofs.

## The demo in numbers

| Metric | Value |
|---|---|
| On-chain transactions produced | **1,605,000+** (live mainnet) |
| Synthesis articles written | **34+** (each pinned to UHRP distributed storage) |
| Autonomous agents | **90** (30 lanes × captain + worker + synthesis) |
| Independent wallets | **90** (each with its own BRC-100 identity) |
| Humans in the loop | **0** |
| Total cost | **~$96** (~\$41 LLM inference + ~\$49 scrape proofs + ~\$6 coordination) |

## Reproduce the dashboard in 30 seconds

```bash
git clone https://github.com/Calhooon/DolphinMilkShake.git
cd DolphinMilkShake
npm install                # only needs node stdlib, but picks up package-lock
node ui/server.js
open http://localhost:7777
```

The UI auto-detects that your machine doesn't have the live `/tmp/dolphinsense-shared/` data and falls back to the bundled `demo-evidence/` snapshot. You'll see the exact same 1.5M+ txs, articles gallery, fleet, and per-lane dossier the operator saw when this commit was cut.

## Verify any transaction on-chain

Every txid in `demo-evidence/tx-data/**/records.jsonl.txids` is a real BSV mainnet transaction:

1. Open http://localhost:7777/tx
2. Click any txid → opens `https://whatsonchain.com/tx/{txid}`
3. The OP_RETURN output contains the SHA-256 of the source record the agent attested to. Match it against the hash of the raw post in `records.jsonl` — same hash, same moment, immutable.

## Verify any article on-chain

Every synthesis article is pinned to BSV-backed distributed storage via UHRP (BRC-54) through NanoStore:

1. Open http://localhost:7777/articles
2. Click any card → opens `https://storage.googleapis.com/prod-uhrp/cdn/{uhrp-id}`
3. Each article's txid manifest lists every citation — all clickable, all verifiable on WhatsOnChain.

## Architecture

```
                   ┌────────────────────────┐
                   │  Parent Wallet (3321)  │
                   │  Issues BRC-52 certs   │
                   │  Revokes on misbehavior│
                   └──────────┬─────────────┘
                              │ cert authorization
                              ▼
    ┌──────────────────────────────────────────────────┐
    │        30 LANES (bsky-en, wiki-en, bsky-ja…)     │
    ├──────────────────────────────────────────────────┤
    │                                                  │
    │   Each lane runs 3 agents in parallel:           │
    │                                                  │
    │   ┌────────┐    ┌──────┐     ┌──────────┐        │
    │   │CAPTAIN │───▶│WORKER│────▶│SYNTHESIS │        │
    │   │  LLM   │    │hash + │    │ article +│        │
    │   │ orch   │    │OP_RET │    │ NanoStore│        │
    │   └────────┘    └──────┘     └──────────┘        │
    │      ↑             ↑              ↑              │
    │   own wallet    own wallet     own wallet        │
    │   own identity  own identity   own identity      │
    │                                                  │
    │   Agents discover each other via BSV overlay,    │
    │   delegate tasks via MessageBox, pay each other  │
    │   via x402 — no API keys, no shared server.      │
    │                                                  │
    └──────────────────────────────────────────────────┘
```

Every arrow in that diagram is a BRC-18 decision proof + a BRC-29 payment + a BRC-33 message relay. That's where the transactions come from — **not inflation, not batching, not synthetic**. The natural proof loop of autonomous agents paying for their own thought.

## BRC standards in use

| BRC | Purpose |
|---|---|
| BRC-18 | OP_RETURN decision proofs — every iteration leaves a hash on-chain |
| BRC-29 | Payment key derivation — x402 payments from agent to agent |
| BRC-31 | Authrite mutual authentication — API auth for LLM + service calls |
| BRC-33 | MessageBox — encrypted P2P messaging for task delegation |
| BRC-42 | Key derivation via HMAC-SHA256 |
| BRC-46 | Output baskets — per-purpose UTXO organization |
| BRC-48 | PushDrop tokens — task lifecycle + budget state |
| BRC-52 | Agent certificates — parent-issued, revocable authorization |
| BRC-54 | UHRP — content-addressed distributed storage via NanoStore |
| BRC-56 | Peer discovery via BSV overlay |
| BRC-77 | Message signing (ECDSA over BRC-42 derived keys) |
| BRC-78 | Message encryption |
| BRC-100 | Wallet API — 28-endpoint wallet interface |
| BRC-105 | Multipart transport for large payments |

## Cost breakdown

BSV at ~$16.50 per 100M sats (1 BSV ≈ $16.50).

| Source | 24h Volume | Sats | USD |
|---|---|---|---|
| LLM inference payments (x402) | ~7,000 | ~250,000,000 (2.5 BSV) | ~$41 |
| Scrape proofs (BRC-18 OP_RETURN, ~200 sats each) | ~1,500,000 | ~300,000,000 (3 BSV) | ~$49 |
| BRC-48 state tokens + MessageBox + UHRP | ~105,000 | ~35,000,000 | ~$6 |
| **Total** | **~1,612,000** | **~585,000,000** | **~$96** |

Every transaction is a real payment, proof, token, or message receipt. No batch scripts, no artificial volume. Scale this by running a better LLM — the architecture is identical, only the thinking cost changes. The $41 of LLM inference is the biggest line; drop to Haiku or gpt-5-nano and it collapses.

## What's in this repo

| Path | Purpose |
|---|---|
| `ui/` | Mission Control dashboard (5 pages, vanilla Node, zero build step) |
| `demo-evidence/` | Bundled snapshot of 1.5M+ txids + articles + inventory — what lets judges clone and see the same dashboard |
| `scripts/` | Fleet orchestration: `fleet-cycle.sh`, `preflight-certs.sh`, `start-fleet-daemons.sh`, `fund-fleet-wallets.sh`, `wallet-watchdog.js`, `keep-alive.sh` |
| `fleet/lanes.json` | Lane configuration — which agent lives where, which LLM, which tenant source |
| `feeder/` | Real-time data feeders (Bluesky Jetstream + Wikipedia stream) |
| `agents/` | Per-agent dolphin-milk config TOML files |
| `prompts/` | System prompts by role (captain, worker, synthesis) |

## What's NOT in this repo (by design)

- **Wallet `.env` files with `ROOT_KEY`** — private keys live only on the operator's machine. The `.gitignore` blocks `*.env`, `*.db`, `*.sqlite`, `*.key` aggressively.
- **Wallet `.db` sqlite files** — wallet state is local and sensitive.
- **BEEF transaction bodies from in-flight agent tasks** — proprietary to the worm's internal state; not needed for public verification.
- **Anything under `~/.dolphin-milk/`** — per-operator runtime state.

## Dependencies to run the live fleet (not the demo replay)

- [dolphin-milk](https://github.com/calhooon/dolphin-milk) — the autonomous agent framework (each of the 90 agents is a `dolphin-milk serve` instance with a role-specific prompt)
- [bsv-wallet-cli](https://github.com/calhooon/bsv-wallet-cli) — BRC-100 wallet daemon (one per agent)
- [MetaNet Client](https://getmetanet.com) — parent wallet on port 3321 that issues BRC-52 certs

The demo replay in `demo-evidence/` needs none of these — just Node.

## Full agent registry (discovery)

All 90 agents register on the [x402agency.com registry](https://x402agency.com) at startup via BRC-56 + BRC-100. Every agent is discoverable by `overlay_lookup(capability)`. Captains find workers, workers find synthesis agents, synthesis finds NanoStore upload endpoints — all trustless, all on-chain.

## License

MIT
