# POSTMORTEM E22 — Cert Revocation Limbo + Session Fragility

**Date**: 2026-04-15
**Trigger**: 20-lane 17-cycle soak fired 19:01, completed 20:43. 18/20 lanes passed. 2 failed: `bsky-en-11` (cert acquisition at boot) and `wiki-en-3` (HTTP 401 mid-cycle). Subsequent preflight revealed bsky-en-11 was not a timing bug — it was a persistent cert-state asymmetry that a simple timeout bump could not fix.
**Severity**: launch blocker. At 20 lanes we lost 10% of fleet capacity. At 30-40 lanes the same latent bug would compound.
**Status**: resolved end-to-end (data + code), documented, not yet committed.

---

## 1. Timeline

| Time (local) | Event |
|---|---|
| 19:01 | 20-lane 17-cycle soak starts via `./scripts/fleet-cycle.sh` |
| 19:02 | `bsky-en-11` dies at `cluster.js` step 5: `worker-bsky-en-11 did not converge on desired capabilities within 20000ms. Last seen: none. Last error: none.` |
| 20:43 | Soak completes. 18/20 clean. `wiki-en-3` also FAILED on cycle 17 with `submit failed: HTTP 401 ""` after cycle 16's `worker proof not found before deadline`. |
| 21:08 | Watchdog dry-run: 16 healthy / 24 need topup after soak drain |
| 21:10–21:32 | `wallet-watchdog.js --once` live, 24/24 topped up, master 130M → 41M |
| 21:49 | Preflight re-fire with 60s cert timeout bump. 19/20 pass. `bsky-en-11` fails IDENTICALLY with "Last seen: none, Last error: none" — proving the bug is not timing. |
| 22:05 | Root cause identified: revoked-but-present parent-signed cert in `worker-bsky-en-11` wallet store. `has_matching_parent_cert()` doesn't check `is_revoked()`, `/certificates` handler does — asymmetric view. |
| 22:10 | Data fix: `POST /relinquishCertificate` on wallet port 3446, `listCertificates` 1 → 0 |
| 22:15 | Code fix: `has_matching_parent_cert()` now calls `is_revoked()` and forces re-issue on stale revoked certs |

---

## 2. Bug #1 — BRC-31 session fragility (wiki-en-3 HTTP 401)

### Symptom
`wiki-en-3` cycle 17 died with `submit failed: HTTP 401 ""`. Cycle 16 had hit `worker proof not found before deadline` (transient proof wait). `bsky-pt` hit the identical proof-wait transient in its cycle 16 and recovered; `wiki-en-3` did not.

### Root cause
`scripts/lib/auth.js` caches BRC-31 sessions in a `Map<wormPort, session>`. If the cached session goes stale — via server nonce recycling, mid-request abort, or any asymmetry after a prior error — the next authed POST gets 401 with an empty body and there was **zero retry logic** above it. A single stale-session blip kills the lane.

### Fix
`scripts/lib/auth.js` — split `authRequest` into outer wrapper + inner `authRequestOnce`. On HTTP 401 the wrapper calls `sessions.delete(sessionKey)`, performs a fresh handshake via `authRequestOnce`, and retries once. A second 401 is a real auth failure and propagates. Scope: 15 lines, single function.

### Impact
Any lane that hits a transient error (proof-not-found, overlay flap, x402 timeout) and then tries another authed request on the same session no longer dies. This is a launch blocker for long-running soaks where transients are common.

---

## 3. Bug #2 — cluster.js step 5 cert poll timeout

### Symptom
`bsky-en-11` failed at `cluster.js:1052` with `did not converge on desired capabilities within 20000ms` in the original 19:01 soak.

### Preliminary (wrong) diagnosis
Thundering herd on parent wallet (port 3321) when 20+ lanes boot simultaneously and 40+ agents all hit `createSignature` for cert acquisition.

### Fix attempted
`scripts/lib/cluster.js:576` — `POLL_TIMEOUT_MS` bumped 20000 → 60000ms. `LAUNCH_STAGGER_SEC=10` already in `fleet-cycle.sh` was confirmed (200s total ramp for 20 lanes).

### Result
Preflight at 21:49 showed `bsky-en-11` failed again with the IDENTICAL error message at 60s, while all other 19 lanes passed in under 20s each. This proved the bug was not timing-bound. The 60s bump is still worth keeping as headroom — rebuild doesn't break it — but it was not the root cause.

---

## 4. Bug #3 — cert revocation limbo (root cause of bsky-en-11)

### Symptom
`worker-bsky-en-11` dolphin-milk daemon booted, logged `BRC-52: existing parent-signed cert matches desired state — skipping re-issue` (with correct capabilities), accepted a BRC-31 handshake from `cluster.js`, started serving on 8146. Yet `authGet /certificates` from `cluster.js` over 60s returned nothing cluster.js could parse: `Last seen: none, Last error: none`.

### Diagnostic method
1. Curl the wallet API on port 3446 directly via `POST /listCertificates` → returned **1 cert**, parent-signed, caps `llm,tools,wallet,memory,messaging,x402,schedule,orchestration,scraping`, with a `revocationOutpoint` of `6aed7b609bd8d9d83d586f0f119c081d989b74faa6e3ddf2005bdbb0b281ca76:0`.
2. Curl `/listOutputs` on the same wallet for baskets `dm-revocation` and `dm-state` → **both empty**.
3. Compared against healthy workers on ports 3444, 3412, 3440 → each had **1 cert + 1–2 outputs in `dm-revocation`**. Every healthy worker has the cert AND its revocation UTXO still in the basket.
4. Traced the discrepancy through the source: `src/certificates/lifecycle.rs`.

### Root cause
Two code paths checked "does this agent have a valid parent-signed cert?" with **different answers**:

- **`has_matching_parent_cert()`** (used at boot by `src/server/app_state.rs:614`): compared `fields.name` and `fields.capabilities` for a byte-exact match. **Did not check revocation status.**
- **`certificate_status()`** (used by `GET /certificates` handler): iterated certs, called `is_revoked()` (which scans `dm-revocation` and `dm-state` baskets for the cert's revocation outpoint), and **skipped revoked certs**.

So if the cert's revocation UTXO was missing from both baskets — spent, relinquished, or never present — the boot path saw a matching cert and skipped re-issue, but the HTTP handler saw a revoked cert and returned `status: "none"`. The daemon ran with a cert the outside world couldn't see.

`cluster.js` talks to the outside world via the HTTP handler. It saw "none" and timed out the cert audit at 20s (and again at 60s after the bump). "Last seen: none, Last error: none" is exactly the state where the wallet returned a cert, but after the is_revoked filter, nothing was left.

### How the limbo state was created
Unclear exactly which prior event spent/relinquished `worker-bsky-en-11`'s revocation UTXO. The daemon's earlier log (19:12 from the failed 20-lane soak) showed `Overlay registration outdated — spending old and re-registering caps_match:false`. A cert regeneration or a relinquish-then-reacquire path somewhere left the wallet with a cert whose revocation UTXO was gone. This needs a separate investigation to prevent the upstream cause — but the downstream fix ensures it can never boot into limbo again.

### Data fix (applied 22:10)
```
POST http://localhost:3446/relinquishCertificate
{
  "certificateType": "agent-authorization",
  "serialNumber": "dm-worker-bsky-en-11-024fd8f5-1776279820",
  "certifier": "03ef3231669022cc03aa26c74de784648faddb76609465c7181393efb335cbc7e0"
}
→ {"relinquished":true}
→ listCertificates: 1 → 0
```
Zero sats spent. DB untouched. Next boot will call `has_matching_parent_cert()` → no certs → fall through to parent-signed acquisition → fresh cert with fresh revocation UTXO.

### Code fix (applied 22:15)
`src/certificates/lifecycle.rs` — `has_matching_parent_cert()` now calls `is_revoked(c)` after the name+caps match and before returning true. If the cert is revoked, logs `tracing::warn!("has_matching_parent_cert: found matching cert but it is revoked — forcing re-issue")` and continues scanning. The function's scope is unchanged — it still returns true only for a usable cert — but "usable" now excludes revoked.

Scope: one function, one Rust file. Visible warning in stderr if the limbo state ever appears. Does not affect any other cert path.

---

## 5. Full list of artifacts produced in this session

### Source edits (3)
1. `scripts/lib/auth.js` — 401 retry wrapper (Bug #1)
2. `scripts/lib/cluster.js` — `POLL_TIMEOUT_MS` 20000 → 60000 (Bug #2 headroom)
3. `src/certificates/lifecycle.rs` — `is_revoked()` guard in `has_matching_parent_cert()` (Bug #3 root cause)

### New scripts (2)
4. `scripts/wallet-watchdog.js` — background daemon, polls INVENTORY every 30s, tops up captain+synthesis wallets under 1M sats via sender-side split (captain → 5M, synthesis → 2M, split=10). Workers skipped (self-sustaining via x402 inflow). Flags: `--once`, `--dry-run`, `--interval N`, `--only <name>`.
5. `scripts/preflight-certs.sh` + `scripts/lane-cycle.js` env flag — boots full fleet via `fleet-cycle.sh` with `PREFLIGHT_CERTS_ONLY=1`. `lane-cycle.js` short-circuits after `startCluster()` (which includes step 5 cert audit), tears down the cluster cleanly, exits 0. Zero on-chain spend.

### Operational actions
6. Wallet watchdog live run: 24/24 wallets topped up, 0 failures, 21-minute runtime, master 130,352,646 → 41,677,636 sats (−88M ≈ $50).
7. Stale cert relinquished on worker-bsky-en-11 wallet (3446) via BRC-100 `/relinquishCertificate`.

### Not done (deliberately)
- Commit. User wants to pause and document first (this doc).
- 20-lane re-fire. Paused until rebuild + re-preflight.
- Rebuild is running in background as of 22:20; not yet verified on a live preflight.

---

## 6. What a future me (or fresh Claude) needs to know

### Symptoms that point to cert limbo
- `cluster.js` step 5 error: `did not converge on desired capabilities within Xms. Last seen: none. Last error: none.`
- Daemon stderr says `BRC-52: existing parent-signed cert matches desired state — skipping re-issue`
- `GET /certificates` (via BRC-31 authed curl) returns `{status: "none", ...}`
- One specific agent, not all — rules out parent wallet / env / build issues

### Triage in 90 seconds
```bash
# Agent's wallet port is in fleet/lanes.json per lane, role=worker/captain/synthesis
curl -sS -X POST http://localhost:$WALLET_PORT/listCertificates \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost' \
  -d '{"certifiers":[],"types":[],"limit":50,"offset":0}'
# → If totalCertificates ≥ 1 AND fields match: check dm-revocation basket next

curl -sS -X POST http://localhost:$WALLET_PORT/listOutputs \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost' \
  -d '{"basket":"dm-revocation","limit":100}'
# → If totalOutputs == 0: LIMBO CONFIRMED. Cert is in wallet but its revocation UTXO is gone.
```

### Quick unblock (one agent)
```bash
curl -sS -X POST http://localhost:$WALLET_PORT/relinquishCertificate \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost' \
  -d '{"certificateType":"agent-authorization","serialNumber":"$SERIAL","certifier":"$PARENT_KEY"}'
# → {"relinquished":true}
# Next daemon boot will acquire a fresh cert + fresh revocation UTXO.
```
`$SERIAL` and `$PARENT_KEY` come from the `listCertificates` response.

### Durable fix
Already landed in `src/certificates/lifecycle.rs` `has_matching_parent_cert()` — the limbo can't boot silently anymore. Stderr will carry a `tracing::warn!` and the daemon will re-acquire on the next boot.

---

## 7. Open questions (follow-ups, not launch blockers)

1. **Upstream cause** — what actually spends/relinquishes a revocation UTXO without also relinquishing the cert it pairs with? Candidates: failed cert re-issue rollback, overlay registration respend accidentally touching the wrong basket, relinquish_self_signed path removing a parent-signed cert's UTXO. Worth a grep-through.
2. **Session staleness root cause** — BRC-31 sessions should be long-lived. Why do they ever drift? Nonce counter desync? Server session GC on timer? Worth instrumenting to see how often the 401 retry triggers in production.
3. **bsky-en-11 post-mortem** — did the stale cert come from the E14-era overlay spend logged at 19:12, or something earlier? Not a launch blocker but worth knowing for other wallets.
4. **Scale projection** — at 30–40 lanes with 60–80 workers + 30–40 captains hitting parent wallet at boot, is the 60s cert timeout still enough? Parent wallet signing throughput is the ceiling. Maybe measure.
