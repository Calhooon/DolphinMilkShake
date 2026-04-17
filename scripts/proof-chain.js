#!/usr/bin/env node
/**
 * proof-chain.js — high-throughput OP_RETURN tx chain builder.
 *
 * Bypasses the wallet's createAction API entirely. Instead:
 *   1. Wallet sends a seed UTXO to an ephemeral key (acceptDelayedBroadcast=false)
 *   2. Build a chain of N txs offline (each spends previous change)
 *   3. Broadcast the entire chain via ARC in one batch
 *
 * Each tx has 1 OP_RETURN output (SHA-256 hash of a record) + 1 P2PKH change
 * output back to the same ephemeral key. Chain of 500 txs from 1 seed UTXO.
 *
 * Speed: limited only by local signing (~1-5ms/tx). 500 txs built in <1s.
 * Cost: ~1 sat/tx mining fee + dust for change = ~100-150 sats per chain of 500.
 * That's 0.2-0.3 sats/tx. At 1.5M txs: ~450k sats ≈ $0.28.
 *
 * Usage:
 *   node scripts/proof-chain.js --lane bsky-en
 *
 * Environment:
 *   SOAK_CYCLES       number of cycles (default 100, each cycle = 1 chain)
 *   BATCH_CAP         records per cycle / txs per chain (default 500)
 *   SEED_SATS         sats to seed each chain with (default 100000)
 *   ARC_URL           ARC broadcaster URL (default TAAL)
 *   TAAL_API_KEY      TAAL API key
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const {
  PrivateKey,
  Transaction,
  P2PKH,
  ARC,
  LockingScript,
  UnlockingScript,
} = require('@bsv/sdk');

// ---- config ----------------------------------------------------------------

const DOLPHINMILKSHAKE_ROOT = process.env.DOLPHINMILKSHAKE_ROOT
  || path.resolve(__dirname, '..');
const RUST_BSV_WORM_DIR = process.env.RUST_BSV_WORM_DIR
  || path.resolve(process.env.HOME, 'bsv/dolphin-milk');

const LANES_FILE = process.env.LANES_FILE
  || path.join(DOLPHINMILKSHAKE_ROOT, 'fleet/lanes.json');
const FIREHOSE_DIR = process.env.FIREHOSE_DIR || '/tmp/dolphinsense-firehose';

let LANE_ID = process.env.LANE_ID || '';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--lane' && process.argv[i + 1]) {
    LANE_ID = process.argv[i + 1]; i++;
  }
}
if (!LANE_ID) { console.error('[proof-chain] FATAL: --lane <id> required'); process.exit(2); }

const lanesDoc = JSON.parse(fs.readFileSync(LANES_FILE, 'utf8'));
const laneConfig = (lanesDoc.lanes || []).find((l) => l.id === LANE_ID);
if (!laneConfig) { console.error(`[proof-chain] FATAL: lane '${LANE_ID}' not found`); process.exit(2); }
const agentByRole = Object.fromEntries((laneConfig.agents || []).map((a) => [a.role, a]));

// QUEUE_LANE overrides which lane's feeder queue to read from.
// Lets a lane consume records from a different queue (e.g. bsky-en-12
// reads from wiki-en's queue when its own is empty).
const SUBREDDIT = process.env.QUEUE_LANE || laneConfig.subreddit || LANE_ID;
const WORKER_WALLET_PORT = agentByRole.worker.wallet_port;
const WALLET_URL = `http://localhost:${WORKER_WALLET_PORT}`;

const SOAK_CYCLES = parseInt(process.env.SOAK_CYCLES || '100', 10);
const BATCH_CAP = parseInt(process.env.BATCH_CAP || '500', 10);
const SEED_SATS = parseInt(process.env.SEED_SATS || '100000', 10);

const ARC_URL = process.env.ARC_URL || 'https://api.taal.com/arc';
const TAAL_API_KEY = process.env.TAAL_API_KEY || process.env.MAIN_TAAL_API_KEY || 'mainnet_9596de07e92300c6287e4393594ae39c';

const RUN_NONCE = crypto.randomBytes(4).toString('hex');
const FLEET_WORKSPACE_ROOT = path.join(RUST_BSV_WORM_DIR, 'test-workspaces/fleet');
const OUTPUT_DIR = path.join(FLEET_WORKSPACE_ROOT, LANE_ID, `proof-chain-${RUN_NONCE}`);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---- helpers ---------------------------------------------------------------

function log(msg) { console.log(`[proof-chain] ${msg}`); }

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function walletPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, WALLET_URL);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Origin': WALLET_URL },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`parse error: ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

// ---- queue claim -----------------------------------------------------------

function claimFromQueue(cycleDir) {
  const recordsPath = path.join(cycleDir, 'records.jsonl');
  const subDir = path.join(FIREHOSE_DIR, SUBREDDIT);
  const queuePath = path.join(subDir, 'queue.jsonl');
  const claimPath = `${queuePath}.claimed`;
  if (!fs.existsSync(queuePath)) throw new Error(`queue not found: ${queuePath}`);
  let watermark = 0;
  try { watermark = parseInt(fs.readFileSync(claimPath, 'utf8').trim(), 10) || 0; } catch {}
  const stat = fs.statSync(queuePath);
  if (watermark >= stat.size) throw new Error('no unclaimed records');
  const wantBytes = Math.min(stat.size - watermark, 8 * 1024 * 1024);
  const fd = fs.openSync(queuePath, 'r');
  const buf = Buffer.alloc(wantBytes);
  fs.readSync(fd, buf, 0, wantBytes, watermark);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) throw new Error('no complete lines');
  const lines = text.slice(0, lastNl + 1).split('\n').filter(Boolean);
  const claimed = lines.slice(0, BATCH_CAP);
  const claimedBytes = claimed.reduce((a, l) => a + Buffer.byteLength(l, 'utf8') + 1, 0);
  fs.writeFileSync(recordsPath, claimed.join('\n') + '\n');
  const tmp = `${claimPath}.tmp`;
  fs.writeFileSync(tmp, String(watermark + claimedBytes));
  fs.renameSync(tmp, claimPath);
  log(`claimed ${claimed.length} records`);
  return { recordsPath, lines: claimed };
}

// ---- chain builder ---------------------------------------------------------

/**
 * Build a chain of OP_RETURN txs from a single seed UTXO.
 * Returns array of { txid, rawHex } ready for broadcast.
 */
async function buildChain(ephemeralKey, seedTxid, seedVout, seedSats, records, seedTx) {
  const txs = [];
  const p2pkh = new P2PKH();
  const changeScript = p2pkh.lock(ephemeralKey.toAddress());

  let prevTx = seedTx;
  let prevVout = seedVout;
  let prevSats = seedSats;

  for (let i = 0; i < records.length; i++) {
    const hash = sha256hex(records[i]);
    const opReturnScript = LockingScript.fromHex(`006a20${hash}`);

    // ~220 bytes per OP_RETURN tx. At 100 sats/KB = 0.1 sats/byte → ~22 sats fee.
    // Round up to 25 for safety margin.
    const FEE = 25;
    const changeSats = prevSats - FEE;
    if (changeSats < 1) {
      log(`chain exhausted at tx ${i} (${prevSats} sats left)`);
      break;
    }

    const tx = new Transaction();

    tx.addInput({
      sourceTransaction: prevTx,
      sourceOutputIndex: prevVout,
      unlockingScriptTemplate: p2pkh.unlock(ephemeralKey),
    });

    tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 });
    tx.addOutput({ lockingScript: changeScript, satoshis: changeSats });

    await tx.sign();

    txs.push({ txid: tx.id('hex'), rawHex: tx.toHex(), index: i });

    // Chain: next tx spends this tx's output 1 (change)
    prevTx = tx;
    prevVout = 1;
    prevSats = changeSats;
  }

  return txs;
}

// ---- broadcast in batches --------------------------------------------------

const BROADCAST_BATCH = parseInt(process.env.BROADCAST_BATCH || '10', 10);

async function broadcastChain(txs) {
  const broadcaster = new ARC(ARC_URL, TAAL_API_KEY);
  let success = 0;
  let errors = 0;

  // Broadcast in batches of BROADCAST_BATCH. Each batch is submitted via
  // broadcastMany (single HTTP request with N txs). Txs within a batch
  // are ordered (chain dependency), and ARC processes them sequentially.
  for (let i = 0; i < txs.length; i += BROADCAST_BATCH) {
    const batch = txs.slice(i, i + BROADCAST_BATCH);
    const txObjects = batch.map((t) => Transaction.fromHex(t.rawHex));

    try {
      const result = await broadcaster.broadcastMany(txObjects);
      // broadcastMany returns an array of results, one per tx
      if (Array.isArray(result)) {
        for (const r of result) {
          if (r.status === 'success' || r.txid) success++;
          else errors++;
        }
      } else if (result.status === 'success' || result.txid) {
        success += batch.length;
      } else {
        errors += batch.length;
        log(`  batch ${Math.floor(i / BROADCAST_BATCH)}: ${JSON.stringify(result).slice(0, 150)}`);
      }
    } catch (e) {
      // Fallback: try individually
      for (const t of batch) {
        try {
          const tx = Transaction.fromHex(t.rawHex);
          const r = await broadcaster.broadcast(tx);
          if (r.status === 'success' || r.txid) success++;
          else errors++;
        } catch {
          errors++;
        }
      }
      if (errors > 0 && (errors <= 3 || errors % 50 === 0)) {
        log(`  batch broadcast failed, fell back to sequential: ${e.message.slice(0, 80)}`);
      }
    }
  }

  return { success, errors };
}

// ---- run one cycle ---------------------------------------------------------

async function runCycle(cycleIdx) {
  const cycleId = `${RUN_NONCE}-${String(cycleIdx).padStart(3, '0')}`;
  const cycleDir = path.join(OUTPUT_DIR, `cycle-${cycleId}`);
  fs.mkdirSync(cycleDir, { recursive: true });

  const t0 = Date.now();
  log(`--- CYCLE ${cycleIdx + 1}/${SOAK_CYCLES} ---`);

  // 1. claim records
  let claim;
  try { claim = claimFromQueue(cycleDir); }
  catch (e) { log(`SKIP: ${e.message}`); return { txs: 0, errors: 0, wallMs: Date.now() - t0 }; }

  // 2. generate ephemeral key for this chain
  const ephemeralKey = PrivateKey.fromRandom();
  const ephemeralAddr = ephemeralKey.toAddress();
  log(`ephemeral: ${ephemeralAddr}`);

  // 3. seed the ephemeral key from the worker wallet
  const sendResult = await walletPost('/createAction', {
    description: 'dolphinsense chain seed',
    outputs: [{
      lockingScript: new P2PKH().lock(ephemeralAddr).toHex(),
      satoshis: SEED_SATS,
      outputDescription: 'chain seed UTXO for proof batch',
    }],
    options: { acceptDelayedBroadcast: false },
  });

  if (!sendResult.txid) {
    log(`seed FAILED: ${JSON.stringify(sendResult).slice(0, 200)}`);
    return { txs: 0, errors: 1, wallMs: Date.now() - t0 };
  }
  log(`seed tx: ${sendResult.txid.slice(0, 16)}... (${SEED_SATS} sats)`);

  // The wallet returns { txid, tx: [...byte array...] } — tx is BEEF format.
  // Parse with Transaction.fromBEEF to get a proper Transaction with outputs.
  const beefBytes = Array.from(Buffer.from(sendResult.tx));
  const seedTx = Transaction.fromBEEF(beefBytes);

  // Find which vout matches our SEED_SATS output
  let seedVout = 0;
  for (let v = 0; v < seedTx.outputs.length; v++) {
    if (seedTx.outputs[v].satoshis === SEED_SATS) { seedVout = v; break; }
  }

  // 4. build the chain offline (fast — just signing, no network)
  const t1 = Date.now();
  const chain = await buildChain(ephemeralKey, sendResult.txid, seedVout, SEED_SATS, claim.lines, seedTx);
  const buildMs = Date.now() - t1;
  log(`built ${chain.length} txs in ${buildMs}ms (${chain.length > 0 ? Math.round(buildMs / chain.length) + 'ms/tx' : '-'})`);

  // 5. broadcast the chain
  const t2 = Date.now();
  const { success, errors } = await broadcastChain(chain);
  const broadcastMs = Date.now() - t2;
  log(`broadcast: ${success} ok, ${errors} errors in ${Math.round(broadcastMs / 1000)}s`);

  // 6. write txids to shared dir for UI
  const txids = chain.map((t) => t.txid);
  fs.writeFileSync(path.join(cycleDir, 'txids.txt'), txids.join('\n') + '\n');

  const SHARED_DIR = process.env.SHARED_DIR_BASE || '/tmp/dolphinsense-shared';
  const sharedCycleDir = path.join(SHARED_DIR, LANE_ID, `cycle-${cycleId}`);
  fs.mkdirSync(sharedCycleDir, { recursive: true });
  fs.writeFileSync(path.join(sharedCycleDir, 'records.jsonl.txids'), txids.join('\n') + '\n');

  const wallMs = Date.now() - t0;
  log(`CYCLE ${cycleIdx + 1} DONE: ${success} txs, ${errors} errors, ${Math.round(wallMs / 1000)}s`);

  return { txs: success, errors, wallMs, buildMs, broadcastMs };
}

// ---- main ------------------------------------------------------------------

async function main() {
  log('======================================================================');
  log(`proof-chain: lane=${LANE_ID} wallet=${WALLET_URL}`);
  log(`cycles=${SOAK_CYCLES} batch=${BATCH_CAP} seed=${SEED_SATS} arc=${ARC_URL}`);
  log(`output: ${OUTPUT_DIR}`);
  log('======================================================================');

  // Verify wallet
  try {
    const pk = await walletPost('/getPublicKey', { identityKey: true });
    log(`wallet: ${pk.publicKey ? pk.publicKey.slice(0, 16) + '...' : '?'}`);
  } catch { log('FATAL: wallet not reachable'); process.exit(3); }

  const tStart = Date.now();
  let totalTxs = 0, totalErrors = 0, successCycles = 0;
  const summaries = [];

  for (let i = 0; i < SOAK_CYCLES; i++) {
    const r = await runCycle(i);
    summaries.push(r);
    totalTxs += r.txs; totalErrors += r.errors;
    if (r.txs > 0) successCycles++;
  }

  const totalMs = Date.now() - tStart;
  const agg = {
    mode: 'proof-chain', lane: LANE_ID, runNonce: RUN_NONCE,
    soakCycles: SOAK_CYCLES, batchCap: BATCH_CAP, seedSats: SEED_SATS,
    successCycles, totalTxs, totalErrors,
    totalWallSec: Math.round(totalMs / 1000),
    txsPerSecond: totalMs > 0 ? (totalTxs / (totalMs / 1000)).toFixed(1) : '0',
    cycles: summaries,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'aggregate.json'), JSON.stringify(agg, null, 2) + '\n');

  log('======================================================================');
  log(`COMPLETE: ${totalTxs} txs in ${Math.round(totalMs / 1000)}s (${agg.txsPerSecond} tx/sec)`);
  log(`  cycles: ${successCycles}/${SOAK_CYCLES}, errors: ${totalErrors}`);
  log('======================================================================');
}

main().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
