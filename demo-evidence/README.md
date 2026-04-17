# Dolphinsense — Demo Evidence Snapshot

This directory is a point-in-time snapshot of everything produced by the
Dolphinsense agent fleet during the demo run. It's self-contained: you can
clone the repo, start the UI, and see exactly what the operator saw.

## What's in here

| Path | Contents |
|---|---|
| `tx-data/` | Per-lane cycle dirs — `records.jsonl.txids` files list every on-chain txid the agents wrote (~1.6M total). Also includes the hashed source records and the `proof_batch.sh` scripts that produced the proofs. |
| `cycles/` | Per-cycle `aggregate.json` + `cluster-state.json` (139 cycles). Each aggregate includes the captain/worker/synthesis costs, proof count, NanoStore URL for the article (if synthesis ran), and the txid manifest URL. |
| `inventory-public.json` | All 90 fleet wallets — `name`, `role`, `lane_id`, `server_port`, `wallet_port`, `identity_key`, `address`. **Public-only fields.** Root keys are NEVER in this file and never committed to git. |

## Reproduce the dashboard

```bash
git clone https://github.com/Calgooon/DolphinMilkShake.git
cd DolphinMilkShake
node ui/server.js
open http://localhost:7777
```

On a fresh clone, the server auto-detects that `/tmp/dolphinsense-shared/`
doesn't exist and falls back to this `demo-evidence/` snapshot. You'll see
the exact same counter, articles gallery, fleet page, and tx explorer the
operator saw when this commit was cut.

## Verify any transaction on-chain

Every txid in `tx-data/**/records.jsonl.txids` is a real BSV mainnet
transaction. To verify:

1. Open http://localhost:7777/tx
2. Click any txid → opens https://whatsonchain.com/tx/{txid}
3. Read the OP_RETURN output — the 32-byte payload is the sha256 of the
   source record that the agent attested to at that moment.

## Verify any article on-chain

Every synthesis article is pinned to BSV-backed distributed storage via
UHRP (BRC-54) through the NanoStore service.

1. Open http://localhost:7777/articles
2. Click any card → opens `https://storage.googleapis.com/prod-uhrp/cdn/{id}`
3. The article's manifest (linked next to each card) lists every txid the
   agent cited. Each citation is independently verifiable on WhatsOnChain.

## What's NOT here (intentional)

- Wallet `.env` files with `ROOT_KEY` — these live only on the operator's
  machine. The repo's `.gitignore` blocks them aggressively (`*.env`,
  `*.db`, etc).
- Wallet `.db` sqlite files — same reason.
- BEEF transaction bodies from the agents' task transcripts — proprietary
  to the agent's in-flight work, not needed for public verification.

If you want to run the full fleet yourself (not just replay the demo),
see `../STATUS-2026-04-16.md` and `../STATUS-2026-04-17.md` for setup.
