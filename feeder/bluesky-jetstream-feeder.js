#!/usr/bin/env node
/**
 * bluesky-jetstream-feeder.js — DolphinSense fleet Bluesky firehose.
 *
 * Subscribes to the public Bluesky jetstream WebSocket and writes
 * Reddit-envelope records into per-lane queue.jsonl files. The harness
 * (scripts/lane-cycle.js) reads those queues identically to the Reddit
 * feeder — the envelope shape is `{kind:"t1", data:{id, body, author, ...}}`
 * on purpose so nothing downstream has to know the source.
 *
 * Jetstream: wss://jetstream1.us-east.bsky.network/subscribe
 *   ?wantedCollections=app.bsky.feed.post
 *
 * No auth. No rate limit. Real rate ~51 create+text events/sec.
 *
 * Lane fanout:
 *   Filter each commit by record.langs[] against a per-lane language
 *   whitelist. One WS connection feeds all lanes.
 *
 * Dedupe:
 *   In-memory LRU of rkeys (128k entries ≈ 10 MB RAM). Jetstream can
 *   replay after reconnect, so dedupe is non-optional.
 *
 * Reconnect:
 *   websocat dies → exponential backoff (1s → 30s cap) → respawn.
 *   Jetstream supports ?cursor=<time_us> for resume but we skip that
 *   for tonight's soak — the in-memory dedupe catches the overlap.
 *
 * Layout:
 *   /tmp/dolphinsense-firehose/
 *     <lane-id>/queue.jsonl       (written here — shared with Reddit path)
 *     health.bluesky.json         per-process health snapshot
 *     events.jsonl                scrape_start/done (shared with Reddit path)
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
const JETSTREAM_URL = process.env.BSKY_JETSTREAM_URL ||
  'wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';
const HEALTH_PATH = path.join(FIREHOSE_DIR, 'health.bluesky.json');
const EVENTS_PATH = path.join(FIREHOSE_DIR, 'events.jsonl');
const DEDUPE_CAPACITY = parseInt(process.env.BSKY_DEDUPE_CAPACITY || '131072', 10);
const HEALTH_WRITE_MS = parseInt(process.env.BSKY_HEALTH_MS || '2000', 10);

// Lane GROUPS — each language group can have multiple TENANT queues that
// share the same source filter. Posts route round-robin within a group so
// each tenant queue gets a fair, NON-OVERLAPPING share of the firehose.
// Each post still lands in exactly ONE queue (zero dedup risk).
// Tenant counts are configurable via env vars so we can scale to N lanes
// without code changes:
//   BSKY_EN_TENANTS    default: ["bsky-en"]
//                      10-lane: ["bsky-en","bsky-en-2","bsky-en-3","bsky-en-4","bsky-en-5"]
const BSKY_EN_TENANTS    = (process.env.BSKY_EN_TENANTS    || 'bsky-en').split(',').map(s => s.trim()).filter(Boolean);
const BSKY_MULTI_TENANTS = (process.env.BSKY_MULTI_TENANTS || 'bsky-multi').split(',').map(s => s.trim()).filter(Boolean);
const BSKY_JA_TENANTS    = (process.env.BSKY_JA_TENANTS    || 'bsky-ja').split(',').map(s => s.trim()).filter(Boolean);
const BSKY_PT_TENANTS    = (process.env.BSKY_PT_TENANTS    || 'bsky-pt').split(',').map(s => s.trim()).filter(Boolean);

const LANE_GROUPS = [
  { groupId: 'en',    langs: new Set(['en']),                                                                tenants: BSKY_EN_TENANTS },
  { groupId: 'multi', langs: new Set(['es', 'pt', 'pt-BR', 'pt-PT', 'it', 'fr', 'de', 'nl', 'ca']),          tenants: BSKY_MULTI_TENANTS },
  { groupId: 'ja',    langs: new Set(['ja']),                                                                tenants: BSKY_JA_TENANTS },
  { groupId: 'pt',    langs: new Set(['pt', 'pt-BR', 'pt-PT']),                                              tenants: BSKY_PT_TENANTS },
];

// Flat list of every tenant lane id, used for queue dir creation +
// per-lane state tracking.
const LANES = LANE_GROUPS.flatMap((g) => g.tenants.map((id) => ({ id, group: g.groupId, langs: g.langs })));

// Per-group round-robin counter — each post in a matched group goes to
// `tenants[counter++ % tenants.length]`. Zero coordination, zero overlap.
const groupRR = Object.fromEntries(LANE_GROUPS.map((g) => [g.groupId, 0]));

fs.mkdirSync(FIREHOSE_DIR, { recursive: true });
for (const lane of LANES) {
  fs.mkdirSync(path.join(FIREHOSE_DIR, lane.id), { recursive: true });
}

// ---------------------------------------------------------------------------
// Logging + events
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[bsky-feeder ${ts}] ${msg}`);
}

function emitEvent(type, data) {
  const line = JSON.stringify({ ts: Date.now() / 1000, agent: 'bsky-feeder', type, data });
  try { fs.appendFileSync(EVENTS_PATH, line + '\n'); } catch {}
}

// ---------------------------------------------------------------------------
// Dedupe LRU — simple bounded Set, O(1) add + evict
// ---------------------------------------------------------------------------

class DedupeLRU {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  has(key) { return this.map.has(key); }
  add(key) {
    if (this.map.has(key)) return false;
    this.map.set(key, 1);
    if (this.map.size > this.capacity) {
      // Evict oldest (insertion-order)
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    return true;
  }
  get size() { return this.map.size; }
}

const dedupe = new DedupeLRU(DEDUPE_CAPACITY);

// ---------------------------------------------------------------------------
// Envelope adapter — jetstream event → Reddit-shaped queue record
// ---------------------------------------------------------------------------

function toEnvelope(evt, laneId) {
  // evt is the full jetstream message. commit.record.text is the post body.
  const rec = evt.commit.record;
  const rkey = evt.commit.rkey;
  const did = evt.did;
  const tsSec = Math.floor((evt.time_us || 0) / 1_000_000) || Math.floor(Date.now() / 1000);
  // We truncate absurdly long posts so the LLM prompt stays sane. Real
  // Bluesky posts are capped at 300 chars anyway; replies with embedded
  // quote-posts can get longer but 1024 is more than enough.
  const body = String(rec.text || '').slice(0, 1024);
  return {
    kind: 't1',
    data: {
      id: rkey,
      body,
      author: did,
      subreddit: laneId,
      created_utc: tsSec,
      permalink: `/bluesky/${did}/${rkey}`,
      score: 0,
      title: '',
      _source: 'bluesky',
      _langs: Array.isArray(rec.langs) ? rec.langs : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Queue write
// ---------------------------------------------------------------------------

const writeBuffers = new Map(); // laneId → string[]
const WRITE_FLUSH_MS = 500;
const WRITE_FLUSH_COUNT = 100;

function bufferedAppend(laneId, envelope) {
  let buf = writeBuffers.get(laneId);
  if (!buf) { buf = []; writeBuffers.set(laneId, buf); }
  buf.push(JSON.stringify(envelope));
  if (buf.length >= WRITE_FLUSH_COUNT) flushLane(laneId);
}

function flushLane(laneId) {
  const buf = writeBuffers.get(laneId);
  if (!buf || buf.length === 0) return;
  const p = path.join(FIREHOSE_DIR, laneId, 'queue.jsonl');
  const payload = buf.join('\n') + '\n';
  try {
    fs.appendFileSync(p, payload);
    perLaneState[laneId].totalQueued += buf.length;
    perLaneState[laneId].lastWriteTs = Date.now();
  } catch (e) {
    log(`flush fail ${laneId}: ${e.message}`);
    perLaneState[laneId].errors += 1;
  }
  buf.length = 0;
}

function flushAll() {
  for (const laneId of writeBuffers.keys()) flushLane(laneId);
}

setInterval(flushAll, WRITE_FLUSH_MS).unref();

// ---------------------------------------------------------------------------
// Per-lane state
// ---------------------------------------------------------------------------

const perLaneState = {};
for (const lane of LANES) {
  perLaneState[lane.id] = {
    totalQueued: 0,
    totalSeen: 0,
    dropped_lang_mismatch: 0,
    errors: 0,
    lastWriteTs: null,
  };
}

let totalEvents = 0;
let totalDedupeSkips = 0;
let totalNoText = 0;
let totalDeletes = 0;
let reconnectCount = 0;
let startedAt = Date.now();
let currentWSStartedAt = null;

function writeHealth() {
  const perLane = {};
  for (const lane of LANES) {
    const s = perLaneState[lane.id];
    perLane[lane.id] = {
      totalQueued: s.totalQueued,
      totalSeen: s.totalSeen,
      dropped_lang_mismatch: s.dropped_lang_mismatch,
      errors: s.errors,
      lastWriteTs: s.lastWriteTs,
      lastWriteAgoMs: s.lastWriteTs ? Date.now() - s.lastWriteTs : null,
    };
  }
  const health = {
    source: 'bluesky',
    startedAt,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    totalEvents,
    totalDedupeSkips,
    totalNoText,
    totalDeletes,
    reconnectCount,
    dedupeSize: dedupe.size,
    dedupeCapacity: DEDUPE_CAPACITY,
    currentConnectionAgeSec: currentWSStartedAt
      ? Math.round((Date.now() - currentWSStartedAt) / 1000) : null,
    lanes: perLane,
  };
  try {
    const tmp = `${HEALTH_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(health, null, 2));
    fs.renameSync(tmp, HEALTH_PATH);
  } catch (e) { log(`health write fail: ${e.message}`); }
}

setInterval(writeHealth, HEALTH_WRITE_MS).unref();

// ---------------------------------------------------------------------------
// Event router — one jetstream message → 0..N lane writes
// ---------------------------------------------------------------------------

function handleEvent(evt) {
  totalEvents += 1;
  if (evt.kind !== 'commit') return;
  const c = evt.commit;
  if (!c || c.collection !== 'app.bsky.feed.post') return;
  if (c.operation !== 'create') {
    if (c.operation === 'delete') totalDeletes += 1;
    return;
  }
  const rec = c.record;
  if (!rec || typeof rec.text !== 'string' || rec.text.length === 0) {
    totalNoText += 1;
    return;
  }
  const rkey = c.rkey;
  if (!rkey) return;
  // Dedupe on rkey — jetstream may replay after reconnect
  if (!dedupe.add(rkey)) {
    totalDedupeSkips += 1;
    return;
  }

  const postLangs = Array.isArray(rec.langs) ? rec.langs : [];
  // First-MATCHING-GROUP wins, then round-robin within that group's tenants.
  // Each post still lands in AT MOST ONE queue file → zero dedup risk.
  // Multi-tenant groups (e.g. bsky-en split into 5 fanout lanes) get
  // even distribution via groupRR counter; tenant 0 then 1 then 2 etc.
  let routedTenant = null;
  for (const group of LANE_GROUPS) {
    // Track totals against ALL tenants in the group for stats parity
    for (const tid of group.tenants) perLaneState[tid].totalSeen += 1;
    let match = false;
    for (const l of postLangs) {
      if (group.langs.has(l)) { match = true; break; }
    }
    if (!match) {
      for (const tid of group.tenants) perLaneState[tid].dropped_lang_mismatch += 1;
      continue;
    }
    if (routedTenant === null) {
      const tenantIdx = groupRR[group.groupId] % group.tenants.length;
      groupRR[group.groupId] = (groupRR[group.groupId] + 1) | 0;
      routedTenant = group.tenants[tenantIdx];
      bufferedAppend(routedTenant, toEnvelope(evt, routedTenant));
    } else {
      // Already routed to an earlier matching group — don't duplicate.
      for (const tid of group.tenants) perLaneState[tid].dropped_lang_mismatch += 1;
    }
  }
  if (routedTenant === null && postLangs.length === 0) {
    // Post with no language tag → fall through to the EN group's RR queue
    const tenantIdx = groupRR['en'] % BSKY_EN_TENANTS.length;
    groupRR['en'] = (groupRR['en'] + 1) | 0;
    const tenant = BSKY_EN_TENANTS[tenantIdx];
    bufferedAppend(tenant, toEnvelope(evt, tenant));
    perLaneState[tenant].totalSeen += 1;
  }
}

// ---------------------------------------------------------------------------
// websocat subprocess — one line per message on stdout
// ---------------------------------------------------------------------------

let shuttingDown = false;
let currentChild = null;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 30_000;

function connectOnce() {
  if (shuttingDown) return;
  log(`connecting to ${JETSTREAM_URL}`);
  emitEvent('scrape_start', { source: 'bluesky', url: JETSTREAM_URL });
  currentWSStartedAt = Date.now();

  // NOTE: stdio[0] MUST be 'pipe' (not 'ignore'). websocat defaults to a
  // bidirectional `stdio: <->  ws://` pipe, so `ignore` makes it see an
  // instantly-closed stdin and shut down the WS with "Invalid argument
  // (os error 22)". Leaving stdin as an open (unused) pipe keeps it happy.
  const child = spawn('websocat', [JETSTREAM_URL], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  currentChild = child;

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        handleEvent(evt);
      } catch (e) {
        // jetstream can occasionally emit framing-only messages
      }
    }
    // Connection is healthy — reset backoff on sustained data
    if (Date.now() - currentWSStartedAt > 10_000) backoffMs = 1000;
  });

  child.stderr.on('data', (chunk) => {
    const msg = chunk.toString('utf8').trim();
    if (msg) log(`websocat stderr: ${msg.slice(0, 200)}`);
  });

  child.on('exit', (code, signal) => {
    currentChild = null;
    log(`websocat exited code=${code} signal=${signal}; reconnectCount=${reconnectCount}`);
    emitEvent('error', { source: 'bluesky', where: 'ws_exit', reason: `code=${code} signal=${signal}` });
    flushAll();
    if (shuttingDown) return;
    reconnectCount += 1;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    log(`reconnecting in ${delay}ms (backoff)`);
    setTimeout(connectOnce, delay);
  });

  child.on('error', (e) => {
    log(`websocat spawn error: ${e.message}`);
    emitEvent('error', { source: 'bluesky', where: 'spawn', reason: e.message });
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
      flushAll();
      writeHealth();
      if (currentChild) {
        try { currentChild.kill('SIGTERM'); } catch {}
      }
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
  log(`bluesky-jetstream-feeder starting`);
  log(`lanes: ${LANES.map((l) => l.id + '[' + [...l.langs].join(',') + ']').join(' ')}`);
  log(`firehose_dir=${FIREHOSE_DIR}  dedupe_capacity=${DEDUPE_CAPACITY}`);
  log('='.repeat(70));
  writeHealth();
  connectOnce();
}

main();
