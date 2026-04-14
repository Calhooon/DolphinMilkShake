#!/usr/bin/env node
/**
 * DolphinSense Mission Control — tiny live dashboard server.
 *
 * No framework. No build step. Node stdlib + file polling + SSE.
 *
 * Responsibilities:
 *   1. Serve index.html + any static assets at the root.
 *   2. Tail the files that the fleet writes as it runs:
 *        - fleet/lanes.json (lane config, loaded once)
 *        - ~/bsv/wallets/fleet/INVENTORY.json (wallet inventory)
 *        - /tmp/dolphinsense-firehose/health.json (feeder status)
 *        - /tmp/dolphinsense-firehose/events.jsonl (feeder events stream)
 *        - test-workspaces/fleet/<lane>/<agent-name>/tasks/<latest>/session.jsonl
 *          for each lane × role (live agent events)
 *        - test-workspaces/fleet/<lane>/cycle-STAMP/aggregate.json (cycle completion)
 *        - /tmp/dolphinsense-shared/<lane>/cycle-ID/records.jsonl.txids (txid stream)
 *   3. Broadcast each new event as SSE so the browser can render without polling.
 *
 * Usage:
 *   node ui/server.js                      # port 7777
 *   PORT=8888 node ui/server.js             # override
 *   FLEET_WORKSPACE=/path node ui/server.js # override fleet workspace root
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

// ---- paths ----------------------------------------------------------------
const UI_DIR = __dirname;
const REPO_ROOT = path.resolve(UI_DIR, '..');
const LANES_FILE = process.env.LANES_FILE
  || path.join(REPO_ROOT, 'fleet/lanes.json');
const INVENTORY_FILE = process.env.INVENTORY_FILE
  || `${os.homedir()}/bsv/wallets/fleet/INVENTORY.json`;
const FLEET_WORKSPACE = process.env.FLEET_WORKSPACE
  || `${os.homedir()}/bsv/rust-bsv-worm/test-workspaces/fleet`;
const SHARED_DIR = process.env.SHARED_DIR
  || '/tmp/dolphinsense-shared';
const FIREHOSE_DIR = process.env.FIREHOSE_DIR
  || '/tmp/dolphinsense-firehose';

const PORT = parseInt(process.env.PORT || '7777', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '500', 10);

// ---- load lane config once ------------------------------------------------
let lanesDoc;
try {
  lanesDoc = JSON.parse(fs.readFileSync(LANES_FILE, 'utf8'));
} catch (e) {
  console.error(`[ui] FATAL: could not read lanes.json at ${LANES_FILE}: ${e.message}`);
  process.exit(1);
}
const LANES = lanesDoc.lanes || [];

// Build a lookup: {laneId → {captain: agentEntry, worker: ..., synthesis: ...}}
const LANE_AGENTS = {};
for (const lane of LANES) {
  LANE_AGENTS[lane.id] = {};
  for (const a of (lane.agents || [])) {
    LANE_AGENTS[lane.id][a.role] = a;
  }
}

// ---- SSE client registry --------------------------------------------------
const clients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* ignore broken pipes */ }
  }
}

// ---- file tailers ---------------------------------------------------------
// Each tailer tracks a byte offset into a file. On each poll, it reads from
// that offset forward and parses any complete JSON lines, invoking a
// callback per event.
function makeJsonlTailer(fileGetter, onEvent) {
  const state = { file: null, offset: 0, partial: '' };
  return () => {
    let file;
    try {
      file = typeof fileGetter === 'function' ? fileGetter() : fileGetter;
    } catch {
      return;
    }
    if (!file) return;
    if (file !== state.file) {
      state.file = file;
      state.offset = 0;
      state.partial = '';
    }
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (stat.size <= state.offset) return;

    const fd = fs.openSync(file, 'r');
    const len = stat.size - state.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.offset);
    fs.closeSync(fd);
    state.offset = stat.size;

    const text = state.partial + buf.toString('utf8');
    const lines = text.split('\n');
    state.partial = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
  };
}

// ---- feeder events tailer -------------------------------------------------
const tailFeederEvents = makeJsonlTailer(
  () => path.join(FIREHOSE_DIR, 'events.jsonl'),
  (ev) => {
    broadcast({ kind: 'feeder', ev });
  },
);

// ---- feeder health snapshot ----------------------------------------------
let lastHealthSnapshot = '';
function pollFeederHealth() {
  try {
    const raw = fs.readFileSync(path.join(FIREHOSE_DIR, 'health.json'), 'utf8');
    if (raw !== lastHealthSnapshot) {
      lastHealthSnapshot = raw;
      broadcast({ kind: 'feeder_health', data: JSON.parse(raw) });
    }
  } catch {
    /* feeder not running yet */
  }
}

// ---- per-agent session.jsonl tailers -------------------------------------
// For each lane × role, find the latest task dir and tail its session.jsonl.
// When a new task dir appears, switch the tailer to it.
//
// Agent workspace layout:
//   test-workspaces/fleet/<lane>/<agent-name>/tasks/<taskId>/session.jsonl
const agentTailers = new Map(); // key: `${lane}:${role}` → tailer function

function latestTaskSession(lane, role) {
  const agent = LANE_AGENTS[lane] && LANE_AGENTS[lane][role];
  if (!agent) return null;
  const agentName = agent.name;
  const tasksDir = path.join(FLEET_WORKSPACE, lane, agentName, 'tasks');
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let latest = null;
  let latestMtime = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionPath = path.join(tasksDir, entry.name, 'session.jsonl');
    try {
      const stat = fs.statSync(sessionPath);
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = sessionPath;
      }
    } catch { /* skip */ }
  }
  return latest;
}

function ensureAgentTailer(lane, role) {
  const key = `${lane}:${role}`;
  if (agentTailers.has(key)) return agentTailers.get(key);
  const tailer = makeJsonlTailer(
    () => latestTaskSession(lane, role),
    (ev) => {
      broadcast({
        kind: 'agent',
        lane,
        role,
        agent: LANE_AGENTS[lane][role].name,
        ev,
      });
    },
  );
  agentTailers.set(key, tailer);
  return tailer;
}

function pollAgentSessions() {
  for (const lane of LANES) {
    for (const role of ['captain', 'worker', 'synthesis']) {
      const tailer = ensureAgentTailer(lane.id, role);
      tailer();
    }
  }
}

// ---- cycle aggregate watcher ---------------------------------------------
// Each cycle writes aggregate.json at completion with proof counts, nanostore
// URLs, etc. We scan fleet/<lane>/cycle-*/aggregate.json and broadcast new ones.
const seenAggregates = new Set();
function pollCycleAggregates() {
  for (const lane of LANES) {
    const laneDir = path.join(FLEET_WORKSPACE, lane.id);
    let cycleDirs;
    try {
      cycleDirs = fs.readdirSync(laneDir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of cycleDirs) {
      if (!entry.isDirectory() || !entry.name.startsWith('cycle-')) continue;
      const aggPath = path.join(laneDir, entry.name, 'aggregate.json');
      if (seenAggregates.has(aggPath)) continue;
      try {
        const raw = fs.readFileSync(aggPath, 'utf8');
        const data = JSON.parse(raw);
        seenAggregates.add(aggPath);
        broadcast({ kind: 'cycle_aggregate', lane: lane.id, cycle_dir: entry.name, data });
      } catch { /* still being written */ }
    }
  }
}

// ---- txid stream tailer -------------------------------------------------
// records.jsonl.txids gets written line-by-line by proof_batch.sh during a
// cycle. Track per-cycle offset + broadcast each new txid as proof_emitted.
const txidTailers = new Map(); // key: cycleDir → tailer
function pollTxidStreams() {
  for (const lane of LANES) {
    const laneSharedDir = path.join(SHARED_DIR, lane.id);
    let cycleDirs;
    try {
      cycleDirs = fs.readdirSync(laneSharedDir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of cycleDirs) {
      if (!entry.isDirectory() || !entry.name.startsWith('cycle-')) continue;
      const txidsFile = path.join(laneSharedDir, entry.name, 'records.jsonl.txids');
      const key = txidsFile;
      if (!txidTailers.has(key)) {
        // Plain-text tailer (one line = one txid)
        const state = { offset: 0, partial: '' };
        txidTailers.set(key, () => {
          let stat;
          try { stat = fs.statSync(txidsFile); } catch { return; }
          if (stat.size <= state.offset) return;
          const fd = fs.openSync(txidsFile, 'r');
          const len = stat.size - state.offset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, state.offset);
          fs.closeSync(fd);
          state.offset = stat.size;
          const text = state.partial + buf.toString('utf8');
          const lines = text.split('\n');
          state.partial = lines.pop() || '';
          for (const line of lines) {
            const txid = line.trim();
            if (txid.length === 64 && /^[a-f0-9]+$/.test(txid)) {
              broadcast({
                kind: 'proof_emitted',
                lane: lane.id,
                cycle_dir: entry.name,
                txid,
              });
            }
          }
        });
      }
      txidTailers.get(key)();
    }
  }
}

// ---- poll loop ------------------------------------------------------------
setInterval(() => {
  try {
    tailFeederEvents();
    pollFeederHealth();
    pollAgentSessions();
    pollCycleAggregates();
    pollTxidStreams();
  } catch (e) {
    console.error('[ui] poll error:', e.message);
  }
}, POLL_MS);

// ---- HTTP server ----------------------------------------------------------
function serveFile(req, res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // On connect, send the static initial state
  res.write(`data: ${JSON.stringify({
    kind: 'init',
    lanes: LANES.map((l) => ({
      id: l.id,
      subreddit: l.subreddit,
      agents: (l.agents || []).map((a) => ({ role: a.role, name: a.name, server_port: a.server_port })),
    })),
  })}\n\n`);

  // Send last-known feeder health if we have it
  if (lastHealthSnapshot) {
    try {
      res.write(`data: ${JSON.stringify({ kind: 'feeder_health', data: JSON.parse(lastHealthSnapshot) })}\n\n`);
    } catch { /* ignore */ }
  }

  clients.add(res);

  // Heartbeat every 30s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/events') {
    handleSse(req, res);
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    serveFile(req, res, path.join(UI_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lanes: LANES.length, clients: clients.size }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[ui] serving on http://localhost:${PORT}`);
  console.log(`[ui] lanes: ${LANES.map((l) => l.id).join(', ')}`);
  console.log(`[ui] fleet workspace: ${FLEET_WORKSPACE}`);
  console.log(`[ui] firehose: ${FIREHOSE_DIR}`);
  console.log(`[ui] shared: ${SHARED_DIR}`);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[ui] ${sig} received, closing`);
    server.close();
    process.exit(0);
  });
}
