#!/usr/bin/env node
/**
 * wikipedia-stream-feeder.js — DolphinSense fleet Wikipedia firehose.
 *
 * Subscribes to the public MediaWiki EventStreams recent-changes SSE feed
 * and writes Reddit-envelope records into /tmp/dolphinsense-firehose/wiki-en/
 * queue.jsonl. The harness reads this lane identically to any other.
 *
 * Endpoint: https://stream.wikimedia.org/v2/stream/recentchange
 *
 * No auth. No rate limit. Real edit rate (filtered to enwiki + commonswiki
 * + wikidatawiki edit events) is ~9.7/sec — plenty for one lane.
 *
 * Resume: EventStreams supports `Last-Event-ID` header on reconnect.
 * We persist the last-seen id to disk and pass it on respawn.
 *
 * Layout:
 *   /tmp/dolphinsense-firehose/
 *     wiki-en/queue.jsonl         Reddit-shaped envelope records
 *     cursors/wikipedia.eventid   last-seen Last-Event-ID
 *     health.wikipedia.json
 *     events.jsonl                (shared)
 *
 * Stop: SIGINT or SIGTERM.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FIREHOSE_DIR = process.env.FIREHOSE_DIR || '/tmp/dolphinsense-firehose';
const STREAM_URL = process.env.WIKI_STREAM_URL ||
  'https://stream.wikimedia.org/v2/stream/recentchange';
const LANE_ID = process.env.WIKI_LANE_ID || 'wiki-en';
const HEALTH_PATH = path.join(FIREHOSE_DIR, 'health.wikipedia.json');
const EVENTS_PATH = path.join(FIREHOSE_DIR, 'events.jsonl');
const CURSOR_PATH = path.join(FIREHOSE_DIR, 'cursors', 'wikipedia.eventid');

// Wikis accepted into the lane. Mix gives us volume (commons, wikidata)
// and narrative value (enwiki).
const ALLOWED_WIKIS = new Set(
  (process.env.WIKI_ALLOWED || 'enwiki,commonswiki,wikidatawiki')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
// Filter event types. Edits are the most narrative-worthy; categorize
// events are bulk file auto-categorization on commons. We start with
// just edits; add categorize later if we need volume.
const ALLOWED_TYPES = new Set(['edit', 'new']);
// If true, skip events flagged as bot:true by MediaWiki.
const EXCLUDE_BOTS = process.env.WIKI_EXCLUDE_BOTS === '1';

fs.mkdirSync(FIREHOSE_DIR, { recursive: true });
fs.mkdirSync(path.join(FIREHOSE_DIR, LANE_ID), { recursive: true });
fs.mkdirSync(path.dirname(CURSOR_PATH), { recursive: true });

// ---------------------------------------------------------------------------
// Logging + events
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[wiki-feeder ${ts}] ${msg}`);
}

function emitEvent(type, data) {
  const line = JSON.stringify({ ts: Date.now() / 1000, agent: 'wiki-feeder', type, data });
  try { fs.appendFileSync(EVENTS_PATH, line + '\n'); } catch {}
}

// ---------------------------------------------------------------------------
// Cursor (Last-Event-ID)
// ---------------------------------------------------------------------------

function loadLastEventId() {
  try { return fs.readFileSync(CURSOR_PATH, 'utf8').trim() || null; } catch { return null; }
}

function saveLastEventId(id) {
  if (!id) return;
  const tmp = `${CURSOR_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, id);
    fs.renameSync(tmp, CURSOR_PATH);
  } catch (e) { log(`cursor write fail: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Envelope adapter — MediaWiki recentchange → Reddit-shaped record
// ---------------------------------------------------------------------------

function toEnvelope(rc) {
  const revNew = rc.revision && rc.revision.new;
  const id = revNew ? `rev_${revNew}` : `rc_${rc.id || Date.now()}`;
  const title = String(rc.title || '').slice(0, 256);
  const summary = String(rc.comment || '').slice(0, 1024);
  // Body blends title + summary so the LLM has actual content to quote.
  // Wikipedia edit summaries alone are often terse ("typo fix"); combined
  // with the title you get a real quotable sentence.
  const body = summary
    ? `[${rc.wiki}] ${title} — ${summary}`
    : `[${rc.wiki}] ${title}`;
  const bytes = (rc.length && typeof rc.length.new === 'number' && typeof rc.length.old === 'number')
    ? rc.length.new - rc.length.old : 0;
  return {
    kind: 't1',
    data: {
      id,
      body,
      author: String(rc.user || 'anonymous'),
      subreddit: LANE_ID,
      created_utc: rc.timestamp || Math.floor(Date.now() / 1000),
      permalink: String(rc.notify_url || rc.meta?.uri || `/wiki/${rc.wiki}/${title}`),
      score: bytes,
      title,
      _source: 'wikipedia',
      _wiki: rc.wiki,
      _type: rc.type,
      _bot: !!rc.bot,
    },
  };
}

// ---------------------------------------------------------------------------
// Queue write
// ---------------------------------------------------------------------------

const writeBuffer = [];
const WRITE_FLUSH_MS = 500;
const WRITE_FLUSH_COUNT = 50;

function bufferedAppend(envelope) {
  writeBuffer.push(JSON.stringify(envelope));
  if (writeBuffer.length >= WRITE_FLUSH_COUNT) flushWrites();
}

function flushWrites() {
  if (writeBuffer.length === 0) return;
  const p = path.join(FIREHOSE_DIR, LANE_ID, 'queue.jsonl');
  const payload = writeBuffer.join('\n') + '\n';
  try {
    fs.appendFileSync(p, payload);
    state.totalQueued += writeBuffer.length;
    state.lastWriteTs = Date.now();
  } catch (e) {
    log(`flush fail: ${e.message}`);
    state.errors += 1;
  }
  writeBuffer.length = 0;
}

setInterval(flushWrites, WRITE_FLUSH_MS).unref();

// ---------------------------------------------------------------------------
// State + health
// ---------------------------------------------------------------------------

const state = {
  totalQueued: 0,
  totalEvents: 0,
  droppedWiki: 0,
  droppedType: 0,
  droppedBot: 0,
  droppedEmpty: 0,
  errors: 0,
  lastWriteTs: null,
  reconnectCount: 0,
  lastEventId: loadLastEventId(),
  currentConnectionStartedAt: null,
};
const startedAt = Date.now();

function writeHealth() {
  const health = {
    source: 'wikipedia',
    lane: LANE_ID,
    startedAt,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    totalQueued: state.totalQueued,
    totalEvents: state.totalEvents,
    droppedWiki: state.droppedWiki,
    droppedType: state.droppedType,
    droppedBot: state.droppedBot,
    droppedEmpty: state.droppedEmpty,
    errors: state.errors,
    reconnectCount: state.reconnectCount,
    lastEventId: state.lastEventId,
    lastWriteTs: state.lastWriteTs,
    lastWriteAgoMs: state.lastWriteTs ? Date.now() - state.lastWriteTs : null,
    allowedWikis: [...ALLOWED_WIKIS],
    currentConnectionAgeSec: state.currentConnectionStartedAt
      ? Math.round((Date.now() - state.currentConnectionStartedAt) / 1000) : null,
  };
  try {
    const tmp = `${HEALTH_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(health, null, 2));
    fs.renameSync(tmp, HEALTH_PATH);
  } catch (e) { log(`health write fail: ${e.message}`); }
}

setInterval(writeHealth, 2000).unref();

// ---------------------------------------------------------------------------
// SSE event routing
// ---------------------------------------------------------------------------

let pendingId = null;
let pendingData = '';

function handleSSELine(line) {
  if (line === '') {
    // blank line terminates an event — flush pending
    if (pendingData) {
      let rc;
      try { rc = JSON.parse(pendingData); } catch { pendingData = ''; pendingId = null; return; }
      state.totalEvents += 1;
      if (pendingId) {
        state.lastEventId = pendingId;
        // Persist cursor every N events to reduce write amplification
        if (state.totalEvents % 100 === 0) saveLastEventId(pendingId);
      }
      // Apply filters
      if (!ALLOWED_WIKIS.has(rc.wiki)) { state.droppedWiki += 1; pendingData = ''; pendingId = null; return; }
      if (!ALLOWED_TYPES.has(rc.type)) { state.droppedType += 1; pendingData = ''; pendingId = null; return; }
      if (EXCLUDE_BOTS && rc.bot) { state.droppedBot += 1; pendingData = ''; pendingId = null; return; }
      const env = toEnvelope(rc);
      if (!env.data.body || env.data.body.length < 4) {
        state.droppedEmpty += 1;
        pendingData = ''; pendingId = null; return;
      }
      bufferedAppend(env);
      pendingData = '';
      pendingId = null;
    }
    return;
  }
  if (line.startsWith('data: ')) {
    pendingData = line.slice(6);
  } else if (line.startsWith('data:')) {
    pendingData = line.slice(5);
  } else if (line.startsWith('id: ')) {
    pendingId = line.slice(4);
  } else if (line.startsWith('id:')) {
    pendingId = line.slice(3);
  }
  // ignore :comment, retry:, event:, etc.
}

// ---------------------------------------------------------------------------
// curl subprocess — streams SSE to stdout, one line at a time
// ---------------------------------------------------------------------------

let shuttingDown = false;
let currentChild = null;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 30_000;

function connectOnce() {
  if (shuttingDown) return;
  const args = [
    '-sS', '-N', '-L',
    '--max-time', '0',
    '-H', 'Accept: text/event-stream',
  ];
  if (state.lastEventId) {
    args.push('-H', `Last-Event-ID: ${state.lastEventId}`);
  }
  args.push(STREAM_URL);

  log(`connecting to ${STREAM_URL} (lastEventId=${state.lastEventId ? 'set' : 'none'})`);
  emitEvent('scrape_start', { source: 'wikipedia', url: STREAM_URL, resume: !!state.lastEventId });
  state.currentConnectionStartedAt = Date.now();

  const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  currentChild = child;

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      handleSSELine(line);
    }
    if (Date.now() - state.currentConnectionStartedAt > 10_000) backoffMs = 1000;
  });

  child.stderr.on('data', (chunk) => {
    const msg = chunk.toString('utf8').trim();
    if (msg) log(`curl stderr: ${msg.slice(0, 200)}`);
  });

  child.on('exit', (code, signal) => {
    currentChild = null;
    log(`curl exited code=${code} signal=${signal}; reconnectCount=${state.reconnectCount}`);
    emitEvent('error', { source: 'wikipedia', where: 'sse_exit', reason: `code=${code} signal=${signal}` });
    flushWrites();
    saveLastEventId(state.lastEventId);
    if (shuttingDown) return;
    state.reconnectCount += 1;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    log(`reconnecting in ${delay}ms (backoff)`);
    setTimeout(connectOnce, delay);
  });

  child.on('error', (e) => {
    log(`curl spawn error: ${e.message}`);
    emitEvent('error', { source: 'wikipedia', where: 'spawn', reason: e.message });
  });
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

function installSignalHandlers() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`received ${sig}, flushing and exiting`);
      flushWrites();
      saveLastEventId(state.lastEventId);
      writeHealth();
      if (currentChild) { try { currentChild.kill('SIGTERM'); } catch {} }
      setTimeout(() => process.exit(0), 500);
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  installSignalHandlers();
  log('='.repeat(70));
  log(`wikipedia-stream-feeder starting`);
  log(`lane=${LANE_ID}  wikis=${[...ALLOWED_WIKIS].join(',')}  types=${[...ALLOWED_TYPES].join(',')}`);
  log(`exclude_bots=${EXCLUDE_BOTS}  firehose_dir=${FIREHOSE_DIR}`);
  log('='.repeat(70));
  writeHealth();
  connectOnce();
}

main();
