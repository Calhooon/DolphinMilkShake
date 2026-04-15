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
// Tightened from 500ms to 150ms to reduce the worst-case disk→SSE latency
// from ~500ms to ~150ms. Poll duration is logged below so we can verify
// the interval isn't getting starved by the pollers themselves.
const POLL_MS = parseInt(process.env.POLL_MS || '150', 10);

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

// Set of aggregate.json paths the cycle-aggregate watcher has already
// emitted (prevents re-broadcasting). Also primed during startup by
// scanHistoricalState so historical aggregates don't flood new SSE clients.
// Declared here so scanHistoricalState can reference it.
// Tracks aggregate.json mtime per path. Re-broadcasts when mtime changes
// (not just on first sight) so incremental aggregate.json updates from a
// mid-run lane-cycle process (writing aggregate.json after EACH cycle)
// flow through to the UI. At scan time we prime this with current mtimes
// so historical aggregates aren't replayed.
const seenAggregates = new Map();

// ---- historical state -----------------------------------------------------
// At startup we walk the filesystem once to build a snapshot of lifetime
// totals (txs on-chain, sats spent, articles published, cycles completed).
// This is broadcast as `init_historical` to every SSE client on connect.
// The UI shows these as a "Lifetime" counter separate from "Live" session
// events. The 1.5M-tx progress bar sums historical + session.
const TARGET_TXS = parseInt(process.env.TARGET_TXS || '1500000', 10);

const historicalState = {
  target: TARGET_TXS,
  scannedAt: null,
  txs: 0,               // total on-chain txs from records.jsonl.txids files
  sats: 0,              // total sats from cycle aggregate.json cycles[].totalSats
  articles: 0,          // count of cycles with nanostoreUrl set
  cycles: 0,            // total completed cycles
  articlesList: [],     // [{lane, url, txidsUrl, proofs, ts}] for historical panel
  perLane: {},          // {laneId: {txs, sats, cycles, articles}}
};

// Full list of all txids discovered during the historical scan — indexed
// by lane with per-tx source (records.jsonl.txids vs budget.jsonl). Used
// by the GET /api/txs endpoint to power the "all txs ever" view.
// Rebuilt on every rescan so the list stays current.
let allTxidsIndex = {
  byLane: {},              // {laneId: [{txid, source}]}
  flat: [],                // [{txid, lane, source}] newest-first ordering isn't possible without per-tx ts, so we just keep insertion order
  count: 0,                // == flat.length (also == historicalState.txs)
  scannedAt: null,
};

// Tracks records.jsonl.txids files that existed at UI startup (with their
// sizes at scan time). The txid tailer uses this to distinguish historical
// files (seek past scan size to avoid replaying already-counted txids) from
// freshly-created files (read from offset 0 to catch every burst-written
// line).
const seenTxidFilesAtStartup = new Map();

function scanHistoricalState() {
  const t0 = Date.now();
  // CRITICAL: reset ALL accumulators at the start of every scan. The
  // periodic rescan (every 20s) calls this function repeatedly. Any
  // counter using += or .push() without prior reset will double on
  // each rescan. Only txs naturally dedupes (via a Set) — all other
  // fields must be zeroed here.
  historicalState.txs = 0;
  historicalState.sats = 0;
  historicalState.articles = 0;
  historicalState.cycles = 0;
  historicalState.articlesList = [];
  historicalState.perLane = {};
  for (const lane of LANES) {
    historicalState.perLane[lane.id] = { txs: 0, sats: 0, cycles: 0, articles: 0 };
  }

  // Discover ALL lane directories that exist on disk — even ones not in the
  // current lanes.json. This is essential: when we swap the lane config
  // (e.g. Reddit → Bluesky), historical aggregates from the prior config's
  // lane dirs must still count toward the lifetime totals. The 1.5M tx
  // counter is a LIFETIME metric, not a current-config metric.
  const discoveredLaneIds = new Set(LANES.map((l) => l.id));
  function listSubdirs(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
  for (const name of listSubdirs(SHARED_DIR)) discoveredLaneIds.add(name);
  for (const name of listSubdirs(FLEET_WORKSPACE)) discoveredLaneIds.add(name);

  // Helper: decide whether a subdir name "looks like" a lane. We skip
  // top-level non-lane entries (cursors/, health.json files, etc).
  const skipNames = new Set(['cursors', 'events.jsonl', '.DS_Store']);
  const laneIdsToScan = [...discoveredLaneIds].filter(
    (id) => !skipNames.has(id) && !id.startsWith('health.') && !id.endsWith('.json'),
  );

  // Use a Set to dedupe across all sources — same txid may appear in both
  // records.jsonl.txids AND budget.jsonl. perLaneTxidsAll tracks EVERY
  // discovered lane (not just current config) so the /api/txs endpoint
  // exactly matches the header count. perLaneTxids is a subset for
  // current-config lanes used by the UI lane-tile display.
  const fleetTxids = new Set();
  const perLaneTxids = {};
  const perLaneTxidsAll = {}; // all discovered lanes, current + historical
  for (const lane of LANES) perLaneTxids[lane.id] = new Set();
  function addTx(laneId, txid) {
    fleetTxids.add(txid);
    if (perLaneTxids[laneId]) perLaneTxids[laneId].add(txid);
    if (!perLaneTxidsAll[laneId]) perLaneTxidsAll[laneId] = new Set();
    perLaneTxidsAll[laneId].add(txid);
  }

  // 1) Walk shared/<lane>/cycle-*/records.jsonl.txids — data-plane proofs.
  // ALSO prime seenTxidFiles map: {path → size_at_scan}. The tailer uses this
  // to decide: existing-at-startup file → seek past scan size, new file →
  // read from offset 0 to catch every txid. This is the fix for the "lane
  // shows 0 txs while soak is actively producing proofs" bug — worker's
  // proof_batch writes the whole txids file in one burst, so if the tailer
  // naively seeks to end on first-sight it misses everything.
  for (const laneId of laneIdsToScan) {
    const dir = path.join(SHARED_DIR, laneId);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('cycle-')) continue;
      const txidsFile = path.join(dir, entry.name, 'records.jsonl.txids');
      try {
        const sizeAtScan = fs.statSync(txidsFile).size;
        // Only set on FIRST sight — the name literally is "at startup".
        // Rescans that find the file again should not shift the tailer's
        // initial offset forward, or we'd miss records written between
        // scans. (The tailer itself tracks its own growing offset after
        // creation; this value is only used for its very first read.)
        if (!seenTxidFilesAtStartup.has(txidsFile)) {
          seenTxidFilesAtStartup.set(txidsFile, sizeAtScan);
        }
        const content = fs.readFileSync(txidsFile, 'utf8');
        for (const line of content.split('\n')) {
          const t = line.trim();
          if (t.length === 64 && /^[a-f0-9]+$/.test(t)) {
            addTx(laneId, t);
          }
        }
      } catch { continue; }
    }
  }

  // 1b) Walk every lane's agent dirs: FLEET_WORKSPACE/<lane>/<agent>/tasks/*/budget.jsonl.
  // For historical lanes (not in LANE_AGENTS), discover agents by readdir.
  for (const laneId of laneIdsToScan) {
    const laneDir = path.join(FLEET_WORKSPACE, laneId);
    let laneEntries;
    try { laneEntries = fs.readdirSync(laneDir, { withFileTypes: true }); } catch { continue; }
    for (const agentEntry of laneEntries) {
      if (!agentEntry.isDirectory()) continue;
      // Skip cycle-* dirs here — they go to step 2
      if (agentEntry.name.startsWith('cycle-')) continue;
      const tasksDir = path.join(laneDir, agentEntry.name, 'tasks');
      let taskEntries;
      try { taskEntries = fs.readdirSync(tasksDir, { withFileTypes: true }); } catch { continue; }
      for (const task of taskEntries) {
        if (!task.isDirectory()) continue;
        const budgetFile = path.join(tasksDir, task.name, 'budget.jsonl');
        let raw;
        try { raw = fs.readFileSync(budgetFile, 'utf8'); } catch { continue; }
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const txid = entry && entry.details && entry.details.txid;
            if (typeof txid === 'string' && txid.length === 64 && /^[a-f0-9]+$/.test(txid)) {
              addTx(laneId, txid);
            }
          } catch { /* malformed line */ }
        }
      }
    }
  }

  historicalState.txs = fleetTxids.size;
  for (const lane of LANES) {
    historicalState.perLane[lane.id].txs = perLaneTxids[lane.id].size;
  }

  // Build allTxidsIndex from perLaneTxidsAll (all discovered lanes, current +
  // historical). Every txid in fleetTxids is guaranteed to appear in
  // perLaneTxidsAll because addTx() writes to both atomically.
  allTxidsIndex = {
    byLane: {},
    flat: [],
    count: fleetTxids.size,
    scannedAt: Date.now(),
  };
  for (const [laneId, laneSet] of Object.entries(perLaneTxidsAll)) {
    allTxidsIndex.byLane[laneId] = [...laneSet];
    for (const tx of laneSet) {
      allTxidsIndex.flat.push({ txid: tx, lane: laneId });
    }
  }

  // 2) Walk fleet/<lane>/cycle-*/aggregate.json for ALL discovered lanes —
  // counts cycles + sats + articles regardless of whether the lane is in
  // the current config. Historical lanes contribute to global totals but
  // not to perLane (they're not in the current UI display).
  for (const laneId of laneIdsToScan) {
    const laneDir = path.join(FLEET_WORKSPACE, laneId);
    let entries;
    try { entries = fs.readdirSync(laneDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('cycle-')) continue;
      const aggPath = path.join(laneDir, entry.name, 'aggregate.json');
      let data;
      try { data = JSON.parse(fs.readFileSync(aggPath, 'utf8')); } catch { continue; }
      const cycle = (data.cycles || [])[0];
      if (!cycle) continue;
      historicalState.cycles += 1;
      historicalState.sats += cycle.totalSats || 0;
      if (historicalState.perLane[laneId]) {
        historicalState.perLane[laneId].cycles += 1;
        historicalState.perLane[laneId].sats += cycle.totalSats || 0;
      }
      if (cycle.nanostoreUrl) {
        historicalState.articles += 1;
        if (historicalState.perLane[laneId]) {
          historicalState.perLane[laneId].articles += 1;
        }
        historicalState.articlesList.push({
          lane: laneId,
          url: cycle.nanostoreUrl,
          txidsUrl: cycle.txidsUrl,
          proofs: cycle.proofsCreated || 0,
          cycleId: cycle.cycleId,
          cycleDir: entry.name,
          ts: parseCycleDirTs(entry.name),
        });
      }
      // Prime seenAggregates with mtime so the watcher only re-broadcasts
      // when the file is modified AFTER startup (incremental updates from
      // a running lane-cycle, or genuinely new cycles).
      try {
        seenAggregates.set(aggPath, fs.statSync(aggPath).mtimeMs);
      } catch {
        seenAggregates.set(aggPath, 0);
      }
    }
  }

  // Sort articles newest-first, cap at 200 to keep the payload manageable
  historicalState.articlesList.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (historicalState.articlesList.length > 200) {
    historicalState.articlesList.length = 200;
  }

  historicalState.scannedAt = Date.now();
  console.log(
    `[ui] historical scan (${Date.now() - t0}ms): ` +
    `${historicalState.txs} txs, ${historicalState.sats} sats, ` +
    `${historicalState.articles} articles, ${historicalState.cycles} cycles ` +
    `(target: ${TARGET_TXS})`,
  );
}

// Best-effort parse of a cycle dir name like "cycle-2026-04-14T20-57-49-XXXXX"
// into a Unix timestamp (seconds). Returns 0 on failure.
function parseCycleDirTs(dirName) {
  const m = dirName.match(/^cycle-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  // Local time; good enough for "newest first" ordering
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Math.floor(date.getTime() / 1000);
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
//
// Startup behavior: when a tailer sees a file for the FIRST time, it seeks
// to the end (offset = current file size) WITHOUT broadcasting any existing
// content. Only NEW bytes written after the tailer starts are parsed and
// emitted. This prevents stale replay of historical events as if they were
// happening live. Historical state is loaded separately at startup (see
// scanHistoricalState below) and broadcast as a single `init_historical`
// event that the client renders distinctly from the live stream.
function makeJsonlTailer(fileGetter, onEvent, opts = {}) {
  // `replayTailBytes`: when first seeing a file, read the last N bytes so
  // the current state (agent idle/thinking/tool_call/done) can be
  // reconstructed from recent events. Session events are idempotent —
  // replaying them just re-applies the final state — which is safe for
  // agent session tailers. Default 0 (pure seek-to-end) preserves the
  // prior behavior for feeder events (where replay would re-broadcast
  // historical events as "new" which is wrong).
  const replayTailBytes = opts.replayTailBytes || 0;
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
      // First time seeing this file path. If `replayTailBytes` is set,
      // rewind from EOF by that many bytes so we can replay recent
      // events and pick up current in-flight state. Otherwise seek
      // to end (pure live-only mode).
      state.file = file;
      state.partial = '';
      try {
        const size = fs.statSync(file).size;
        state.offset = Math.max(0, size - replayTailBytes);
      } catch {
        state.offset = 0;
        return;
      }
      // Fall through and read from state.offset — don't return early
      // like the old code, because we want to process the tail bytes.
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
// Multi-source: we merge health.json (reddit), health.bluesky.json, and
// health.wikipedia.json into one unified snapshot for the UI feeder bar.
// Each file is optional — missing files are skipped silently.
const HEALTH_FILES = [
  { path: 'health.json',            source: 'reddit' },
  { path: 'health.bluesky.json',    source: 'bluesky' },
  { path: 'health.wikipedia.json',  source: 'wikipedia' },
];
let lastHealthSnapshot = '';
function pollFeederHealth() {
  const merged = { sources: {}, perSub: {}, uptimeSec: 0 };
  for (const h of HEALTH_FILES) {
    try {
      const raw = fs.readFileSync(path.join(FIREHOSE_DIR, h.path), 'utf8');
      const data = JSON.parse(raw);
      merged.sources[h.source] = {
        uptimeSec: data.uptimeSec || 0,
        totalEvents: data.totalEvents || 0,
        reconnectCount: data.reconnectCount || 0,
      };
      merged.uptimeSec = Math.max(merged.uptimeSec, data.uptimeSec || 0);
      // Reddit feeder uses perSub; bluesky uses lanes; wikipedia is a single lane
      if (data.perSub) {
        for (const [sub, s] of Object.entries(data.perSub)) {
          merged.perSub[sub] = { ...s, _source: 'reddit' };
        }
      }
      if (data.lanes) {
        for (const [sub, s] of Object.entries(data.lanes)) {
          merged.perSub[sub] = {
            totalQueued: s.totalQueued,
            ratePerMin: s.totalSeen && data.uptimeSec
              ? +(s.totalQueued / data.uptimeSec * 60).toFixed(1) : null,
            lastPullAgoMs: s.lastWriteAgoMs,
            errors: s.errors,
            _source: 'bluesky',
          };
        }
      }
      if (data.source === 'wikipedia' && data.lane) {
        merged.perSub[data.lane] = {
          totalQueued: data.totalQueued,
          ratePerMin: data.uptimeSec
            ? +(data.totalQueued / data.uptimeSec * 60).toFixed(1) : null,
          lastPullAgoMs: data.lastWriteAgoMs,
          errors: data.errors,
          _source: 'wikipedia',
        };
      }
    } catch {
      /* missing file is fine — that feeder just isn't running */
    }
  }
  const serialized = JSON.stringify(merged);
  if (serialized !== lastHealthSnapshot) {
    lastHealthSnapshot = serialized;
    broadcast({ kind: 'feeder_health', data: merged });
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

// Cache of most recent event per lane:role so we can replay "current state"
// to SSE clients that connect AFTER the events were originally broadcast.
// Without this, a client that connects mid-cycle (or reconnects after a
// server restart) sees nothing until the next fresh event — which might
// be minutes away during a long LLM call. Cache stores the latest event
// per (lane, role) so we can reconstruct agent state at connect time.
// Also cache message_flow and proof_emitted summary state for replay.
const agentStateCache = new Map();  // `${lane}:${role}` → latest agent event

function ensureAgentTailer(lane, role) {
  const key = `${lane}:${role}`;
  if (agentTailers.has(key)) return agentTailers.get(key);
  const tailer = makeJsonlTailer(
    () => latestTaskSession(lane, role),
    (ev) => {
      // Update the per-agent cache so new SSE clients can replay state.
      agentStateCache.set(key, { lane, role, agent: LANE_AGENTS[lane][role].name, ev });
      broadcast({
        kind: 'agent',
        lane,
        role,
        agent: LANE_AGENTS[lane][role].name,
        ev,
      });

      // Detect inter-agent messages and emit a dedicated "message_flow"
      // event so the UI can render a visual handoff between agent tiles.
      //
      // In cycle-v2 the primary inter-agent message is delegate_task:
      // captain → worker via BRC-33 messagebox with a paid commission.
      // We emit one event on tool_call (the send intent) and an enriched
      // event on tool_result (with commission_id + amount_sats).
      if (role === 'captain' && ev.type === 'tool_call' && ev.name === 'delegate_task') {
        broadcast({
          kind: 'message_flow',
          phase: 'sending',
          lane,
          from: 'captain',
          to: 'worker',
          tool: 'delegate_task',
          from_name: LANE_AGENTS[lane].captain.name,
          to_name: LANE_AGENTS[lane].worker.name,
        });
      }
      if (role === 'captain' && ev.type === 'tool_result' && ev.name === 'delegate_task' && ev.success) {
        let commission_id = null;
        let amount_sats = null;
        try {
          const content = typeof ev.content === 'string' ? JSON.parse(ev.content) : ev.content;
          if (content && typeof content === 'object') {
            commission_id = content.commission_id || null;
            amount_sats = content.amount_sats || null;
          }
        } catch { /* content may not be JSON */ }
        broadcast({
          kind: 'message_flow',
          phase: 'confirmed',
          lane,
          from: 'captain',
          to: 'worker',
          tool: 'delegate_task',
          from_name: LANE_AGENTS[lane].captain.name,
          to_name: LANE_AGENTS[lane].worker.name,
          commission_id,
          amount_sats,
        });
      }
      // Worker picking up the commission from its inbox: the first
      // think_request after session_start signals "received message".
      // We signal on session_start to make the arrival moment clear.
      if (role === 'worker' && ev.type === 'session_start') {
        broadcast({
          kind: 'message_flow',
          phase: 'received',
          lane,
          from: 'captain',
          to: 'worker',
          from_name: LANE_AGENTS[lane].captain.name,
          to_name: LANE_AGENTS[lane].worker.name,
        });
      }
    },
    // Replay the last 128 KB of the session.jsonl when we first see the
    // file. This lets the UI reconstruct current in-flight state — e.g.
    // after a UI server restart mid-synthesis LLM call, the tailer
    // would otherwise seek-to-end and miss the fact that the agent is
    // active/thinking, leaving the tile stuck at "idle" until the next
    // event (which might be minutes away during a long LLM call).
    // Session events are idempotent — replaying them just re-applies
    // the final state. Safe for agent session tailers.
    { replayTailBytes: 128 * 1024 },
  );
  agentTailers.set(key, tailer);
  return tailer;
}

// Per-agent last-seen task dir, used to detect lane recovery (a new task dir
// appearing = lane started a fresh cycle after a previous one). When that
// happens, we clear the agent's cached state and broadcast a synthetic
// session_start so the UI resets from stale error text to "starting".
// Without this, after a cycle errored with "✗ payment error ..." the tile
// would keep showing that error until the NEW cycle's first real event
// landed — which could be minutes later, and visually very misleading.
const lastTaskPathByAgent = new Map();

function pollAgentSessions() {
  for (const lane of LANES) {
    for (const role of ['captain', 'worker', 'synthesis']) {
      const key = `${lane.id}:${role}`;
      // Recovery reset: if the latest task dir has rotated, the previous
      // session's cached terminal state (possibly an error) is stale. Clear
      // it and announce a fresh session_start so the client returns to a
      // clean "starting" state immediately. Real events will flow in as the
      // new session writes them.
      try {
        const currentPath = latestTaskSession(lane.id, role);
        if (currentPath) {
          const prev = lastTaskPathByAgent.get(key);
          if (prev && prev !== currentPath) {
            agentStateCache.delete(key);
            broadcast({
              kind: 'agent',
              lane: lane.id,
              role,
              agent: LANE_AGENTS[lane.id][role].name,
              ev: { type: 'session_start', _synthetic: true },
            });
          }
          lastTaskPathByAgent.set(key, currentPath);
        }
      } catch { /* ignore path lookup errors */ }
      const tailer = ensureAgentTailer(lane.id, role);
      tailer();
    }
  }
}

// ---- cycle aggregate watcher ---------------------------------------------
// Each cycle writes aggregate.json at completion with proof counts, nanostore
// URLs, etc. We scan fleet/<lane>/cycle-*/aggregate.json and broadcast new ones.
// The `seenAggregates` set is declared near the top of this file so
// scanHistoricalState can prime it with existing paths at startup (preventing
// historical aggregates from being replayed to new clients).
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
      let mtime;
      try { mtime = fs.statSync(aggPath).mtimeMs; } catch { continue; }
      const prev = seenAggregates.get(aggPath);
      if (prev !== undefined && prev >= mtime) continue; // no change
      try {
        const raw = fs.readFileSync(aggPath, 'utf8');
        const data = JSON.parse(raw);
        seenAggregates.set(aggPath, mtime);
        broadcast({ kind: 'cycle_aggregate', lane: lane.id, cycle_dir: entry.name, data });
      } catch { /* still being written — leave prev mtime so we retry */ }
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
        // Plain-text tailer (one line = one txid). Two cases:
        //  - File existed at UI startup → seek past its scan-time size. The
        //    txids before that offset are already in historicalState and
        //    re-broadcasting them would double-count.
        //  - File is new this session (e.g. a soak cycle's proof_batch just
        //    landed) → read from offset 0 so every txid gets streamed live.
        //    We MUST use 0 here, not the current file size, because worker
        //    proof_batch writes the whole file in one burst between polls.
        let initialOffset = 0;
        if (seenTxidFilesAtStartup.has(txidsFile)) {
          initialOffset = seenTxidFilesAtStartup.get(txidsFile);
        }
        const state = { offset: initialOffset, partial: '' };
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
// Self-diagnosing poll loop. Logs `[ui] poll ran in Xms (N clients)` when
// the loop exceeds 100ms, so we can tell from the server log whether poll
// duration is eating the POLL_MS interval (saturation) vs completing fast
// and just waiting on the next tick. Silent when polls are fast.
let _pollBusy = false;
setInterval(() => {
  if (_pollBusy) return; // skip this tick if the previous one is still running
  _pollBusy = true;
  const t0 = Date.now();
  try {
    tailFeederEvents();
    pollFeederHealth();
    pollAgentSessions();
    pollCycleAggregates();
    pollTxidStreams();
  } catch (e) {
    console.error('[ui] poll error:', e.message);
  } finally {
    const dt = Date.now() - t0;
    if (dt > 100) {
      console.log(`[ui] poll ran in ${dt}ms (${clients.size} clients) — approaching POLL_MS=${POLL_MS}`);
    }
    _pollBusy = false;
  }
}, POLL_MS);

// ---- wallet health polling -----------------------------------------------
// For each agent's wallet_port, POST /listOutputs to get UTXO count + total
// satoshis. Broadcast a per-agent wallet snapshot every WALLET_POLL_MS.
// The wallet daemons run the BRC-100 wallet API; Origin header is required
// for local calls.
const WALLET_POLL_MS = parseInt(process.env.WALLET_POLL_MS || '25000', 10);
const walletCache = new Map(); // key: `${laneId}:${role}` → {sats, utxos, lastUpdate}

function queryWallet(port, callback) {
  const body = JSON.stringify({
    basket: 'default',
    includeTotalValue: true,
    limit: 1000,
  });
  const req = http.request(
    {
      hostname: 'localhost',
      port,
      path: '/listOutputs',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://localhost:${port}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 3000,
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const outputs = parsed.outputs || [];
          const sats = outputs.reduce((a, o) => a + (o.satoshis || 0), 0);
          callback(null, { sats, utxos: outputs.length });
        } catch (e) {
          callback(e);
        }
      });
    },
  );
  req.on('error', (e) => callback(e));
  req.on('timeout', () => { req.destroy(); callback(new Error('timeout')); });
  req.write(body);
  req.end();
}

function pollWallets() {
  const updates = [];
  let pending = 0;
  for (const lane of LANES) {
    for (const role of ['captain', 'worker', 'synthesis']) {
      const agent = LANE_AGENTS[lane.id] && LANE_AGENTS[lane.id][role];
      if (!agent || !agent.wallet_port) continue;
      const key = `${lane.id}:${role}`;
      pending += 1;
      queryWallet(agent.wallet_port, (err, result) => {
        pending -= 1;
        if (!err && result) {
          walletCache.set(key, { ...result, lastUpdate: Date.now() });
          updates.push({
            lane: lane.id,
            role,
            sats: result.sats,
            utxos: result.utxos,
          });
        }
        if (pending === 0 && updates.length > 0) {
          broadcast({ kind: 'wallet_health', updates });
        }
      });
    }
  }
}
setInterval(pollWallets, WALLET_POLL_MS);
// Kick off an immediate first poll so the UI gets values on connect
setTimeout(pollWallets, 500);

// ---- periodic historical rescan ------------------------------------------
// scanHistoricalState walks all cycle dirs on disk to compute lifetime totals.
// We re-run it every 20s so the historical baseline grows as the live soak
// produces new aggregate.json files. Without this rescan, the historical
// value is frozen at UI-startup time and refreshing the browser appears to
// "lose" txs that were counted live (because live resets but historical
// doesn't pick up the replacement).
const HISTORICAL_RESCAN_MS = parseInt(process.env.HISTORICAL_RESCAN_MS || '20000', 10);
setInterval(() => {
  try {
    scanHistoricalState();
    // Broadcast the refreshed snapshot so connected clients update their
    // historical baseline AND zero their live-delta to prevent double-counting.
    broadcast({
      kind: 'init_historical',
      target: historicalState.target,
      scannedAt: historicalState.scannedAt,
      txs: historicalState.txs,
      sats: historicalState.sats,
      articles: historicalState.articles,
      cycles: historicalState.cycles,
      articlesList: historicalState.articlesList,
      perLane: historicalState.perLane,
    });
  } catch (e) {
    console.error('[ui] rescan error:', e.message);
  }
}, HISTORICAL_RESCAN_MS);

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
      source: l.source || 'reddit',
      display_prefix: l.display_prefix || '',
      agents: (l.agents || []).map((a) => ({ role: a.role, name: a.name, server_port: a.server_port })),
    })),
  })}\n\n`);

  // Send historical lifetime snapshot — lifetime totals + recent articles.
  // This gets rendered in a dedicated "Historical" panel distinct from the
  // live stream. The 1.5M progress bar sums historical + session.
  res.write(`data: ${JSON.stringify({
    kind: 'init_historical',
    target: historicalState.target,
    scannedAt: historicalState.scannedAt,
    txs: historicalState.txs,
    sats: historicalState.sats,
    articles: historicalState.articles,
    cycles: historicalState.cycles,
    articlesList: historicalState.articlesList,
    perLane: historicalState.perLane,
  })}\n\n`);

  // Send last-known feeder health if we have it
  if (lastHealthSnapshot) {
    try {
      res.write(`data: ${JSON.stringify({ kind: 'feeder_health', data: JSON.parse(lastHealthSnapshot) })}\n\n`);
    } catch { /* ignore */ }
  }

  // Send last-known wallet health snapshot so new clients see balances
  // immediately instead of waiting for the next 25s poll cycle.
  if (walletCache.size > 0) {
    const updates = [];
    for (const [key, val] of walletCache.entries()) {
      const [lane, role] = key.split(':');
      updates.push({ lane, role, sats: val.sats, utxos: val.utxos });
    }
    res.write(`data: ${JSON.stringify({ kind: 'wallet_health', updates })}\n\n`);
  }

  // Replay cached agent state so newly-connected clients see in-flight
  // cycle state (e.g. captain "thinking…", worker mid-proof-batch)
  // immediately instead of waiting for the next fresh event, which can
  // be minutes away during a long LLM call. Without this, a client that
  // refreshes or reconnects mid-synthesis sees all agents stuck at
  // "idle" until the next event fires.
  if (agentStateCache.size > 0) {
    for (const cached of agentStateCache.values()) {
      res.write(`data: ${JSON.stringify({
        kind: 'agent',
        lane: cached.lane,
        role: cached.role,
        agent: cached.agent,
        ev: cached.ev,
      })}\n\n`);
    }
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

  // GET /api/txs — returns all txids discovered during the historical scan.
  //   ?lane=<id>     filter to a single lane
  //   ?offset=N      pagination (default 0)
  //   ?limit=N       pagination (default 500, max 5000)
  // Response: { total, offset, limit, txs: [{txid, lane}], scannedAt, byLaneCounts }
  if (pathname === '/api/txs') {
    const laneFilter = url.searchParams.get('lane');
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit') || '500', 10)));
    let source = allTxidsIndex.flat;
    if (laneFilter) {
      source = source.filter((e) => e.lane === laneFilter);
    }
    const total = source.length;
    const page = source.slice(offset, offset + limit);
    const byLaneCounts = {};
    for (const [lid, arr] of Object.entries(allTxidsIndex.byLane)) {
      byLaneCounts[lid] = arr.length;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      total,
      offset,
      limit,
      scannedAt: allTxidsIndex.scannedAt,
      byLaneCounts,
      txs: page,
    }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// Scan historical state BEFORE starting the server so the first SSE client
// always gets a non-empty init_historical. Also primes seenAggregates.
scanHistoricalState();

server.listen(PORT, () => {
  console.log(`[ui] serving on http://localhost:${PORT}`);
  console.log(`[ui] lanes: ${LANES.map((l) => l.id).join(', ')}`);
  console.log(`[ui] fleet workspace: ${FLEET_WORKSPACE}`);
  console.log(`[ui] firehose: ${FIREHOSE_DIR}`);
  console.log(`[ui] shared: ${SHARED_DIR}`);
  console.log(`[ui] target: ${TARGET_TXS.toLocaleString()} on-chain txs`);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[ui] ${sig} received, closing`);
    server.close();
    process.exit(0);
  });
}
