# E21-0 — fleet bootstrap + the funding bug (2026-04-14 late session)

> **Stage doc**, not a checkpoint. This run is still in progress — multiple
> fixes are landing simultaneously and the real E21-0 5-lane full-synth run
> hasn't fired yet. This file captures where we are so context-loss is
> survivable.

## Timeline

| t | event |
|---|---|
| ~14:20 | E20d full pipeline checkpoint passes. rust-bsv-worm pinned at `f47c0c3`, dolphinmilkshake scaffolding committed. |
| ~14:30 | Start fleet infrastructure: lanes.json, provision-fleet-wallets.sh, start-fleet-daemons.sh. |
| ~14:45 | 15 fleet wallets provisioned on ports 3400-3414 (captain/worker/synthesis × 5 lanes). |
| ~14:55 | `fund-fleet-wallets.sh` runs: send→fund→split on all 15. Script reports all-failed due to split-output JSON parser bug, but funds DID move. 14/15 wallets actually split-correctly on disk, 1 (worker-movies) hit a toolbox merkle-root error that's unrelated. |
| ~15:10 | Parser fix + idempotent skip re-run: all 15 wallets at target balance, verified via preflight. |
| ~15:20 | First 5-lane E21-0 attempt. All 5 lanes fail at `cluster.js` step 4 (identity verify) — MetaNet thundering herd from ~75 concurrent BRC-31 getPublicKey calls overwhelms MetaNet Desktop. **MetaNet wedges completely.** |
| ~15:30 | MetaNet recovery blocked on user (cmd-Q + reopen). Feeder keeps running in background collecting comment data. 186 new comments/min aggregate across 5 subs. Zero 429s. |
| ~15:55 | MetaNet back. Apply fix: `LAUNCH_STAGGER_SEC=10` in fleet-cycle.sh + serialize step 4 in cluster.js. |
| ~16:00 | 2-lane retry (worldnews + askreddit). **AskReddit passes (118,485 sats/199s), worldnews fails at step 6 overlay registration** with "Insufficient funds: need 45, have 36". |
| ~16:05 | Diagnose: captain-worldnews has an untagged 36-sat dust UTXO. dolphin-milk's createAction picks it first, fails. |
| ~16:10 | Relinquish the dust. Retry. **Same error — now "need 30, have 0"**. Dust was a symptom, not the cause. |
| ~16:15 | Discover 9 of 15 fleet wallets have similar dust. Also discover **captain-askreddit has 12 untagged outputs** that make it work while other captains have only tagged split outputs. |
| ~16:20 | Write + run `relinquish-fleet-dust.sh` (sweep all dust). Still fails. |
| ~16:25 | Write + run `topup-fleet-untagged.sh` (adds a fresh send-received output to each failing wallet, skipping the split). 8 wallets topped up. |
| ~16:30 | **2-lane retry PASSES.** Worldnews 125,334 sats/264s, AskReddit 121,569/294s. Both lanes produce 100 proofs. First true parallel-lane fleet run works. |
| ~16:35 | User stops work to discuss funding bug properly. Max-effort fix starts. |

## Root cause (the funding bug)

The `bsv-wallet-cli split` subcommand produces outputs that are
**invisible to dolphin-milk's `createAction` coin selector**. The reason
is NOT primarily the `relinquish` tag on those outputs (though that
exists) — the real filter is the `outputs.change` column in the wallet
SQLite schema.

### The mechanism

bsv-wallet-toolbox-rs's coin selector (`allocate_change_input` in
`create_action.rs` lines 1560-1639) picks inputs to cover fees for a
new `createAction` call with this predicate:

```sql
SELECT ... FROM outputs
WHERE user_id = ? AND basket_id = ? AND change = 1
  AND spent_by IS NULL AND spendable = 1
  AND transaction_id IN (completed/unproven txs)
```

The key filter: **`change = 1`**. Only outputs the wallet considers
"change" are eligible to fund new transactions.

### The split command creates non-change outputs

`bsv-wallet-cli/src/commands/split.rs` at lines 93-103:

```rust
// Build outputs — tagged relinquish so createAction doesn't track them as ours.
// We'll self-internalize after to get proper derivation stored.
let outputs: Vec<CreateActionOutput> = (0..count)
    .map(|_| CreateActionOutput {
        locking_script: lock_bytes.clone(),
        satoshis: per_output,
        output_description: "split output".to_string(),
        basket: Some("default".to_string()),
        custom_instructions: None,
        tags: Some(vec!["relinquish".to_string()]),
    })
    .collect();
```

Then `create_action(...)` is called, then `internalize_action(...)` with
protocol `"wallet payment"` to register derivation metadata. The outputs
land in storage with:

```
provided_by = "you"   (the wallet created them for itself)
purpose     = (unset)
change      = 0       (they're intentional outputs, not change)
tag         = "relinquish"
```

**These three flags together make the split outputs invisible** to
dolphin-milk's coin selector, even though `listOutputs` reports them as
`spendable: true`. The toolbox's SQL filter `change = 1` excludes them.

### Why the CLI's own `send` works on tagged outputs

The CLI's `send` command calls `create_action` which internally invokes
`allocate_change_input` — the SAME coin selector. So why does it work?
Because `send` creates its change output with `change = 1, provided_by =
"storage", purpose = "change"` — a proper change marker. Once you have
ONE change-marked output with enough sats, subsequent `send`s can
cascade-chain from it. The CLI's `send` can spend split outputs as
inputs ONLY because the coin selector is told to explicitly include
them via the outputs path, not via the change selector.

### Why captain-askreddit worked on the first 2-lane run

The earlier fund-fleet-wallets.sh retry (before I killed it) did
multiple partial send attempts on some wallets. captain-askreddit ended
up with 12 untagged outputs from those retries — which happened to come
from `send` operations that marked them as `change=1`. So it had a
healthy change pool from day one. Other captains didn't.

### Why the topup-fleet-untagged fix worked

`topup-fleet-untagged.sh` adds a `send → fund → (no split)` to each
broken wallet. The resulting output (internalized via "wallet payment")
was marked as `change=1, purpose=receive` by the toolbox (receive from
external party IS considered change for funding purposes). This gave
dolphin-milk one usable UTXO per wallet. **Band-aid, not root fix.**

## What's been landed so far

### Code (dolphinmilkshake)

- `scripts/provision-fleet-wallets.sh` — creates 15 wallets with env files
- `scripts/start-fleet-daemons.sh` — lifecycle for the 15 daemons, paranoid about env file safety
- `scripts/fund-fleet-wallets.sh` — wraps `fund-wallet.sh` per-role with role-sized amounts
- `scripts/relinquish-fleet-dust.sh` — sweeps dust UTXOs (not needed once we fix the real bug, but safe)
- `scripts/topup-fleet-untagged.sh` — the band-aid that gave each wallet a change-marked UTXO
- `scripts/fund-wallet.sh` — parser bug fixed (split output JSON extraction via regex)
- `scripts/fleet-cycle.sh` — parallel lane orchestrator with `LAUNCH_STAGGER_SEC` (default 10s)
- `scripts/lane-cycle.js` — vendored from test_cycle_v2.js, parameterized on `LANE_ID`
- `scripts/lib/cluster.js` — vendored + patched to serialize step 4 identity verify (prevents parent-wallet thundering herd)
- `scripts/lib/auth.js` — vendored unchanged
- `fleet/lanes.json` — 5-lane smoke config (worldnews, politics, askreddit, gaming, movies)

### Fleet state

- 15 bsv-wallet daemons running on ports 3400-3414
- Each daemon has env file with ROOT_KEY persisted at `~/bsv/wallets/fleet/<name>.env`
- Inventory at `~/bsv/wallets/fleet/INVENTORY.json` + human-readable `INVENTORY.md`
- Total fleet balance: ~100M sats spread across 15 wallets
- Feeder running in background (bg from this session — will need re-audit) feeding 5-sub queue with 200+ records per sub

### Experiments

- 2-lane run passed: worldnews 125,334 sats / 264s, askreddit 121,569 / 294s. Both lanes 100 proofs on-chain, no synthesis. Proves parallel lane execution works with the stagger fix + topup band-aid.
- Single-lane synthesis validation has NOT been run yet — deferred to after the real root-fix lands.
- 5-lane E21-0 (no synth) not run yet — stopped before firing per user's request to fix the bug properly.

## What's next (max-effort fix, in order)

1. **Patch `bsv-wallet-cli/src/commands/split.rs`** — remove the relinquish tag, and ensure split outputs get registered with `change=1` somehow. Best path: don't use `internalize_action` with "wallet payment" protocol — instead directly construct the tx, mark outputs as change in storage, and let the wallet's normal change-tracking handle it. If that's too invasive, fall back to a post-internalize SQL UPDATE inside the split command.
2. **Rebuild bsv-wallet-cli binary** and swap into place. Test: fresh split on a scratch wallet produces outputs with `change=1` and no `relinquish` tag.
3. **DB surgery on the 15 existing fleet wallets** — UPDATE outputs SET change=1 WHERE (joined to split-labeled txs), AND soft-delete the relinquish tag (set `output_tags_map.is_deleted = 1`). Run on one wallet as a canary first, verify via a dolphin-milk createAction probe, then apply to all.
4. **Single-lane synthesis validation** (`C2`) — fire one lane with `ENABLE_SYNTHESIS=1` to confirm my `lane-cycle.js` refactor didn't break the synthesis code path. Static review (`C3`) already found zero bugs but the run is the real test.
5. **5-lane E21-0 full run** — synthesis ON, stagger 15s, all 5 lanes. Produces 500 proofs + 5 NanoStore HTML articles + 5 txid manifests in one cycle. The actual pre-smoke.

## Open questions that might blow up

- The `internalize_action` call after split is load-bearing for storing
  derivation info — the wallet needs to be able to sign when spending
  these outputs later. If I bypass it, can the wallet still spend the
  split outputs? Needs investigation before patching.
- DB surgery on a running daemon: SQLite WAL allows concurrent writes,
  but the daemon caches output metadata in memory. Flipping `change=1`
  in the DB won't be visible until the daemon re-reads, which might not
  happen until restart. Safest: stop the target daemon, edit, restart
  (following the env-safety rule).
- Per-lane synthesis running 5 synthesis agents simultaneously is
  expensive (5 × ~285K = ~1.4M sats per full-synth cycle) — OK for the
  pre-smoke but for 1h+ soak we'd want synthesis pooled or amortized.
  This is a decision deferred until after the real E21-0 lands.

## Cross-ref

- `rust-bsv-worm@f47c0c3` — pinned binary dependency
- [../NEXT.md](../NEXT.md) — post-E20d roadmap header gets a pointer to this file
- [../PLAN-C-SCALE.md](../PLAN-C-SCALE.md) — architecture
- [../WALLETS.md](../WALLETS.md) — wallet ops recipe (needs amendment: the split flow has a footgun)
- [E20d-checkpoint.md](E20d-checkpoint.md) — the previous known-good checkpoint
