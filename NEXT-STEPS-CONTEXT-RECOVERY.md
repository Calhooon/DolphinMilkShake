# NEXT STEPS — Context Recovery Doc

> Written 2026-04-15 mid-session as a fail-safe in case the Claude conversation is lost. If you're a fresh Claude reading this: read it top-to-bottom, then run the verification checklist at the bottom before touching anything. **Do not skip the wallet-safety section.** Do not lose sats.

---

## Current state at write-time

- **Branch**: `main` on dolphinmilkshake (also active on `phase-3-cluster-and-poc-23-infra` in rust-bsv-worm)
- **Last shipped commit**: `e3f4175` — "ui: fix tile overflow + reset stale agent state on task rotation"
- **Active soak**: 17-cycle 5-lane via `fleet-cycle.sh`, run dir `/tmp/dolphinsense-fleet-runs/2026-04-15T15-59-45/`. PID can be found via `ps aux | grep lane-cycle`.
- **NanoStore status**: was DOWN all morning (synthesis cycles failed to upload articles). User reports the maintainers restarted it at ~16:00 UTC. **This 17-cycle soak is the test of whether NanoStore is back.** If `lifetime-articles` ticks past 12 in the dashboard header, NanoStore is up.
- **Wallets**: 15 fleet wallets at ports 3400-3414, all topped up to **2.5M / 5M / 2.5M** sats per role (captain/worker/synthesis). Master wallet at port 3322, ~227M sats remaining.

## Where we are in the god-tier UI plan (6 phases)

| Phase | Status | Commit |
|---|---|---|
| **1**: budget tailer + max-iter not-an-error + port links | ✅ shipped | `85a4b49` |
| **2**: rich per-agent state + cycle phase indicator | ✅ shipped | `4e61c4a` |
| **3**: heartbeat broadcast + tx/s + +N delta + snapshot tx stream | ✅ shipped | `8ead8a2` |
| **fix**: tile overflow + stale state on task rotation | ✅ shipped | `e3f4175` |
| **4**: slide-out detail panel (click agent → live transcript) | ⏭ pending |  |
| **5**: beautify (color/sparklines/animations) | ⏭ pending |  |
| **6**: stress test 5→10→15 lanes | ⏭ pending |  |

The **dashboard is genuinely live everywhere** as of `8ead8a2` + `e3f4175`. Quality-gated via Playwright: 116 snapshots in 53s, 4 distinct totals tick monotonically, lifeDelta shows `+N live`, tx/s non-zero, no overlap, stale state resets on task rotation. Server has a 1Hz heartbeat broadcast on top of event-driven snapshots.

## How we run tests

### Canary (1 cycle, 1 lane, ~2 min, ~$0.05)
For verifying code changes don't break the live update path. **Always use `fleet-cycle.sh`, never `node lane-cycle.js` directly** — that bypass drops `SKINNY_CAPTAIN_MODE=parallel` and falls back to the legacy non-deterministic overlay_lookup → delegate flow which **delegates to phantom workers**. We hit this bug today; do not repeat it.

```bash
cd /Users/johncalhoun/bsv/dolphinmilkshake && \
  SOAK_CYCLES=1 \
  SKIP_LANES=bsky-multi,bsky-ja,bsky-pt,wiki-en \
  ENABLE_SYNTHESIS=0 \
  nohup ./scripts/fleet-cycle.sh > /tmp/canary.log 2>&1 &
```

### 17-cycle 5-lane soak (~30-50 min, ~$3-5)
The "real" run. Tests cycle progression, synthesis amortization, NanoStore, all 5 lanes in parallel.

```bash
cd /Users/johncalhoun/bsv/dolphinmilkshake && \
  SOAK_CYCLES=17 \
  nohup ./scripts/fleet-cycle.sh > /tmp/soak-17cycle.log 2>&1 &
```

### Watching a soak
- Per-lane logs: `/tmp/dolphinsense-fleet-runs/<TIMESTAMP>/lane-<id>.log`
- Look for: `CYCLE N/17`, `captain done`, `worker proof: created=100`, `synthesis task`, `nanostore`, `cycle complete`, `aggregate written`, `ERROR`, `✗`
- Use the `Monitor` tool with `tail -F` + grep for live event stream

## How we test the UI as we go (Playwright-driven)

The user got bitten by my earlier promises of "live updates" without proof, so the bar is now: **every UI claim must be playwright-verified**.

### Playwright instrumentation hooks (window.__dm)
The client exposes a `window.__dm` namespace specifically for playwright probes:
```js
window.__dm = {
  _snapCount,         // total snapshots received since page load
  _snapHistory,       // last 120 snapshots: { t, totalTxs, bskyEnTxs, bskyEnPhase, captainState, captainIter }
  state,              // full client state object
  latestSnapshot,     // most recent snap
  snapCount,          // alias for _snapCount
}
```

### Quality-gate checklist (run before claiming "live")
```js
// 1. Snapshot cadence — should be ~1-3/sec
window.__dm._snapCount

// 2. Distinct totals ticked over the observation window
[...new Set(window.__dm._snapHistory.map(s => s.totalTxs))]

// 3. Header counters
({
  lifeTxs: document.getElementById('lifetime-txs').textContent,
  lifeDelta: document.getElementById('lifetime-delta').textContent,
  txRate: document.getElementById('tx-rate').textContent,
})

// 4. Lane tile field check (for any specific lane)
({
  tx: document.querySelector('.lane[data-lane-id="bsky-en"] [data-field="tx-count"]').textContent,
  cap: document.querySelector('.lane[data-lane-id="bsky-en"] .agent[data-role="captain"] [data-field="state"]').textContent,
  iter: document.querySelector('.lane[data-lane-id="bsky-en"] .agent[data-role="captain"] [data-field="iter"]').textContent,
  lastTool: document.querySelector('.lane[data-lane-id="bsky-en"] .agent[data-role="captain"] [data-field="last-tool"]').textContent,
})

// 5. Overflow check (no DOM child should extend past its agent box)
const issues = [];
document.querySelectorAll('.agent').forEach(a => {
  const ar = a.getBoundingClientRect();
  a.querySelectorAll('*').forEach(c => {
    const cr = c.getBoundingClientRect();
    if (cr.right > ar.right + 1) issues.push(c.tagName + '.' + c.className);
  });
});
issues  // should be []
```

### `/api/state` server-side truth check
```bash
curl -s http://localhost:7777/api/state | python3 -m json.tool | head -80
```
Compare server snapshot against client DOM. They MUST match. If they diverge, snapshot mode is broken.

## NanoStore (2026-04-15 status)

- **Symptom**: synthesis agents failed `upload_to_nanostore` tool calls all morning. Errors were x402 payment errors from the NanoStore service.
- **User action**: had maintainers restart NanoStore at ~16:00 UTC.
- **How to know if it's back**: 17-cycle soak in progress should produce articles. Check:
  - Header `lifetime-articles` ticks past 12
  - `recent articles` panel gains entries with NanoStore URLs
  - `synthesis` agent strip shows `✓ done` instead of `running upload_to_nanostore` indefinitely
- **If it's still down**: the user has explicitly accepted "no articles for this run" — keep the soak running for raw proof counts. Do NOT block on NanoStore.

## Next major step: 10 lanes → 15 lanes (the scaling path)

If the 17-cycle 5-lane soak passes (all lanes complete, tx counts tick live, dashboard stays correct), the path forward is:

### Architecture decision (already made by user, 2026-04-15)
**Path B from earlier ultrathink: feeder fanout with round-robin routing.** Each English bluesky / wiki post is routed to EXACTLY ONE tenant queue via a counter. New lanes are tenant copies (bsky-en-2, bsky-en-3, etc) that read from their own queue file with their own watermark. **Zero dedup risk** — same post never goes to multiple lanes.

### 10-lane plan (~3-4h, ~$15)
Lanes: existing 5 + bsky-en-2, bsky-en-3, bsky-en-4, bsky-en-5, wiki-en-2
- Throughput per English tenant: 30/sec ÷ 5 tenants = 6/sec each → 100 records in ~17s
- Code changes:
  - `feeder/bluesky-jetstream-feeder.js`: add `ENGLISH_TENANTS` array + RR router. ~15 lines.
  - `feeder/wikipedia-stream-feeder.js`: same fanout. ~15 lines.
  - `fleet/lanes.json`: add 5 new lane entries with wallet ports 3415-3429, server ports 8115-8129
  - **NO `lane-cycle.js` change needed**
- Wallet provisioning (15 new wallets):
  ```bash
  cd /Users/johncalhoun/bsv/dolphinmilkshake
  ./scripts/provision-fleet-wallets.sh                # creates env+db files (idempotent)
  ./scripts/start-fleet-daemons.sh start              # boots 15 new wallet daemons
  CAPTAIN_SATS=2500000 CAPTAIN_SPLIT=30 \
    WORKER_SATS=5000000 WORKER_SPLIT=20 \
    SYNTHESIS_SATS=2500000 SYNTHESIS_SPLIT=10 \
    ./scripts/fund-fleet-wallets.sh                   # funds new wallets from master
  ./scripts/preflight-wallets.sh                      # verifies all 30 wallets
  ```
- Run: `SOAK_CYCLES=17 ./scripts/fleet-cycle.sh` for 30-min validation

### 15-lane plan (~30 min, ~$5)
Add 5 more lanes: bsky-en-6/7/8, wiki-en-3, wiki-en-4. Wallet ports 3430-3444, server ports 8130-8144.
- Throughput: bsky-en split 8 ways → 3.75/sec each → still 8× headroom
- Same provisioning sequence as 10-lane
- Run: `SOAK_CYCLES=17 ./scripts/fleet-cycle.sh`

### 24h "big daddy" run (target: 1.5M txs)
Only after 10 + 15 lane runs both pass. Math: 15 lanes × ~1,234 cycles in 48h × 100 proofs = ~1.85M proofs. Use `SYNTHESIS_EVERY_N=15` for cost discipline. Budget ~$200.

## Wallet safety — DO NOT LOSE SATS

This section is the most important part of this doc. Today we hit 4+ wallet bugs (split fee reserve, captain overpayment, BEEF round-trip, UTXO lock starvation). Every one was found because we ran small things first. Do not skip safety steps.

### The 15 fleet wallets (ports 3400-3414)
DBs are at `~/bsv/wallets/fleet/` named after the ORIGINAL Reddit lane names (worldnews, politics, askreddit, gaming, movies) but the lanes.json maps them to bsky-en/multi/ja/pt + wiki-en. **Never rename the .db files.** Inventory at `~/bsv/wallets/fleet/INVENTORY.json`.

| Port | Role | Lane | DB name |
|---|---|---|---|
| 3400 | captain | bsky-en | captain-worldnews.db |
| 3401 | worker | bsky-en | worker-worldnews.db |
| 3402 | synthesis | bsky-en | synthesis-worldnews.db |
| 3403 | captain | bsky-multi | captain-politics.db |
| 3404 | worker | bsky-multi | worker-politics.db |
| 3405 | synthesis | bsky-multi | synthesis-politics.db |
| 3406 | captain | bsky-ja | captain-askreddit.db |
| 3407 | worker | bsky-ja | worker-askreddit.db |
| 3408 | synthesis | bsky-ja | synthesis-askreddit.db |
| 3409 | captain | bsky-pt | captain-gaming.db |
| 3410 | worker | bsky-pt | worker-gaming.db |
| 3411 | synthesis | bsky-pt | synthesis-gaming.db |
| 3412 | captain | wiki-en | captain-movies.db |
| 3413 | worker | wiki-en | worker-movies.db |
| 3414 | synthesis | wiki-en | synthesis-movies.db |

### Master wallet
- Path: `~/bsv/_archived/bsv-wallet-cli-old/wallet.db`
- Env: `~/bsv/_archived/bsv-wallet-cli-old/.env`
- Port: **3322** (running as `bsv-wallet daemon`)
- **As of 2026-04-15 ~16:00 UTC**: ~227,737,006 sats remaining (~$68 @ $30/BSV)

### Funding sizing per phase

| Phase | Captain | Worker | Synthesis | Per-lane total | 5 lanes | 10 lanes | 15 lanes |
|---|---|---|---|---|---|---|---|
| **30-min canary** | 1.5M / 30 | 5M / 20 | 1.5M / 8 | 8M | 40M | 80M | 120M |
| **17-cycle test** | 2.5M / 30 | 5M / 20 | 2.5M / 10 | 10M | 50M | 100M | 150M |
| **48h big-daddy** | 5M / 50 | 10M / 30 | 5M / 15 | 20M | 100M | 200M | 300M |

**Always use `fund-fleet-wallets.sh` — it is IDEMPOTENT.** Sets env vars `CAPTAIN_SATS / CAPTAIN_SPLIT / WORKER_SATS / WORKER_SPLIT / SYNTHESIS_SATS / SYNTHESIS_SPLIT`. Skips wallets already at target (within 500 sat tolerance).

### Wallet safety rules
1. **NEVER `rm` a wallet .env file** — it contains the ROOT_KEY private key. Losing the .env = losing the funds permanently.
2. **NEVER reset / re-init / rekey** a funded wallet. The user owns these wallets daemon-side; you can only ADD funds, never destroy.
3. **NEVER directly call `node scripts/lane-cycle.js`** — bypass of fleet-cycle.sh drops critical env vars (SKINNY_CAPTAIN_MODE=parallel) and breaks the captain → local-worker delegation. Use `./scripts/fleet-cycle.sh` always.
4. **Always audit balances before a soak**. Captains starve fastest; check ports 3400/3403/3406/3409/3412 first.
5. **Top up via fund-fleet-wallets.sh, never via fund-wallet.sh directly** unless you know which specific wallet you're targeting.
6. **Confirm with the user before any sat-spending operation**. The user said "dont fucking lose my sats man" today. Take this literally.
7. **Verify before claiming success**. After a topup, re-query each topped-up wallet's balance via `/listOutputs` and confirm it's at target.
8. The split count matters. Captain splits in particular: too few large UTXOs cause lock starvation under x402 concurrent load, too many small UTXOs blow the createAction script size. **Sweet spot for captain: 30-50 UTXOs of ~50-83k sats each.**

### When something goes wrong
- **"Insufficient funds: need X have Y"** = captain UTXO starvation. Top up that wallet.
- **"Hit max iterations (N)"** = NORMAL captain end state in PARALLEL mode. NOT an error. Server should render as `✓ done capped@N`, client should NOT apply `.error` class.
- **Synthesis stuck on `running upload_to_nanostore` indefinitely** = NanoStore is down OR x402 payment error. Not a code bug. Either wait or kill the synthesis cycle.
- **Captain delegated to wrong recipient (phantom worker)** = you ran `lane-cycle.js` directly instead of `fleet-cycle.sh`. Kill it, re-fire via the wrapper.

## Critical files

| File | What it does |
|---|---|
| `dolphinmilkshake/scripts/fleet-cycle.sh` | The orchestrator. Runs all lanes in parallel. Sets `SKINNY_CAPTAIN_MODE=parallel` by default. |
| `dolphinmilkshake/scripts/lane-cycle.js` | One-lane cycle runner. **Don't call directly.** Called by fleet-cycle.sh per lane. |
| `dolphinmilkshake/scripts/lib/cluster.js` | Spawns dolphin-milk dm-server processes per agent, manages identity verification. |
| `dolphinmilkshake/scripts/provision-fleet-wallets.sh` | Creates new wallet env+db files from `fleet/lanes.json`. Idempotent. |
| `dolphinmilkshake/scripts/start-fleet-daemons.sh` | Starts/stops wallet daemons. **Refuses to SIGTERM a daemon whose .env is missing** — important safety rule. |
| `dolphinmilkshake/scripts/fund-fleet-wallets.sh` | Tops up wallets from master. Idempotent. Uses `CAPTAIN_SATS/SPLIT` env vars. |
| `dolphinmilkshake/scripts/preflight-wallets.sh` | Audits all wallets for balance + UTXO count + identity health. |
| `dolphinmilkshake/feeder/bluesky-jetstream-feeder.js` | Bluesky firehose consumer. Per-lane queue routing by `langs[]` filter. |
| `dolphinmilkshake/feeder/wikipedia-stream-feeder.js` | Wikipedia EventStreams consumer. |
| `dolphinmilkshake/fleet/lanes.json` | Authoritative lane → agent → port mapping. |
| `dolphinmilkshake/ui/server.js` | UI server with `dashboardState` + per-event tailers + 1Hz heartbeat broadcast. |
| `dolphinmilkshake/ui/index.html` | Lit-free vanilla JS dashboard with `applySnapshot` + surgical DOM updates + `window.__dm` diagnostics. |
| `~/bsv/wallets/fleet/INVENTORY.json` | Wallet inventory: name, role, lane, identity_key, address, env_path, db_path. |
| `/tmp/dolphinsense-shared/<lane>/cycle-*/records.jsonl.txids` | Worker proof_batch txid output (1 line per tx). Tailed by ui/server.js. |
| `/tmp/dolphinsense-firehose/<lane>/queue.jsonl` | Per-lane work queue from feeders. Lane-cycle claims records here. |

## Verification checklist when picking up where we left off

```bash
# 1. Wallet daemons up (15 expected)
lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | grep -cE ':34[0-1][0-9]'  # → 15

# 2. UI server up
curl -s http://localhost:7777/health  # → {"ok":true,...}

# 3. Feeders up (3 expected: bluesky-jetstream, wikipedia-stream, websocat child)
ps aux | grep -E "bluesky-jetstream-feeder|wikipedia-stream-feeder|websocat" | grep -v grep | wc -l

# 4. Active soak status (if any)
ps aux | grep "lane-cycle.js" | grep -v grep | awk '{print $2, $NF}'
ls -td /tmp/dolphinsense-fleet-runs/2026-* | head -1  # latest run dir

# 5. Master wallet balance
SOURCE_ENV=~/bsv/_archived/bsv-wallet-cli-old/.env
SOURCE_DB=~/bsv/_archived/bsv-wallet-cli-old/wallet.db
BIN=~/bsv/bsv-wallet-cli/target/release/bsv-wallet
( set +u; export $(grep -v '^\s*#' "$SOURCE_ENV" | xargs); "$BIN" --db "$SOURCE_DB" balance --json )

# 6. UI snapshot (server-side truth)
curl -s http://localhost:7777/api/state | python3 -c "import sys,json;s=json.load(sys.stdin);print('totals:',s['totals'])"

# 7. Browse the dashboard
open http://localhost:7777/
```

If any of those fail, fix THAT before doing anything else.

## What NOT to do (lessons from today)

1. **Don't run `lane-cycle.js` directly** — bypasses fleet-cycle.sh's critical env vars, falls through to the legacy non-deterministic captain prompt that delegates to phantom workers via overlay_lookup. Use `./scripts/fleet-cycle.sh`.
2. **Don't claim "live updates work" without a Playwright snapHistory check** — I've been wrong about this twice today. Verify with `window.__dm._snapHistory`, not vibes.
3. **Don't add new code paths before re-validating the previous one** — at one point I had budget tailer + applySnapshot copy bug + tx/s rate broken simultaneously. Hard to debug. Phase the work, gate each phase.
4. **Don't try to "fix" overlay_lookup** — it's working as designed. The bug was in MY canary command. Use fleet-cycle.sh.
5. **Don't forget the existing scripts** — `provision-fleet-wallets.sh`, `fund-fleet-wallets.sh`, `start-fleet-daemons.sh`, `preflight-wallets.sh` already exist and handle every wallet operation safely. Don't reinvent.
6. **Don't promise "every field updates live" without verifying every field** — the user noticed `+0` in the delta indicators when the architecture was right but baseline tracking was missing. Now fixed (Phase 3, `8ead8a2`).
7. **Don't trust legacy event handlers in snapshot mode** — they're gated behind `if (USE_SNAPSHOT_MODE) return;` but if you accidentally call one (like `doRenderTxStream` instead of `doRenderTxStreamSnapshot`), you get partial broken behavior.

## Open work queue (highest → lowest priority)

1. **Watch the in-flight 17-cycle 5-lane soak** for: NanoStore success, all lanes complete, no panics, dashboard stays correct
2. **Phase 4 — slide-out detail panel** (god-tier UX): click any agent strip → right-side slide-out panel with live transcript stream from `recentEvents` ring buffer, cost breakdown, current tool args, port link. ~90 min.
3. **Phase 5 — beautify**: color-code agent states deeper, sparkline tx rate per lane (60s window), smooth animations, glass blur on panel. ~60 min.
4. **Phase 6 — stress test**: 5-lane → 10-lane → 15-lane snapshot mode under live event load. ~60 min.
5. **#41 PLAN-E22-24H-BIG-DADDY.md** — pre-flight planning doc for the 48h 1.5M target run.

## How to commit

User wants `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` in every commit (set globally in CLAUDE.md). User wants quality-gated work — verify with playwright before committing.
