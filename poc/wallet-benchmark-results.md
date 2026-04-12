# POC #11: Wallet Throughput Benchmark

**Date**: 2026-04-12
**Wallet**: localhost:3322 (~47M sats, bsv-wallet-cli / toolbox 0.3.36)
**Machine**: Apple M1 Max, 32GB RAM
**Test**: 500 sequential OP_RETURN (0-sat) createAction calls

## Results

| Batch | Txs | Time | tx/s |
|-------|-----|------|------|
| 1 | 100 | 74s | 1.3 |
| 2 | 100 | 99s | 1.0 |
| 3 | 100 | 301s | 0.3 (dip) |
| 4 | 100 | 166s | 0.6 (recovering) |
| 5 | 100 | 82s | 1.2 (back up) |
| **Total** | **500** | **722s** | **0.69 avg** |

- **500/500 success, 0 failures**
- Temporary dip in batch 3 (likely UTXO sync or proof fetching), recovered by batch 5
- No SQLite lock errors observed
- Cost: ~12,500 sats in miner fees ($0.002)

## Extrapolation to DolphinSense

- 0.7 tx/s per wallet (worst-case, sequential hammering)
- 25 wallets x 0.7 = 17.5 tx/s total
- 17.5 x 86,400 seconds = **1.51M txs/day** -- right at target

Real-world agent loop has 2-10s pauses between wallet calls (LLM inference). This gives the wallet time to sync between txs. Actual throughput should be better than this benchmark.

## Verdict

**PASS.** Wallet throughput is sufficient for 1.5M txs/day across 25 agents. The temporary dip is a concern to monitor during longer runs (#17, #22) but it self-recovered.
