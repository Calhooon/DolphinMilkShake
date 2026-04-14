# prompts/cycle-v2/ — the DolphinSense proof-pipeline agent prompts

> **Context**: the existing `prompts/*.md` in the parent directory are the
> **25-agent pyramid** architecture (captain → coordinators → workers → auditors).
> These `cycle-v2/` prompts are the **simpler 3-agent proof-pipeline** stack
> we validated end-to-end in E20d — the one that actually gets shipped for
> the hackathon. Both architectures coexist in this repo; the 25-agent pyramid
> lives as a future-ambition design, the cycle-v2 stack is the production core.

## The cycle-v2 stack (what E20d validated)

```
            ┌─────────────────┐
            │  reddit-cache-  │
            │     feeder      │       one feeder, many lanes
            └────────┬────────┘
                     │
                     ▼
        /tmp/dolphinsense-firehose/<sub>/queue.jsonl
                     │
                     │  (per-sub watermark claim)
                     ▼
  ┌──────────────────────────────────────────────────────┐
  │                   ONE LANE (per sub)                  │
  │                                                        │
  │   Captain (gpt-5-mini, skinny parallel)               │
  │     │                                                  │
  │     ├── overlay_lookup (liveness, not used for routing)│
  │     └── delegate_task (paid handoff, 600K sats)        │
  │              │                                          │
  │              ▼                                          │
  │     Worker (gpt-5-nano, pre-baked identity)             │
  │       │                                                  │
  │       └── execute_bash → proof_batch.sh → 100 OP_RETURNs│
  │              │                                            │
  │              ▼                                            │
  │     Synthesis (every 25th cycle, gpt-5-mini)              │
  │       ├── file_read records-annotated.jsonl              │
  │       ├── upload_to_nanostore (txid manifest via file_path)│
  │       └── upload_to_nanostore (HTML article)              │
  └──────────────────────────────────────────────────────┘
```

**Per cycle on average** (1-in-25 synthesis amortization):
- ~103K sats total (captain 91K + worker 14K + amortized synthesis)
- ~142-300s wall (worker-only 142s, synth cycle 299s)
- 100 on-chain data-plane proofs + ~12 control-plane proofs + ~30 x402 payments

## Files in this directory

| file | role | extracted from |
|---|---|---|
| `captain-parallel.md` | **PRODUCTION** captain prompt — overlay_lookup + delegate_task as parallel tool_calls, pre-baked worker identity | `rust-bsv-worm@f47c0c3:tests/multi-worm/test_cycle_v2.js` `buildSkinnyCaptainTask()` |
| `captain-liveness.md` | alternate captain mode — liveness-only overlay_lookup, harness submits worker directly. Lower cost (70K sats) but drops delegate_task audit trail. Not shipped for hackathon narrative reasons. | `buildLivenessCaptainTask()` |
| `worker-proof.md`     | worker proof-batch prompt — execute_bash to run proof_batch.sh + report manifest | `buildWorkerTask()` |
| `synthesis-html.md`   | synthesis prompt — file_read → upload txid manifest → compose + upload HTML article with inline txid citations | `buildSynthesisTask()` |

## Source-of-truth policy

**This directory is the canonical versioned source for these prompts.**

However — at the time of the E20d run, the harness
(`rust-bsv-worm@f47c0c3:tests/multi-worm/test_cycle_v2.js`) embeds these
prompts as inline string-builder functions, NOT as file reads. The files in
this directory were extracted verbatim from those functions for
version-control and future UI rendering ("what prompt is the captain running
right now?").

**Until the fleet launcher is written** (dolphinmilkshake Day 2 task), the
rust-bsv-worm test harness continues to use its inline versions. If you edit
a prompt here, you need to hand-patch it into the harness too, OR skip the
harness for your test and use the dolphinmilkshake fleet launcher when it
lands.

**Once the fleet launcher lands**, it will read these `.md` files directly
from disk at launch time, and this directory becomes the single source of
truth. Edit-once-run-everywhere.

## The runtime templating convention

These prompts contain `{{placeholder}}` tokens (see the files). The fleet
launcher (Day 2 task) will substitute:

| token | value provided by |
|---|---|
| `{{run_nonce}}` | harness at cycle start (cycle ID) |
| `{{worker_identity_key}}` | cluster handle at startup (stable across cycles) |
| `{{worker_capabilities}}` | launch config |
| `{{abs_script_path}}` | harness (proof_batch.sh location in cycle workspace) |
| `{{abs_records_path}}` | harness (records.jsonl location) |
| `{{worker_wallet_url}}` | launch config (http://localhost:<wallet_port>) |
| `{{abs_annotated_path}}` | harness (records-annotated.jsonl location) |
| `{{abs_txids_path}}` | harness (records.jsonl.txids location) |
| `{{proofs_created}}` | harness (from worker proof_report) |
| `{{manifest_sha}}` | harness (from worker proof_report) |
| `{{worker_task_text}}` | pre-rendered `worker-proof.md` (captain embeds worker prompt opaquely) |

Templating is naive string replace (no Handlebars, no Mustache). Keep
substitutions simple.

## Related

- [../../NEXT.md](../../NEXT.md) — post-E20d roadmap
- [../../PLAN-C-SCALE.md](../../PLAN-C-SCALE.md) — full architecture
- [../../experiments/E20d-checkpoint.md](../../experiments/E20d-checkpoint.md) — the run that validated these prompts
