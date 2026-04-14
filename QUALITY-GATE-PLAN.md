# Quality Gate Plan — #23 POC and Reusable Test Infrastructure

> Living doc. Created 2026-04-13 evening, updated as we build. This is the architectural spec for the #23 proof-batch quality gate AND the reusable multi-agent test infrastructure (cluster manager, chain inspector, proof verifier) it sits on top of. Everything in `~/bsv/rust-bsv-worm/tests/multi-worm/lib/` eventually traces back to decisions recorded here. If you're picking this up cold, read HANDOFF-2026-04-13.md first, then this.

---

## TL;DR

We need a hard quality gate for DolphinMilkShake issue #23 before investing in #18 (provisioning), #20 (launcher), and the rest of the 5-day push to Friday submission. The existing `tests/multi-worm/test_proof_batch_cost.js` is a cost-measurement scaffold with a weak pass criterion — it can't serve as a quality gate in its current form. Rather than patching it narrowly (throwaway work that gets re-done for #20 and #22 anyway), we're building three reusable modules that become the foundation for every multi-agent test from now through the 24-hour hackathon run and beyond:

1. **`lib/cluster.js`** — declarative multi-agent cluster manager (startup, cert issuance with per-role capabilities, overlay registration verification, idempotent reuse). Same module powers #23, #20's 25-agent launcher, the 5-agent smoke test, the 4-hour dry run, and the 24-hour production run.
2. **`lib/inspector.js`** — chain-aware transcript inspector with a three-layer verdict architecture. Hard outcome checks decide pass/fail; structural invariants confirm architecture; rich chain DSL is diagnostic only. Designed to be trustworthy (low false-negative rate) and reusable for every scenario going forward.
3. **`lib/proof_verify.js`** — bijective proof verifier. Independently re-computes expected SHA-256 hashes, extracts on-chain hashes from wallet DB, asserts a 1:1 mapping. This is the same verifier that will audit the Friday video's daily-report provenance claims.

The Friday success metric is pinned to **Option A: 1.5M txs in a 24-hour run.** See HANDOFF-2026-04-13.md and `~/.claude/projects/-Users-johncalhoun-bsv-rust-bsv-worm/memory/project_dolphinsense_friday_metric.md` for rationale. Option A makes the reuse story load-bearing: every module built for #23 directly supports the 24-hour run's audit chain and the Mission Control UI.

---

## Why this doc exists

The user pushed back on test_proof_batch_cost.js with two critical observations:

1. **"After #23 we need to pause... we need deep transcription inspection quality gate there... like we actually have to pass etc."** The existing test's pass criterion (`web_fetch > 0 && (proofs > 0 || execute_bash > 0)`) is not a gate — a worker that fetched anything and ran any bash command would pass, with zero proofs verified on-chain. We need a gate that fails hard when the cascade didn't actually produce bijectively-verified on-chain provenance.

2. **"We MUST use the overlay."** The existing cascade test shortcuts overlay discovery by resolving Worker's identity_key up front. For #23 we need Captain to actually call `overlay_lookup(findByCapability: "scraping")` and receive Worker in the result set — proving the production discovery path works end-to-end. This requires Worker to be registered on the overlay with the "scraping" capability, which requires its BRC-52 cert to declare that capability, which requires per-role cert issuance at cluster startup.

And the follow-up concerns that shaped the architecture:

3. **"Is it reusable for the UI, etc?"** Yes, and that reuse story is how we justify building the three-module stack instead of patching the test narrowly. Mission Control (#21) becomes a thin rendering layer on top of JSON outputs the cluster/inspector/verifier already produce. #20's 25-agent launcher is the same `startCluster` call with a bigger array. The 24-hour run's daily-report audit is the same `proof_verify` bijection at scale.

4. **"The inspectChain thing is hard to get perfect, won't it false-negative?"** Yes, this is a real risk, and it's why the inspector uses a three-layer verdict architecture: outcome checks (binary economic ground truth) decide pass/fail, structural invariants confirm architectural claims, and the rich chain DSL is diagnostic-only. An inspector chain false-negative cannot fail the verdict if outcomes are green.

This doc is the full spec we agreed on at the end of that conversation. The build order, the rationale, and the trade-offs are all captured so future sessions don't have to re-derive them.

---

## Current state (as of 2026-04-13 evening)

### Green

- **rust-bsv-worm@main** at commit `09b7eb8`. 3-layer bidirectional cascade passes 7/7 in `test_three_layer_cascade.js`. Measured run 2026-04-13: 237.6s wall clock, 2.04M sats, 112 txs, all 4 commission payments internalized successfully.
- **Three product-level dolphin-milk bugs shipped** in commit `2fb5c17`: tool result offload structural preview (god-tier), delegation allowlist preserving read_tool_output + file_read, commission payment direct-BEEF internalize (bypasses WoC indexing lag).
- **Wallets funded and live**: Captain (:3322, ~470M sats), Coordinator (:3323, ~13M sats), Worker (:3324, ~6M sats). Parent (:3321) is MetaNet Client, managed externally.
- **Overlay** at `https://rust-overlay.dev-a3e.workers.dev` is deployed and known-working for agent discovery via SHIP/SLAP.

### Red

- **`test_proof_batch_cost.js`** has multiple real problems (see "Why this doc exists" and the audit below). Cannot be used as a quality gate in its current form.
- **Worker's cert capabilities don't declare "scraping"**. Current cascade spawns all agents with a generic cert, so `overlay_lookup(findByCapability: "scraping")` from Captain won't return Worker.
- **No shared cluster manager exists**. `test_three_layer_cascade.js` has ~150 lines of ad-hoc spawn logic embedded directly in the test file. Any other test that wants a cluster has to duplicate that code.
- **No shared chain inspector**. Each test writes its own ad-hoc transcript walking code.
- **No shared proof verifier**. No bijective check exists anywhere in the codebase.

### The ask

Build the three modules, use them to rebuild `test_proof_batch_cost.js` as a real quality gate, run it once, inspect deeply, and declare pass/fail. Then pause and reassess before moving to #18/#20/#22.

### Success metric pinned

**Option A: 1.5M txs in a 24-hour run on Thursday, submitted Friday.** User explicitly chose this on 2026-04-13 after being offered the safer "architecture demonstration" framing. See the project memory `project_dolphinsense_friday_metric.md` for the rationale, path constraints, and escalation trigger if concurrent cascades don't work by Wednesday EOD.

---

## Audit of `test_proof_batch_cost.js` — problems to fix

Before writing new code, here's the full list of concrete issues in the existing test, captured so we don't regress on any of them. Ranked by severity.

### Blockers (test cannot serve as a quality gate until these are fixed)

1. **`--standalone` flag is documented but not implemented**. Lines 37 and 179 reference it as a way to start agents when they're not already running, but there's no actual branch in the code. The test errors out immediately if agents aren't on 8081/8083. Replaced by: cluster.js starts Captain + Worker with proper config.

2. **The built-in pass criterion is `workerWebFetchCalls > 0 && (batchProofsCreated > 0 || workerExecuteBashCalls > 0)`**. That's "did the worker fetch anything, AND did it either create a proof or just make any bash call." A worker that `execute_bash`'d `echo hi` with zero real proofs would pass. Replaced by: three-layer verdict with hard outcome checks in Layer 1.

3. **Proof uniqueness is "(check wallet DB manually)"**. The test prints a log line telling the operator to go check distinctness by hand. For a quality gate, uniqueness must be machine-verified. Replaced by: proof_verify.js bijection assertion.

4. **`RUN_NONCE` propagation is baked into the task text but never asserted**. The task asks Captain to include a random nonce in its final report so we can verify it processed the reply from Worker (vs hallucinating a response). The test doesn't check that Captain's final result actually contains the nonce. Replaced by: Layer 1 outcome check on Captain's final task result.

5. **Test calls `overlay_lookup(findByCapability: "scraping")` but cascade Worker isn't registered with that capability**. The cascade test issues a generic BRC-52 cert to all 3 agents. Worker's capabilities don't include "scraping", so overlay won't return it, so Captain either fails or hallucinates. Replaced by: cluster.js issues per-role certs with capabilities matching the role, and verifies overlay registration with the expected capability before allowing the test to proceed.

### Silent-failure plumbing (must fix to get trustworthy measurements)

6. **Hardcoded wallet DB paths**. Captain DB at `/Users/johncalhoun/bsv/_archived/bsv-wallet-cli-old/wallet.db`, Worker DB at `~/bsv/wallets/worker-3324.db`. If either path is wrong, `countWalletTxs` returns `null`, deltas become 0, and the extrapolation math still prints "HITS TARGET." Replaced by: proof_verify.js queries the wallet HTTP API (`/listActions`, `/wallet/status`) instead of SQLite, so paths don't matter. Falls back to sqlite only with explicit opt-in.

7. **Proof counting uses `description LIKE '%provenance%' OR description LIKE '%proof%'`**. If the shell script's description string changes or the wallet normalizes text, the count drops to zero silently. Replaced by: proof_verify.js extracts OP_RETURN outputs directly from tx data and doesn't depend on wallet description metadata.

8. **No cross-check between reported txids and actual on-chain state**. Worker's shell script returns an array of txids, but the test never verifies those txids actually exist in Worker's wallet. A bug in the script could return placeholder strings and nothing would catch it. Replaced by: proof_verify.js verifies each reported txid exists AND has the expected OP_RETURN payload.

### Architectural mismatch (won't actually run as written)

9. **Task uses direct Captain → Worker 2-hop pattern**, but the cascade test is architected for 3-hop (Captain → Coordinator → Worker). Direct delegation should work under narrowing rules (single-hop is fine), but this hasn't been validated. If it doesn't, the 3-layer inspector will tell us exactly which link failed. Tolerance added to Layer 2 invariants: structural check is "at least one delegation hop from Captain's domain reached Worker" — doesn't care whether it went through Coordinator.

10. **`execute_bash` must be in Worker's cert allowlist AND in the delegated capability set**. Currently neither is guaranteed. Replaced by: cluster.js's per-role cert issuance step grants Worker `execute_bash`; the prompt's delegate_task args explicitly include it; Layer 2 invariant verifies the delegate_task call carried the expected capability list; Layer 1 outcome check verifies the Worker actually executed the script successfully.

Every fix above maps to a specific feature in one of the three new modules. Nothing is patched in place.

---

## Module 1 — `lib/cluster.js`

### Purpose

The single source of truth for how multi-agent clusters come up. Used by every multi-agent test from #23 forward, including #20's 25-agent launcher, the 5-agent smoke test, and the 24-hour production run.

### Design requirements

- **Declarative**: the caller describes the cluster as a config array; the module does everything else.
- **Idempotent**: probes each agent's health endpoint first; reuses already-running agents when they're compatible; only spawns missing ones. Re-running tests doesn't create duplicate processes.
- **Verified**: every startup step is a hard gate. Spawning a process isn't enough — we verify identity, cert capabilities, and overlay registration before declaring the agent ready.
- **Composable**: `stopCluster(handle, { onlySpawned: true })` kills only processes this invocation started, leaving pre-existing ones alone. Safe to use inside other test harnesses.
- **Zero hardcoded paths**: all wallet DBs, workspaces, parent keys are resolved from the config or from live HTTP calls, never from literal strings in the code.
- **Single-file output artifact**: writes a `cluster-state.json` in the test output dir with every agent's identity key, workspace, port, capabilities, cert hash, and overlay registration status. Mission Control UI reads this file directly (zero extra plumbing needed for #21).

### Declarative config shape

```js
const handle = await startCluster({
  parentWalletPort: 3321,
  binary: './target/release/dolphin-milk',
  overlay: {
    url: 'https://rust-overlay.dev-a3e.workers.dev',
    verifyRegistration: true,
    registrationTimeoutMs: 30000,
  },
  outputDir: './test-workspaces/poc-23',
  agents: [
    {
      name: 'captain',
      port: 8081,
      walletPort: 3322,
      model: 'claude-haiku-4-5',
      workspace: './test-workspaces/cascade-captain',
      capabilities: ['orchestration', 'intelligence', 'reporting'],
      env: {}, // optional overrides
    },
    {
      name: 'worker',
      port: 8083,
      walletPort: 3324,
      model: 'claude-haiku-4-5',
      workspace: './test-workspaces/cascade-worker',
      capabilities: ['scraping', 'web_fetch', 'execute_bash', 'delegate_task'],
      env: {},
    },
  ],
});

// handle.captain.identityKey, handle.captain.proc, handle.captain.certHash, ...
// handle.stateFile === './test-workspaces/poc-23/cluster-state.json'
```

### Startup sequence (each step is a hard gate)

1. **Binary check**: `fs.existsSync(config.binary)` — hard fail with a clear error if missing. Tell the user to `cargo build --release`.
2. **Parent wallet probe**: `GET /agent` against `parentWalletPort` via BRC-31. Resolve parent identity key. Hard fail if parent wallet isn't reachable.
3. **Per-agent health probe**: for each agent, `GET /health` on its port. If reachable with `wallet_connected: true`, proceed to step 4 (reuse path). If not, spawn fresh via `spawn(binary, ['serve', '--port', ..., '--workspace', ...], { env: {...} })` and loop until healthy or timeout.
4. **Identity verification**: `GET /agent` on each agent via BRC-31 (same pattern as the cascade test). Independently query `getPublicKey` against the agent's wallet. Assert the two identity keys match. Catches "spawned with wrong wallet" misconfiguration silently — a class of bug that otherwise produces cryptic downstream errors.
5. **Cert audit + per-role issuance**: `GET /certificates` on each agent. Parse out existing certs signed by the parent. If none, OR if `capabilities` doesn't match the declared role capabilities, call `POST /certificates/issue` against the parent with `{ subject_pubkey, capabilities, expires_at }` to issue a fresh cert with the declared capabilities. Re-verify after issuance.
6. **Overlay registration verification**: this is the most sensitive step. After cert issuance, either (a) trigger re-registration explicitly if the server exposes such an endpoint, or (b) wait for the next heartbeat tick (~15s). Then, for each declared capability, query `GET {overlay}/lookup?service=ls_agent&findByCapability=<capability>` and assert the agent's identity key is in the result set. Retry with backoff up to `registrationTimeoutMs`. Hard fail with a clear error if registration is missing — this is exactly the failure mode that causes `overlay_lookup` to silently return an empty set during the actual test.
7. **State file emit**: write `cluster-state.json` with the full resolved state: agent identity keys, ports, workspaces, cert hashes, overlay registration timestamps, parent key. This file is the input to the inspector, the proof verifier, and the UI.
8. **Return structured handle**: `{ agents: Map<name, agentHandle>, stateFile, stopCluster() }`.

### Teardown

`stopCluster(handle, options)` with:
- `onlySpawned: true` (default) — only stops processes this `startCluster` call spawned. Pre-existing agents stay running. Safe to compose.
- `onlySpawned: false` — force-stops every agent in the config regardless of who spawned it. Used in CI or when cleaning up after a crashed test.
- Graceful SIGTERM with 5s timeout, then SIGKILL. Same pattern as the cascade test.

### Cert issuance — implementation details

Need to verify the existing `POST /certificates/issue` endpoint accepts a custom `capabilities` field in the request body. If it does, perfect. If it only issues with default capabilities, we need a small patch to the handler to accept and honor a per-call override. Will check `src/server/certificates.rs` (or equivalent) during implementation and either use the existing API or submit a patch to rust-bsv-worm as part of this work.

**Open question**: where do capability strings come from in the current code path? If capabilities are derived from the worm's static CAPABILITY_DECLARATION proof at boot, we might need a separate mechanism (e.g., an env var `DOLPHIN_MILK_DECLARED_CAPABILITIES`) for each agent to override its declaration at boot time. Investigate during the first implementation pass.

### Reuse map for cluster.js

- **`test_three_layer_cascade.js`** — first consumer after #23. Refactor to use cluster.js for startup; the test shrinks by ~150 lines and still passes 7/7 (this is how we validate the abstraction).
- **`test_proof_batch_cost.js`** — second consumer. Replaces the non-existent `--standalone` mode.
- **5-agent smoke test** (gate for #20) — same module, 5 entries.
- **#20 launcher script** — same module, 25 entries. Plus a thin wrapper that sets up long-running processes and handles signal forwarding.
- **#22 4-hour dry run** — same module, runs alongside a concurrent-cascade driver.
- **Thursday 24-hour run** — same module, plus monitoring.
- **Any future multi-agent test** — always uses cluster.js. No ad-hoc spawn code in test files, ever again.

---

## Module 2 — `lib/inspector.js`

### Purpose

Read `session.jsonl` transcripts from running or completed agents, correlate events across agents, verify expected behavior chains, and emit structured verdicts. Used as the quality gate for #23 and as the narrative layer for the Mission Control UI and the Friday demo video.

### Three-layer verdict architecture (the critical design)

The single most important design decision in this module: **the inspector is never the sole source of truth for pass/fail**. Pass/fail is decided by outcome ground truth, and the rich chain matching is strictly diagnostic.

This is how we avoid false-negative hell. Expected-chain DSLs are notoriously brittle — if we gate pass/fail on them, a small prompt drift or tool-result format change turns every real pass into an "inspector fail," and the gate loses all credibility. Layering prevents that.

#### Layer 1 — Hard outcome checks (these decide pass/fail)

Each check is a binary, economically-meaningful ground truth assertion. No fuzzy matching, no LLM-behavior speculation. If all Layer 1 checks pass, the cascade did its job economically. Full stop.

For #23, Layer 1 checks are:

- **`proof_bijection`**: proof_verify.js's bijective assertion (Reddit records ↔ on-chain OP_RETURN SHA-256 hashes). Binary pass/fail.
- **`wallet_tx_delta`**: Worker's wallet gained N transactions in the test window, and N matches the txid count reported in the worker's execute_bash result. Binary.
- **`captain_task_complete`**: Captain's final task record has `status: complete`, `error: null`, and its `result` field contains the `RUN_NONCE`. Binary.
- **`commission_settled`**: all expected commission payments were broadcast AND internalized, observed by pattern-matching against `server-stderr.log` files. Binary.
- **`budget_respected`**: no agent exceeded its per-task budget cap, and total sats spent is within expected range ±30% of run11 baseline (~2M for cascade, ~X for #23 — will calibrate after first green run).

**Layer 1 is the authoritative verdict.** If all of these pass, the cascade achieved its economic outcome, and nothing else can override that verdict.

#### Layer 2 — Structural invariants (these decide pass/fail for architectural claims)

Things that must be true if the architecture is honest, independent of LLM behavior or tool-result format drift. These are tiny predicates (5-10 lines each) that scan the full event stream for "did this class of event happen at all." They don't care about exact args, exact ordering, retries, or extra sanity calls — only about whether the architectural intent was realized.

For #23, Layer 2 checks are:

- **`overlay_was_used`**: at least one `tool_call` event in Captain's transcript with `tool == "overlay_lookup"` AND the args contain `"scraping"` (substring match, case-insensitive). Proves the discovery path was exercised.
- **`delegation_happened`**: at least one `tool_call` event in Captain's transcript with `tool == "delegate_task"` AND at least one `task_received` event in Worker's transcript with `sender == captain_identity_key` AND Captain's timestamp precedes Worker's by less than 60 seconds. Proves the delegation actually bridged agents.
- **`worker_did_external_work`**: at least one `web_fetch` tool_call in Worker's transcript with a result that doesn't start with "error", AND at least one `execute_bash` tool_call with a non-error result. Proves the worker actually ran external work.
- **`reverse_path_existed`**: at least one `delegate_task` tool_call in Worker's transcript (or `send_message`, depending on the chosen reverse-path pattern) with `recipient == captain_identity_key`. Proves the results flowed back.
- **`commission_messages_fired`**: at least 4 commission-related messages in the server-stderr logs across all agents (2 × `commission_payment_sent`, 2 × `commission_payment_received`, adjusted for the actual hop count). Proves the economic settlement loop closed.

Each Layer 2 predicate is **small, substring-based, and validated against the green cascade run's fixtures before being added to the gate**. We read the actual event stream from a known-green run, write the predicate, and only commit it if it passes on real data.

#### Layer 3 — Expected-chain DSL (diagnostic only, never fails verdict)

This is where the rich declarative chain lives. It walks the transcripts in order, matches each expected link with semantic predicates, reports evidence and closest-match diffs for near-misses. Its output is a detailed markdown narrative of "what happened during this run" — perfect for the demo video, for debugging, and for the Mission Control UI's cascade timeline. But **it cannot fail a run**. Its verdict is always `{ level: "advisory" }`.

Example expected chain for #23:

```js
const expectedChain = [
  { agent: 'captain', event: 'tool_call', tool: 'overlay_lookup',
    match: (args) => JSON.stringify(args).toLowerCase().includes('scraping') },
  { agent: 'captain', event: 'tool_result', tool: 'overlay_lookup',
    match: (result) => {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      return (parsed.results || []).some(a => a.identity_key === workerKey);
    }},
  { agent: 'captain', event: 'tool_call', tool: 'delegate_task',
    match: (args) => args.recipient === workerKey &&
                     (args.capabilities || []).includes('execute_bash') },
  { agent: 'worker', event: 'task_received',
    match: (evt) => evt.from === captainKey },
  { agent: 'worker', event: 'tool_call', tool: 'web_fetch',
    match: (args) => /reddit\.com.*\/r\/technology/i.test(args.url || '') },
  { agent: 'worker', event: 'tool_result', tool: 'web_fetch',
    match: (result) => !String(result).startsWith('error') &&
                       String(result).toLowerCase().includes('data') },
  { agent: 'worker', event: 'tool_call', tool: 'execute_bash',
    match: (args) => (args.command || '').includes('proof_records.sh') },
  { agent: 'worker', event: 'tool_result', tool: 'execute_bash',
    match: (result) => {
      try {
        const j = JSON.parse(String(result));
        return j.proofs_created >= 10 && (j.errors || 0) === 0;
      } catch { return false; }
    }},
  { agent: 'worker', event: 'tool_call', tool: 'delegate_task',
    match: (args) => args.recipient === captainKey &&
                     String(args.task || '').includes(RUN_NONCE) },
  { agent: 'captain', event: 'task_received',
    match: (evt) => evt.from === workerKey },
  { agent: 'captain', event: 'tool_call', tool: 'working_memory_set',
    match: (args) => String(args.value || '').includes(RUN_NONCE) },
];
```

The inspector walks this chain, for each link finding the next matching event after the current cursor, reporting pass/fail/closest-match per link with rich evidence. But the verdict is "warning" at worst, never "fail."

### False-negative mitigations inside the DSL

Even though Layer 3 can't fail a run, we still want its output to be trustworthy so it's useful for debugging:

1. **Semantic predicates, never syntactic matches**. Every `match` function uses substring, regex, or semantic shape checks. Never string equality on args.
2. **Retry tolerance**. For each link, walk ALL matching events in the stream, not just the first. If any match, the link passes. Retry counts become metadata, not failures. (This is the existing `findSuccessfulCall` pattern from the cascade test, formalized into library code.)
3. **Outcome-first, sequence-second**. Links are "did this outcome appear at some point after the current cursor" not "was this the Nth event." Temporal ordering is only enforced where it's causally required (e.g., Captain's `delegate_task` must precede Worker's `task_received`), and always with a wall-clock tolerance (default 60s).
4. **Closest-match reporting on near-misses**. When a link doesn't match, compute the 3 closest events by tool name + arg Jaccard similarity and report them with a diff. Makes debugging bad prompts trivial — the operator sees "we looked for X, the closest thing we found was Y, here's what didn't match."
5. **Per-assertion advisory flags**. Each assertion has `level: "outcome" | "structural" | "advisory"`. Start everything at `advisory` when adding it; promote to `structural` only after it passes on 3+ known-green runs empirically. Never promote without empirical validation.
6. **Empirical calibration mode**. `inspector --calibrate path/to/known-green-transcripts/` runs every assertion in the inspector against a saved known-green run and reports pass/fail per assertion. Any assertion that fails on known-green is broken and gets rewritten before being added to the gate. This is how we bootstrap trust.
7. **Regression suite for the inspector itself**. Every green cascade's transcripts are saved to `tests/fixtures/inspector/cascade-green-<date>/`. Changes to the inspector must still mark all fixtures as pass. The inspector's own test suite catches false-negative regressions before they hit a real run.
8. **Fail-loud on predicate bugs, not runs**. If a predicate throws an exception (e.g., bad JSON parse, missing field), the inspector reports that as a predicate bug — not a run failure. The operator sees "predicate `worker_did_external_work` threw TypeError, inspector output is unreliable for this check" and can triage.

### Verdict output shape

```json
{
  "verdict": "PASS" | "WARN" | "FAIL",
  "layer1": {
    "status": "PASS" | "FAIL",
    "checks": [
      { "name": "proof_bijection", "status": "PASS", "evidence": {...} },
      { "name": "wallet_tx_delta", "status": "PASS", "evidence": {...} },
      ...
    ]
  },
  "layer2": {
    "status": "PASS" | "FAIL",
    "invariants": [
      { "name": "overlay_was_used", "status": "PASS", "evidence": "..." },
      ...
    ]
  },
  "layer3": {
    "status": "PASS" | "WARN",
    "chain": [
      { "link": 1, "description": "captain: overlay_lookup(scraping)",
        "status": "PASS", "matched_event": {...}, "evidence": {...} },
      { "link": 5, "description": "worker: web_fetch(reddit)",
        "status": "WARN", "closest_matches": [...], "reason": "..." },
      ...
    ]
  },
  "totals": {
    "sats_spent": 2040260,
    "tx_count": 112,
    "wall_clock_ms": 237600,
    "per_agent_iters": { "captain": 4, "worker": 3 }
  },
  "warnings": ["..."]
}
```

**Verdict rules**:
- `PASS` = Layer 1 PASS + Layer 2 PASS + Layer 3 PASS
- `WARN` = Layer 1 PASS + Layer 2 PASS + Layer 3 FAIL (cascade worked economically and architecturally; inspector narrative flagged something to investigate; not a run failure)
- `FAIL` = Layer 1 FAIL or Layer 2 FAIL (cascade did not achieve its outcome or architectural intent)

**The exit code of `node inspector.js <run-output>` follows the verdict**: 0 for PASS, 1 for WARN (discussable), 2 for FAIL. CI and scripts can treat exit-code 0 as "green" and non-zero as "investigate," with WARN being the middle ground.

### Reuse map for inspector.js

- **#23 quality gate** — first consumer. Verdict decides whether we pause or proceed.
- **#22 4-hour dry run** — runs the inspector in streaming mode (tails session.jsonl files, emits partial verdicts). Layer 1 + Layer 2 checks on every completed cascade; Layer 3 chain narrative rendered to a live dashboard.
- **Thursday 24-hour run** — same streaming mode at scale. Layer 1 + Layer 2 on every cascade, aggregated into a run-long verdict. Layer 3 feeds the Friday demo video's cascade-timeline animations.
- **Mission Control UI (#21)** — reads inspector verdict JSON in real time via SSE or polling, renders cascade timeline + per-agent status + proof explorer. The UI is a thin rendering layer on top of the same JSON the gate consumes.
- **Future scenarios** — any multi-agent test defines its expected chain once, gets outcome + structural + diagnostic verdict for free.

---

## Module 3 — `lib/proof_verify.js`

### Purpose

Bijective proof verification. Independently re-compute expected SHA-256 hashes from ground-truth records, extract actual on-chain hashes from the wallet DB, and assert a 1:1 mapping. This is the same verifier that will audit the Friday video's daily-report provenance claims — the demo where a judge clicks a claim and traces it to source.

### Verification flow

1. **Ground truth acquisition**. Two modes:
   - **Snapshot mode** (for #23 and the dry run): snapshot Reddit's response once at test-start, pass it to Worker as literal input (via a workspace file or task arg), and use the same snapshot as ground truth. Fully deterministic, no flakiness. This is the preferred mode for scripted tests.
   - **Live mode** (for the 24-hour run): after the test completes, independently fetch the same URLs Worker was told to fetch. Tolerate ±20% record overlap due to Reddit's live ordering drift. Bijection is on post IDs, not order — we accept a record as verified if its ID appears in both the live re-fetch and the Worker's proof set.
2. **Worker result parsing**. Read Worker's `execute_bash` tool_result from its session.jsonl (via inspector.js's event extraction). Parse the reported JSON: `{ proofs_created, errors, txids }`. Hard fail if the JSON is malformed or reports errors.
3. **Expected hash computation**. For each record in ground truth, compute `sha256(JSON.stringify(record))` the same way `proof_records.sh` does. Build the "expected hash set" — a Set<hex-string>.
4. **On-chain hash extraction**. For each txid in Worker's reported `txids[]`:
   - Fetch the tx via `GET http://localhost:3324/listActions?filter=<txid>` or the equivalent `POST /wallet/listActions` endpoint (whichever the wallet exposes).
   - Parse the tx's outputs. Find the OP_RETURN output (identifiable by `satoshis: 0` and script prefix `006a` = `OP_FALSE OP_RETURN`).
   - Extract the pushed data following the `OP_RETURN` opcode. The shell script pushes a raw 32-byte SHA-256, so the script bytes are `006a20<64 hex chars>`. Extract those 64 chars.
   - Build the "actual hash set" — a Set<hex-string>.
5. **Bijection assertion**. Compare expected and actual sets:
   - **Orphans**: hashes in actual that aren't in expected. These are on-chain proofs with no matching record — injected noise or accounting bugs. Must be empty for PASS.
   - **Misses**: hashes in expected that aren't in actual. These are records that were supposed to be proofed but weren't. Must be empty for PASS.
   - **Duplicates**: the same hash appearing twice in actual. Indicates aliasing or replay. Must be empty for PASS.
   - **Cardinality**: `|expected| == |actual|`. Must hold for PASS.
6. **On-chain broadcast verification** (optional but preferred for hard gates):
   - For each proof txid, query the Worker wallet's `proven_txs` table directly, OR fetch via WhatsOnChain/overlay and verify the merkle root against a ChainTracker.
   - Hard cut-off: 2-minute timeout. WoC indexing lag can be 30-60s, so we retry with backoff.
   - If any proof is not on-chain after the timeout, report it as a warning but don't fail — this catches "tx was broadcast but not yet mined" which is a real state but not a correctness bug. The bijection is the primary correctness check; on-chain verification is the secondary durability check.
7. **Temporal window assertion**. All proof txs must have `createdAt` in `[test_start, test_end + 60s]`. Catches baseline leakage (accidentally counting old proofs).
8. **BRC-18 chain integrity (optional)**. If the proofs are wrapped in the worm's BRC-18 proof envelope, verify each one's hash chain back to the prior proof. Proves the proofs weren't injected post-hoc.

### Output shape

```json
{
  "verdict": "PASS" | "FAIL",
  "mode": "snapshot" | "live",
  "expected_count": 10,
  "actual_count": 10,
  "verified_count": 10,
  "bijection": {
    "status": "PASS",
    "orphans": [],
    "misses": [],
    "duplicates": []
  },
  "on_chain": {
    "status": "PASS",
    "verified": 10,
    "pending": 0,
    "failed": []
  },
  "temporal": {
    "status": "PASS",
    "window": { "start": "2026-04-13T15:53:00Z", "end": "2026-04-13T15:57:00Z" },
    "out_of_window": []
  },
  "evidence": {
    "txid_hash_pairs": [
      { "txid": "abc123...", "hash": "def456...", "record_id": "t3_xyz" },
      ...
    ]
  }
}
```

### Reuse map for proof_verify.js

- **#23 quality gate** — Layer 1 check for `proof_bijection`.
- **#22 dry run** — runs the verifier after each cascade, aggregates pass counts over 4 hours.
- **Thursday 24-hour run** — runs at scale. Thousands of records → thousands of proofs, all bijectively verified. The aggregate verdict is the Friday video's money shot: "1,487,234 records, 1,487,234 proofs, bijection VERIFIED."
- **Friday demo** — the verifier's output is the provenance-traceability demo. A judge clicks a claim → we show the expected hash → we show the on-chain txid → we link to WhatsOnChain → the judge verifies it themselves. Every step is in the verifier's output JSON.
- **Future per-source verifiers** — snapshot-mode generalizes to any idempotent data source (HN, RSS, overlay data). Live-mode generalizes to any x402 service with a `snapshot-at-scrape-time` escape hatch for non-reproducible sources.

---

## How the three modules fit together for #23

```
                    ┌─────────────────────────┐
                    │   test_poc_23.js (new)  │
                    │   — top-level test       │
                    └────────────┬────────────┘
                                 │
             ┌───────────────────┼───────────────────┐
             ▼                   ▼                   ▼
   ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
   │   cluster.js    │ │  inspector.js   │ │ proof_verify.js │
   │   startup +     │ │  Layer 1/2/3    │ │  bijection +    │
   │   cert + over-  │ │  verdict over   │ │  on-chain +     │
   │   lay verify    │ │  session.jsonl  │ │  temporal       │
   └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
            │                   │                   │
            ▼                   ▼                   ▼
     cluster-state.json   verdict-2026-04-13.json  proof-verdict.json
                                 │                   │
                                 └─────────┬─────────┘
                                           ▼
                             ┌───────────────────────────┐
                             │  Final quality gate:      │
                             │  verdict = PASS if all    │
                             │  layers green, else FAIL  │
                             └───────────────────────────┘
```

`test_poc_23.js` is the new top-level test that replaces `test_proof_batch_cost.js`. It:

1. Calls `cluster.js::startCluster()` to bring up Captain + Worker with proper certs and verified overlay registration.
2. Snapshots Reddit's response for deterministic ground truth (snapshot mode).
3. Submits the proof-batch task to Captain. The task text is essentially the same as `test_proof_batch_cost.js`'s, but with a small addition: Worker is given the snapshot file path so it uses deterministic data, and is told to return all proof txids in a structured format the inspector can parse.
4. Waits for Captain's task to complete. Uses the same 10-minute phase timeout as the cascade test.
5. Waits for commission settlement (~4 minutes for the 2-hop direct delegation, shorter than the 3-hop cascade).
6. Calls `proof_verify.js::verifyProofBatch()` to get the Layer 1 bijection verdict.
7. Calls `inspector.js::inspectRun()` to get the full Layer 1/2/3 verdict (the Layer 1 slot for bijection is fed by the proof_verify output).
8. Prints a human-readable summary.
9. Exits with 0 (PASS), 1 (WARN), or 2 (FAIL).

The entire top-level test is maybe 150 lines because everything real is in the three modules.

---

## Reuse map — the big picture

This is the table that justifies the investment. Every row is a thing we have to build for the 5-day push. The right three columns mark whether the new modules directly serve that work.

| Deliverable | Purpose | cluster.js | inspector.js | proof_verify.js |
|---|---|:---:|:---:|:---:|
| **#23 quality gate** | Prove the cascade + proof flow works end-to-end before investing in provisioning | ✓ | ✓ | ✓ |
| **5-agent smoke test** (gate for #20) | Validate concurrent cascades at small scale before scaling to 25 | ✓ | ✓ | ✓ |
| **#18 wallet provisioning** | 23 new wallets, split, funded, idempotent | (uses same daemon-mode pattern cluster.js establishes) | — | — |
| **#20 25-agent launcher** | Bring up the full cluster, health-check, stable | ✓ (same call, 25 entries) | — | — |
| **#21 Mission Control UI** | Agent grid, cascade timeline, proof explorer, live tx counter | ✓ (cluster-state.json is the agent grid's data source) | ✓ (verdict JSON is the cascade timeline's data source) | ✓ (bijection evidence is the proof explorer's data source) |
| **#22 4-hour dry run** | Validate sustained rate, find scale bottlenecks | ✓ | ✓ (streaming mode) | ✓ (per-cascade) |
| **Thursday 24-hour run** | The 1.5M-tx production run | ✓ | ✓ (streaming mode at scale) | ✓ (at scale) |
| **Friday demo video** | Show provenance chain, rate, cost, verification | — | ✓ (cascade narrative for screen overlays) | ✓ (the money shot: bijective verification of the daily report) |
| **Post-hackathon multi-agent tests** | Regression suite for every future scenario | ✓ | ✓ | ✓ |

Nine deliverables. Three modules cover 7 directly and the eighth (#18 provisioning) uses the same daemon-mode + split-UTXO patterns cluster.js establishes. The only row the modules don't touch is the video editing itself — but they provide the screen-captured content and on-screen verification the video needs.

---

## Build order

The only safe order (each step validates the previous one against real data):

1. **Write `lib/cluster.js`** against the declarative config and startup sequence spec above. Keep it under ~400 lines. Include the cert-issuance-with-capabilities and overlay-registration-verification gates from day one — these are load-bearing.
2. **Validate cluster.js by refactoring `test_three_layer_cascade.js` to use it**. The cascade test must still pass 7/7 in ~240s. This proves the abstraction is sound on known-green code before we build anything on top.
3. **Patch rust-bsv-worm if needed for per-role capabilities**. If the existing `POST /certificates/issue` endpoint doesn't accept a `capabilities` override, add that in a small PR. Test in isolation.
4. **Write `lib/proof_verify.js`**. Start with snapshot mode only (live mode is for the 24-hour run). Test against the existing cascade test's worker — even though cascade doesn't run proof_records.sh, we can hand-run it separately and verify the verifier's math is right.
5. **Write `lib/inspector.js` Layer 1 and Layer 2 only**. No chain DSL yet. Calibrate every invariant against the last 3 green cascade runs' transcripts before adding it to the gate. Inspector must mark all 3 as green.
6. **Write `test_poc_23.js`**. Replaces `test_proof_batch_cost.js`. Wires cluster.js + proof_verify.js + inspector.js together with the snapshot-mode task. Use Captain + Worker only.
7. **Run `test_poc_23.js` once** against the real cluster. Inspect the output by hand. If Layer 1 PASS and Layer 2 PASS, we have the gate. If not, debug the specific failing invariant — trust the outcome checks, treat inspector misses as bugs in the inspector, not the cascade.
8. **Add `lib/inspector.js` Layer 3 chain DSL**. Only after Layers 1 and 2 are stable. Calibrate against saved fixtures. Never let Layer 3 fail a run.
9. **Commit everything**. Archive the first green `verdict-*.json` as the baseline. Future runs are compared against it for regression detection.
10. **Pause per user directive. Reassess the 5-day plan before moving to #18.**

### Time estimate

Honest estimates at thoughtful pace, with space for debugging:

| Step | Effort | Notes |
|---|---|---|
| 1. cluster.js | 3-4 hours | ~400 lines, plus integration testing |
| 2. cascade test refactor + validate | 1 hour | Should just work if abstraction is right |
| 3. Per-role capabilities patch (if needed) | 1-2 hours | Depends on current endpoint shape |
| 4. proof_verify.js | 2-3 hours | ~350 lines, bijection logic is straightforward |
| 5. inspector.js Layer 1+2 | 2-3 hours | Calibration against real data is the slow part |
| 6. test_poc_23.js | 1 hour | Thin wiring |
| 7. First run + debug | 1-2 hours | First run likely needs one debug cycle |
| 8. inspector.js Layer 3 | 2 hours | Rich chain DSL + fixture-based testing |
| 9. Commit + baseline | 30 min | Document the green baseline |
| **Total** | **13-18 hours** | One day of focused work at unlimited-energy pace |

Plus one `~$0.40` test run to produce the first pass verdict. Every subsequent test run is insurance, not uncertainty.

---

## Open decisions / risks

Things that need answers before or during implementation:

1. **Does `POST /certificates/issue` accept a per-call capabilities override?** Need to read `src/server/certificates.rs` (or the equivalent handler) during step 1. If no, step 3 (rust-bsv-worm patch) becomes load-bearing. ~1-2 hours added, but the patch is small.

2. **Where do agent capability strings come from in the worm code path?** Possibilities: (a) static CAPABILITY_DECLARATION proof at boot, (b) cert field parsed from BRC-52 cert, (c) config file, (d) env var. Need to trace during step 1. If it's (a) only, we might need a new mechanism (env var override or cert-driven override) for per-role capabilities to work.

3. **Can we make the worm re-register on overlay on demand?** Step 6 of cluster.js's startup sequence waits for the next heartbeat tick for re-registration after cert issuance. If there's an explicit re-register endpoint (`POST /overlay/register` or similar), we can be faster and more deterministic. Check during step 1.

4. **2-hop direct delegation under narrowing rules**. `test_proof_batch_cost.js` has Captain delegate directly to Worker (bypass Coordinator). Narrowing should allow single-hop cert issuance, but this hasn't been validated. If narrowing rejects it, we either (a) re-introduce the Coordinator hop (matches cascade architecture, slightly more expensive), or (b) fix narrowing to allow single-hop. Layer 2's `delegation_happened` invariant will surface the failure mode clearly if it happens.

5. **Proof script path resolution**. The shell script `proof_records.sh` needs to be in Worker's workspace at a predictable path AND Worker's `execute_bash` must resolve that path correctly. The existing test writes to `test-workspaces/cascade-worker/workspace/proof_records.sh` and hopes Worker's CWD matches. Need to verify this explicitly during step 6 — possibly with an absolute path in the task text.

6. **RUN_NONCE propagation path**. Worker's final `delegate_task` call back to Captain must carry RUN_NONCE in the task text. Captain must then include it in its `working_memory_set` or final result. This is entirely prompt-driven — LLM behavior risk. Mitigations: explicit nonce handling instructions in the task text, and Layer 1 outcome check that asserts the nonce appears in Captain's final result.

7. **Reddit rate limiting**. Independent re-fetch during proof verification (live mode) hits Reddit's public API. Rate limits are ~60 req/min unauthenticated. For snapshot mode this is fine (one fetch). For live mode we need to throttle and use a proper User-Agent. Not a blocker for #23; planning for the 24-hour run.

8. **Commission settlement timing**. The cascade test waits 4 minutes for commission settlement at the end. For a 2-hop test (Captain → Worker direct), expected settlement is ~2 minutes (2 × heartbeat interval + processing). Adjust the wait in `test_poc_23.js` accordingly.

9. **Workspace persistence vs isolation**. `test-workspaces/` is evidence per the handoff's "don't delete" rule. For #23, we either (a) reuse the cascade test's workspaces (risk: stale state from prior runs), or (b) create new workspaces per-run with date-stamped names (cleaner, but we need cluster.js to support per-run workspace overrides). Preference: (b), with cluster.js accepting an optional `workspaceDir` override per agent.

10. **Inspector fixture storage**. Where do saved known-green transcripts live? Proposal: `tests/fixtures/inspector/cascade-green-2026-04-13/captain.jsonl` etc. Committed to git. Allows calibration of new invariants against real data without re-running expensive cascades.

---

## Pinned decisions (do not change without explicit user approval)

These are the calls the user made during the conversation that led to this plan. If future sessions want to deviate, check with the user first.

1. **Friday metric = Option A** (1.5M txs in 24-hour run). Locked 2026-04-13. Fallback to Option B (architecture demonstration) requires explicit user escalation.
2. **#23 must use the overlay** (no identity-key shortcut). The production discovery path must be exercised.
3. **Pause after #23**. No #18, #20, #22 work until the quality gate passes. Explicit user directive.
4. **Reuse wallets 3322, 3323, 3324** (already funded). Don't provision new wallets until after the pause.
5. **Three-module test infra is the right investment** (cluster.js + inspector.js + proof_verify.js). Rejected: narrow patching of `test_proof_batch_cost.js`. Justified by reuse map above.
6. **Layered verdict architecture** is the answer to false-negative risk. Outcome checks decide pass/fail; structural invariants confirm architecture; chain DSL is diagnostic only. Never change without re-analyzing the false-negative surface.

---

## Update log

Append to this section as the plan evolves. Each entry is a one-liner with date, who (Claude session or user), and what changed.

- **2026-04-13 evening (Claude session)** — Initial draft. Created after the conversation about #23 gaps, the three-module proposal, the reuse map, and the layered verdict architecture. Cascade sanity regression passed at commit 09b7eb8 immediately before writing. Nothing implemented yet — this is the spec we're about to build against.
