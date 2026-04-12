# POC #15 + #342: Working Memory E2E Results

**Date**: 2026-04-12
**Branch**: feat/working-memory (rust-bsv-worm)
**Binary**: ~/bsv/rust-bsv-worm-working-memory/target/release/dolphin-milk
**Wallet**: Fresh daemon-mode wallet on 3340, pre-split 20 UTXOs

## The Problem

Without working memory, microcompact clears memory_search results between iterations. Captain searches 6 times, but by the time it writes the report, searches 1-3 are gone ("Content cleared").

## The Fix

1. **Tier 1**: Removed memory_search from COMPACTABLE_TOOLS
2. **Tier 4**: Working Memory — 4 tools (set, clear, list, clear_all), 32KB cap, auto-injected into system prompt

## Test: Captain Report Assembly Pattern

Agent searches memory 4 times, extracts key findings to working memory, then assembles a daily report using ONLY working memory.

### Haiku Results

| Step | Tool | Raw data | Extracted to WM | Compression |
|------|------|----------|-----------------|-------------|
| 1 | memory_search("hour results signals") | 25 results, 9.7 KB | hourly_summary: 945 bytes | 10x |
| 2 | memory_search("report batch url") | 12 results, 6.5 KB | report_urls: 407 bytes | 16x |
| 3 | memory_search("quality pass rate") | 9 results, 3.7 KB | quality_summary: 474 bytes | 8x |
| 4 | memory_search("signal strong") | 21 results, 7.9 KB | top_signals: 460 bytes | 17x |
| 5 | working_memory_list | 4 keys, 2,286 bytes / 32,768 cap | | |
| 6-10 | Report assembly from working memory only | | | |

- **Status**: COMPLETE, 10 iterations, 2,029,235 sats
- **Report**: Full daily intelligence report with tables, signal analysis, quality metrics
- **All 4 WM keys**: Used successfully in final report
- **Wallet errors**: NONE (daemon mode + pre-split UTXOs)

### GPT-5-mini Results

Same test, same memories, different model.

- **Status**: COMPLETE, 10 iterations, 387,307 sats
- **Report**: Clean, data-focused, actionable intelligence summary
- **All 4 WM keys**: Used successfully
- **Wallet errors**: NONE
- **5.2x cheaper than Haiku** for equivalent results

## Model Comparison

| Metric | Haiku | GPT-5-mini |
|--------|-------|------------|
| Cost | 2.03M sats ($0.34) | 387K sats ($0.065) |
| Iterations | 10 | 10 |
| Pattern followed | Yes | Yes |
| Report quality | Polished, tables, structured | Clean, concise, actionable |
| WM keys used | All 4 | All 4 |
| Wallet stability | No errors | No errors |

## Wallet Findings (Final)

| Setup | Result |
|-------|--------|
| `bsv-wallet serve` (no monitor) | FAIL — unproven tx chains → double-spend errors after ~30 txs |
| `bsv-wallet daemon` (with monitor) on corrupted DB | FAIL — existing chain too deep to recover |
| `bsv-wallet daemon` from birth + `split --count 20` | **PASS** — zero wallet errors across 20 iterations |

**Mandatory for DolphinSense**: All 25 wallets must start in `daemon` mode from first transaction, with `split --count 20` after initial funding.

## Verdict

**PASS** — Working memory solves the context compaction problem completely. Both Haiku and GPT-5-mini follow the search-extract-report pattern reliably. GPT-5-mini is 5x cheaper and equally effective for worker agents.
