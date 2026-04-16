#!/usr/bin/env node
/**
 * proof-only-cycle.js — high-throughput OP_RETURN proof factory.
 *
 * Bypasses the full agent pipeline (captain LLM → worker LLM → synthesis)
 * and runs proof_batch.sh DIRECTLY from the harness. Each cycle:
 *   1. Claims BATCH_CAP records from the feeder queue
 *   2. Hashes each record (SHA-256)
 *   3. Creates one OP_RETURN per record via the lane's worker wallet API
 *   4. Writes txids + manifest to disk
 *   5. Advances watermark
 *
 * No dolphin-milk binary needed. No MetaNet clicks. No LLM inference.
 * Cost per proof: ~130 sats (the OP_RETURN createAction fee alone).
 *
 * At BATCH_CAP=500 × 30 lanes × 100 cycles = 1,500,000 proofs.
 * Cost: 1.5M × 130 = 195M sats ≈ $122.
 * Time: ~2 min/cycle × 100 cycles = ~3.3 hours.
 *
 * Usage:
 *   node scripts/proof-only-cycle.js --lane bsky-en
 *
 * Environment (same as lane-cycle.js):
 *   SOAK_CYCLES       number of cycles (default 100)
 *   BATCH_CAP         records per cycle (default 500)
 *   FIREHOSE_DIR      feeder queue root (default /tmp/dolphinsense-firehose)
 *   LANES_FILE        path to fleet/lanes.json
 *   INVENTORY_FILE    path to INVENTORY.json
 *   PARALLELISM       proof_batch.sh parallelism (default 4)
 *
 * Runs as a single node process — fleet-proof-only.sh wraps N of these.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// execSync removed — batched proof creation is pure Node, no bash subprocess

// ---- config ----------------------------------------------------------------

const DOLPHINMILKSHAKE_ROOT = process.env.DOLPHINMILKSHAKE_ROOT
  || path.resolve(__dirname, '..');
const RUST_BSV_WORM_DIR = process.env.RUST_BSV_WORM_DIR
  || path.resolve(process.env.HOME, 'bsv/rust-bsv-worm');

const LANES_FILE = process.env.LANES_FILE
  || path.join(DOLPHINMILKSHAKE_ROOT, 'fleet/lanes.json');
const INVENTORY_FILE = process.env.INVENTORY_FILE
  || `${process.env.HOME}/bsv/wallets/fleet/INVENTORY.json`;
const FIREHOSE_DIR = process.env.FIREHOSE_DIR || '/tmp/dolphinsense-firehose';

let LANE_ID = process.env.LANE_ID || '';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--lane' && process.argv[i + 1]) {
    LANE_ID = process.argv[i + 1];
    i += 1;
  }
}
if (!LANE_ID) {
  console.error('[proof-only] FATAL: --lane <id> or LANE_ID env required');
  process.exit(2);
}

const lanesDoc = JSON.parse(fs.readFileSync(LANES_FILE, 'utf8'));
const laneConfig = (lanesDoc.lanes || []).find((l) => l.id === LANE_ID);
if (!laneConfig) {
  console.error(`[proof-only] FATAL: lane '${LANE_ID}' not found in ${LANES_FILE}`);
  process.exit(2);
}
const agentByRole = Object.fromEntries(
  (laneConfig.agents || []).map((a) => [a.role, a]),
);

const SUBREDDIT = laneConfig.subreddit || LANE_ID;
const WORKER_WALLET_PORT = agentByRole.worker.wallet_port;
const WALLET_URL = `http://localhost:${WORKER_WALLET_PORT}`;

const SOAK_CYCLES = parseInt(process.env.SOAK_CYCLES || '100', 10);
const BATCH_CAP = parseInt(process.env.BATCH_CAP || '500', 10);

const RUN_NONCE = crypto.randomBytes(4).toString('hex');
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const FLEET_WORKSPACE_ROOT = process.env.FLEET_WORKSPACE_ROOT
  || path.join(RUST_BSV_WORM_DIR, 'test-workspaces/fleet');
const OUTPUT_DIR = path.join(
  FLEET_WORKSPACE_ROOT,
  LANE_ID,
  `proof-only-${RUN_TIMESTAMP}-${RUN_NONCE}`,
);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---- logging ---------------------------------------------------------------

function log(msg) {
  console.log(`[proof-only] ${msg}`);
}
function formatSats(n) {
  return n == null ? 'null' : n.toLocaleString();
}

// ---- chained proof creation (1 tx per proof, delayed broadcast) ------------
//
// Each record → 1 createAction → 1 OP_RETURN tx → 1 on-chain transaction.
// The goal is to MAXIMIZE tx count (1.5M target), not minimize cost.
//
// acceptDelayedBroadcast=true: wallet creates + signs the tx locally and
// returns the txid immediately. The change output feeds the next tx in the
// chain. Broadcast happens in the background. This means we're limited by
// local signing speed (~10-50ms/tx) not network latency (~1s/tx).
//
// The wallet internally chains UTXOs: tx1's change → tx2's input → tx2's
// change → tx3's input → ... Building a chain of N transactions from a
// single starting UTXO, all broadcast in bulk.

const http = require('http');

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * POST JSON to a wallet HTTP endpoint. Returns parsed response body.
 */
function walletPost(walletUrl, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, walletUrl);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Origin': walletUrl,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`wallet parse error: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('wallet timeout')); });
    req.write(data);
    req.end();
  });
}

// CHAIN_LEN: number of txs per UTXO chain. First (N-1) use delayed
// broadcast (fast, ~50-100ms — local sign only, UTXO stays locked). The
// Nth tx broadcasts synchronously (~1s), which releases all N change
// outputs back to the pool. Net: each chain of N consumes 1 UTXO from
// the pool and produces 1 fresh UTXO (the Nth tx's change). With 144
// starting UTXOs we can do 144 chains × 10 = 1440 txs per cycle.
//
// For 500 records/cycle we need ceil(500/10) = 50 chains = 50 UTXOs.
// Split the wallet to 50+ UTXOs before running.
const CHAIN_LEN = parseInt(process.env.CHAIN_LEN || '10', 10);

/**
 * Create a single OP_RETURN proof tx. `flush` controls broadcast mode.
 */
async function createProofTx(record, flush) {
  const hash = sha256hex(record);
  const result = await walletPost(WALLET_URL, '/createAction', {
    description: 'dolphinsense provenance',
    outputs: [{
      lockingScript: `006a20${hash}`,
      satoshis: 0,
      outputDescription: 'dolphinsense record proof',
    }],
    options: { acceptDelayedBroadcast: !flush },
  });

  if (!result.txid) {
    throw new Error(`createAction failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return result.txid;
}

// ---- queue claim (same logic as lane-cycle.js claimFromQueue) --------------

function claimFromQueue(cycleDir) {
  const t0 = Date.now();
  const recordsPath = path.join(cycleDir, 'records.jsonl');
  const subDir = path.join(FIREHOSE_DIR, SUBREDDIT);
  const queuePath = path.join(subDir, 'queue.jsonl');
  const claimPath = `${queuePath}.claimed`;

  if (!fs.existsSync(queuePath)) {
    throw new Error(`queue not found: ${queuePath}`);
  }

  let watermark = 0;
  try {
    watermark = parseInt(fs.readFileSync(claimPath, 'utf8').trim(), 10) || 0;
  } catch {
    watermark = 0;
  }

  const stat = fs.statSync(queuePath);
  if (watermark >= stat.size) {
    throw new Error(`no unclaimed records (watermark=${watermark} size=${stat.size})`);
  }

  const wantBytes = Math.min(stat.size - watermark, 8 * 1024 * 1024); // 8MB for 500 records
  const fd = fs.openSync(queuePath, 'r');
  const buf = Buffer.alloc(wantBytes);
  fs.readSync(fd, buf, 0, wantBytes, watermark);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) throw new Error('no complete lines at watermark');
  const lines = text.slice(0, lastNewline + 1).split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('no records after watermark');

  const claimed = lines.slice(0, BATCH_CAP);
  const claimedBytes = claimed.reduce(
    (acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1,
    0,
  );
  const newWatermark = watermark + claimedBytes;

  fs.writeFileSync(recordsPath, claimed.join('\n') + '\n');

  const tmpClaim = `${claimPath}.tmp`;
  fs.writeFileSync(tmpClaim, String(newWatermark));
  fs.renameSync(tmpClaim, claimPath);

  const wallMs = Date.now() - t0;
  log(`claimed ${claimed.length} records (watermark ${watermark}→${newWatermark}, ${wallMs}ms)`);
  return { recordsPath, recordCount: claimed.length };
}

// ---- run one cycle ---------------------------------------------------------

async function runCycle(cycleIdx) {
  const cycleId = `${RUN_NONCE}-${String(cycleIdx).padStart(3, '0')}`;
  const cycleDir = path.join(OUTPUT_DIR, `cycle-${cycleId}`);
  fs.mkdirSync(cycleDir, { recursive: true });

  const t0 = Date.now();
  log(`--- CYCLE ${cycleIdx + 1}/${SOAK_CYCLES} id=${cycleId} ---`);

  // 1. claim records
  let claim;
  try {
    claim = claimFromQueue(cycleDir);
  } catch (e) {
    log(`SKIP: ${e.message}`);
    return { cycleIdx, error: e.message, proofs: 0, txs: 0, wallMs: Date.now() - t0 };
  }

  // 2. read records — each becomes 1 tx (1 record = 1 createAction = 1 on-chain tx)
  const lines = fs.readFileSync(claim.recordsPath, 'utf8').split('\n').filter(Boolean);

  // 3. process in chains of CHAIN_LEN. Within each chain:
  //    - txs 1..(N-1): acceptDelayedBroadcast=true (fast, ~50-100ms, locks 1 UTXO)
  //    - tx N: acceptDelayedBroadcast=false (flush, ~1s, broadcasts the chain)
  //    Each chain consumes 1 starting UTXO. Need ceil(records/CHAIN_LEN) UTXOs.
  const txids = [];
  let errors = 0;

  for (let i = 0; i < lines.length; i++) {
    const posInChain = (i % CHAIN_LEN) + 1; // 1-based position
    const isFlush = posInChain === CHAIN_LEN || i === lines.length - 1; // flush on Nth or last record
    try {
      const txid = await createProofTx(lines[i], isFlush);
      txids.push(txid);
      // After flush, brief pause so wallet UTXO index settles before next chain
      if (isFlush) await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      errors++;
      if (errors === 1 || errors % 50 === 0) {
        log(`  tx ${i + 1}/${lines.length} FAILED (${errors} total): ${e.message.slice(0, 100)}`);
      }
    }
  }

  // 4. write txid file to both proof-only dir AND shared dir for UI
  const txidPath = path.join(cycleDir, 'txids.txt');
  fs.writeFileSync(txidPath, txids.join('\n') + '\n');

  const SHARED_DIR = process.env.SHARED_DIR_BASE || '/tmp/dolphinsense-shared';
  const sharedCycleDir = path.join(SHARED_DIR, LANE_ID, `cycle-${cycleId}`);
  fs.mkdirSync(sharedCycleDir, { recursive: true });
  fs.writeFileSync(
    path.join(sharedCycleDir, 'records.jsonl.txids'),
    txids.join('\n') + '\n',
  );

  const manifestSha = sha256hex(txids.join('\n') + '\n');
  const wallMs = Date.now() - t0;
  const txCount = txids.length;
  log(
    `CYCLE ${cycleIdx + 1} DONE: ${txCount} txs, ${errors} errors, ` +
    `${Math.round(wallMs / 1000)}s wall, ` +
    `${txCount > 0 ? Math.round(wallMs / txCount) + 'ms/tx' : '-'}`,
  );

  const manifest = {
    cycleId, cycleIdx, lane: LANE_ID,
    txs: txCount, errors, wallMs,
    txidFile: txidPath, manifestSha256: manifestSha,
    firstTxid: txids[0] || null, lastTxid: txids[txids.length - 1] || null,
  };
  fs.writeFileSync(path.join(cycleDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  return { cycleIdx, txs: txCount, errors, wallMs };
}

// ---- main ------------------------------------------------------------------

async function main() {
  log('======================================================================');
  log(`proof-only-cycle: lane=${LANE_ID} wallet=${WALLET_URL}`);
  log(`cycles=${SOAK_CYCLES} batch=${BATCH_CAP} chain=${CHAIN_LEN} (delayed ${CHAIN_LEN - 1}, flush 1)`);
  log(`output: ${OUTPUT_DIR}`);
  log('======================================================================');

  // Verify wallet is reachable
  try {
    const pk = await walletPost(WALLET_URL, '/getPublicKey', { identityKey: true });
    log(`wallet identity: ${pk.publicKey ? pk.publicKey.slice(0, 16) + '...' : '?'}`);
  } catch {
    log(`FATAL: wallet at ${WALLET_URL} not reachable`);
    process.exit(3);
  }

  const tStart = Date.now();
  let totalTxs = 0;
  let totalErrors = 0;
  let successCycles = 0;
  const cycleSummaries = [];

  for (let i = 0; i < SOAK_CYCLES; i++) {
    const result = await runCycle(i);
    cycleSummaries.push(result);
    totalTxs += result.txs || 0;
    totalErrors += result.errors || 0;
    if ((result.txs || 0) > 0) successCycles++;
  }

  const totalWallMs = Date.now() - tStart;

  // Write aggregate
  const aggregate = {
    mode: 'proof-only-chained',
    lane: LANE_ID,
    runNonce: RUN_NONCE,
    soakCycles: SOAK_CYCLES,
    batchCap: BATCH_CAP,
    chainLen: CHAIN_LEN,
    successCycles,
    completedCycles: SOAK_CYCLES,
    totalTxs,
    totalErrors,
    totalWallSec: Math.round(totalWallMs / 1000),
    avgTxsPerCycle: successCycles > 0 ? Math.round(totalTxs / successCycles) : 0,
    txsPerSecond: totalWallMs > 0 ? (totalTxs / (totalWallMs / 1000)).toFixed(1) : '0',
    cycles: cycleSummaries,
  };
  const aggPath = path.join(OUTPUT_DIR, 'aggregate.json');
  fs.writeFileSync(aggPath, JSON.stringify(aggregate, null, 2) + '\n');

  log('======================================================================');
  log(`PROOF-ONLY COMPLETE: ${totalTxs} txs (${Math.round(totalWallMs / 1000)}s)`);
  log(`  success cycles: ${successCycles}/${SOAK_CYCLES}`);
  log(`  errors: ${totalErrors}`);
  log(`  rate: ${aggregate.txsPerSecond} tx/sec`);
  log(`  mode: chain ${CHAIN_LEN} (delayed ${CHAIN_LEN - 1}, flush 1)`);
  log(`  aggregate: ${aggPath}`);
  log('======================================================================');
}

main();
