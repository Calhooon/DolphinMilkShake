# E22 Launch Readiness — 20→40 lane path to the 24h big daddy

**Last updated**: 2026-04-15 22:25 local
**Owner**: John
**Companion doc**: `POSTMORTEM-E22-CERT-LIMBO.md` (the *why*; this is the *what next*)

This is the operational checklist. It's meant to be short, scannable, and
deleted after the 24h run lands.

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

### Fleet wallet state
- ✅ All 40 captain+synthesis wallets at or above target (captain 5M, synthesis 2M)
- ✅ All 20 worker wallets are self-sustaining (x402 inflow)
- ✅ Master (`3322`) balance ~41,677,636 sats (~$23 at $15.62/BSV)
- ✅ Parent wallet (`3321`) responsive
- ✅ All 60 wallet daemons running (ports 3400–3459)
- ✅ `worker-bsky-en-11` cert state repaired (stale cert relinquished via BRC-100 API)

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

### 3. Fire the 20-lane 17-cycle soak (production validation)
```bash
cd /Users/johncalhoun/bsv/dolphinmilkshake
nohup ./scripts/fleet-cycle.sh > /tmp/soak-20lane-17-v2.log 2>&1 &
```
**Runtime**: ~50 min at 20 lanes
**Expected cost**: ~$0.30–0.50 end-to-end
**Target**: 20/20 lanes complete, zero FATAL errors, matches or beats the 18/20 on the last run.

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

## CHECKLIST (literal — tick as you go)

- [ ] Preflight `./scripts/preflight-certs.sh` → 20/20 PASS
- [ ] Watchdog running in background (`pgrep -f wallet-watchdog.js` returns a pid)
- [ ] Master balance ≥ 50M sats before firing soak
- [ ] Fire 20-lane 17-cycle soak via `./scripts/fleet-cycle.sh`
- [ ] All 20 lanes complete (`grep completed /tmp/soak-20lane-17-v2.log | wc -l` == 20)
- [ ] Zero FAILED lanes
- [ ] Aggregate written and sats totals look sane
- [ ] Commit the session's changes with a clear message
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
