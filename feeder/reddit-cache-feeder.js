#!/usr/bin/env node
/**
 * reddit-cache-feeder.js — the DolphinSense fleet's data plane firehose.
 *
 * Pulls /r/<sub>/comments.json?before=<cursor>&limit=100 round-robin for a
 * configured set of subs, writing new comments to per-sub append-only
 * queue.jsonl files. Agents consume from those queues via a per-sub
 * watermark (see queue-claim.js).
 *
 * This process is the ONLY thing that talks to Reddit during the long
 * production runs. Agents read from disk. No concurrent IP hits, no
 * duplicate scraping, no cross-agent coordination.
 *
 * Layout:
 *   /tmp/dolphinsense-firehose/
 *     cursors/<sub>.cursor            per-sub `before=` fullname state
 *     <sub>/queue.jsonl               append-only per-sub record stream
 *     <sub>/queue.jsonl.claimed       byte offset consumed by agents
 *     health.json                     last-pull stats, 429 counter, errors
 *     events.jsonl                    scrape_start/done events for UI
 *
 * Usage:
 *   node scripts/reddit-cache-feeder.js
 *   SUBS=technology,worldnews,... INTERVAL_MS=2000 node scripts/reddit-cache-feeder.js
 *   FIREHOSE_DIR=/tmp/dolphinsense-firehose node scripts/reddit-cache-feeder.js
 *
 * Stop: SIGINT or SIGTERM. Cursors and queues persist — restart resumes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_SUBS = [
  // Tech news + discussion
  'technology', 'gadgets', 'hardware', 'buildapc', 'linux',
  'programming', 'webdev', 'MachineLearning', 'cybersecurity', 'sysadmin',
  // News + politics-adjacent
  'news', 'worldnews', 'UpliftingNews', 'geopolitics', 'Economics',
  // Finance + crypto
  'Bitcoin', 'CryptoCurrency', 'stocks', 'investing', 'wallstreetbets',
  // Science + future
  'science', 'Futurology', 'space', 'EverythingScience', 'environment',
  // Biz + startups
  'startups', 'Entrepreneur', 'smallbusiness', 'marketing', 'SaaS',
];

const SUBS = (process.env.SUBS ? process.env.SUBS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_SUBS);
const FIREHOSE_DIR = process.env.FIREHOSE_DIR || '/tmp/dolphinsense-firehose';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '2000', 10); // stagger between per-sub fetches
const LIMIT = parseInt(process.env.LIMIT || '100', 10);
// Reddit rate-limits by (IP, User-Agent) pair. Their API etiquette asks for
// a unique descriptive UA with contact info, not a browser spoof. Using a
// branded UA also plays better with their abuse detection — swap-able via
// FEEDER_USER_AGENT for per-agent variation during fleet runs.
const USER_AGENT = process.env.FEEDER_USER_AGENT ||
  'DolphinSense/0.1 (+https://dolphinmilk.local; contact: ops@dolphinmilk.local)';
// A "soft pause" between full round-robin sweeps — ensures we don't ever
// burn CPU on a tight loop if all fetches are fast.
const ROUND_SOFT_PAUSE_MS = parseInt(process.env.ROUND_SOFT_PAUSE_MS || '0', 10);

const CURSOR_DIR = path.join(FIREHOSE_DIR, 'cursors');
const HEALTH_PATH = path.join(FIREHOSE_DIR, 'health.json');
const EVENTS_PATH = path.join(FIREHOSE_DIR, 'events.jsonl');

fs.mkdirSync(FIREHOSE_DIR, { recursive: true });
fs.mkdirSync(CURSOR_DIR, { recursive: true });
for (const sub of SUBS) {
  fs.mkdirSync(path.join(FIREHOSE_DIR, sub), { recursive: true });
}

// ---------------------------------------------------------------------------
// Logging + events
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[feeder ${ts}] ${msg}`);
}

function emitEvent(type, data) {
  const line = JSON.stringify({
    ts: Date.now() / 1000,
    agent: 'feeder',
    type,
    data,
  });
  try {
    fs.appendFileSync(EVENTS_PATH, line + '\n');
  } catch (e) {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// HTTP via curl (same pattern as test_cycle_v2.js for consistency)
// ---------------------------------------------------------------------------

function curlGet(url) {
  // Returns { body, statusCode } — we need the status to detect 429 etc.
  // Using -w to append status at the end, separated by a null byte.
  const out = execFileSync(
    'curl',
    ['-sS', '-A', USER_AGENT, '-L', '--max-time', '30', '-w', '\n__STATUS__%{http_code}', url],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const marker = out.lastIndexOf('\n__STATUS__');
  if (marker < 0) return { body: out, statusCode: 0 };
  const body = out.slice(0, marker);
  const statusCode = parseInt(out.slice(marker + '\n__STATUS__'.length), 10) || 0;
  return { body, statusCode };
}

// ---------------------------------------------------------------------------
// Per-sub cursor state
// ---------------------------------------------------------------------------

function cursorPath(sub) {
  return path.join(CURSOR_DIR, `${sub}.cursor`);
}

function loadCursor(sub) {
  try {
    return fs.readFileSync(cursorPath(sub), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function saveCursor(sub, fullname) {
  const p = cursorPath(sub);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, fullname);
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Per-sub queue append
// ---------------------------------------------------------------------------

function queuePath(sub) {
  return path.join(FIREHOSE_DIR, sub, 'queue.jsonl');
}

function appendRecords(sub, records) {
  if (records.length === 0) return 0;
  const p = queuePath(sub);
  // Append a single buffer to minimize write syscalls. POSIX O_APPEND
  // makes a single write() atomic for <PIPE_BUF bytes, but for multi-line
  // batches we just write them as one big chunk and rely on the fact that
  // agents seek-and-read from a committed byte offset AFTER the append
  // completes, not concurrently with it.
  const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(p, payload);
  return records.length;
}

// ---------------------------------------------------------------------------
// Per-sub pull
// ---------------------------------------------------------------------------

async function pullSub(sub, state) {
  const cursor = loadCursor(sub);
  const base = `https://www.reddit.com/r/${sub}/comments.json?limit=${LIMIT}`;
  const url = cursor ? `${base}&before=${cursor}` : base;
  const t0 = Date.now();
  emitEvent('scrape_start', { sub, sort: 'comments', cursor });
  let result;
  try {
    result = curlGet(url);
  } catch (e) {
    state.errors += 1;
    state.lastError = String(e.message);
    log(`  ${sub}: curl fail: ${e.message}`);
    emitEvent('error', { sub, where: 'curl', reason: String(e.message) });
    return { appended: 0, fetched: 0, statusCode: 0 };
  }
  const ms = Date.now() - t0;
  const { body, statusCode } = result;
  if (statusCode === 429) {
    state.rateLimitCount += 1;
    log(`  ${sub}: 429 rate-limited (count=${state.rateLimitCount})`);
    emitEvent('error', { sub, where: 'reddit', reason: '429' });
    return { appended: 0, fetched: 0, statusCode };
  }
  if (statusCode < 200 || statusCode >= 300) {
    state.errors += 1;
    log(`  ${sub}: HTTP ${statusCode}`);
    emitEvent('error', { sub, where: 'reddit', reason: `http_${statusCode}` });
    return { appended: 0, fetched: 0, statusCode };
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    state.errors += 1;
    log(`  ${sub}: parse fail: ${e.message}`);
    emitEvent('error', { sub, where: 'parse', reason: String(e.message) });
    return { appended: 0, fetched: 0, statusCode };
  }

  const children = (parsed.data && parsed.data.children) || [];
  if (children.length === 0) {
    state.lastPulls.push({ ts: Date.now(), ms, fetched: 0, appended: 0 });
    while (state.lastPulls.length > 20) state.lastPulls.shift();
    return { appended: 0, fetched: 0, statusCode };
  }

  // children[0] is the newest. Set that as the next cursor.
  const newestFullname = children[0] && children[0].data && children[0].data.name;

  const appended = appendRecords(sub, children);
  state.totalQueued += appended;
  state.lastPulls.push({ ts: Date.now(), ms, fetched: children.length, appended });
  while (state.lastPulls.length > 20) state.lastPulls.shift();
  if (newestFullname) saveCursor(sub, newestFullname);

  emitEvent('scrape_done', { sub, sort: 'comments', record_count: appended, ms });
  return { appended, fetched: children.length, statusCode };
}

// ---------------------------------------------------------------------------
// Health file
// ---------------------------------------------------------------------------

function writeHealth(subStates, startedAt) {
  const now = Date.now();
  const perSub = {};
  for (const [sub, s] of Object.entries(subStates)) {
    const last = s.lastPulls[s.lastPulls.length - 1] || null;
    const avgInterval = s.lastPulls.length >= 2
      ? (s.lastPulls[s.lastPulls.length - 1].ts - s.lastPulls[0].ts) / (s.lastPulls.length - 1)
      : null;
    const totalAppendedRecent = s.lastPulls.reduce((acc, p) => acc + p.appended, 0);
    const windowMs = avgInterval != null ? avgInterval * (s.lastPulls.length - 1) : null;
    const ratePerMin = windowMs && windowMs > 0 ? (totalAppendedRecent / windowMs) * 60000 : null;
    perSub[sub] = {
      totalQueued: s.totalQueued,
      errors: s.errors,
      rateLimitCount: s.rateLimitCount,
      lastPullTs: last ? last.ts : null,
      lastPullAgoMs: last ? now - last.ts : null,
      lastPullMs: last ? last.ms : null,
      lastPullAppended: last ? last.appended : null,
      avgIntervalMs: avgInterval ? Math.round(avgInterval) : null,
      ratePerMin: ratePerMin != null ? +ratePerMin.toFixed(1) : null,
      lastError: s.lastError || null,
    };
  }
  const health = {
    startedAt,
    uptimeSec: Math.round((now - startedAt) / 1000),
    subs: SUBS,
    intervalMs: INTERVAL_MS,
    limit: LIMIT,
    totalSubs: SUBS.length,
    perSub,
  };
  try {
    const tmp = `${HEALTH_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(health, null, 2));
    fs.renameSync(tmp, HEALTH_PATH);
  } catch (e) {
    log(`health write fail: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let shuttingDown = false;

function installSignalHandlers() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`received ${sig}, exiting cleanly`);
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  installSignalHandlers();
  const startedAt = Date.now();
  log('='.repeat(70));
  log(`reddit-cache-feeder starting`);
  log(`subs: ${SUBS.length} — [${SUBS.slice(0, 5).join(', ')}${SUBS.length > 5 ? ', ...' : ''}]`);
  log(`interval_ms=${INTERVAL_MS} limit=${LIMIT} firehose_dir=${FIREHOSE_DIR}`);
  log('='.repeat(70));

  const subStates = {};
  for (const sub of SUBS) {
    subStates[sub] = {
      totalQueued: 0,
      errors: 0,
      rateLimitCount: 0,
      lastPulls: [], // ring buffer of last 20 pulls
      lastError: null,
    };
  }

  // Write initial health file so callers can tell we started
  writeHealth(subStates, startedAt);

  let rounds = 0;
  while (!shuttingDown) {
    rounds += 1;
    const roundStart = Date.now();
    for (const sub of SUBS) {
      if (shuttingDown) break;
      try {
        const res = await pullSub(sub, subStates[sub]);
        if (res.fetched > 0) {
          log(`  ${sub.padEnd(16)} fetched=${String(res.fetched).padStart(3)} appended=${String(res.appended).padStart(3)} totalQ=${subStates[sub].totalQueued}`);
        }
      } catch (e) {
        subStates[sub].errors += 1;
        subStates[sub].lastError = String(e.message);
        log(`  ${sub}: UNCAUGHT: ${e.message}`);
      }
      // Write health after every sub so consumers see near-live state
      writeHealth(subStates, startedAt);
      if (!shuttingDown && INTERVAL_MS > 0) await sleep(INTERVAL_MS);
    }
    const totalThisRound = SUBS.reduce((acc, s) => acc + (subStates[s].lastPulls[subStates[s].lastPulls.length - 1]?.appended || 0), 0);
    log(`round ${rounds} done: +${totalThisRound} records across ${SUBS.length} subs (${Math.round((Date.now() - roundStart) / 1000)}s)`);
    if (!shuttingDown && ROUND_SOFT_PAUSE_MS > 0) await sleep(ROUND_SOFT_PAUSE_MS);
  }

  writeHealth(subStates, startedAt);
  log('exit');
}

main().catch((e) => {
  console.error('[feeder] FATAL:', e);
  process.exitCode = 1;
});
