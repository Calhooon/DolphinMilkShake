# 10-Lane Scaling Prep

Drafted while the 17-cycle 5-lane soak is in flight. Everything in this doc is REVIEW-ONLY until the 5-lane soak passes — then we execute in order.

## Trigger conditions to start

✅ All 5 lanes complete 17/17 cycles
✅ Zero panics
✅ NanoStore working (already verified — 4 articles uploaded in cycle 0 of this soak)
✅ Master wallet has ≥ 60M sats
✅ User says GO

## Lane plan (10 lanes total)

5 existing + 5 new English-leaning fanout tenants:

| # | Lane ID | Wallet ports | Server ports | Source | Tenant of |
|---|---|---|---|---|---|
| 1 | bsky-en | 3400/01/02 | 8100/01/02 | bluesky en | (existing) |
| 2 | bsky-multi | 3403/04/05 | 8103/04/05 | bluesky multi | (existing) |
| 3 | bsky-ja | 3406/07/08 | 8106/07/08 | bluesky ja | (existing) |
| 4 | bsky-pt | 3409/10/11 | 8109/10/11 | bluesky pt | (existing) |
| 5 | wiki-en | 3412/13/14 | 8112/13/14 | wikipedia | (existing) |
| **6** | **bsky-en-2** | **3415/16/17** | **8115/16/17** | bluesky en | RR slot 1 |
| **7** | **bsky-en-3** | **3418/19/20** | **8118/19/20** | bluesky en | RR slot 2 |
| **8** | **bsky-en-4** | **3421/22/23** | **8121/22/23** | bluesky en | RR slot 3 |
| **9** | **bsky-en-5** | **3424/25/26** | **8124/25/26** | bluesky en | RR slot 4 |
| **10** | **wiki-en-2** | **3427/28/29** | **8127/28/29** | wikipedia | RR slot 1 |

Throughput math:
- bsky-en source: ~30/sec → split 5 ways = 6/sec per tenant → 100 records in ~17s ✓
- wiki-en source: ~10/sec → split 2 ways = 5/sec per tenant → 100 records in ~20s ✓

Both well above the ~0.5/sec needed for 17-cycle wall time. Zero starvation risk.

## Funding budget

```
Per-wallet sizing (17-cycle test runs):
  captain   2.5M sats / 30 split (~83k per UTXO)
  worker    5.0M sats / 20 split
  synthesis 2.5M sats / 10 split

Per new lane: 10M sats (~$3.00)
5 new lanes:  50M sats (~$15.00)

Master wallet: ~227,737,006 sats
After 10-lane provisioning: ~177,737,006 sats (~$53)

10-lane 17-cycle run estimated burn: ~10-15M sats (~$3-5)
After 10-lane run: ~165-170M sats (~$50)

Plenty of headroom for 15-lane next + the 24h big-daddy run.
```

## Code change 1: bluesky-jetstream-feeder.js — fanout

**File**: `feeder/bluesky-jetstream-feeder.js`
**Where**: replace the LANES const + the routing block (~line 67 + ~line 277)

Replace LANES const:

```js
// Lane GROUPS — each language group can have multiple tenant queues that
// share the same source filter. Posts route round-robin within a group so
// each tenant queue gets a fair, NON-OVERLAPPING share of the firehose.
// Tenant counts are configurable via env vars so we can scale to 10/15/N
// lanes without code changes:
//   BSKY_EN_TENANTS    default 1: ["bsky-en"]
//                      10-lane:   ["bsky-en","bsky-en-2","bsky-en-3","bsky-en-4","bsky-en-5"]
//                      15-lane:   ["bsky-en","bsky-en-2",...,"bsky-en-8"]
const BSKY_EN_TENANTS = (process.env.BSKY_EN_TENANTS || 'bsky-en').split(',');
const BSKY_MULTI_TENANTS = (process.env.BSKY_MULTI_TENANTS || 'bsky-multi').split(',');
const BSKY_JA_TENANTS = (process.env.BSKY_JA_TENANTS || 'bsky-ja').split(',');
const BSKY_PT_TENANTS = (process.env.BSKY_PT_TENANTS || 'bsky-pt').split(',');

const LANE_GROUPS = [
  { groupId: 'en',    langs: new Set(['en']),                                                                tenants: BSKY_EN_TENANTS },
  { groupId: 'multi', langs: new Set(['es', 'pt', 'pt-BR', 'pt-PT', 'it', 'fr', 'de', 'nl', 'ca']),          tenants: BSKY_MULTI_TENANTS },
  { groupId: 'ja',    langs: new Set(['ja']),                                                                tenants: BSKY_JA_TENANTS },
  { groupId: 'pt',    langs: new Set(['pt', 'pt-BR', 'pt-PT']),                                              tenants: BSKY_PT_TENANTS },
];

// Flat list of every tenant lane id, used for queue dir creation +
// per-lane state tracking.
const LANES = LANE_GROUPS.flatMap((g) => g.tenants.map((id) => ({ id, group: g.groupId })));

// Per-group round-robin counters. Incremented on every routed post so
// group N gets distributed evenly across its tenants[].
const groupRR = Object.fromEntries(LANE_GROUPS.map((g) => [g.groupId, 0]));
```

Replace the routing block (~line 277):

```js
const postLangs = Array.isArray(rec.langs) ? rec.langs : [];
// First-MATCHING-GROUP wins, then round-robin within that group's tenants.
// Each post still lands in AT MOST ONE queue file → zero dedup risk.
let routedTenant = null;
for (const group of LANE_GROUPS) {
  // Track totals against ALL tenants in the group for stats parity
  for (const tid of group.tenants) perLaneState[tid].totalSeen += 1;
  let match = false;
  for (const l of postLangs) {
    if (group.langs.has(l)) { match = true; break; }
  }
  if (!match) {
    for (const tid of group.tenants) perLaneState[tid].dropped_lang_mismatch += 1;
    continue;
  }
  if (routedTenant === null) {
    // Pick a tenant for this post via round-robin
    const tenantIdx = groupRR[group.groupId] % group.tenants.length;
    groupRR[group.groupId] = (groupRR[group.groupId] + 1) | 0;
    routedTenant = group.tenants[tenantIdx];
    bufferedAppend(routedTenant, toEnvelope(evt, routedTenant));
  } else {
    for (const tid of group.tenants) perLaneState[tid].dropped_lang_mismatch += 1;
  }
}
if (routedTenant === null && postLangs.length === 0) {
  // Untagged post → fall through to the FIRST tenant of the en group as before
  const tenantIdx = groupRR['en'] % BSKY_EN_TENANTS.length;
  groupRR['en'] = (groupRR['en'] + 1) | 0;
  const tenant = BSKY_EN_TENANTS[tenantIdx];
  bufferedAppend(tenant, toEnvelope(evt, tenant));
  perLaneState[tenant].totalSeen += 1;
}
```

The `LANES` flat array is still iterated for queue dir creation (line 74) — works unchanged because `LANES = LANE_GROUPS.flatMap(...)`.

## Code change 2: wikipedia-stream-feeder.js — fanout

**File**: `feeder/wikipedia-stream-feeder.js`
**Where**: replace LANE_ID const (~line 40) + bufferedAppend usage (~line 139, 238)

Replace const:
```js
// Tenant array — single lane by default, multi-tenant for fanout scaling.
//   WIKI_TENANTS=wiki-en              → 1 lane (default)
//   WIKI_TENANTS=wiki-en,wiki-en-2    → 2 lanes (10-lane setup)
//   WIKI_TENANTS=wiki-en,wiki-en-2,wiki-en-3,wiki-en-4 → 4 lanes (15-lane setup)
const WIKI_TENANTS = (process.env.WIKI_TENANTS || process.env.WIKI_LANE_ID || 'wiki-en').split(',');
let wikiRR = 0;
```

Replace bufferedAppend invocations to round-robin across WIKI_TENANTS:
```js
function bufferedAppend(envelope) {
  const tenant = WIKI_TENANTS[wikiRR % WIKI_TENANTS.length];
  wikiRR = (wikiRR + 1) | 0;
  // ... rest of function uses `tenant` instead of LANE_ID
  const p = path.join(FIREHOSE_DIR, tenant, 'queue.jsonl');
  // ...
}
```

Also create directories for ALL tenants at startup:
```js
fs.mkdirSync(FIREHOSE_DIR, { recursive: true });
for (const t of WIKI_TENANTS) {
  fs.mkdirSync(path.join(FIREHOSE_DIR, t), { recursive: true });
}
```

## Config change: fleet/lanes.json

Add 5 new lane entries to the `lanes` array. Use the existing entries as templates. Pattern for `bsky-en-2`:

```json
{
  "id": "bsky-en-2",
  "subreddit": "bsky-en-2",
  "source": "bluesky",
  "display_prefix": "🦋",
  "_note": "Bluesky English fanout tenant 2 of 5. Reads bsky-en-2/queue.jsonl populated via round-robin from BSKY_EN_TENANTS in the bluesky feeder.",
  "agents": [
    {"role": "captain",   "name": "captain-bsky-en-2",   "server_port": 8115, "wallet_port": 3415, "model": "gpt-5-mini", "max_iterations": 2, "mode": "parallel"},
    {"role": "worker",    "name": "worker-bsky-en-2",    "server_port": 8116, "wallet_port": 3416, "model": "gpt-5-nano", "max_iterations": 6},
    {"role": "synthesis", "name": "synthesis-bsky-en-2", "server_port": 8117, "wallet_port": 3417, "model": "gpt-5-mini", "max_iterations": 6}
  ]
}
```

Repeat for bsky-en-3 (3418/19/20), bsky-en-4 (3421/22/23), bsky-en-5 (3424/25/26), wiki-en-2 (3427/28/29). Update `_port_ranges` if needed (currently `wallet_max: 3499`).

## Execution sequence (when 5-lane soak passes)

```bash
cd /Users/johncalhoun/bsv/dolphinmilkshake

# 1. Edit feeder fanout — 2 file edits per draft above
$EDITOR feeder/bluesky-jetstream-feeder.js
$EDITOR feeder/wikipedia-stream-feeder.js

# 2. Restart feeders with the env vars set so they spin up the new tenant queues
pkill -f "bluesky-jetstream-feeder.js"
pkill -f "wikipedia-stream-feeder.js"
sleep 1

BSKY_EN_TENANTS=bsky-en,bsky-en-2,bsky-en-3,bsky-en-4,bsky-en-5 \
  nohup node feeder/bluesky-jetstream-feeder.js > /tmp/bsky-feeder.log 2>&1 &

WIKI_TENANTS=wiki-en,wiki-en-2 \
  nohup node feeder/wikipedia-stream-feeder.js > /tmp/wiki-feeder.log 2>&1 &

# 3. Verify queues populating
ls /tmp/dolphinsense-firehose/bsky-en-2/queue.jsonl  # should exist within ~5s
ls /tmp/dolphinsense-firehose/wiki-en-2/queue.jsonl

# 4. Edit lanes.json to add 5 new lanes
$EDITOR fleet/lanes.json

# 5. Provision 15 new wallets (idempotent — skips existing 15)
./scripts/provision-fleet-wallets.sh
# Should report: 15 created, 15 skipped, 0 failed

# 6. Boot the 15 new wallet daemons
./scripts/start-fleet-daemons.sh start
# Verify: ports 3415-3429 all listening

# 7. Top up the new wallets
CAPTAIN_SATS=2500000 CAPTAIN_SPLIT=30 \
  WORKER_SATS=5000000 WORKER_SPLIT=20 \
  SYNTHESIS_SATS=2500000 SYNTHESIS_SPLIT=10 \
  ./scripts/fund-fleet-wallets.sh
# Should fund 15 (existing 15 already at target, will skip)
# Master should drop ~50M sats (~$15)

# 8. Verify all 30 wallets healthy
./scripts/preflight-wallets.sh
# All 30 wallets should report OK

# 9. Restart UI server (picks up new lanes from lanes.json)
pkill -f "ui/server"
sleep 1
cd /Users/johncalhoun/bsv/dolphinmilkshake && nohup node ui/server.js > /tmp/ui-server.log 2>&1 &

# 10. Verify UI shows 10 lane tiles
curl -s http://localhost:7777/api/state | python3 -c "
import sys, json
s = json.load(sys.stdin)
print('lane count:', len(s['perLane']))
print('lanes:', list(s['perLane'].keys()))"

# 11. Open UI in browser, verify all 10 lanes render correctly
open http://localhost:7777/

# 12. Fire the 10-lane 17-cycle soak
SOAK_CYCLES=17 nohup ./scripts/fleet-cycle.sh > /tmp/soak-10lane.log 2>&1 &

# 13. Watch run dir for progress
ls -td /tmp/dolphinsense-fleet-runs/2026-* | head -1
```

## Verification gates between steps

After step 2: feeder logs should show "5 lanes" or similar; queue files should grow (`watch -n 1 ls -la /tmp/dolphinsense-firehose/bsky-en-2/queue.jsonl`).

After step 5: INVENTORY.json should have 30 wallets. `jq '.wallets | length' ~/bsv/wallets/fleet/INVENTORY.json` → 30.

After step 6: 30 wallet ports should be listening. `lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | grep -cE ':34[0-2][0-9]'` → 30.

After step 7: master wallet should drop ~50M sats. Re-query to verify.

After step 9: UI's `/api/state` should show 10 lanes in `perLane`.

After step 12: all 10 lanes should appear in run dir, all spinning up.

## Risks I'm watching for

1. **Wallet provisioning failure mid-batch** — provision-fleet-wallets.sh is idempotent and writes .env BEFORE init, so partial state recovers gracefully. But: 15 sequential init calls = 15 chances to fail. If one fails, find the offending wallet and retry just that one with `--only`.
2. **Feeder queue starvation** — bsky-en-5 might lag if RR isn't perfectly even. Watch `wc -l /tmp/dolphinsense-firehose/bsky-en-*/queue.jsonl` over a minute.
3. **UI 10-lane layout** — current grid is 5-col single row. 10 lanes = 2 rows of 5 OR layout overflow. Check after step 11.
4. **Snapshot payload size** — 10 lanes × rich state ≈ 30-40KB per snapshot. At 1Hz heartbeat that's ~40KB/s/client. Fine.
5. **Wikipedia rate limit** — feeder might get rate-limited if we run 2 tenants worth of throughput off one stream. wikipedia-stream-feeder.js uses ONE source connection that fans out to N queues, so rate is unchanged. Safe.
6. **Cluster.js spawn cost** — boots 30 dolphin-milk processes at startup. Memory: ~50MB each = 1.5GB. Fine on a dev machine.

## Quick rollback

If 10-lane scaling breaks anything, revert is fast:
```bash
git checkout fleet/lanes.json feeder/bluesky-jetstream-feeder.js feeder/wikipedia-stream-feeder.js
pkill -f "ui/server"
pkill -f "lane-cycle.js"
pkill -f "dolphin-milk serve --port 81[1-3][5-9]"
# Restart feeders without the tenant env vars
nohup node feeder/bluesky-jetstream-feeder.js > /tmp/bsky-feeder.log 2>&1 &
nohup node feeder/wikipedia-stream-feeder.js > /tmp/wiki-feeder.log 2>&1 &
nohup node ui/server.js > /tmp/ui-server.log 2>&1 &
```

The 15 new wallets stay funded (cheap) — we can use them for the 15-lane attempt later or just leave them sitting.
