#!/usr/bin/env node
//
// wallet-watchdog.js — background top-up daemon for the fleet.
//
// Polls INVENTORY.json every N seconds (default 30). For every captain and
// synthesis wallet (workers are self-sustaining via x402 inflow), if balance
// is under 1,000,000 sats, shells out to scripts/fund-wallet.sh to top up:
//
//   captain   → target 5,000,000 sats, split 10 fresh untagged UTXOs
//   synthesis → target 2,000,000 sats, split 10 fresh untagged UTXOs
//
// fund-wallet.sh does N small sends from the master wallet (port 3322). Each
// send creates ONE fresh untagged BRC-29 output on the receiver. The receiver's
// existing UTXOs are NEVER touched, so this is safe to run while lane cycles
// are mid-flight — no consolidation, no rekey, no daemon restarts.
//
// Usage:
//   node scripts/wallet-watchdog.js                 # run forever, 30s interval
//   node scripts/wallet-watchdog.js --once          # single pass, exit
//   node scripts/wallet-watchdog.js --dry-run       # show what WOULD topup
//   node scripts/wallet-watchdog.js --interval 60   # poll every 60s
//   node scripts/wallet-watchdog.js --only captain-bsky-en --once
//
// Run in background:
//   nohup node scripts/wallet-watchdog.js > /tmp/wallet-watchdog.log 2>&1 &
//
// Environment:
//   BIN                 bsv-wallet CLI binary path
//   SOURCE_ENV          master wallet .env path (default: 3322 legacy)
//   SOURCE_DB           master wallet .db path
//   INVENTORY           path to fleet INVENTORY.json
//   WATCHDOG_THRESHOLD  sats threshold (default 1000000)
//

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// -------------------------- config --------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();

const BIN = process.env.BIN || path.join(HOME, 'bsv/bsv-wallet-cli/target/release/bsv-wallet');
const SOURCE_ENV = process.env.SOURCE_ENV || path.join(HOME, 'bsv/_archived/bsv-wallet-cli-old/.env');
const SOURCE_DB = process.env.SOURCE_DB || path.join(HOME, 'bsv/_archived/bsv-wallet-cli-old/wallet.db');
const INVENTORY = process.env.INVENTORY || path.join(HOME, 'bsv/wallets/fleet/INVENTORY.json');
const FUND_SCRIPT = path.join(REPO_ROOT, 'scripts/fund-wallet.sh');

const THRESHOLD = parseInt(process.env.WATCHDOG_THRESHOLD || '1000000', 10);
const SPLIT = 10;
const TARGET_BY_ROLE = {
  captain: 5_000_000,
  synthesis: 2_000_000,
};

// -------------------------- args --------------------------

const args = process.argv.slice(2);
const opts = { once: false, dryRun: false, interval: 30, only: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--once') opts.once = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--interval') opts.interval = parseInt(args[++i], 10);
  else if (a === '--only') opts.only = args[++i];
  else if (a === '-h' || a === '--help') {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 33).map((l) => l.replace(/^\/\/\s?/, '')).join('\n') + '\n');
    process.exit(0);
  } else {
    console.error(`unknown flag: ${a}`);
    process.exit(1);
  }
}

// -------------------------- logging --------------------------

const C = {
  red: '\x1b[0;31m', green: '\x1b[0;32m', yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m', dim: '\x1b[2m', nc: '\x1b[0m',
};
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log  = (m) => console.log(`${C.dim}[${ts()}]${C.nc} ${C.blue}[watchdog]${C.nc} ${m}`);
const ok   = (m) => console.log(`${C.dim}[${ts()}]${C.nc} ${C.green}[ OK ]${C.nc}    ${m}`);
const warn = (m) => console.log(`${C.dim}[${ts()}]${C.nc} ${C.yellow}[WARN]${C.nc}    ${m}`);
const err  = (m) => console.log(`${C.dim}[${ts()}]${C.nc} ${C.red}[FAIL]${C.nc}    ${m}`);

// -------------------------- preflight --------------------------

function preflight() {
  if (!fs.existsSync(BIN)) throw new Error(`bsv-wallet binary not found: ${BIN}`);
  if (!fs.existsSync(SOURCE_ENV)) throw new Error(`master env not found: ${SOURCE_ENV}`);
  if (!fs.existsSync(SOURCE_DB)) throw new Error(`master db not found: ${SOURCE_DB}`);
  if (!fs.existsSync(INVENTORY)) throw new Error(`inventory not found: ${INVENTORY}`);
  if (!fs.existsSync(FUND_SCRIPT)) throw new Error(`fund-wallet.sh not found: ${FUND_SCRIPT}`);
  try { fs.accessSync(FUND_SCRIPT, fs.constants.X_OK); }
  catch { throw new Error(`fund-wallet.sh not executable: ${FUND_SCRIPT}`); }
}

// -------------------------- inventory --------------------------

function loadInventory() {
  const raw = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const wallets = raw.wallets || raw;
  return wallets.filter((w) => w.role === 'captain' || w.role === 'synthesis');
}

// -------------------------- balance query --------------------------

function parseEnvFile(envPath) {
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

function queryBalance(wallet) {
  const env = { ...process.env, ...parseEnvFile(wallet.env_path) };
  const result = spawnSync(BIN, ['--db', wallet.db_path, 'balance', '--json'], {
    env, encoding: 'utf8', timeout: 15000,
  });
  if (result.status !== 0) {
    throw new Error(`balance query failed (${result.status}): ${result.stderr?.slice(0, 200)}`);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return parseInt(parsed.satoshis || 0, 10);
  } catch {
    throw new Error(`balance JSON parse failed: ${result.stdout?.slice(0, 200)}`);
  }
}

// -------------------------- topup --------------------------

function topup(wallet, amountSats) {
  const args = [
    SOURCE_ENV, SOURCE_DB,
    wallet.env_path, wallet.db_path,
    String(amountSats), String(SPLIT),
  ];
  log(`  ${C.yellow}→ fund-wallet.sh ${amountSats} sats × ${SPLIT} split${C.nc}`);
  const result = spawnSync(FUND_SCRIPT, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 300_000, // 5 min per topup (10 sends × 600ms + overhead)
  });
  // stderr is human-formatted progress, stdout is the machine-readable summary
  if (result.stderr) {
    for (const line of result.stderr.trim().split('\n').slice(-4)) {
      if (line.trim()) log(`    ${C.dim}${line}${C.nc}`);
    }
  }
  if (result.status !== 0) {
    err(`  topup failed for ${wallet.name} (exit ${result.status})`);
    return null;
  }
  try {
    const summary = JSON.parse(result.stdout.trim().split('\n').pop());
    return summary;
  } catch {
    warn(`  topup summary unparseable: ${result.stdout?.slice(0, 200)}`);
    return { txid: 'unknown' };
  }
}

// -------------------------- one pass --------------------------

async function pass() {
  const wallets = loadInventory();
  const filtered = opts.only ? wallets.filter((w) => w.name === opts.only) : wallets;
  if (opts.only && filtered.length === 0) {
    warn(`--only "${opts.only}" matched no wallets`);
    return;
  }

  let needsTopup = 0, toppedUp = 0, failures = 0, skipped = 0;

  for (const wallet of filtered) {
    let balance;
    try {
      balance = queryBalance(wallet);
    } catch (e) {
      err(`${wallet.name.padEnd(24)} balance query failed: ${e.message}`);
      failures++;
      continue;
    }

    if (balance >= THRESHOLD) {
      skipped++;
      continue; // healthy, skip silently
    }

    needsTopup++;
    const target = TARGET_BY_ROLE[wallet.role];
    if (!target) {
      warn(`${wallet.name} role '${wallet.role}' has no target, skipping`);
      continue;
    }

    const shortfall = target - balance;
    const fmt = (n) => n.toLocaleString();
    log(`${C.yellow}${wallet.name.padEnd(24)}${C.nc} balance=${fmt(balance).padStart(12)} < ${fmt(THRESHOLD)} — need +${fmt(shortfall)} (target ${fmt(target)}, role=${wallet.role})`);

    if (opts.dryRun) {
      log(`  ${C.dim}(dry-run — no topup)${C.nc}`);
      continue;
    }

    const summary = topup(wallet, shortfall);
    if (summary) {
      toppedUp++;
      const after = summary.receiver?.after ?? '?';
      ok(`${wallet.name.padEnd(24)} topup complete: ${fmt(balance)} → ${fmt(after)} (txid=${String(summary.txid || 'unknown').slice(0, 16)}...)`);
    } else {
      failures++;
    }
  }

  const msg = `pass: ${skipped} healthy, ${needsTopup} need topup, ${toppedUp} topped up, ${failures} failed`;
  if (failures > 0) warn(msg);
  else if (needsTopup > 0) ok(msg);
  else log(`${C.dim}${msg}${C.nc}`);
}

// -------------------------- main --------------------------

async function main() {
  try { preflight(); }
  catch (e) { err(e.message); process.exit(2); }

  const wallets = loadInventory();
  log(`starting watchdog — ${wallets.length} captain+synthesis wallets, threshold=${THRESHOLD.toLocaleString()} sats, interval=${opts.interval}s${opts.dryRun ? ' [DRY RUN]' : ''}${opts.once ? ' [ONCE]' : ''}`);
  log(`  master: ${SOURCE_DB}`);
  log(`  targets: captain=${TARGET_BY_ROLE.captain.toLocaleString()} synthesis=${TARGET_BY_ROLE.synthesis.toLocaleString()} split=${SPLIT}`);

  let stopping = false;
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`received ${sig}, exiting after current pass`);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  while (true) {
    try { await pass(); }
    catch (e) { err(`pass crashed: ${e.message}`); }

    if (opts.once || stopping) break;
    await new Promise((r) => setTimeout(r, opts.interval * 1000));
  }
  log('watchdog stopped');
}

main();
