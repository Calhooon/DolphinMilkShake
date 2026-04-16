# E22 Launch Readiness — 30→40 lane path to the 24h big daddy

**Last updated**: 2026-04-15 22:35 local (30-lane scale-up underway)
**Owner**: John
**Companion doc**: `POSTMORTEM-E22-CERT-LIMBO.md` (the *why*; this is the *what next*)

This is the operational checklist. It's meant to be short, scannable, and
deleted after the 24h run lands.

**Scope change 2026-04-15 22:25**: after the 20-lane preflight passed cleanly
on the targeted bsky-en-11 run, we skipped a 20-lane validation soak and
jumped straight to **30 lanes** by adding 10 new bsky-en fanout tenants
(bsky-en-12 through bsky-en-21). See §"30-lane scale-up log" at the bottom.

---

## STATE OF THE WORLD

### Code
- ✅ `scripts/lib/auth.js` — 401 stale-session retry (BRC-31 session recovery)
- ✅ `scripts/lib/cluster.js` — `POLL_TIMEOUT_MS` 20000 → 60000 (cert poll headroom)
- ✅ `src/certificates/lifecycle.rs` — `has_matching_parent_cert()` now calls `is_revoked()` before returning true
- ✅ `scripts/wallet-watchdog.js` — new background topup daemon
- ✅ `scripts/preflight-certs.sh` + `scripts/lane-cycle.js` env flag `PREFLIGHT_CERTS_ONLY=1`
- ✅ Rebuild: `target/release/dolphin-milk` timestamp 18:03 (new binary with cert fix baked in)
- ❌ Nothing committed yet

### Fleet wallet state (30-lane scope)
- ✅ 60 captain+synthesis wallets targets: captain 5M, synthesis 2M
- ✅ 30 worker wallets: existing 20 self-sustaining; new 10 bootstrapped to ~500k via fund-wallet.sh (split=3)
- ✅ Master (`3322`) balance at ~161M sats before 30-lane pre-fund, ~80M expected after
- ✅ Parent wallet (`3321`) responsive
- ✅ All 90 wallet daemons running (ports 3400–3489)
- ✅ `worker-bsky-en-11` cert state repaired (stale cert relinquished via BRC-100 API)
- ✅ New 10 lanes appended to `fleet/lanes.json` (bsky-en-12..21, wallet ports 3460–3489, server ports 8160–8189)
- ✅ INVENTORY.json grew 60 → 90 entries via provision-fleet-wallets.sh (idempotent, existing 60 untouched)

### Verification
- ❌ Preflight not yet re-run with the new binary — **this is the gate before the 24h**
- ❌ 24-hour run not started

---

## RUN ORDER (in order; do not skip)

### 0. Quality gate (optional but recommended)
```bash
cd /Users/johncalhoun/bsv/rust-bsv-worm
cargo fmt --check && cargo clippy -- -D warnings
```
We only touched one function in `lifecycle.rs` so this should be a no-op; skip if pressed for time, but DO run it before any `git commit`.

### 1. Re-fire the preflight (zero-cost gate)
```bash
cd /Users/johncalhoun/bsv/dolphinmilkshake
./scripts/preflight-certs.sh
```
**Expected**: all 20 lanes PASS. `bsky-en-11` should pass this time because:
- its wallet no longer holds a stale revoked cert (relinquished earlier)
- the new binary's `has_matching_parent_cert()` now checks revocation, so if the limbo ever recurs the daemon will self-heal by re-acquiring
- the 60s cluster timeout gives real headroom

**Runtime**: ~5 min (20 lanes × 10s stagger + 60-90s per lane boot/audit/stop)
**Cost**: $0 (no cycles, no proofs, no LLM calls)

**If it fails**: inspect `/tmp/dolphinsense-fleet-runs/<latest>/lane-*.log` for the specific lane. The diagnostic playbook is in `POSTMORTEM-E22-CERT-LIMBO.md` §6.

### 2. Start the wallet watchdog in the background
```bash
cd /Users/johncalhoun/bsv/dolphinmilkshake
nohup node scripts/wallet-watchdog.js > /tmp/wallet-watchdog-24h.log 2>&1 &
echo "watchdog pid: $!"
```
Runs forever (30s interval). Automatically tops up any captain/synthesis wallet that drops below 1M sats. Workers are not watched — they're self-sustaining via x402 inflow.

Safe to run while cycles are mid-flight — `fund-wallet.sh` does sender-side split, receiver UTXOs are never touched.

### 3. Fire the 30-lane 17-cycle soak (production validation, updated scope)
```bash
cd /Users/johncalhoun/bsv/dolphinmilkshake
# Make sure both feeders are running with updated tenant env:
#   BSKY_EN_TENANTS=bsky-en,bsky-en-2,...,bsky-en-21  (21 tenants)
#   BSKY_JA_TENANTS=bsky-ja,bsky-ja-2
#   BSKY_PT_TENANTS=bsky-pt,bsky-pt-2
#   WIKI_TENANTS=wiki-en,wiki-en-2,wiki-en-3,wiki-en-4

# IMPORTANT: SOAK_CYCLES defaults to 1 in fleet-cycle.sh (line 45). MUST pass
# SOAK_CYCLES=17 explicitly or each lane will run ONE cycle and exit — you'll
# get a ~8 min smoke test instead of the intended 75 min production soak.
SOAK_CYCLES=17 nohup ./scripts/fleet-cycle.sh > /tmp/soak-30lane-17.log 2>&1 &
```
**Runtime**: ~75 min at 30 lanes (stagger 200s for 30 lanes + 17 cycles × ~120s/cycle avg)
**Expected cost**: ~$0.50–0.80 end-to-end
**Target**: 30/30 lanes complete, zero FATAL errors, validates the cert revocation guard fix across ALL new lanes.

### 3b. (optional) Fire a 1-cycle smoke test first
```bash
# Default SOAK_CYCLES=1 — runs one cycle per lane, ~8 min total. Useful as a
# cheap end-to-end validation before committing to the 17-cycle spend. Catches
# any lane-specific regression for ~1/17 the cost.
nohup ./scripts/fleet-cycle.sh > /tmp/soak-30lane-smoke.log 2>&1 &
```
If any lane FAILs in the smoke test, debug before firing the 17-cycle run.

### 4. Collect the baseline
- Read final `fleet-aggregate.json`
- Compare vs 2026-04-15T19-01-00 run (that's the baseline to beat)
- Capture per-lane sats spend, proof count, wall time
- Watch for any new failure mode — if a new bug appears, STOP and debug before 24h

### 5. Fire the 24h big daddy
**Only after** steps 1–4 pass clean. Separate plan doc needed (see Task #41 PLAN-E22-24H-BIG-DADDY.md — still pending).

Open questions for that plan:
- target lane count: 20, 30, or 40?
- cycle count: enough to fill 24h at current throughput
- master wallet budget: 41M sats current, 24h at 20 lanes could burn ~120M sats → need to pre-fund master before firing
- watchdog topup cost over 24h: estimate 100 topups × 3M avg = 300M sats headroom needed in master
- dashboard visibility: confirm the live UI handles 24h of data without OOM

---

## DEPLOYMENT NOTES

### Rebuild is done
`target/release/dolphin-milk` is 18:03 (post-cert-fix). This is the binary `cluster.js` will spawn on every lane, every cycle. No manual deploy needed — the fleet uses the on-disk binary path.

### Don't rebuild mid-soak
Rebuilding while a soak is running will corrupt the binary if a daemon is mid-spawn. If you absolutely need to rebuild, stop the soak first.

### Don't touch wallet daemons
The 60 fleet wallet daemons (ports 3400–3459) are long-lived, manage their own state, and should never be stopped/restarted during a soak. `fund-wallet.sh` and `wallet-watchdog.js` both talk to the daemons via HTTP and are safe.

### Don't touch master (`3322`)
Master is the source of all top-ups. Do not stop, re-init, or rekey. HTTP API only. The watchdog assumes it's running and will fail topup attempts cleanly if not.

---

## ROLLBACK

If anything looks wrong after a fix:
- **Code fixes**: `git diff` shows exactly what changed, all in `scripts/lib/`, `scripts/`, and `src/certificates/lifecycle.rs`. `git checkout HEAD -- <path>` reverts individual files.
- **worker-bsky-en-11 cert state**: can't "un-relinquish" the stale cert. Fresh one will be acquired on next boot. This is fine.
- **Wallet balances**: the watchdog over-topped if it misfires. Use `fund-wallet.sh` in reverse (captain → master) with a manual send. Check balances via `/balance` on each wallet port before and after.
- **Binary**: previous binary timestamp was 08:48 (this morning). Lost when rebuilt. If the new binary misbehaves, `git stash` the cert fix and `cargo build --release` again. Keep a known-good build around if in doubt.

---

## CHECKLIST (literal — tick as you go, 30-lane scope)

- [x] Append 10 new bsky-en lanes to `fleet/lanes.json` (bsky-en-12..21)
- [x] `./scripts/provision-fleet-wallets.sh` → 30 new env/db created, existing 60 skipped
- [x] `./scripts/start-fleet-daemons.sh start` → 30 new wallet daemons on ports 3460–3489
- [x] 10 new workers funded to ~500k each via `fund-wallet.sh`
- [x] Feeder restarted with BSKY_EN_TENANTS=21, WIKI_TENANTS=4, all groups preserved
- [ ] Watchdog `--once` to fund 20 new captains (5M) + 20 new synthesis (2M) — **in progress**
- [ ] Targeted preflight: `ONLY_LANES=bsky-en-12,bsky-en-13,...,bsky-en-21 ./scripts/preflight-certs.sh` → 10/10 PASS
- [ ] Start watchdog in continuous mode in background for the soak
- [ ] Master balance ≥ 50M sats before firing soak
- [ ] Fire 30-lane 17-cycle soak via `SOAK_CYCLES=17 ./scripts/fleet-cycle.sh` — **DO NOT forget SOAK_CYCLES=17 or each lane runs ONE cycle and exits**
- [ ] All 30 lanes complete (`grep completed /tmp/soak-30lane-17.log | wc -l` == 30)
- [ ] Zero FAILED lanes
- [ ] Aggregate written and sats totals look sane
- [ ] Commit lanes.json + INVENTORY.json + doc updates
- [ ] Write PLAN-E22-24H-BIG-DADDY.md (task #41)
- [ ] Pre-fund master for 24h
- [ ] Fire 24h run

---

## WHAT THE COMMIT LOOKS LIKE

Files changed:
- `scripts/lib/auth.js` — 401 retry (Bug #1)
- `scripts/lib/cluster.js` — cert timeout bump (Bug #2 headroom)
- `scripts/lane-cycle.js` — `PREFLIGHT_CERTS_ONLY` short-circuit + stopCluster import
- `scripts/fleet-cycle.sh` — propagate `PREFLIGHT_CERTS_ONLY` env to children
- `scripts/wallet-watchdog.js` — new (fleet topup daemon)
- `scripts/preflight-certs.sh` — new (cert audit wrapper)
- `POSTMORTEM-E22-CERT-LIMBO.md` — new (this session's narrative)
- `LAUNCH-READINESS-E22-24H.md` — new (this file)

And in `rust-bsv-worm`:
- `src/certificates/lifecycle.rs` — `has_matching_parent_cert()` revocation guard (Bug #3 root fix)

Two separate commits in two repos.

---

## 30-lane scale-up log (2026-04-15 evening)

Session after the initial E22 fixes landed. Skipped 20-lane validation and
went straight to 30-lane provisioning.

### Decisions
- **+10 bsky-en tenants, not split across sources**. Rationale: bluesky en
  firehose is the highest-volume stream (44k+ records per lane even at
  11-way fanout). Wiki stream is too slow for more tenants. Adding more
  ja/pt would starve already-data-light lanes. Pure copy-paste of the
  bsky-en-11 template = minimal new surface.

### Port allocation
- Lanes: 21 total for bsky-en (bsky-en, bsky-en-2..21)
- Wallet ports: 3460–3489 (30 new)
- Server ports: 8160–8189 (30 new)
- Clean contiguous extension of the existing 3400–3459 / 8100–8159 block

### Provisioning sequence executed
1. Backup `fleet/lanes.json` → `fleet/lanes.json.bak-pre-30lane`
2. Append 10 lanes via `node -e` script (pure JSON mutation, safer than text edit)
3. `./scripts/provision-fleet-wallets.sh` — 30 created, 60 skipped (idempotent)
4. `./scripts/start-fleet-daemons.sh start` — 30 new daemons, existing 60 untouched (skip-if-running logic verified)
5. Fund 10 new workers to 500k each via `fund-wallet.sh <src> <dst> 500000 3`
6. Restart feeders with `BSKY_EN_TENANTS` = 21 comma-sep values; `WIKI_TENANTS` = 4; ja/pt preserved
7. `wallet-watchdog.js --once` fills the 20 new captain+synthesis wallets
8. `ONLY_LANES=bsky-en-12,...,bsky-en-21 ./scripts/preflight-certs.sh` for targeted cert validation
9. Background watchdog (continuous mode)
10. `./scripts/fleet-cycle.sh` for the full 30-lane 17-cycle soak

### Gotchas observed
- **Feeder nohup inside Bash tool subshell**: `nohup … &` inside a `run_in_background` Bash call gets killed when the outer bash exits. Workaround: invoke the feeder as a top-level `run_in_background` command with the harness supervising it.
- **Triple feeder race**: old feeder from 2:43pm (stale `BSKY_EN_TENANTS` env) was still alive. Had to pkill all before restarting clean.
- **Wikipedia cursors dir missing**: `mkdir -p /tmp/dolphinsense-firehose/cursors` before starting wiki feeder or it'll spam `ENOENT` errors on every cursor flush. Not fatal but noisy.
- **Feeder log doesn't show wiki tenants**: the wiki feeder log line says `lane=wiki-en` because it prints `LANE_ID` fallback, not the parsed `WIKI_TENANTS` array. Verify tenant routing via queue file creation under `/tmp/dolphinsense-firehose/wiki-en-N/` rather than trusting the log.

### Feeder queue fill rate observed
At ~3 minutes of uptime, all 10 new bsky-en lanes had exactly **318 records each** (perfectly round-robin balanced across all 21 en tenants). Projection: ~1500-2000 records per new lane after 15-20 minutes — plenty for the 17-cycle × 100-record-batch soak.
