#!/usr/bin/env node
/**
 * test_cycle_v2.js — DolphinSense production cycle harness (Approach B)
 * ======================================================================
 *
 * Measures the real cost and throughput of ONE production cycle:
 *
 *   Captain (gpt-5-mini)
 *     ├── overlay_lookup (find scraping worker)
 *     └── delegate_task  → Worker (gpt-5-nano)
 *                           ├── execute_bash → proof_batch.sh (N createActions)
 *                           └── end session with proof_report as result
 *
 * NO reverse delegation. NO Captain T2. NO nested opaque-task-string pattern.
 * The harness extracts the Worker's proof_report directly from its session.jsonl
 * after the Worker task completes. This is the production cycle shape that the
 * 24h run will execute.
 *
 * Experiments this file supports (selected via env vars):
 *
 *   E12: single-Captain baseline. POSTS_ONLY=1 (default), batch ≈ 100 records.
 *        Goal: measure cost drop vs E10 (target ≤ 180K sats/cycle).
 *   E13: comment expansion. POSTS_ONLY=0, batch ≈ 500 records.
 *        Goal: prove batch=500 wall clock + cost still inside budget.
 *
 * Env:
 *   POSTS_ONLY=1            posts only (E12 mode) / 0 = post+comments (E13)
 *   BATCH_CAP=100           max records per cycle (truncates if more scraped)
 *   SUBREDDIT=technology
 *   COMMENT_LIMIT=100       passed to reddit per-post comment fetch
 *
 * SAFETY: wallets on 3322/3324 are persistent and funded — HTTP only. Never
 * init/reset.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { startCluster } = require('./lib/cluster');
const { authGet, authPost } = require('./lib/auth');

// -----------------------------------------------------------------------------
// Lane-aware config — reads LANE_ID + lanes.json + INVENTORY.json
// -----------------------------------------------------------------------------
//
// This is dolphinmilkshake's fleet version of rust-bsv-worm's
// tests/multi-worm/test_cycle_v2.js. Each invocation runs ONE lane's cycle
// loop, identified by LANE_ID env var (or --lane <id> CLI arg).
//
// Lane-specific values (sub, agent names, server ports, wallet ports) come
// from fleet/lanes.json. Wallet env file paths come from INVENTORY.json.

const DOLPHINMILKSHAKE_ROOT = path.resolve(__dirname, '..');
const RUST_BSV_WORM_DIR = process.env.RUST_BSV_WORM_DIR
  || `${process.env.HOME}/bsv/rust-bsv-worm`;
const BINARY = path.join(RUST_BSV_WORM_DIR, 'target/release/dolphin-milk');

const LANES_FILE = process.env.LANES_FILE
  || path.join(DOLPHINMILKSHAKE_ROOT, 'fleet/lanes.json');
const INVENTORY_FILE = process.env.INVENTORY_FILE
  || `${process.env.HOME}/bsv/wallets/fleet/INVENTORY.json`;

// Parse --lane <id> or LANE_ID env var
let LANE_ID = process.env.LANE_ID || '';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--lane' && process.argv[i + 1]) {
    LANE_ID = process.argv[i + 1];
    i += 1;
  }
}
if (!LANE_ID) {
  console.error('[lane-cycle] FATAL: LANE_ID env var or --lane <id> required');
  process.exit(2);
}

// Load lane config
const lanesDoc = JSON.parse(fs.readFileSync(LANES_FILE, 'utf8'));
const laneConfig = (lanesDoc.lanes || []).find((l) => l.id === LANE_ID);
if (!laneConfig) {
  console.error(`[lane-cycle] FATAL: lane '${LANE_ID}' not found in ${LANES_FILE}`);
  process.exit(2);
}
const agentByRole = Object.fromEntries(
  (laneConfig.agents || []).map((a) => [a.role, a]),
);
for (const role of ['captain', 'worker', 'synthesis']) {
  if (!agentByRole[role]) {
    console.error(`[lane-cycle] FATAL: lane ${LANE_ID} missing agent role '${role}'`);
    process.exit(2);
  }
}

// Load wallet inventory (for future use — per-wallet env paths)
const inventoryDoc = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
const walletByName = Object.fromEntries(
  (inventoryDoc.wallets || []).map((w) => [w.name, w]),
);

const PARENT_WALLET_PORT = lanesDoc._parent_wallet_port || 3321;

const CAPTAIN_PORT = agentByRole.captain.server_port;
const WORKER_PORT = agentByRole.worker.server_port;
const SYNTHESIS_PORT = agentByRole.synthesis.server_port;
const CAPTAIN_WALLET_PORT = agentByRole.captain.wallet_port;
const WORKER_WALLET_PORT = agentByRole.worker.wallet_port;
const SYNTHESIS_WALLET_PORT = agentByRole.synthesis.wallet_port;

const CAPTAIN_NAME = agentByRole.captain.name;
const WORKER_NAME = agentByRole.worker.name;
const SYNTHESIS_NAME = agentByRole.synthesis.name;

const CAPTAIN_MODEL = agentByRole.captain.model || 'gpt-5-mini';
const WORKER_MODEL = agentByRole.worker.model || 'gpt-5-nano';
const SYNTHESIS_MODEL = agentByRole.synthesis.model || 'gpt-5-mini';

const OVERLAY_URL = lanesDoc._overlay_url || 'https://rust-overlay.dev-a3e.workers.dev';

const POSTS_ONLY = process.env.POSTS_ONLY !== '0';
const BATCH_CAP = parseInt(process.env.BATCH_CAP || '100', 10);
// SUBREDDIT defaults to the lane's configured sub; env can override
const SUBREDDIT = process.env.SUBREDDIT || laneConfig.subreddit;
const COMMENT_LIMIT = parseInt(process.env.COMMENT_LIMIT || '100', 10);
const SOAK_CYCLES = parseInt(process.env.SOAK_CYCLES || '1', 10);
const ENABLE_SYNTHESIS = process.env.ENABLE_SYNTHESIS !== '0';
// SYNTHESIS_EVERY_N: amortization schedule. Synthesis runs only when
// (cycleIdx % SYNTHESIS_EVERY_N === 0). Default 25 per PLAN-C-SCALE.md
// (1-in-25 cycles). Value 1 means "every cycle" (pre-amortization behavior).
// Value 0 has no effect — ENABLE_SYNTHESIS=0 is the dedicated off switch.
// For single-cycle runs (SOAK_CYCLES=1), cycleIdx=0 always matches so
// synthesis runs on the first cycle regardless of SYNTHESIS_EVERY_N.
const SYNTHESIS_EVERY_N = Math.max(
  1,
  parseInt(process.env.SYNTHESIS_EVERY_N || '25', 10),
);
// E20 skinny captain: two modes, selected by SKINNY_CAPTAIN_MODE.
//   parallel (V1, E20): captain emits overlay_lookup + delegate_task as
//     parallel tool calls in a single iteration, with the worker identity
//     pre-baked from the cluster handle so there's no data dependency.
//     Measured: 104K captain sats (E18 baseline: 121K).
//   liveness (V2, E20b): captain emits ONLY overlay_lookup; after the
//     captain session ends the harness submits the worker task directly
//     to the worker's /task endpoint. delegate_task is not on the captain
//     tool path for worker-only cycles. Target: ~60K captain sats.
//
// SKINNY_CAPTAIN=1 (legacy) turns on parallel mode.
// SKINNY_CAPTAIN_MODE=liveness (preferred) turns on liveness mode.
const SKINNY_CAPTAIN_MODE = process.env.SKINNY_CAPTAIN_MODE ||
  (process.env.SKINNY_CAPTAIN === '1' ? 'parallel' : null);
const SKINNY_CAPTAIN = SKINNY_CAPTAIN_MODE != null;
const CAPTAIN_MAX_ITER = parseInt(
  process.env.CAPTAIN_MAX_ITER || (SKINNY_CAPTAIN ? '2' : '6'),
  10,
);

// QUEUE_MODE: when enabled, the harness claims records from the per-sub work
// queue written by scripts/reddit-cache-feeder.js instead of doing its own
// live Reddit scrape. This is the production path — a running feeder is
// required (POC: start it in another terminal). When unset, the existing
// per-cycle live-scrape path is preserved for local/dev.
const QUEUE_MODE = process.env.QUEUE_MODE === '1';
const FIREHOSE_DIR = process.env.FIREHOSE_DIR || '/tmp/dolphinsense-firehose';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

const RUN_NONCE = crypto.randomBytes(4).toString('hex');
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// Per-lane output dir lives under test-workspaces/fleet/<lane-id>/<run>
const FLEET_WORKSPACE_ROOT = process.env.FLEET_WORKSPACE_ROOT
  || path.join(RUST_BSV_WORM_DIR, 'test-workspaces/fleet');
const OUTPUT_DIR = path.join(
  FLEET_WORKSPACE_ROOT,
  LANE_ID,
  `cycle-${RUN_TIMESTAMP}-${RUN_NONCE}`,
);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Per-lane agent workspaces — isolated from other lanes so session.jsonl files
// for different lanes don't collide. Each agent's workspace is under the lane.
const CAPTAIN_WORKSPACE = path.join(FLEET_WORKSPACE_ROOT, LANE_ID, CAPTAIN_NAME);
const WORKER_WORKSPACE = path.join(FLEET_WORKSPACE_ROOT, LANE_ID, WORKER_NAME);
const SYNTHESIS_WORKSPACE = path.join(FLEET_WORKSPACE_ROOT, LANE_ID, SYNTHESIS_NAME);
fs.mkdirSync(CAPTAIN_WORKSPACE, { recursive: true });
fs.mkdirSync(WORKER_WORKSPACE, { recursive: true });
fs.mkdirSync(SYNTHESIS_WORKSPACE, { recursive: true });

// Shared records dir — Worker writes records here, Synthesis reads from here.
// Absolute paths are passed to both agents via their task prompts.
// Per-lane shared dir — parallel lanes must not stomp each other's records.
// Each lane gets /tmp/dolphinsense-shared/<lane-id>/ as its base.
const SHARED_DIR = path.join(
  process.env.SHARED_DIR_BASE || '/tmp/dolphinsense-shared',
  LANE_ID,
);
fs.mkdirSync(SHARED_DIR, { recursive: true });

const CAPTAIN_TIMEOUT_MS = 10 * 60 * 1000;
const WORKER_TIMEOUT_MS = 15 * 60 * 1000;
const SYNTHESIS_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

// -----------------------------------------------------------------------------
// The proof batch script — one OP_RETURN per record via wallet createAction.
// Reads from a records.jsonl file (one JSON record per line, pre-built by the
// harness). Writes txids to <records>.txids and prints a compact manifest.
// -----------------------------------------------------------------------------

const PROOF_SCRIPT = `#!/bin/bash
# proof_batch.sh — per-record OP_RETURN provenance proof creator (xargs -P 8)
# Usage: proof_batch.sh <wallet_url> <records_jsonl> [parallelism]
#
# Uses xargs -P N for real kernel-level concurrency. macOS /bin/bash is 3.2
# (2007) which does NOT support \`wait -n\` — the old background-job pool
# degraded to serial-batches-of-8. xargs -P is supported on macOS natively.
# This script re-invokes itself via --worker per line number to avoid
# JSON-quote escaping; each worker sed-extracts its own record.
set -u

# ---- WORKER MODE ----
if [ "\${1:-}" = "--worker" ]; then
  shift
  WALLET_URL="\$1"; RECORDS_FILE="\$2"; LINE="\$3"
  TXID_FILE="\${RECORDS_FILE}.txids"
  ERR_FILE="\${RECORDS_FILE}.errors"
  record=\$(sed -n "\${LINE}p" "\$RECORDS_FILE")
  [ -z "\$record" ] && exit 0
  HASH=\$(printf '%s' "\$record" | shasum -a 256 | cut -d' ' -f1)
  if [ -z "\$HASH" ]; then
    printf 'hash-fail\\n' >> "\$ERR_FILE"
    exit 0
  fi
  LOCKING="006a20\${HASH}"
  # acceptDelayedBroadcast=false forces synchronous broadcast — the wallet
  # waits for the broadcast to complete (or fail) before returning, instead of
  # queuing internally with status="sending". E16 confirmed: without this, txs
  # showed status=completed in listActions but never appeared on WoC because
  # broadcast was queued and never fired during sustained load.
  RESULT=\$(curl -sS --max-time 30 -X POST "\${WALLET_URL}/createAction" \\
    -H "Origin: \${WALLET_URL}" \\
    -H 'Content-Type: application/json' \\
    -d "{\\"description\\":\\"dolphinsense provenance\\",\\"outputs\\":[{\\"lockingScript\\":\\"\${LOCKING}\\",\\"satoshis\\":0,\\"outputDescription\\":\\"record proof\\"}],\\"options\\":{\\"acceptDelayedBroadcast\\":false}}" 2>/dev/null)
  TXID=\$(printf '%s' "\$RESULT" | jq -r '.txid // empty' 2>/dev/null)
  if [ -n "\$TXID" ] && [ "\$TXID" != "null" ]; then
    printf '%s\\n' "\$TXID" >> "\$TXID_FILE"
  else
    printf 'curl-fail\\n' >> "\$ERR_FILE"
  fi
  exit 0
fi

# ---- MAIN MODE ----
WALLET_URL="\${1:-}"
RECORDS_FILE="\${2:-}"
# E15 finding: wallet 3324 rejects 96/100 createActions at P=8 (parallel
# contention). Single serial calls succeed reliably. Default to P=1 until
# the wallet can be confirmed safe for higher parallelism. Override with
# the third argument if testing parallel.
PARALLELISM="\${3:-1}"
if [ -z "\$WALLET_URL" ] || [ -z "\$RECORDS_FILE" ]; then
  echo '{"error":"usage: proof_batch.sh <wallet_url> <records_jsonl> [parallelism]"}'
  exit 1
fi
if [ ! -f "\$RECORDS_FILE" ]; then
  echo "{\\"error\\":\\"records file not found: \$RECORDS_FILE\\"}"
  exit 1
fi

TXID_FILE="\${RECORDS_FILE}.txids"
ERR_FILE="\${RECORDS_FILE}.errors"
: > "\$TXID_FILE"
: > "\$ERR_FILE"

N_RECORDS=\$(wc -l < "\$RECORDS_FILE" | tr -d ' ')
SCRIPT_PATH="\$0"

# xargs -P N: kernel-level concurrent subprocess spawning. Each subprocess
# receives a line number and sed-extracts its own record. POSIX O_APPEND
# writes < PIPE_BUF are atomic so sidecar appends don't tear.
seq 1 "\$N_RECORDS" | xargs -n 1 -P "\$PARALLELISM" -I LINE \\
  bash "\$SCRIPT_PATH" --worker "\$WALLET_URL" "\$RECORDS_FILE" LINE

CREATED=\$(wc -l < "\$TXID_FILE" | tr -d ' ')
ERRORS=\$(wc -l < "\$ERR_FILE" | tr -d ' ')
FIRST=\$(head -n 1 "\$TXID_FILE" 2>/dev/null)
LAST=\$(tail -n 1 "\$TXID_FILE" 2>/dev/null)
MANIFEST_SHA=\$(shasum -a 256 "\$TXID_FILE" | cut -d' ' -f1)

printf '{"proofs_created":%d,"errors":%d,"txid_file":"%s","first_txid":"%s","last_txid":"%s","manifest_sha256":"%s","parallelism":%d}\\n' \\
  "\$CREATED" "\$ERRORS" "\$TXID_FILE" "\$FIRST" "\$LAST" "\$MANIFEST_SHA" "\$PARALLELISM"
`;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function log(msg) {
  console.log(`[cycle-v2] ${msg}`);
}

function formatSats(n) {
  if (n == null) return 'null';
  return n.toLocaleString() + ' sats';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function curlGet(url) {
  return execFileSync(
    'curl',
    ['-sS', '-A', USER_AGENT, '-L', '--max-time', '30', url],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
}

// -----------------------------------------------------------------------------
// Scrape: build a records.jsonl file from Reddit hot + (optionally) comments.
// Returns { recordsPath, recordCount, scrapeWallMs }.
// -----------------------------------------------------------------------------

// QUEUE_MODE: claim up to BATCH_CAP records from the per-sub work queue
// written by scripts/reddit-cache-feeder.js and advance the per-sub watermark
// atomically. Agents never touch Reddit; the feeder holds the cursor, the
// watermark prevents double-consume across restarts and future parallel
// agents on the same sub.
function claimFromQueue(cycleDir) {
  const t0 = Date.now();
  const recordsPath = path.join(cycleDir, 'records.jsonl');
  const subDir = path.join(FIREHOSE_DIR, SUBREDDIT);
  const queuePath = path.join(subDir, 'queue.jsonl');
  const claimPath = `${queuePath}.claimed`;

  if (!fs.existsSync(queuePath)) {
    throw new Error(
      `QUEUE_MODE: queue file not found at ${queuePath}. Is the feeder running? (node scripts/reddit-cache-feeder.js)`,
    );
  }

  let watermark = 0;
  try {
    const raw = fs.readFileSync(claimPath, 'utf8').trim();
    watermark = parseInt(raw, 10) || 0;
  } catch {
    watermark = 0;
  }

  const stat = fs.statSync(queuePath);
  if (watermark >= stat.size) {
    throw new Error(
      `QUEUE_MODE: no unclaimed records (watermark=${watermark} size=${stat.size}). Feeder behind or sub idle.`,
    );
  }

  // Read from watermark forward, capped at 4 MB which comfortably covers
  // BATCH_CAP=100 comment records.
  const wantBytes = Math.min(stat.size - watermark, 4 * 1024 * 1024);
  const fd = fs.openSync(queuePath, 'r');
  const buf = Buffer.alloc(wantBytes);
  fs.readSync(fd, buf, 0, wantBytes, watermark);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) {
    throw new Error('QUEUE_MODE: no complete lines available at watermark (partial write?)');
  }
  const completeText = text.slice(0, lastNewline + 1);
  const lines = completeText.split('\n').filter(Boolean);
  if (lines.length === 0) {
    throw new Error('QUEUE_MODE: no complete records after watermark');
  }

  const claimed = lines.slice(0, BATCH_CAP);
  // Byte cost of the claimed lines (each followed by one '\n')
  const claimedBytes = claimed.reduce(
    (acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1,
    0,
  );
  const newWatermark = watermark + claimedBytes;

  fs.writeFileSync(recordsPath, claimed.join('\n') + '\n');

  // Atomic watermark write
  const tmpClaim = `${claimPath}.tmp`;
  fs.writeFileSync(tmpClaim, String(newWatermark));
  fs.renameSync(tmpClaim, claimPath);

  const wallMs = Date.now() - t0;
  log(
    `QUEUE_MODE: claimed ${claimed.length} records from ${queuePath} ` +
      `(watermark ${watermark}→${newWatermark}, ${claimedBytes}b, ${wallMs}ms)`,
  );
  return { recordsPath, recordCount: claimed.length, scrapeWallMs: wallMs };
}

async function buildRecordsFile(cycleId) {
  const t0 = Date.now();
  // Cycle-scoped shared dir so each cycle has its own records + manifest +
  // sidecar files. Worker writes here, Synthesis reads from here, harness
  // post-mortem inspects here.
  const cycleDir = path.join(SHARED_DIR, `cycle-${cycleId}`);
  fs.mkdirSync(cycleDir, { recursive: true });
  const recordsPath = path.join(cycleDir, 'records.jsonl');
  const postsPath = path.join(cycleDir, 'posts.json');

  if (QUEUE_MODE) {
    const claimed = claimFromQueue(cycleDir);
    return { cycleDir, ...claimed };
  }

  log(`scraping r/${SUBREDDIT} hot...`);
  const postsJson = curlGet(
    `https://www.reddit.com/r/${SUBREDDIT}/hot.json?limit=100`,
  );
  fs.writeFileSync(postsPath, postsJson);
  const posts = JSON.parse(postsJson);
  const children = (posts.data && posts.data.children) || [];
  log(`got ${children.length} posts`);

  const jsonl = [];
  // Each child → one post record (jq -c canonical form).
  for (const child of children) {
    jsonl.push(JSON.stringify(child));
  }

  if (!POSTS_ONLY) {
    log(`fetching comments (limit ${COMMENT_LIMIT} per post)...`);
    for (let i = 0; i < children.length && jsonl.length < BATCH_CAP; i++) {
      const permalink = child_permalink(children[i]);
      if (!permalink) continue;
      try {
        const commentJson = curlGet(
          `https://www.reddit.com${permalink}.json?limit=${COMMENT_LIMIT}`,
        );
        const parsed = JSON.parse(commentJson);
        const flattened = flattenComments(parsed);
        for (const c of flattened) {
          if (jsonl.length >= BATCH_CAP) break;
          jsonl.push(JSON.stringify(c));
        }
      } catch (e) {
        // skip
      }
      await sleep(150);
    }
  }

  // Cap at BATCH_CAP
  const truncated = jsonl.slice(0, BATCH_CAP);
  fs.writeFileSync(recordsPath, truncated.join('\n') + '\n');
  const scrapeWallMs = Date.now() - t0;
  log(`wrote ${truncated.length} records → ${recordsPath} (${scrapeWallMs}ms)`);
  return { cycleDir, recordsPath, recordCount: truncated.length, scrapeWallMs };
}

function child_permalink(child) {
  return child && child.data && child.data.permalink;
}

function flattenComments(parsed) {
  // Reddit comment tree: parsed is [postListing, commentListing]
  const out = [];
  if (!Array.isArray(parsed) || parsed.length < 2) return out;
  const commentListing = parsed[1];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.body === 'string' && typeof node.id === 'string') {
        out.push({
          id: node.id,
          body: node.body,
          author: node.author || null,
          score: typeof node.score === 'number' ? node.score : null,
          parent_id: node.parent_id || null,
          created_utc: node.created_utc || null,
        });
      }
      for (const k of Object.keys(node)) {
        if (k === 'body') continue;
        walk(node[k]);
      }
    }
  };
  walk(commentListing);
  return out;
}

// -----------------------------------------------------------------------------
// Captain + Worker task prompts
// -----------------------------------------------------------------------------

function buildWorkerTask(absScriptPath, absRecordsPath, walletUrl, runNonce) {
  return [
    '=== SCRAPING WORKER TASK (dolphinsense cycle) ===',
    `run nonce: ${runNonce}`,
    '',
    'You will make EXACTLY ONE or TWO tool calls: execute_bash (to run the',
    'proof batch), then optionally a second execute_bash to read the txid',
    'sidecar file if the first one errored. Then end your session with a',
    'proof report as the final message.',
    '',
    'STEP 1 (REQUIRED): call execute_bash with this EXACT command:',
    '',
    `  bash ${absScriptPath} ${walletUrl} ${absRecordsPath}`,
    '',
    'The script runs up to 8 concurrent createAction calls and writes each',
    'successful txid as its own line to a sidecar file. It prints a compact',
    'JSON manifest on stdout at the end: proofs_created, errors, txid_file,',
    'first_txid, last_txid, manifest_sha256.',
    '',
    'IF STEP 1 ERRORS OR TIMES OUT: the sidecar file still contains every',
    'txid that succeeded before the error. Run ONE more execute_bash call to',
    'count them and build the manifest yourself:',
    '',
    `  bash -c 'F=${absRecordsPath}.txids; N=$(wc -l < "$F"); FIRST=$(head -n1 "$F"); LAST=$(tail -n1 "$F"); SHA=$(shasum -a 256 "$F" | cut -d" " -f1); printf "{\\"proofs_created\\":%d,\\"first_txid\\":\\"%s\\",\\"last_txid\\":\\"%s\\",\\"manifest_sha256\\":\\"%s\\",\\"txid_file\\":\\"%s\\"}\\n" "$N" "$FIRST" "$LAST" "$SHA" "$F"'`,
    '',
    'This recovers the REAL numbers. Do not invent values. Do not report zero',
    'unless the sidecar file is empty.',
    '',
    'STEP 2 (REQUIRED): end your session by reporting the proof manifest in',
    'plain text on a single final message. Use this EXACT format:',
    '',
    '-----BEGIN PROOF REPORT-----',
    `Run ${runNonce} proof batch complete.`,
    'proofs_created: <N from STEP 1 manifest or recovery manifest>',
    'errors: <M>',
    'first_txid: <first>',
    'last_txid: <last>',
    'manifest_sha256: <sha>',
    'txid_file: <path>',
    '-----END PROOF REPORT-----',
    '',
    'Do NOT call any other tool. Do NOT retry execute_bash more than once.',
    'Do NOT reverse-delegate. After printing the report, end your session.',
  ].join('\n');
}

function buildCaptainTask(workerTaskText, workerCapabilities, runNonce) {
  return [
    '=== DOLPHINSENSE CAPTAIN — single-cycle orchestration ===',
    `run nonce: ${runNonce}`,
    '',
    'You will make EXACTLY TWO tool calls in this session:',
    '  1. overlay_lookup (to find the scraping worker)',
    '  2. delegate_task  (to dispatch the opaque worker task below)',
    '',
    'After delegate_task returns, report the commission_id and end your session.',
    'Do NOT call any other tool. Do NOT wait for the worker. Do NOT delegate to',
    'yourself.',
    '',
    '=== STEP 1: overlay_lookup ===',
    '',
    '  service = "ls_agent"',
    '  query   = { "findByCapability": "scraping" }',
    '',
    'Pick the FIRST returned agent whose capabilities include "scraping" AND',
    '"execute_bash". Remember its identity_key.',
    '',
    '=== STEP 2: delegate_task ===',
    '',
    '  recipient                   = <identity_key from STEP 1>',
    `  capabilities                = ${JSON.stringify(workerCapabilities)}`,
    '  budget_cap_sats             = 600000',
    '  expires_in_secs             = 600',
    '  payment_amount_per_unit     = 50000',
    '  payment_unit                = "commission"',
    '  payment_max_total           = 50000',
    '  payment_derivation_invoice  = ""',
    '  task                        = (the verbatim opaque string between the markers below)',
    '',
    '=== RULE: the task ARGUMENT IS OPAQUE ===',
    '',
    'The task string below is instructions for the WORKER, not for you. You',
    'will copy it character-for-character into the task argument of',
    'delegate_task. Do NOT paraphrase or modify it. Do NOT extract values from',
    'it — your capabilities argument is exactly the list above.',
    '',
    '===WORKER_TASK_BEGIN===',
    workerTaskText,
    '===WORKER_TASK_END===',
    '',
    'After delegate_task returns, report the commission_id and end your session.',
  ].join('\n');
}

// E20b liveness-only captain prompt.
// Captain calls ONLY overlay_lookup as a liveness check. No delegate_task.
// The harness POSTs the worker task directly to the worker port after
// the captain's session ends. Minimal prompt, tiny completion tokens,
// target captain total ~60K sats.
function buildLivenessCaptainTask(runNonce) {
  return [
    '=== DOLPHINSENSE CAPTAIN — liveness check ===',
    `run nonce: ${runNonce}`,
    '',
    'Make EXACTLY ONE tool call and then end your session with a short',
    'acknowledgement.',
    '',
    '  tool: overlay_lookup',
    '  arguments:',
    '    service = "ls_agent"',
    '    query   = { "findByCapability": "scraping" }',
    '',
    'This is a liveness probe against the overlay service — the result',
    'is recorded but not used for routing. After the tool returns, end',
    'your session with a single short message naming how many agents',
    'the overlay returned. Do NOT call any other tool. Do NOT delegate.',
    'Do NOT analyze. Stop after one tool call + one short message.',
  ].join('\n');
}

// E20 skinny captain prompt.
// Instructs the LLM to emit overlay_lookup and delegate_task as PARALLEL
// tool_calls in a single response. delegate_task's recipient is pre-baked
// from the harness's known worker identity key — so there's no runtime
// data dependency between the two calls, which lets gpt-5-mini emit them
// together. max_iterations=2 means one iter for parallel tool_calls and
// one iter for the short wrap-up message.
function buildSkinnyCaptainTask(workerTaskText, workerCapabilities, runNonce, workerIdentityKey) {
  return [
    '=== DOLPHINSENSE CAPTAIN — skinny orchestration ===',
    `run nonce: ${runNonce}`,
    '',
    'Emit BOTH tool calls below in parallel in your very first assistant',
    'message, then end your session. Do NOT call any other tool.',
    '',
    '1) overlay_lookup',
    '     service = "ls_agent"',
    '     query   = { "findByCapability": "scraping" }',
    '   (liveness check — the result is not used for routing)',
    '',
    '2) delegate_task',
    `     recipient                   = "${workerIdentityKey}"`,
    `     capabilities                = ${JSON.stringify(workerCapabilities)}`,
    '     budget_cap_sats             = 600000',
    '     expires_in_secs             = 600',
    '     payment_amount_per_unit     = 50000',
    '     payment_unit                = "commission"',
    '     payment_max_total           = 50000',
    '     payment_derivation_invoice  = ""',
    '     task                        = (the opaque string between the markers below)',
    '',
    '===WORKER_TASK_BEGIN===',
    workerTaskText,
    '===WORKER_TASK_END===',
    '',
    'The task string is OPAQUE — copy it character-for-character into the',
    'task argument. After both tool calls return, produce ONE short final',
    'message naming the commission_id and end the session. No analysis.',
  ].join('\n');
}

function buildSynthesisTask(absAnnotatedPath, absTxidsPath, runNonce, proofsCreated, manifestSha) {
  return [
    '=== SYNTHESIS AGENT TASK (dolphinsense valuable read) ===',
    `run nonce: ${runNonce}`,
    '',
    `The scraping worker just hashed and proof-batched ${proofsCreated} records`,
    'from a public content firehose and pinned an OP_RETURN tx for each one. Your job is',
    'to read the annotated records (one line per record, each line carries',
    'both the original record AND its on-chain txid), upload the txid list',
    'to NanoStore, write a cited HTML analysis article, and upload it too.',
    '',
    'You will make EXACTLY THREE tool calls:',
    '  1. file_read           — read the annotated records file',
    '  2. upload_to_nanostore — upload a plaintext txid manifest',
    '  3. upload_to_nanostore — upload the finished HTML article',
    '',
    'STEP 1 (REQUIRED): file_read',
    '',
    `  path: ${absAnnotatedPath}`,
    '',
    'This file has ONE JSON object per line, shape:',
    '',
    '  {"txid":"<64-char hex>","record":{...original record fields...}}',
    '',
    'Each line is a real public record (e.g. a Bluesky post, Wikipedia edit,',
    'or similar firehose item) whose content hash is pinned to BSV via the',
    '`txid` field. Read all of it. The `record` sub-object has fields like',
    'body, author, score, id, title, permalink, and an optional `_source`',
    'tag indicating origin. Quote the body text verbatim in citations.',
    `Expected proofs: ${proofsCreated}. Manifest sha256: ${manifestSha.slice(0, 16)}…`,
    '',
    'STEP 2 (REQUIRED): upload_to_nanostore — txid manifest from FILE',
    '',
    'The harness has already written the complete, authoritative txid',
    'manifest (one txid per line, exact line order matching the annotated',
    'file) to disk. DO NOT try to compose this manifest yourself — you will',
    'truncate it. Upload the file AS IS via the file_path parameter:',
    '',
    '  tool: upload_to_nanostore',
    '  arguments:',
    `    file_path:         "${absTxidsPath}"`,
    '    retention_minutes: 525600',
    '    content_type:      "text/plain"',
    '',
    'Do NOT provide a `content` argument. Do NOT read the file into your',
    'context first — let the tool stream the bytes directly from disk.',
    'Remember the returned public URL. Reference it in STEP 3 as TXIDS_URL.',
    '',
    'STEP 3 (REQUIRED): upload_to_nanostore — HTML article',
    '',
    'Compose a complete standalone HTML5 document containing a 1000-1500',
    'word analysis article. The HTML must include:',
    '',
    '  - <!DOCTYPE html>, <html lang="en">, <head>, <body>',
    '  - <meta charset="utf-8"> + <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  - <title> with the article headline',
    '  - <style> block with:',
    '      * system font stack (-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif)',
    '      * max-width ~720px centered, line-height 1.6-1.7',
    '      * dark text on light background, hierarchical headings',
    '      * <blockquote> left-border accent + subtle background',
    '      * <code> monospace + subtle background (for txid citations)',
    '      * footer card with subtle background for Provenance Note',
    '      * mobile responsive via viewport meta + @media (max-width:420px)',
    '  - Article body inside <main class="container"> or <article>',
    '  - Sections as <section> blocks with <h2> headings:',
    '      Key Themes, Notable Discussions, Sentiment & Context, Analysis,',
    '      Provenance Note',
    '',
    '=== CRITICAL: inline citations with on-chain txids ===',
    '',
    'Every direct quote MUST carry its on-chain txid inline. Use this',
    'EXACT blockquote pattern, with the txid taken from the SAME line in',
    'the annotated file as the record you are quoting:',
    '',
    '  <blockquote>',
    '    "Quoted text from the record body..."',
    '    <footer>— @&lt;author&gt; · <code>&lt;full 64-char txid&gt;</code></footer>',
    '  </blockquote>',
    '',
    'Include AT LEAST 4 different <blockquote> citations in the article,',
    'each with a DIFFERENT txid. The txid must match the record you quote',
    '— a judge should be able to paste any cited txid into',
    'whatsonchain.com/tx/ and find the exact OP_RETURN that hashes to',
    'the quoted content.',
    '',
    '=== Provenance Note section (REQUIRED content) ===',
    '',
    'The final <section> (Provenance Note) must include:',
    '',
    `  <p><strong>On-chain proofs:</strong> ${proofsCreated} records were`,
    '     hashed and pinned to BSV via OP_RETURN transactions.</p>',
    `  <p><strong>Manifest sha256:</strong> <code>${manifestSha}</code></p>`,
    `  <p><strong>Run nonce:</strong> <code>${runNonce}</code></p>`,
    '  <p><strong>Full txid manifest:</strong>',
    '     <a href="TXIDS_URL">TXIDS_URL</a> — one txid per line, in the',
    '     same order as the scraped records. Each line maps 1:1 to a',
    '     quoted record in this article.</p>',
    '  <p>To verify any claim: copy a <code>&lt;code&gt;</code>-wrapped',
    '     txid above, look it up on a BSV block explorer, and inspect the',
    '     OP_RETURN output. Its 32-byte payload is the SHA-256 of the',
    '     canonical jq-compact JSON of the quoted record.</p>',
    '',
    'Replace TXIDS_URL above with the actual URL returned by STEP 2.',
    '',
    '=== Upload the HTML ===',
    '',
    'Call upload_to_nanostore with:',
    '',
    '  content:           <full HTML document as a single string>',
    '  retention_minutes: 525600',
    '  content_type:      "text/html"',
    '',
    '=== Report ===',
    '',
    'End your session with BOTH URLs on separate lines in this EXACT',
    'format (no other output needed before or after):',
    '',
    '  TXIDS_URL: <url from STEP 2>',
    '  NANOSTORE_URL: <url from STEP 3>',
    '',
    'Do NOT call any other tool. Do NOT call file_write. Do NOT call',
    'search_tools. Compose the HTML and the txid manifest directly as',
    'strings in the tool_call arguments.',
    '',
    'IMPORTANT: this article is the PRODUCTION DELIVERABLE judges will',
    'open in a browser. Every quoted <blockquote> must carry a real',
    'on-chain txid. Typography, spacing, structure, and correct txid',
    'citations all matter.',
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Task polling + session scraping
// -----------------------------------------------------------------------------

async function submitTask(port, taskText, maxIterations = 6) {
  const resp = await authPost(
    `http://localhost:${port}/task`,
    { task: taskText, max_iterations: maxIterations },
    PARENT_WALLET_PORT,
  );
  if (resp.status !== 200 && resp.status !== 201 && resp.status !== 202) {
    throw new Error(`submit failed: HTTP ${resp.status} ${JSON.stringify(resp.body).slice(0, 300)}`);
  }
  const id = resp.body && (resp.body.id || resp.body.task_id);
  if (!id) throw new Error(`submit returned no id: ${JSON.stringify(resp.body).slice(0, 300)}`);
  return id;
}

async function pollTaskComplete(port, taskId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      const { status, body } = await authGet(
        `http://localhost:${port}/task/${taskId}`,
        PARENT_WALLET_PORT,
      );
      if (status === 200 && body) {
        const s = String(body.status || '').toLowerCase();
        if (s === 'complete' || s === 'completed') return body;
        if (s === 'error' || s === 'failed' || s === 'cancelled') return body;
      }
    } catch (e) {
      // transient
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`task ${taskId} did not complete before deadline`);
}

// Find the Worker's task that ran during [runStartMs, now]. Returns task id +
// execute_bash proof manifest (or null). Fixes the E5+ stale-task bug by
// filtering by session mtime.
function extractWorkerProofResult(workerWorkspace, runStartMs) {
  const tasksDir = path.join(workerWorkspace, 'tasks');
  if (!fs.existsSync(tasksDir)) return null;
  const taskIds = fs.readdirSync(tasksDir);
  const candidates = [];
  for (const tid of taskIds) {
    const sessionPath = path.join(tasksDir, tid, 'session.jsonl');
    if (!fs.existsSync(sessionPath)) continue;
    const stat = fs.statSync(sessionPath);
    if (stat.mtimeMs < runStartMs) continue;
    candidates.push({ tid, mtimeMs: stat.mtimeMs, sessionPath });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    const lines = fs.readFileSync(c.sessionPath, 'utf8').split('\n');
    // Look for an execute_bash tool_result whose content JSON has proofs_created.
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if ((event.type || '') !== 'tool_result') continue;
      // Tool result shape: content might be string OR offloaded pointer.
      // For small results content is the manifest JSON directly.
      const content = event.content
        || (event.data && event.data.result)
        || (event.result != null ? event.result : null);
      if (typeof content !== 'string') continue;
      const match = content.match(/\{[^{}]*"proofs_created"[^{}]*\}/);
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed.proofs_created === 'number') {
          return { taskId: c.tid, result: parsed, sessionPath: c.sessionPath };
        }
      } catch {
        // skip
      }
    }
    // Also check if the session END event contains the proof report (alt path).
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if ((event.type || '') !== 'session_end') continue;
      const result = String(event.result || '');
      if (result.includes('BEGIN PROOF REPORT')) {
        return { taskId: c.tid, result: { _report: result }, sessionPath: c.sessionPath };
      }
    }
  }
  return null;
}

function sumSatsFromTask(body) {
  if (!body) return null;
  return body.sats_spent != null
    ? body.sats_spent
    : (body.cost_sats != null ? body.cost_sats : null);
}

// Find the latest synthesis task spawned after runStartMs and pull its result
// + sats from session.jsonl. Returns null if not found.
function extractSynthesisResult(synthesisWorkspace, runStartMs) {
  const tasksDir = path.join(synthesisWorkspace, 'tasks');
  if (!fs.existsSync(tasksDir)) return null;
  const taskIds = fs.readdirSync(tasksDir);
  const candidates = [];
  for (const tid of taskIds) {
    const sessionPath = path.join(tasksDir, tid, 'session.jsonl');
    if (!fs.existsSync(sessionPath)) continue;
    const stat = fs.statSync(sessionPath);
    if (stat.mtimeMs < runStartMs) continue;
    candidates.push({ tid, mtimeMs: stat.mtimeMs, sessionPath });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const c = candidates[0];
  const lines = fs.readFileSync(c.sessionPath, 'utf8').split('\n');
  let sessionEnd = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if ((ev.type || '') === 'session_end') {
      sessionEnd = ev;
      break;
    }
  }
  if (!sessionEnd) return null;
  const result = String(sessionEnd.result || '');
  const htmlMatch = result.match(/NANOSTORE_URL:\s*(\S+)/);
  const txidsMatch = result.match(/TXIDS_URL:\s*(\S+)/);
  return {
    taskId: c.tid,
    sats_spent: sessionEnd.sats_spent,
    iterations: sessionEnd.iterations,
    nanostoreUrl: htmlMatch ? htmlMatch[1] : null,
    txidsUrl: txidsMatch ? txidsMatch[1] : null,
    result,
    sessionPath: c.sessionPath,
  };
}

// -----------------------------------------------------------------------------
// runCycle — one full production cycle (scrape → captain → worker → synthesis)
// -----------------------------------------------------------------------------

async function runCycle(handle, cycleIdx) {
  const cycleId = `${RUN_NONCE}-${String(cycleIdx).padStart(3, '0')}`;
  const cycleStartMs = Date.now();
  log('-'.repeat(70));
  log(`CYCLE ${cycleIdx + 1}/${SOAK_CYCLES} — id=${cycleId}`);
  log('-'.repeat(70));

  // 1. build records into shared cycle dir
  const { cycleDir, recordsPath, recordCount, scrapeWallMs } = await buildRecordsFile(cycleId);

  // 2. write the proof script alongside the records
  const proofScriptPath = path.join(cycleDir, 'proof_batch.sh');
  fs.writeFileSync(proofScriptPath, PROOF_SCRIPT, { mode: 0o755 });

  // 3. build Captain + Worker prompts
  const workerCaps = ['execute_bash', 'send_message'];
  const walletUrl = `http://localhost:${WORKER_WALLET_PORT}`;
  const absScriptPath = path.resolve(proofScriptPath);
  const absRecordsPath = path.resolve(recordsPath);
  const workerTaskText = buildWorkerTask(absScriptPath, absRecordsPath, walletUrl, cycleId);
  let captainTaskText;
  if (SKINNY_CAPTAIN_MODE === 'liveness') {
    captainTaskText = buildLivenessCaptainTask(cycleId);
    log(`captain mode: LIVENESS (max_iter=${CAPTAIN_MAX_ITER}, harness submits worker directly)`);
  } else if (SKINNY_CAPTAIN_MODE === 'parallel') {
    const workerAgent = handle.agents.get(WORKER_NAME);
    if (!workerAgent || !workerAgent.identityKey) {
      throw new Error(`SKINNY_CAPTAIN_MODE=parallel requires worker '${WORKER_NAME}' identity key`);
    }
    captainTaskText = buildSkinnyCaptainTask(
      workerTaskText,
      workerCaps,
      cycleId,
      workerAgent.identityKey,
    );
    log(`captain mode: PARALLEL (max_iter=${CAPTAIN_MAX_ITER})`);
  } else {
    captainTaskText = buildCaptainTask(workerTaskText, workerCaps, cycleId);
  }
  log(`prompts: captain=${captainTaskText.length}c worker=${workerTaskText.length}c`);

  // 4. submit Captain task
  const captainTaskId = await submitTask(CAPTAIN_PORT, captainTaskText, CAPTAIN_MAX_ITER);
  log(`captain task: ${captainTaskId}`);

  // 5. poll Captain to completion
  const captainResult = await pollTaskComplete(
    CAPTAIN_PORT,
    captainTaskId,
    Date.now() + CAPTAIN_TIMEOUT_MS,
  );
  const captainSats = sumSatsFromTask(captainResult) || 0;
  log(`captain done: iter=${captainResult.iterations}, sats=${formatSats(captainSats)}`);

  // 5b. LIVENESS mode: the captain did its job (verified overlay); the
  //     harness now directly submits the worker task to the worker port.
  //     This bypasses captain-driven delegation entirely for worker-only
  //     cycles, keeping the captain's LLM cost tiny while still asserting
  //     overlay liveness every cycle.
  if (SKINNY_CAPTAIN_MODE === 'liveness') {
    const workerTaskId = await submitTask(WORKER_PORT, workerTaskText, 6);
    log(`worker task (harness-direct): ${workerTaskId}`);
  }

  // 6. wait for Worker's proof manifest in its transcript
  let workerProof = null;
  const workerDeadline = Date.now() + WORKER_TIMEOUT_MS;
  while (Date.now() < workerDeadline) {
    workerProof = extractWorkerProofResult(WORKER_WORKSPACE, cycleStartMs);
    if (workerProof) break;
    await sleep(POLL_INTERVAL_MS);
  }
  if (!workerProof) {
    throw new Error(`cycle ${cycleId}: worker proof not found before deadline`);
  }
  log(`worker proof: task=${workerProof.taskId} created=${workerProof.result.proofs_created}`);

  // 7. wait for the Worker session_end event to appear (the proof_result is
  //    written to the transcript at iter-1's tool_result, but session_end
  //    isn't written until iter-2 finishes. E15 hit this race and parsed
  //    workerSats as 0).
  let workerSats = 0;
  const sessionEndDeadline = Date.now() + WORKER_TIMEOUT_MS;
  while (Date.now() < sessionEndDeadline) {
    let foundEnd = false;
    try {
      const wlines = fs.readFileSync(workerProof.sessionPath, 'utf8').split('\n');
      for (const line of wlines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if ((ev.type || '') === 'session_end') {
          workerSats = ev.sats_spent || 0;
          foundEnd = true;
          break;
        }
      }
    } catch (e) {
      log(`warn: worker session_end read failed: ${e.message}`);
    }
    if (foundEnd) break;
    await sleep(POLL_INTERVAL_MS);
  }
  log(`worker sats: ${formatSats(workerSats)}`);

  // 8. write a manifest sidecar + build the annotated records file that
  //    pairs each record line-by-line with its on-chain txid. Synthesis
  //    reads this annotated file so it can cite specific records with
  //    their real on-chain txids.
  const manifest = {
    cycleId,
    runNonce: RUN_NONCE,
    cycleIdx,
    recordCount,
    proofsCreated: workerProof.result.proofs_created || 0,
    errors: workerProof.result.errors || 0,
    firstTxid: workerProof.result.first_txid,
    lastTxid: workerProof.result.last_txid,
    manifestSha256: workerProof.result.manifest_sha256,
    txidFile: workerProof.result.txid_file,
    createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(cycleDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Build annotated records: join records.jsonl line N with txids[N].
  // This only includes records that have a successful on-chain txid.
  const annotatedPath = path.join(cycleDir, 'records-annotated.jsonl');
  let annotatedCount = 0;
  try {
    const txidFile = workerProof.result.txid_file;
    if (txidFile && fs.existsSync(txidFile) && fs.existsSync(recordsPath)) {
      const recordLines = fs.readFileSync(recordsPath, 'utf8').split('\n').filter(Boolean);
      const txidLines = fs.readFileSync(txidFile, 'utf8').split('\n').filter(Boolean);
      const pairLen = Math.min(recordLines.length, txidLines.length);
      const out = [];
      for (let i = 0; i < pairLen; i++) {
        let rec;
        try { rec = JSON.parse(recordLines[i]); } catch { continue; }
        out.push(JSON.stringify({ txid: txidLines[i], record: rec }));
      }
      fs.writeFileSync(annotatedPath, out.join('\n') + '\n');
      annotatedCount = out.length;
      log(`annotated: ${annotatedCount} records paired with txids → ${annotatedPath}`);
    } else {
      log(`warn: cannot build annotated file (txid_file or records missing)`);
    }
  } catch (e) {
    log(`warn: annotated file build failed: ${e.message}`);
  }

  // 9. SYNTHESIS — submit to synthesis agent (skipped if disabled OR amortized)
  let synthesisResult = null;
  let synthesisSats = 0;
  let nanostoreUrl = null;
  let txidsUrl = null;
  // Amortization: synthesis runs only when cycleIdx % SYNTHESIS_EVERY_N === 0.
  // At default N=25, that's cycle 0, 25, 50, ... — 1 synthesis per 25 cycles.
  // SOAK_CYCLES=1 always matches (cycleIdx=0) so smoke tests still produce
  // a synthesis article.
  const synthesisThisCycle = cycleIdx % SYNTHESIS_EVERY_N === 0;
  if (
    ENABLE_SYNTHESIS &&
    synthesisThisCycle &&
    (workerProof.result.proofs_created || 0) > 0 &&
    annotatedCount > 0
  ) {
    const synthBeforeMs = Date.now();
    const absAnnotatedPath = path.resolve(annotatedPath);
    const absTxidsPath = path.resolve(workerProof.result.txid_file);
    const synthTaskText = buildSynthesisTask(
      absAnnotatedPath,
      absTxidsPath,
      cycleId,
      workerProof.result.proofs_created || 0,
      workerProof.result.manifest_sha256 || '',
    );
    log(`synthesis prompt: ${synthTaskText.length}c  annotated_path: ${absAnnotatedPath}`);
    const synthTaskId = await submitTask(SYNTHESIS_PORT, synthTaskText);
    log(`synthesis task: ${synthTaskId}`);
    const synthResult = await pollTaskComplete(
      SYNTHESIS_PORT,
      synthTaskId,
      Date.now() + SYNTHESIS_TIMEOUT_MS,
    );
    log(`synthesis done: status=${synthResult.status}, iter=${synthResult.iterations}, sats=${formatSats(sumSatsFromTask(synthResult))}`);
    await sleep(2000);
    synthesisResult = extractSynthesisResult(SYNTHESIS_WORKSPACE, synthBeforeMs);
    if (synthesisResult) {
      synthesisSats = synthesisResult.sats_spent || sumSatsFromTask(synthResult) || 0;
      nanostoreUrl = synthesisResult.nanostoreUrl;
      txidsUrl = synthesisResult.txidsUrl;
      log(`synthesis HTML URL: ${nanostoreUrl || '(not extracted)'}`);
      log(`synthesis TXIDS URL: ${txidsUrl || '(not extracted)'}`);
    } else {
      synthesisSats = sumSatsFromTask(synthResult) || 0;
      log('warn: synthesis transcript not parsed; using task body sats');
    }
  } else if (!ENABLE_SYNTHESIS) {
    log('synthesis: SKIPPED (ENABLE_SYNTHESIS=0)');
  } else if (!synthesisThisCycle) {
    const nextSynth = SYNTHESIS_EVERY_N - (cycleIdx % SYNTHESIS_EVERY_N);
    log(`synthesis: AMORTIZED OFF (cycle ${cycleIdx}, every ${SYNTHESIS_EVERY_N}, next in ${nextSynth})`);
  } else {
    log('synthesis: SKIPPED (no proofs or no annotated records)');
  }

  const totalSats = captainSats + workerSats + synthesisSats;
  const cycleWallMs = Date.now() - cycleStartMs;

  const cycleSummary = {
    cycleIdx,
    cycleId,
    recordCount,
    scrapeWallMs,
    captainTaskId,
    captainIter: captainResult.iterations,
    captainSats,
    workerTaskId: workerProof.taskId,
    workerSats,
    proofsCreated: workerProof.result.proofs_created || 0,
    proofErrors: workerProof.result.errors || 0,
    firstTxid: workerProof.result.first_txid,
    lastTxid: workerProof.result.last_txid,
    manifestSha256: workerProof.result.manifest_sha256,
    synthesisTaskId: synthesisResult ? synthesisResult.taskId : null,
    synthesisSats,
    nanostoreUrl,
    txidsUrl,
    annotatedCount,
    totalSats,
    satsPerProof: workerProof.result.proofs_created
      ? Math.round(totalSats / workerProof.result.proofs_created)
      : null,
    cycleWallMs,
    cycleWallSec: Math.round(cycleWallMs / 1000),
  };
  log(`CYCLE ${cycleIdx + 1} TOTAL: ${formatSats(totalSats)} (${Math.round(cycleWallMs / 1000)}s)`);
  return cycleSummary;
}

// -----------------------------------------------------------------------------
// Main — boot cluster once, run SOAK_CYCLES cycles, report aggregate
// -----------------------------------------------------------------------------

async function main() {
  const tStart = Date.now();
  log('='.repeat(70));
  log(`DolphinSense Full Pipeline POC (cycle-v2 + synthesis + soak)`);
  log(`run nonce: ${RUN_NONCE}`);
  log(`mode: ${POSTS_ONLY ? 'POSTS_ONLY' : 'post+comments'}, batch_cap=${BATCH_CAP}, subreddit=r/${SUBREDDIT}`);
  log(`soak cycles: ${SOAK_CYCLES}, synthesis: ${ENABLE_SYNTHESIS}`);
  log(`shared dir: ${SHARED_DIR}`);
  log(`output dir: ${OUTPUT_DIR}`);
  log('='.repeat(70));

  log('step 1 — startCluster (3 agents: captain + worker + synthesis)');
  const DEFAULT_CAPS = [
    'llm', 'tools', 'wallet', 'memory', 'messaging', 'x402', 'schedule', 'orchestration',
  ];
  const agents = [
    {
      name: CAPTAIN_NAME,
      port: CAPTAIN_PORT,
      walletPort: CAPTAIN_WALLET_PORT,
      model: CAPTAIN_MODEL,
      workspace: CAPTAIN_WORKSPACE,
      capabilities: [...DEFAULT_CAPS],
      env: { DOLPHIN_MILK_LLM_STALL_TIMEOUT: '300' },
    },
    {
      name: WORKER_NAME,
      port: WORKER_PORT,
      walletPort: WORKER_WALLET_PORT,
      model: WORKER_MODEL,
      workspace: WORKER_WORKSPACE,
      capabilities: [...DEFAULT_CAPS, 'scraping'],
      env: { DOLPHIN_MILK_LLM_STALL_TIMEOUT: '300' },
    },
  ];
  if (ENABLE_SYNTHESIS) {
    agents.push({
      name: SYNTHESIS_NAME,
      port: SYNTHESIS_PORT,
      walletPort: SYNTHESIS_WALLET_PORT,
      model: SYNTHESIS_MODEL,
      workspace: SYNTHESIS_WORKSPACE,
      capabilities: [...DEFAULT_CAPS, 'synthesis'],
      env: { DOLPHIN_MILK_LLM_STALL_TIMEOUT: '300' },
    });
  }

  const handle = await startCluster({
    parentWalletPort: PARENT_WALLET_PORT,
    binary: BINARY,
    overlay: {
      url: OVERLAY_URL,
      verifyRegistration: true,
      registrationTimeoutMs: 45_000,
    },
    outputDir: OUTPUT_DIR,
    agents,
    // SUPERVISE=1 in env enables cluster.js auto-restart of crashed agents.
    // Max 3 restarts/60s with exponential backoff (2s→4s→8s). For 24h runs.
    supervise: process.env.SUPERVISE === '1',
  });

  for (const [name, ag] of handle.agents) {
    log(`  ${name}: ${ag.identityKey.slice(0, 16)}...`);
  }

  const cycleSummaries = [];
  let fatalError = null;

  // Build the aggregate object from current state. Called both
  // incrementally after each cycle (so the UI can see partial progress)
  // and once at the end. The UI's handleCycleAggregate reads cycles[],
  // so incremental writes with a growing cycles[] array give live visibility.
  function buildAggregate() {
    const successCyclesLocal = cycleSummaries.filter((s) => !s.error);
    const totalSatsAll = successCyclesLocal.reduce((acc, s) => acc + (s.totalSats || 0), 0);
    const totalProofsAll = successCyclesLocal.reduce((acc, s) => acc + (s.proofsCreated || 0), 0);
    const totalWallSecLocal = Math.round((Date.now() - tStart) / 1000);
    return {
      runNonce: RUN_NONCE,
      mode: POSTS_ONLY ? 'POSTS_ONLY' : 'post+comments',
      batchCap: BATCH_CAP,
      soakCycles: SOAK_CYCLES,
      successCycles: successCyclesLocal.length,
      completedCycles: cycleSummaries.length,
      inProgress: cycleSummaries.length < SOAK_CYCLES,
      synthesisEnabled: ENABLE_SYNTHESIS,
      totalSats: totalSatsAll,
      totalProofs: totalProofsAll,
      satsPerProofAvg: totalProofsAll > 0 ? Math.round(totalSatsAll / totalProofsAll) : null,
      avgCycleSats: successCyclesLocal.length > 0 ? Math.round(totalSatsAll / successCyclesLocal.length) : null,
      avgCycleWallSec: successCyclesLocal.length > 0
        ? Math.round(successCyclesLocal.reduce((acc, s) => acc + (s.cycleWallMs || 0), 0) / successCyclesLocal.length / 1000)
        : null,
      totalWallSec: totalWallSecLocal,
      fatalError: fatalError ? String(fatalError.message) : null,
      cycles: cycleSummaries,
    };
  }

  function writeAggregateIncremental() {
    try {
      const aggregatePath = path.join(OUTPUT_DIR, 'aggregate.json');
      const tmp = `${aggregatePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(buildAggregate(), null, 2));
      fs.renameSync(tmp, aggregatePath);
    } catch (e) {
      log(`warn: incremental aggregate write failed: ${e.message}`);
    }
  }

  try {
    for (let i = 0; i < SOAK_CYCLES; i++) {
      try {
        const summary = await runCycle(handle, i);
        cycleSummaries.push(summary);
      } catch (e) {
        log(`CYCLE ${i + 1} FAILED: ${e.message}`);
        cycleSummaries.push({ cycleIdx: i, error: String(e.message) });
        // Continue to next cycle so we still get partial soak data
      }
      // Write aggregate.json after every cycle (success or fail) so the
      // UI can see articles + tx counts incrementally, not just at end-of-run.
      writeAggregateIncremental();
    }
  } catch (e) {
    fatalError = e;
    log(`FATAL outside cycle loop: ${e.message}`);
  } finally {
    // Final aggregate (one more definitive write after loop exits, so
    // `inProgress: false` is captured even on fatal errors).
    const aggregate = buildAggregate();
    aggregate.inProgress = false;
    const successCycles = cycleSummaries.filter((s) => !s.error);

    log('='.repeat(70));
    log('AGGREGATE SOAK SUMMARY');
    log('='.repeat(70));
    console.log(JSON.stringify(aggregate, null, 2));

    // Per-cycle table
    log('');
    log('per-cycle:');
    log('  #   recs  proofs   captainSats   workerSats   synthSats   totalSats   wallSec   nanostoreUrl');
    for (const s of cycleSummaries) {
      if (s.error) {
        log(`  ${String(s.cycleIdx + 1).padStart(2)}  ERROR: ${s.error}`);
        continue;
      }
      log(
        `  ${String(s.cycleIdx + 1).padStart(2)}  ${String(s.recordCount).padStart(4)}  ${String(s.proofsCreated).padStart(6)}   ${String(s.captainSats).padStart(11)}   ${String(s.workerSats).padStart(10)}   ${String(s.synthesisSats).padStart(9)}   ${String(s.totalSats).padStart(9)}   ${String(s.cycleWallSec).padStart(7)}   ${s.nanostoreUrl || '-'}`,
      );
    }

    const aggregatePath = path.join(OUTPUT_DIR, 'aggregate.json');
    try {
      fs.writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2));
      log(`aggregate written to ${aggregatePath}`);
    } catch (e) {
      log(`warn: failed to write aggregate.json: ${e.message}`);
    }

    log('stopping cluster...');
    try {
      await handle.stop();
    } catch (e) {
      log(`warn: cluster stop error: ${e.message}`);
    }
  }
}

main().catch((err) => {
  console.error('[cycle-v2] FATAL:', err);
  process.exitCode = 1;
});
