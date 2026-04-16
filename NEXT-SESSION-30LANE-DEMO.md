# Next Session: 30-Lane Full-Feature Demo Prep

**Date**: 2026-04-16 (pick up from here)
**Goal**: Get all 30 lanes running the full agent pipeline (captain → worker → synthesis + NanoStore)

## What's Already Done
- 1,548,000+ on-chain txs (verified, UI shows them on port 7777)
- Full-feature pipeline VALIDATED on bsky-en-16: captain 103k, worker 100 proofs, synthesis 726k, NanoStore article live
- **Key finding**: wallet DBs corrupt after heavy use. Fresh DB + same ROOT_KEY fixes it instantly.
- All data backed up at `~/bsv/fleet-backup-2026-04-16/`
- 180M sats available on embedded wallet (port 8080, address `1FAibWX1C6eQrUzKWHUiYD3p4ApE2r2CRJ`)

## What Needs to Happen (in order)

### 1. Archive + recreate ALL 90 wallet DBs
Every wallet DB that's been through heavy use has corrupted proven_txs. The x402 payment bridge rejects their BEEFs. Fresh DBs fix this.

```bash
# For each wallet in INVENTORY.json:
#   1. Kill its daemon
#   2. mv wallet.db wallet.db.archived
#   3. rm -f wallet.db-shm wallet.db-wal
#   4. bsv-wallet --db wallet.db init --key $ROOT_KEY
#   5. Restart daemon
```

**CRITICAL**: Keep the .env files (ROOT_KEYs). Only archive the .db files.
**UI DATA IS SAFE**: txid files are in `/tmp/dolphinsense-shared/`, not wallet DBs.

### 2. Fund all 90 wallets from 8080 embedded wallet
The embedded wallet on port 8080 has 180M sats. Use `fund-wallet.sh` with the embedded wallet's DB as source.

**Note**: the embedded wallet DB path needs to be found. It's NOT at `~/bsv/_archived/bsv-wallet-cli-old/wallet-fresh.db` (that's the 3322 HTTP wallet which shows 0). The embedded wallet is internal to dolphin-milk's data dir. Check `lsof -p $(pgrep -f "dolphin-milk serve") | grep .db` to find it.

**Alternatively**: reload 3322 externally via MetaNet Desktop or exchange, then fund from 3322.

Targets per role:
- Captain: 5,000,000 sats (covers ~25 cycles at 180k/cycle)
- Worker: 2,000,000 sats (covers ~140 cycles at 14k/cycle)  
- Synthesis: 2,000,000 sats (covers ~6 synthesis runs at 300k each)
- Split: 3 UTXOs per wallet

Total needed: 30 × (5M + 2M + 2M) = 270M sats (~$170)

Scripts:
```bash
# fund-wallet.sh handles send + internalize + split
./scripts/fund-wallet.sh <source_env> <source_db> <recv_env> <recv_db> <sats> <split>
```

### 3. Start all 90 wallet daemons
```bash
./scripts/start-fleet-daemons.sh start
```

### 4. Preflight cert check (1 lane first)
```bash
ONLY_LANES=bsky-en-16 ./scripts/preflight-certs.sh
```
This boots the 3 agents, acquires BRC-52 certs from parent (port 3321), verifies capabilities, tears down. Zero cost. **Requires MetaNet Desktop clicks** (~6 dialogs).

### 5. Full-feature test (1 lane, 1 cycle)
```bash
SOAK_CYCLES=1 SKINNY_CAPTAIN_MODE=parallel SYNTHESIS_EVERY_N=1 \
  ENABLE_SYNTHESIS=1 QUEUE_MODE=1 ONLY_LANES=bsky-en-16 \
  ./scripts/fleet-cycle.sh
```
**Requires MetaNet clicks** during boot. Watch for:
- Captain: should be iter=2, ~100k sats (NOT iter=1, 1800 sats — that means payment failed)
- Worker: 100 proofs created
- Synthesis: status=complete, 4 iter, ~700k sats
- NanoStore URL: should be a real `storage.googleapis.com/prod-uhrp/cdn/` URL

### 6. Scale to 5 lanes, then 30
```bash
# 5 lanes
SOAK_CYCLES=3 SKINNY_CAPTAIN_MODE=parallel SYNTHESIS_EVERY_N=1 \
  ENABLE_SYNTHESIS=1 QUEUE_MODE=1 SUPERVISE=1 \
  ONLY_LANES=bsky-en-16,bsky-en-2,bsky-en-3,bsky-en-4,bsky-en-5 \
  ./scripts/fleet-cycle.sh

# 30 lanes (the demo)
SOAK_CYCLES=17 SKINNY_CAPTAIN_MODE=parallel SYNTHESIS_EVERY_N=15 \
  ENABLE_SYNTHESIS=1 QUEUE_MODE=1 SUPERVISE=1 \
  ./scripts/fleet-cycle.sh
```

### 7. Make the UI beautiful for the demo (ORCHESTRATE + PARALLELIZE)
The current single-page dashboard is overwhelming at 30 lanes and the cards are stuck in stale red state. Split into multiple pages. Judges will see this.

**Pages needed:**
- **Dashboard** (home): 30-lane overview grid, live tx counter (1.5M+), tx/sec rate, total sats spent, uptime
- **Transaction Explorer**: searchable/filterable table of all 1.5M+ txids, click any txid → opens WoC, filter by lane/time/source. Pagination. This is what judges click to verify.
- **Articles**: gallery of all synthesis articles with NanoStore links, thumbnails/previews, proof counts, timestamps. Click → opens the live HTML article.
- **Fleet / Wallets**: all 90 wallets with balances, health, role (captain/worker/synthesis), port, lane assignment. Show funded vs drained. This page proves the fleet is real.
- **Lane Detail**: click a lane card → cycle history, per-cycle sats breakdown, wallet balances for that lane's 3 agents, latest article, error log
- **Responsive**: must look good at 1440/1920/2560 viewports for demo screen

**The fleet/wallet config should also be visible in the git repo** — judges will look at:
- `fleet/lanes.json` (30 lanes, all config visible)
- `~/bsv/wallets/fleet/INVENTORY.json` (90 wallets, ports, addresses)
- The scripts (`fleet-cycle.sh`, `proof-chain.js`, `wallet-watchdog.js`, `keep-alive.sh`)

**CRITICAL**: UI changes must NOT touch `/tmp/dolphinsense-shared/` txid files. The UI READS from them, never writes or deletes. All 1.5M txids must remain intact.

Apply /beautiful standards: Steve Jobs minimal, Bob Ross harmonious, Van Gogh detail. Multiple parallel agents can work on different pages simultaneously.

### 8. Background services
```bash
# Wallet watchdog (auto-topup captains/synthesis under 1M)
# NOTE: update wallet-watchdog.js source to use the correct funded wallet DB
nohup node scripts/wallet-watchdog.js > /tmp/wallet-watchdog.log 2>&1 &

# Keep-alive (restart dead daemons + feeders)
nohup ./scripts/keep-alive.sh > /tmp/keep-alive.log 2>&1 &

# Feeders (if not running)
BSKY_EN_TENANTS=bsky-en,bsky-en-2,...,bsky-en-21 \
BSKY_JA_TENANTS=bsky-ja,bsky-ja-2 \
BSKY_PT_TENANTS=bsky-pt,bsky-pt-2 \
BSKY_MULTI_TENANTS=bsky-multi \
node feeder/bluesky-jetstream-feeder.js > /tmp/feeder-bsky.log 2>&1 &

WIKI_TENANTS=wiki-en,wiki-en-2,wiki-en-3,wiki-en-4 \
node feeder/wikipedia-stream-feeder.js > /tmp/feeder-wiki.log 2>&1 &
```

## Known Issues to Watch For
1. **Wallet DB corruption**: Heavy createAction usage corrupts proven_txs. Fix: archive + fresh DB + same ROOT_KEY.
2. **MetaNet Desktop clicks**: Every fleet-cycle boot needs ~6 dialogs per lane × stagger time. 30 lanes = 180 clicks over 5 min.
3. **NanoStore**: Was intermittently failing. Test on 1 lane first.
4. **Feeder queue starvation**: bsky-en-12 through 21 share the EN firehose across 21 tenants. At 500 records/cycle they can outrun the feeder. Use `QUEUE_LANE=wiki-en` env override to point starved lanes at the wiki queue (1M+ records available).
5. **3322 wallet state**: Fresh DB shows 0 via CLI but embedded wallet on 8080 has 180M. These are separate DBs. Fund fleet from whichever has sats.

## DO NOT DELETE
- `/tmp/dolphinsense-shared/` — 1.5M txid files (UI source of truth)
- `~/bsv/wallets/fleet/*.env` — ROOT_KEYs
- `~/bsv/fleet-backup-2026-04-16/` — full backup
- Any `.db.archived` files — may contain recoverable sats
