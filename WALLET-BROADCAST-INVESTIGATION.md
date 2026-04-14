# Wallet Broadcast Investigation — 2026-04-14

> Context-preservation file. Everything we've found, in chronological order, so we can resume without losing the thread.

## The core question

**Why do yesterday's E12 txs mine cleanly through wallet 3324, but today's E16 (same wallet, same code, same architecture) sit at `ANNOUNCED_TO_NETWORK` forever?**

Something changed in 24 hours. Either the network, the wallet state, or a dependency.

## Known good vs known bad

| Run | Date | Batch | Result | GorillaPool status |
|---|---|---|---|---|
| E12 | 2026-04-13 evening | 100 | **MINED at block 944703** | `MINED` ✓ |
| E13 | 2026-04-13 late evening | 500 | 497 on chain (3 dropped to bash timeout) | (assumed MINED) |
| **E14** | 2026-04-14 early AM | 50 parallel | **13/50 landed** | unknown |
| **E15** | 2026-04-14 morning | 100 | **4/100 landed** | `ANNOUNCED_TO_NETWORK` forever |
| **E16** | 2026-04-14 morning (post wallet restart) | 100 serial | 100 signed, **0 on chain** | `ANNOUNCED_TO_NETWORK` forever |
| Post-restart single probe | 2026-04-14 12:30 | 1 | signed, **0 on chain** | `ANNOUNCED_TO_NETWORK` forever |

**Conclusion: broadcast pipeline to miners broke sometime between E13 (late 2026-04-13) and E14 (early 2026-04-14).**

## Wallet broadcast providers (from source)

`~/bsv/bsv-wallet-toolbox-rs/src/services/services.rs` — providers added in this order, mode `UntilSuccess`:

1. **GorillaPool ARC** (`https://arc.gorillapool.io`)
2. **TAAL ARC** (`https://arc.taal.com`)
3. **Bitails**
4. **WhatsOnChain**

The wallet tries each in order and stops on the first that returns "success". Only if the first provider fails does it try the next.

## Direct provider health check (done at ~2026-04-14 08:22)

- **GorillaPool ARC `/v1/policy`**: HTTP 200 ✓, returns full policy (min fee 100 sats/KB, max tx size 100MB)
- **TAAL ARC `/v1/policy`**: **times out after 10s** — TAAL is down or degraded
- **Bitails tx query**: HTTP 404 (service alive, just doesn't have our tx)
- **GorillaPool junglebus tx query**: HTTP 404 (service alive, doesn't have our tx)

**So GorillaPool is the only live ARC provider today. Yesterday it was probably working alongside TAAL.**

## What GorillaPool ARC says about our txs

```
GET https://arc.gorillapool.io/v1/tx/<our_txid>
→ {
    "txStatus": "ANNOUNCED_TO_NETWORK",
    "blockHeight": 0,
    "blockHash": "",
    "merklePath": "",
    "extraInfo": ""
  }
```

For every E16 tx, every fresh test probe, and the post-restart single tx.

For E12 (yesterday's):
```
→ {
    "txStatus": "MINED",
    "blockHeight": 944703,
    "blockHash": "0000...",
    "merklePath": "<real merkle path>",
  }
```

## ARC status progression (from ARC spec)

```
RECEIVED → STORED → ANNOUNCED_TO_NETWORK → REQUESTED_BY_NETWORK → SEEN_ON_NETWORK → MINED
```

`ANNOUNCED_TO_NETWORK` = ARC has broadcast the tx to its peer nodes.
`SEEN_ON_NETWORK` = other nodes have confirmed receiving it.
`MINED` = in a block.

**All our txs stall at `ANNOUNCED_TO_NETWORK`.** GorillaPool announced them but nothing on the network picked them up. Since GorillaPool's peer list probably includes TAAL (which is down), the propagation graph may be broken.

## Wallet's own triage output

```
2026-04-14 12:15:54 synchronize_transaction_statuses: triage complete
  total=191 confirmed=0 mempool=0 missing=191
```

The wallet's own check reports 191 txs as "missing from the indexers it queries". Confirmed via wallet logs.

## The Rust toolbox `post_raw_tx` classification bug

`~/bsv/bsv-wallet-toolbox-rs/src/services/providers/arc.rs` lines 243-297:

```rust
let is_double_spend = data.tx_status == "DOUBLE_SPEND_ATTEMPTED";
let is_orphan_mempool = data.tx_status == "SEEN_IN_ORPHAN_MEMPOOL";

if is_double_spend { ... error }
else if is_orphan_mempool { ... error }
else {
    // ANY OTHER tx_status → "success"
    Ok(PostTxResultForTxid { status: "success", ... })
}
```

The `else` branch classifies **ANYTHING** that isn't double-spend or orphan as success — including `RECEIVED`, `STORED`, `ANNOUNCED_TO_NETWORK`, `QUEUED`. The wallet records the tx as successfully broadcast even though ARC has only queued it.

**Compare to the same file's `get_tx_data` query path at line 530:**

```rust
let status = if data.tx_status == "SEEN_ON_NETWORK"
    || data.tx_status == "STORED"
    || data.tx_status == "MINED"
{
    "success"
} else {
    "error"
};
```

The query path requires `SEEN_ON_NETWORK || STORED || MINED`. The post path accepts anything. **The two paths disagree.**

## Current wallet state

- **Wallet 3324** restarted once (SIGTERM + reload at 08:11, then again at 08:30 after my rebuild)
- **DB**: `~/bsv/wallets/worker-3324.db` (50 MB, unchanged)
- **Identity**: `026468a60d00ec36bc1dafafbd8992d12f40fb6a4740f278deb5ee94d346bd9722`
- **Env**: `ROOT_KEY=dc8259...` (from `~/bsv/wallets/worker-3324.env`)
- **Default basket outputs**: 59 (healthy, spendable)
- **Total historical actions**: 2262
- **Status distribution in recent 2000**: all `completed`

## Fee analysis

- Wallet default fee rate: `DEFAULT_FEE_RATE_SAT_PER_KB = 101` (toolbox `create_action.rs:32`)
- GorillaPool mining policy minimum: 100 sats/KB

We are **1 sat/KB above the floor**. Razor-thin. User says fee is fine, so not the issue.

## What I changed (current local state)

Local edits I've made (not yet rebuilt / not yet active for the toolbox one):

### 1. `~/bsv/bsv-wallet-cli/src/commands/daemon.rs` — REBUILT, ACTIVE

Added env var `ARC_WAIT_FOR` (default `SEEN_ON_NETWORK`) and built `ArcConfig` passed to both `with_arc` (TAAL) and `with_gorillapool`. The wallet now sends `X-WaitFor: SEEN_ON_NETWORK` header on every broadcast POST.

### 2. `~/bsv/bsv-wallet-toolbox-rs/src/services/providers/arc.rs` — NOT ACTIVE (local only)

Changed the `post_raw_tx` classification to require `SEEN_ON_NETWORK || STORED || MINED` for success, treating everything else as `service_error` (retry-eligible).

**But**: `~/bsv/bsv-wallet-cli/Cargo.toml` references `bsv-wallet-toolbox-rs` from crates.io, not my local checkout. Confirmed via `Cargo.lock`:

```
name = "bsv-wallet-toolbox-rs"
version = "0.3.36"
source = "registry+https://github.com/rust-lang/crates.io-index"
```

So the local toolbox edit has NO effect. To activate it I'd need `[patch.crates-io]` in `Cargo.toml`. Not yet done — paused to talk with user first.

## User concerns raised

1. **"wait_for should be a header option"** — confirmed and applied in daemon.rs edit.
2. **"fee rate is fine"** — acknowledged, not changing fee.
3. **"what does ~/bsv/wallet-toolbox do?"** — that's the TypeScript reference implementation. We should compare our Rust behavior to TS to see how the reference handles this exact situation.
4. **"how are they handling this? we need to match them"** — next task: compare TS toolbox's `arc.ts` classification logic.
5. **"we only spend from default basket with spendable=1"** — need to verify the wallet is doing this and not something weird.

## Open questions to resolve

- **Q1 (HIGHEST PRIORITY): How does the TS toolbox classify ARC post responses?** Does it check `tx_status` against `SEEN_ON_NETWORK` or does it also accept `ANNOUNCED_TO_NETWORK` as success? If the Rust and TS implementations differ here, we should match TS.
- **Q2: Does TS toolbox set `wait_for` by default?**
- **Q3: What provider order does the TS toolbox use for `post_beef`?** Same as Rust (GorillaPool → TAAL → Bitails → WoC)? Different?
- **Q4: Is TAAL's ARC endpoint really down, or is it just slow for us?** If TAAL recovers, do our stuck txs eventually mine?
- **Q5: Is there a mempool/chain descendant limit issue?** Our batches are 100-tx dependent chains. BSV node defaults can be 25 descendants.
- **Q6: What's the mempool fee rate ceiling right now?** If miners are accepting higher-fee txs and deprioritizing ours, fee might still matter (user says no, but verify).

## Next steps (in order)

1. Open `~/bsv/wallet-toolbox/src/services/providers/arc.ts` and compare classification to Rust arc.rs.
2. Open TS's `services.ts` or equivalent, compare post_beef service ordering + config.
3. Decide: do we match TS (and maybe propagate a fix upstream)?
4. If TS is the same as Rust, then the bug is upstream in both — different root cause. Focus on TAAL / propagation.
5. After we know the classification should match TS, apply changes, rebuild toolbox, rebuild wallet, restart, test with a single tx and wait for `txStatus: MINED` on WoC before declaring victory.

## Files touched

- `~/bsv/bsv-wallet-cli/src/commands/daemon.rs` — added ARC_WAIT_FOR env
- `~/bsv/bsv-wallet-toolbox-rs/src/services/providers/arc.rs` — post_raw_tx classification (NOT active)
- `~/bsv/rust-bsv-worm/tests/multi-worm/test_cycle_v2.js` — full POC harness (synthesis + HTML article)
- `~/bsv/rust-bsv-worm/tests/multi-worm/lab/e11_comment_expand.sh` — content multiplier POC
- `~/bsv/dolphinmilkshake/SHIP-PLAN-B.md` — ship plan doc
- `/tmp/wallet-3324-waitfor.log` — latest wallet daemon log

## Key txids for reference

**On-chain (yesterday's E12)**:
- `b427b1ffcfa9f13239651b5c8b98fdde34e677cd8f5f26fdfa40e440e05ea74c` at block 944703

**Not on chain (this morning's stuck txs)**:
- `eef1458c5734fdf3611fff340c82ab9122247e9d19814873e1d07ad5b4ca171c` (E16 first)
- `fe1c32896aaedd684921ca8a29c2d3f4db15194e51418a3084afc1db7856552e` (E16 last)
- `d377afbac1cdd359ed84e6000a6b470da2219c2ee25310d69c25b841551d7193` (post-restart probe)
- `bebb0828f80e59fd248469f43042361c4af947801017cb2863d2f3bc880ed920` (post-rebuild probe with X-WaitFor header)

All four of the "not on chain" txids are stuck at `ANNOUNCED_TO_NETWORK` per GorillaPool ARC.

---

## Resolution (2026-04-14 ~09:05 local)

**Root cause confirmed**: GorillaPool ARC is silently broken today. It accepts POSTs to `/v1/tx` and responds HTTP 200 with `txStatus: ANNOUNCED_TO_NETWORK`, but **does NOT actually federate the tx to other ARC nodes / miners**. The Rust toolbox (and TS toolbox) classify ANNOUNCED_TO_NETWORK as broadcast-success and stop the `UntilSuccess` provider loop on GorillaPool, never reaching TAAL/Bitails/WoC.

**Wallet 3322 vs 3324**:
- 3322 (old process image since Sat, pre-BUG-004 toolbox) somehow routes around GorillaPool and hits WoC/Bitails directly. Txs land in their mempools.
- 3324 (new process image, 0.3.36 toolbox) hits GorillaPool first, receives fake-success, stops. Txs never reach miners.

**TAAL is the working ARC today**: direct POSTs to `https://arc.taal.com/v1/tx` with `Authorization: mainnet_9596de07e92300c6287e4393594ae39c` return `SEEN_ON_NETWORK` and the tx actually propagates.

**Wallet DB poison state in 3324 at time of resolution**:
- 193 `unmined` proven_tx_reqs (every broadcast since E11 that never reached miners)
- 2,338 outputs locked (spendable=0, 130M sats trapped)
- 62 "spendable=1" outputs, 58 of them chained off unmined parents (poisoned, unusable)
- 4 genuinely-usable outputs from completed parents (1.3M sats)

**Recovery action taken**: extracted all 193 raw tx hex from `transactions.raw_tx` in the SQLite DB and POSTed each directly to TAAL ARC with auth. Results:
- 182 `SEEN_ON_NETWORK` ✓
- 1 `SENT_TO_NETWORK`
- 1 `REQUESTED_BY_NETWORK`
- 1 `ANNOUNCED_TO_NETWORK`
- 8 `DOUBLE_SPEND_ATTEMPTED` (legitimate — these spent already-spent inputs)

**State after recovery**:
- 185 of 193 are now on the BSV network via TAAL
- All 3 test txids also visible on WoC `tx/hash/{txid}` (HTTP 200, blockheight=None = in mempool)
- Wallet DB unchanged because BSV chain is in a slow period (block 944769 stalled for 30+ min)
- `check_for_proofs` is event-driven by `new_header` — only fires when a new block comes. Until then, status stays `unmined`.

**What's still needed**:

1. **Wait for the next BSV block**. When it arrives, `new_header` fires → `check_for_proofs` triggers → wallet syncs 185 txs to `completed` → 2,338 outputs unlock.
2. **Permanent fix to daemon.rs** so future wallets don't hit the GorillaPool trap:
   - Set `arc_gorillapool_url = None` in ServicesOptions (disables GorillaPool entirely)
   - OR switch `postBeefMode` from `UntilSuccess` to `PromiseAll`
   - Add `MAIN_TAAL_API_KEY` env var support so TAAL gets authenticated
   - Revert the earlier `wait_for = SEEN_ON_NETWORK` edit (not standard, non-TS-matching)
3. **Clean up the 8 double-spent unmined rows** in the wallet DB so they don't keep retrying.

**Scripts produced**:
- `/tmp/unmined-193.tsv` — (txid, raw_hex) for all 193 stuck txs
- `/tmp/taal-broadcast-results.log` — (txid, ARC status) for each re-broadcast
- `/tmp/wallet-3324-waitfor.log` — wallet daemon log since 12:30 restart

