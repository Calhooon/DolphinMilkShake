# WALLETS — operational recipe for the DolphinSense fleet

> Validated: 2026-04-14 during the E20d funding detour.
> Applies to `bsv-wallet-cli` at path
> `/Users/johncalhoun/bsv/bsv-wallet-cli/target/release/bsv-wallet`.
> Safe against running daemons: SQLite WAL mode + --db + ROOT_KEY env
> sourcing lets the CLI coexist with the daemon without rekeying or
> forcing a restart.

---

## Golden rules (learned the hard way)

1. **NEVER** `rm`, reset, or rekey a wallet that has funds on-chain. Lost
   ROOT_KEY = lost funds.
2. **NEVER** `SIGTERM` a daemon without first dumping its env — the env file
   is the canonical source of ROOT_KEY and the DB path. Losing them while
   the daemon dies means the funds on-chain are unspendable from CLI until
   the key is recovered.
3. The CLI **CAN** run alongside a running daemon — SQLite WAL handles
   concurrent reads + serialized writes. Always pass `--db <path>` AND
   `export $(cat <wallet>.env)` to source ROOT_KEY.
4. Always use `--json` on CLI subcommands — easier to parse, scriptable.
5. Broadcast goes through the daemon's configured chain. Don't assume your
   CLI-issued send will go through a different provider.

---

## The validated 3-wallet topology (POC / pre-production)

| Port | Role | DB path | Env file | Identity key (pub prefix) |
|---|---|---|---|---|
| 3321 | MetaNet parent | (MetaNet Desktop GUI) | n/a | `03ef3231669022cc...` |
| 3322 | Captain | `~/bsv/_archived/bsv-wallet-cli-old/wallet.db` | `~/bsv/_archived/bsv-wallet-cli-old/.env` | `034aa44668fbc73c...` |
| 3323 | Synthesis | `~/bsv/wallets/synthesis-3323.db` | `~/bsv/wallets/synthesis-3323.env` | `0388ccdf0d1bfdf5...` |
| 3324 | Worker | `~/bsv/wallets/worker-3324.db` | `~/bsv/wallets/worker-3324.env` | `026468a60d00ec36...` |

**Current balances** (post-E20d top-up):
- 3322: ~381.65M sats (master funding pool)
- 3323: ~15.26M sats (10-output split, 1.526M/output)
- 3324: ~21.24M sats (20-output split on a small UTXO subset)

---

## The fund → internalize → split recipe (manual)

This is what `scripts/fund-wallet.sh` automates. Done manually it looks like:

### Step 1 — Get the recipient's receive address (BRC-29 P2PKH)

```bash
BIN=/Users/johncalhoun/bsv/bsv-wallet-cli/target/release/bsv-wallet

( export $(cat ~/bsv/wallets/synthesis-3323.env) \
  && $BIN --db ~/bsv/wallets/synthesis-3323.db address --json )
# {"address":"12ai7SsYGyuP7yGJA14diW7AfZmWCDhiCB"}
```

Key points:
- Must pass `--db <path>` — `--port` alone does NOT work; the CLI is
  database-first and tries to open `wallet.db` in CWD if you omit `--db`.
- Must `export $(cat <wallet>.env)` — the CLI requires `ROOT_KEY` to be
  in the environment, even for a read-only query.
- Works while the daemon is running the same DB file.

### Step 2 — Send from the source wallet, capture the BEEF

```bash
( export $(cat ~/bsv/_archived/bsv-wallet-cli-old/.env) \
  && $BIN --db ~/bsv/_archived/bsv-wallet-cli-old/wallet.db \
     send 12ai7SsYGyuP7yGJA14diW7AfZmWCDhiCB 15000000 --json )
# {"beef":"0101010...long hex...","txid":"bf2639b8ff8a78253a5fd7ed5c008298f9abff71abe7510cf76e76adac7eba8c"}
```

The `--json` output gives you:
- `txid` — the broadcast txid (goes on-chain immediately)
- `beef` — the BEEF blob needed to internalize on the receiver

The send command automatically handles: UTXO selection, change output,
signing, AtomicBEEF wrapping, broadcast, and database update on the
sender. Wait for `"Transaction broadcast successfully"` in the daemon logs
(which appear when the daemon is mid-broadcast — visible in the CLI output
because it's going through the same bsv-wallet-toolbox-rs code path).

### Step 3 — Internalize on the recipient

```bash
BEEF="<paste the beef hex from step 2>"
( export $(cat ~/bsv/wallets/synthesis-3323.env) \
  && $BIN --db ~/bsv/wallets/synthesis-3323.db \
     fund "$BEEF" --vout 0 --json )
# {"accepted":true}
```

The `--vout 0` tells the wallet which output in the BEEF to claim as its
own. The `send` command always places the payment at `vout 0` and the
change at `vout 1`, so `--vout 0` is correct in every case.

Verify:

```bash
( export $(cat ~/bsv/wallets/synthesis-3323.env) \
  && $BIN --db ~/bsv/wallets/synthesis-3323.db balance --json )
# {"satoshis":15261398}
```

### Step 4 — Split the fresh UTXO into parallel-friendly outputs

```bash
( export $(cat ~/bsv/wallets/synthesis-3323.env) \
  && $BIN --db ~/bsv/wallets/synthesis-3323.db split --count 10 --json )
# {"outputs":10,"satoshisPerOutput":1526119,"txid":"1cbc7702..."}
```

`split` picks a UTXO from the wallet's spendable pool and creates N equal
outputs (minus fees). Subsequent `createAction` calls can draw on any of
the N outputs in parallel without contention.

---

## How many UTXOs does each wallet role need?

The UTXO count matters because BSV's UTXO model serializes createAction
calls that share an input. More independent UTXOs = more parallel createAction
throughput ceiling.

| Role | Target UTXO count | Why | UTXO size |
|---|---:|---|---:|
| **Worker** (proof_batch) | **~100** | Max concurrent createAction during proof_batch. At P=8 contention was observed on old wallets; 100 UTXOs gives 12× safety margin for future P bumps. | ~300K-500K sats each (covers ~500-1000 sats/tx fees × 300-500 txs per UTXO before re-split) |
| **Captain** (skinny) | **~20** | Captain fires 2-4 on-chain proofs per cycle (decision + task_completion + custody + state). Sequential. 20 UTXOs is overkill headroom. | ~500K sats each |
| **Synthesis** | **~20** | Single-threaded LLM calls. Each x402 inference = 1 createAction. 20 UTXOs covers ~20 synthesis cycles before re-split. | ~1.5M sats each (x402 x payments spike to 300K+ per call) |

**At 25 lanes production**:
- 25 worker wallets × 100 UTXOs = 2,500 total worker UTXOs
- 25 captain wallets × 20 UTXOs = 500 total captain UTXOs
- 1-2 synthesis wallets × 20 UTXOs = 20-40 total synthesis UTXOs
- **Grand total: ~3,000 UTXOs to provision**

Each fund-and-split operation creates roughly 100 UTXOs in one tx (big UTXO
+ split-100). Provisioning 25 worker wallets = 25 send-and-split operations
= ~25 BSV transactions from the master wallet. Time budget: ~30 minutes for
the full fleet bootstrap when `scripts/fund-wallet.sh` is working.

---

## Daily sats consumption per lane (for sizing the initial fund)

From E20d measured numbers:

| Role | Sats/cycle | Cycles/day/lane | Daily sats/lane |
|---|---:|---:|---:|
| Worker createAction fees | ~14K (100 proofs × ~140 sats fee each) | 608 | ~8.5M/day |
| Captain x402 LLM | 91K | 608 | ~55M/day |
| Synthesis x402 LLM (1-in-25 cycles) | 284K | 24 | ~7M/day |

**Per-lane daily spend**: ~70M sats ≈ $7/day at $100k sats/USD.
**Full 25-lane fleet daily spend**: ~1.75B sats ≈ $175/day.

**Initial fund per wallet** (for a 24h run with safety margin):
- Worker wallets: **50M sats each** (6× daily fee spend, plenty of margin
  for fee spikes + broadcast retries)
- Captain wallets: **150M sats each** (2.5× daily x402 spend)
- Synthesis wallet(s): **50M sats each** (2× daily x402 spend)

**Total initial fund for 25-lane fleet**: 25 × (50 + 150) + 2 × 50 = ~5B
sats ≈ $500 worth of BSV pre-staged. The master wallet 3322 currently
has ~381M sats, which is not enough — will need additional funding from
MetaNet Desktop (3321) before Day 1 provisioning.

---

## Danger zone

### "My daemon won't start — 'no such table: settings'"

You're opening an empty database file. This happens when `--db` isn't set
and the CLI creates a blank `wallet.db` in CWD. Always pass `--db <full-path>`.

### "ROOT_KEY not set"

You forgot to source the env file. Run:
```bash
export $(cat ~/bsv/wallets/<wallet>.env)
```
Then retry the CLI command in the same shell. Or use a subshell wrapper:
```bash
( export $(cat <envfile>) && bsv-wallet --db <dbpath> <cmd> )
```

### "I SIGTERMed a daemon and now I can't find its env"

This is the incident that created the orphan wallet in `secrets.md`. The
env file gets lost when you don't save it before killing the process.
**Never kill a daemon without first recording its env.**

Recovery: if the wallet DB is intact but ROOT_KEY is lost, funds are
on-chain but CLI cannot spend them. Save the DB aside as
`wallet.db.ORPHAN-no-rootkey-<timestamp>` and move on. The MetaNet Desktop
wallet at 3321 (parent) is the fallback funding source.

### "The balance is wrong after a split"

Split operations **include fees** taken from the input UTXO. So splitting
a 15,261,398-sat UTXO into 10 outputs gives outputs of 1,526,119 sats
(not 1,526,139.8). The "missing" ~80 sats are transaction fees. This is
expected.

### "`send` says 'insufficient funds' but balance shows plenty"

You probably have one giant UTXO that's already pending broadcast or
reserved by another concurrent action. Check `outputs` to see the raw
UTXO set:
```bash
( export $(cat <envfile>) && bsv-wallet --db <dbpath> outputs --json )
```

### "The daemon isn't picking up a new incoming payment"

The daemon's monitor only finds outputs owned by its own BRC-29 key space.
For inter-wallet transfers, you MUST call `fund <BEEF> --vout N` on the
receiver explicitly — the receiver does not auto-discover payments unless
they originate from a BRC-29 invoice it issued.

---

## Handy one-liner: balance check across the whole fleet

```bash
BIN=/Users/johncalhoun/bsv/bsv-wallet-cli/target/release/bsv-wallet
for w in "captain|/Users/johncalhoun/bsv/_archived/bsv-wallet-cli-old/.env|/Users/johncalhoun/bsv/_archived/bsv-wallet-cli-old/wallet.db" \
         "synthesis|/Users/johncalhoun/bsv/wallets/synthesis-3323.env|/Users/johncalhoun/bsv/wallets/synthesis-3323.db" \
         "worker|/Users/johncalhoun/bsv/wallets/worker-3324.env|/Users/johncalhoun/bsv/wallets/worker-3324.db"; do
  IFS='|' read name env db <<< "$w"
  BAL=$( ( export $(cat $env) && $BIN --db $db balance --json 2>/dev/null ) )
  echo "$name: $BAL"
done
```

Same pattern scales trivially to 25+ wallets — see
`scripts/preflight-wallets.sh` for the production version with alerting.

---

## Related docs

- [NEXT.md](NEXT.md) — post-E20d roadmap + what to do next
- [PLAN-C-SCALE.md](PLAN-C-SCALE.md) — god-tier architecture + scale math
- `scripts/fund-wallet.sh` — automated version of the recipe above
- `scripts/preflight-wallets.sh` — read-only fleet health check
- `rust-bsv-worm/secrets.md` (gitignored) — canonical wallet inventory
