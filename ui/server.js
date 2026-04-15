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
    (id) => !skipNames.has(id)
      && !id.startsWith('health.')
      && !id.endsWith('.json')
      && !id.startsWith('cycle-'),
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

// ---- SERVER-AUTHORITATIVE DASHBOARD STATE --------------------------------
// Single source of truth for the dashboard. Replaces the legacy split between
// historicalState (periodic-rescan) and client-side live-delta counters.
//
// Design principles:
//   1. txidsByLane is a Map<lane, Set<txid>>. Union is never shrunk — all
//      additions go through addTxid(). Counts are DERIVED at snapshot time
//      from set size, never running counters. No drops possible.
//   2. perLane aggregates (sats, cycles, articles) come from aggregate.json
//      files via rebuildAggregatesFromDisk() which fully recomputes them on
//      every rescan. Because they're replaced atomically from the source of
//      truth, no race/staleness.
//   3. agents/walletHealth/feederHealth are pure live state written by
//      tailers. No historical fallback needed — if a tailer hasn't seen it
//      yet, the field is empty.
//   4. Every mutation calls scheduleBroadcast() which debounces 150ms and
//      sends the full computed snapshot to every SSE client. Clients are
//      pure renderers: apply snapshot → surgical DOM.
// Tx category buckets — { category → { count, sats } }
// Categories are derived from the budget.jsonl entry's service + operation
// fields, OR for worker proof_batch txs (which only have txids on disk),
// attributed wholesale to "scrape_proofs". See categorizeBudgetEntry().
function categorizeBudgetEntry(entry) {
  const svc = entry && entry.service;
  const op = entry && (entry.operation || '');
  if (svc === 'llm') return 'llm_inference';
  if (op === 'upload_to_nanostore') return 'nanostore_upload';
  if (typeof op === 'string' && op.startsWith('brc18_message_')) return 'messaging';
  if (op === 'brc18_capability_proof') return 'capability_proof';
  if (svc === 'state') return 'state_tokens';
  if (svc === 'proofs') return 'proof_commitments';
  return 'other';
}

const dashboardState = {
  schema: 1,
  updatedAt: Date.now(),
  // union counts — lane → Set<txid>
  txidsByLane: new Map(),
  // Tx categories aggregated across all lanes/agents.
  // Map<category, { count: number, sats: number }>
  txCategories: new Map(),
  // aggregate per-lane state merged from disk + live events
  //   laneId → {
  //     sats, cycles, articles,         // from aggregate.json
  //     agents: { captain, worker, synthesis }, // live agent state
  //     lastDelegateAt,                 // epoch ms
  //     cycle_dir,                      // most recent cycle dir name
  //   }
  perLane: new Map(),
  articles: [], // [{lane, url, txidsUrl, proofs, cycleId, cycleDir, ts}] newest first
  recentTxs: [],    // [{lane, cycle_dir, txid, ts}] newest first, cap 50
  recentFlows: [],  // [{lane, phase, from, to, from_name, to_name, amount_sats?, ts}] newest first, cap 20
  walletHealth: {}, // `${lane}:${role}` → {sats, utxos, updatedAt}
  feederHealth: null,
};

function ensureLaneSlot(laneId) {
  if (!dashboardState.perLane.has(laneId)) {
    dashboardState.perLane.set(laneId, {
      sats: 0,
      cycles: 0,
      articles: 0,
      agents: { captain: null, worker: null, synthesis: null },
      lastDelegateAt: null,
      cycle_dir: null,
      // Cycle phase tracks where the lane is in its current cycle:
      //   idle | claim | captain | worker | synthesis | upload | done
      // Derived from agent activity sequence, useful for the per-tile
      // 5-dot phase indicator coming in Phase 5.
      cyclePhase: 'idle',
      cycleStartMs: null,
    });
  }
  if (!dashboardState.txidsByLane.has(laneId)) {
    dashboardState.txidsByLane.set(laneId, new Set());
  }
  return dashboardState.perLane.get(laneId);
}

function addTxid(laneId, txid) {
  if (!dashboardState.txidsByLane.has(laneId)) {
    dashboardState.txidsByLane.set(laneId, new Set());
  }
  const set = dashboardState.txidsByLane.get(laneId);
  const before = set.size;
  set.add(txid);
  return set.size > before; // true if newly added
}

// Helper to bump a category's count + sats. Used by budget tailer (live)
// and rebuildTxCategoriesFromDisk (full rebuild on rescan).
function bumpCategory(cat, sats = 0) {
  if (!dashboardState.txCategories.has(cat)) {
    dashboardState.txCategories.set(cat, { count: 0, sats: 0 });
  }
  const slot = dashboardState.txCategories.get(cat);
  slot.count += 1;
  slot.sats += sats || 0;
}

// Walk every budget.jsonl file across all lanes and rebuild txCategories
// from scratch. Called from rebuildDashboardFromDisk on the 20s rescan so
// the breakdown is always anchored to disk truth (idempotent — txCategories
// is fully replaced, not appended). Worker scrape proofs (records.jsonl.txids)
// are added separately by rebuildTxidsFromDisk via the addScrapeCount() call.
function rebuildTxCategoriesFromDisk() {
  // Reset — we're rebuilding from scratch
  dashboardState.txCategories = new Map();

  const discoveredLaneIds = new Set(LANES.map((l) => l.id));
  try {
    for (const e of fs.readdirSync(FLEET_WORKSPACE, { withFileTypes: true })) {
      if (e.isDirectory()) discoveredLaneIds.add(e.name);
    }
  } catch { /* missing dir */ }
  const skipNames = new Set(['cursors', 'events.jsonl', '.DS_Store']);
  const laneIdsToScan = [...discoveredLaneIds].filter(
    (id) => !skipNames.has(id) && !id.startsWith('health.') && !id.endsWith('.json') && !id.startsWith('cycle-'),
  );

  for (const laneId of laneIdsToScan) {
    const laneDir = path.join(FLEET_WORKSPACE, laneId);
    let agentEntries;
    try { agentEntries = fs.readdirSync(laneDir, { withFileTypes: true }); } catch { continue; }
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory() || agentEntry.name.startsWith('cycle-')) continue;
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
            if (typeof txid !== 'string' || txid.length !== 64 || !/^[a-f0-9]+$/.test(txid)) continue;
            const cat = categorizeBudgetEntry(entry);
            const sats = (typeof entry.sats === 'number') ? entry.sats : 0;
            bumpCategory(cat, sats);
          } catch { /* malformed */ }
        }
      }
    }
  }
}

// Recompute perLane.sats/cycles/articles + articles list from aggregate.json
// files. This is idempotent and replaces the aggregate-derived fields
// atomically from disk — the source of truth for those counts.
function rebuildAggregatesFromDisk() {
  // Reset aggregate fields on every lane in our state. DO NOT touch
  // txidsByLane (that's additive) or agents/wallet/feeder (pure live).
  for (const laneState of dashboardState.perLane.values()) {
    laneState.sats = 0;
    laneState.cycles = 0;
    laneState.articles = 0;
  }
  const articles = [];

  // Discover all lane dirs on disk — current config + historical
  const discoveredLaneIds = new Set(LANES.map((l) => l.id));
  try {
    for (const e of fs.readdirSync(SHARED_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) discoveredLaneIds.add(e.name);
    }
  } catch { /* missing dir */ }
  try {
    for (const e of fs.readdirSync(FLEET_WORKSPACE, { withFileTypes: true })) {
      if (e.isDirectory()) discoveredLaneIds.add(e.name);
    }
  } catch { /* missing dir */ }
  const skipNames = new Set(['cursors', 'events.jsonl', '.DS_Store']);
  const laneIdsToScan = [...discoveredLaneIds].filter(
    (id) => !skipNames.has(id)
      && !id.startsWith('health.')
      && !id.endsWith('.json')
      && !id.startsWith('cycle-'),
  );

  for (const laneId of laneIdsToScan) {
    ensureLaneSlot(laneId);
    const laneState = dashboardState.perLane.get(laneId);
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
      laneState.cycles += 1;
      laneState.sats += cycle.totalSats || 0;
      if (cycle.nanostoreUrl) {
        laneState.articles += 1;
        articles.push({
          lane: laneId,
          url: cycle.nanostoreUrl,
          txidsUrl: cycle.txidsUrl,
          proofs: cycle.proofsCreated || 0,
          cycleId: cycle.cycleId,
          cycleDir: entry.name,
          ts: parseCycleDirTs(entry.name),
        });
      }
    }
  }
  articles.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (articles.length > 200) articles.length = 200;
  dashboardState.articles = articles;
}

// Walk records.jsonl.txids and budget.jsonl across all discovered lanes,
// adding txids to dashboardState.txidsByLane. Set union => never shrinks.
// Called at boot + on 20s rescan. Safe to call repeatedly.
function rebuildTxidsFromDisk() {
  const discoveredLaneIds = new Set(LANES.map((l) => l.id));
  try {
    for (const e of fs.readdirSync(SHARED_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) discoveredLaneIds.add(e.name);
    }
  } catch { /* missing dir */ }
  try {
    for (const e of fs.readdirSync(FLEET_WORKSPACE, { withFileTypes: true })) {
      if (e.isDirectory()) discoveredLaneIds.add(e.name);
    }
  } catch { /* missing dir */ }
  const skipNames = new Set(['cursors', 'events.jsonl', '.DS_Store']);
  const laneIdsToScan = [...discoveredLaneIds].filter(
    (id) => !skipNames.has(id)
      && !id.startsWith('health.')
      && !id.endsWith('.json')
      && !id.startsWith('cycle-'),
  );
  for (const laneId of laneIdsToScan) {
    ensureLaneSlot(laneId);
    // records.jsonl.txids (data-plane proofs)
    const sharedLaneDir = path.join(SHARED_DIR, laneId);
    let sharedEntries;
    try { sharedEntries = fs.readdirSync(sharedLaneDir, { withFileTypes: true }); } catch { sharedEntries = []; }
    for (const entry of sharedEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith('cycle-')) continue;
      const txidsFile = path.join(sharedLaneDir, entry.name, 'records.jsonl.txids');
      try {
        const content = fs.readFileSync(txidsFile, 'utf8');
        for (const line of content.split('\n')) {
          const t = line.trim();
          if (t.length === 64 && /^[a-f0-9]+$/.test(t)) addTxid(laneId, t);
        }
      } catch { /* file may not exist for all cycle dirs */ }
    }
    // budget.jsonl (control-plane proofs via agent actions)
    const fleetLaneDir = path.join(FLEET_WORKSPACE, laneId);
    let agentEntries;
    try { agentEntries = fs.readdirSync(fleetLaneDir, { withFileTypes: true }); } catch { agentEntries = []; }
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      if (agentEntry.name.startsWith('cycle-')) continue;
      const tasksDir = path.join(fleetLaneDir, agentEntry.name, 'tasks');
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
              addTxid(laneId, txid);
            }
          } catch { /* malformed line */ }
        }
      }
    }
  }
}

// Full disk rebuild — txids (additive) + aggregates (atomic replace) + tx
// categories (atomic replace from budget.jsonl walk).
function rebuildDashboardFromDisk() {
  const t0 = Date.now();
  rebuildTxidsFromDisk();
  rebuildAggregatesFromDisk();
  rebuildTxCategoriesFromDisk();
  // Add the worker scrape proofs as a single category — they live in
  // records.jsonl.txids, which has no per-tx metadata, so we attribute
  // ALL of them to "scrape_proofs" wholesale. Count is derived from the
  // total txids minus the categorized ones (everything in budget.jsonl
  // is already counted). This is approximate but close — the diff is
  // dominated by worker proof_batch which is what we want anyway.
  let categorizedCount = 0;
  for (const v of dashboardState.txCategories.values()) categorizedCount += v.count;
  let totalTxs = 0;
  for (const set of dashboardState.txidsByLane.values()) totalTxs += set.size;
  const scrapeCount = Math.max(0, totalTxs - categorizedCount);
  if (scrapeCount > 0) {
    // Per-tx sats for worker proof_batch is fixed at 200 sats (BRC-29 fee)
    dashboardState.txCategories.set('scrape_proofs', {
      count: scrapeCount,
      sats: scrapeCount * 200,
    });
  }
  dashboardState.updatedAt = Date.now();
  console.log(`[ui] dashboard rebuilt (${Date.now() - t0}ms): ${totalTxs} txs across ${dashboardState.perLane.size} lanes (${dashboardState.txCategories.size} categories)`);
}

// Compute the snapshot payload that gets broadcast to clients. Derived from
// dashboardState at call time — no running totals. Totals = sum over sets.
function computeSnapshot() {
  const totals = { txs: 0, sats: 0, articles: 0, cycles: 0 };
  const perLaneOut = {};
  for (const [laneId, laneState] of dashboardState.perLane.entries()) {
    const txidSet = dashboardState.txidsByLane.get(laneId);
    const laneTxs = txidSet ? txidSet.size : 0;
    totals.txs += laneTxs;
    totals.sats += laneState.sats || 0;
    totals.cycles += laneState.cycles || 0;
    totals.articles += laneState.articles || 0;
    perLaneOut[laneId] = {
      txs: laneTxs,
      sats: laneState.sats || 0,
      cycles: laneState.cycles || 0,
      articles: laneState.articles || 0,
      agents: laneState.agents || {},
      lastDelegateAt: laneState.lastDelegateAt || null,
      cycle_dir: laneState.cycle_dir || null,
      cyclePhase: laneState.cyclePhase || 'idle',
      cycleStartMs: laneState.cycleStartMs || null,
    };
  }
  // Tx categories — Map<string, {count, sats}> → plain object for JSON
  const txCategoriesOut = {};
  for (const [cat, v] of dashboardState.txCategories.entries()) {
    txCategoriesOut[cat] = { count: v.count, sats: v.sats };
  }

  return {
    schema: 1,
    target: TARGET_TXS,
    updatedAt: dashboardState.updatedAt,
    totals,
    perLane: perLaneOut,
    articles: dashboardState.articles,
    recentTxs: dashboardState.recentTxs,
    recentFlows: dashboardState.recentFlows,
    walletHealth: dashboardState.walletHealth,
    feederHealth: dashboardState.feederHealth,
    txCategories: txCategoriesOut,
    lanes: LANES.map((l) => ({
      id: l.id,
      subreddit: l.subreddit,
      source: l.source || 'reddit',
      display_prefix: l.display_prefix || '',
      agents: (l.agents || []).map((a) => ({ role: a.role, name: a.name, server_port: a.server_port })),
    })),
  };
}

// Debounced broadcast: many mutations in rapid succession coalesce into one
// snapshot send. 150ms gives us real-time feel without flooding clients.
let _broadcastTimer = null;
function scheduleBroadcast() {
  dashboardState.updatedAt = Date.now();
  if (_broadcastTimer) return;
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    broadcastSnapshot();
  }, 150);
}

function broadcastSnapshot() {
  const snap = computeSnapshot();
  const payload = `data: ${JSON.stringify({ kind: 'snapshot', state: snap })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* ignore broken pipes */ }
  }
}

// Heartbeat broadcast: ALWAYS push a fresh snapshot every 1 second, even if
// no event has fired. This keeps client-side "X seconds ago" timestamps and
// any derived rates ticking, and gives the user the perception of a truly
// live dashboard. Snapshot payload is ~5-15KB so 1Hz × N clients is trivial.
const HEARTBEAT_BROADCAST_MS = parseInt(process.env.HEARTBEAT_BROADCAST_MS || '1000', 10);
setInterval(() => {
  if (clients.size === 0) return;
  broadcastSnapshot();
}, HEARTBEAT_BROADCAST_MS);

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
    dashboardState.feederHealth = merged;
    scheduleBroadcast();
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
  return latestTaskFile(lane, role, 'session.jsonl');
}

function latestTaskBudget(lane, role) {
  return latestTaskFile(lane, role, 'budget.jsonl');
}

// Generic helper: walk an agent's tasks dir, return the path to the
// latest-mtime file with the given basename. Used by both session.jsonl
// and budget.jsonl tailers.
function latestTaskFile(lane, role, basename) {
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
    const filePath = path.join(tasksDir, entry.name, basename);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = filePath;
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
const agentStateCache = new Map();  // `${lane}:${role}` → latest agent event

// Ring buffer of recent proof_emitted events so fresh SSE clients see
// an immediately-populated tx stream instead of "waiting for live txs…"
// until the next proof lands (which during a synthesis cycle can be
// 2-5 min of silence). Capped at RECENT_TXS_MAX to bound memory.
const RECENT_TXS_MAX = 50;
const recentTxs = [];  // [{ kind: 'proof_emitted', lane, cycle_dir, txid }, ...] newest first

// Ring buffer of recent message_flow events (captain → worker delegate_task).
// These fire once per cycle per lane, so a full 5-lane soak produces maybe
// one banner every 25-60 seconds — fresh clients connecting between events
// see nothing until the next delegate lands (potentially minutes away).
// Capped at RECENT_FLOWS_MAX to keep replay bounded.
const RECENT_FLOWS_MAX = 20;
const recentFlows = [];  // newest first

function recordFlow(ev) {
  recentFlows.unshift(ev);
  if (recentFlows.length > RECENT_FLOWS_MAX) recentFlows.length = RECENT_FLOWS_MAX;
}

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

      // ---- RICH PER-AGENT STATE ------------------------------------
      // Server-authoritative tracking. Every tile field has a single
      // source of truth on this slot. Fields:
      //   state:       short label rendered in the tile (e.g. "thinking…")
      //   phase:       one of {idle, starting, thinking, tool, done, error}
      //   active:      whether the agent currently has work in flight
      //   lastTool:    last tool_call name ("delegate_task", "execute_bash", …)
      //   lastToolAt:  epoch ms of the last tool_call
      //   iter:        current iteration count (0-indexed, increments on tool_call)
      //   sats:        running cost for THIS session (incremented on tool_result)
      //   sessionStart epoch ms when current session began
      //   taskId:      current dolphin-milk task id
      //   name:        agent name (set once)
      //   port:        dolphin-milk web UI port (carried via lane.agents config)
      //   recentEvents: ring buffer of last 20 {type,name,ts,iter} for the
      //                 detail panel in Phase 4 (kept compact)
      const laneSlot = ensureLaneSlot(lane);
      if (!laneSlot.agents[role]) {
        laneSlot.agents[role] = {
          state: 'idle', phase: 'idle', active: false,
          lastTool: null, lastToolAt: null,
          iter: 0, sats: 0,
          sessionStart: null, taskId: null,
          name: null, port: null,
          recentEvents: [],
        };
      }
      const a = laneSlot.agents[role];
      a.name = LANE_AGENTS[lane][role].name;
      a.port = LANE_AGENTS[lane][role].server_port;
      const nowMs = Date.now();

      // Push compact event into the per-agent ring (last 20). Phase 4
      // detail panel will subscribe to this stream.
      const compactEv = {
        type: ev.type,
        name: ev.name || null,
        ts: nowMs,
        iter: a.iter,
      };
      a.recentEvents.push(compactEv);
      if (a.recentEvents.length > 20) a.recentEvents.shift();

      if (ev.type === 'session_start') {
        // Reset session-scoped state on every new session_start so stale
        // values from a prior cycle don't leak into the new one.
        a.state = 'starting';
        a.phase = 'starting';
        a.active = true;
        a.lastTool = null;
        a.lastToolAt = null;
        a.iter = 0;
        a.sats = 0;
        a.sessionStart = nowMs;
        a.taskId = ev.task_id || ev.id || null;
        a.recentEvents = [compactEv];
        // Lane cyclePhase advances based on which agent just started:
        // captain → 'captain', worker → 'worker', synthesis → 'synthesis'.
        // First captain start of a fresh cycle resets cycleStartMs.
        if (role === 'captain') {
          if (laneSlot.cyclePhase === 'idle' || laneSlot.cyclePhase === 'done') {
            laneSlot.cycleStartMs = nowMs;
          }
          laneSlot.cyclePhase = 'captain';
        } else if (role === 'worker') {
          laneSlot.cyclePhase = 'worker';
        } else if (role === 'synthesis') {
          laneSlot.cyclePhase = 'synthesis';
        }
      } else if (ev.type === 'think_request') {
        a.state = 'thinking…';
        a.phase = 'thinking';
        a.active = true;
      } else if (ev.type === 'tool_call') {
        a.state = `→ ${ev.name || 'tool'}`;
        a.phase = 'tool';
        a.active = true;
        a.lastTool = ev.name || null;
        a.lastToolAt = nowMs;
        a.iter += 1;
      } else if (ev.type === 'tool_result') {
        // Accumulate sats from tool result if present. Different tools
        // report cost in different fields; cover both common shapes.
        const cost = ev.sats_effective || ev.sats || ev.cost || 0;
        if (typeof cost === 'number' && cost > 0) {
          a.sats += cost;
        }
        if (ev.success === false) {
          a.state = `✗ ${ev.name || 'tool'} error`;
          a.phase = 'error';
          a.active = false;
        } else {
          // Successful tool result — return to thinking until next tool
          // or session_end. Keeps the tile from looking stuck on a tool
          // name when the agent has actually moved on.
          a.state = 'thinking…';
          a.phase = 'thinking';
        }
      } else if (ev.type === 'session_end') {
        const sats = ev.sats_effective || ev.sats || a.sats || 0;
        const errStr = ev.error ? String(ev.error) : '';
        const isMaxIterCap = /Hit max iterations/i.test(errStr);
        if (errStr && !isMaxIterCap) {
          a.state = `✗ ${errStr.slice(0, 40)}`;
          a.phase = 'error';
          a.active = false;
        } else {
          const iterMatch = errStr.match(/\((\d+)\)/);
          const iterTag = iterMatch ? ` capped@${iterMatch[1]}` : '';
          a.state = sats > 0
            ? `✓ done${iterTag} (${sats.toLocaleString()} sats)`
            : `✓ done${iterTag}`;
          a.phase = 'done';
          a.active = false;
        }
        a.sats = sats;
        // If this is the synthesis agent finishing, mark the lane's
        // cycle as fully done (synthesis is the last phase of cycle-v2).
        // If synthesis is disabled and the worker just finished, treat
        // worker-end as cycle-done.
        if (role === 'synthesis') {
          laneSlot.cyclePhase = 'done';
        } else if (role === 'worker' && (!laneSlot.agents.synthesis || laneSlot.agents.synthesis.phase !== 'starting')) {
          // Worker finished and synthesis hasn't started — possibly the
          // last phase of an ENABLE_SYNTHESIS=0 run. Mark done.
          if (laneSlot.cyclePhase === 'worker') {
            laneSlot.cyclePhase = 'done';
          }
        }
      }
      scheduleBroadcast();

      // Detect inter-agent messages and emit a dedicated "message_flow"
      // event so the UI can render a visual handoff between agent tiles.
      //
      // In cycle-v2 the primary inter-agent message is delegate_task:
      // captain → worker via BRC-33 messagebox with a paid commission.
      // We emit one event on tool_call (the send intent) and an enriched
      // event on tool_result (with commission_id + amount_sats).
      if (role === 'captain' && ev.type === 'tool_call' && ev.name === 'delegate_task') {
        const flow = {
          kind: 'message_flow',
          phase: 'sending',
          lane,
          from: 'captain',
          to: 'worker',
          tool: 'delegate_task',
          from_name: LANE_AGENTS[lane].captain.name,
          to_name: LANE_AGENTS[lane].worker.name,
          ts: Date.now(),
        };
        recordFlow(flow);
        broadcast(flow);
        // dashboardState mirror
        dashboardState.recentFlows.unshift({
          lane, phase: 'sending',
          from: 'captain', to: 'worker',
          from_name: flow.from_name, to_name: flow.to_name,
          ts: flow.ts,
        });
        if (dashboardState.recentFlows.length > RECENT_FLOWS_MAX) {
          dashboardState.recentFlows.length = RECENT_FLOWS_MAX;
        }
        laneSlot.lastDelegateAt = flow.ts;
        scheduleBroadcast();
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
        const flow = {
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
          ts: Date.now(),
        };
        recordFlow(flow);
        broadcast(flow);
        dashboardState.recentFlows.unshift({
          lane, phase: 'confirmed',
          from: 'captain', to: 'worker',
          from_name: flow.from_name, to_name: flow.to_name,
          amount_sats, commission_id,
          ts: flow.ts,
        });
        if (dashboardState.recentFlows.length > RECENT_FLOWS_MAX) {
          dashboardState.recentFlows.length = RECENT_FLOWS_MAX;
        }
        laneSlot.lastDelegateAt = flow.ts;
        scheduleBroadcast();
      }
      // Worker picking up the commission from its inbox: the first
      // think_request after session_start signals "received message".
      // We signal on session_start to make the arrival moment clear.
      if (role === 'worker' && ev.type === 'session_start') {
        const flow = {
          kind: 'message_flow',
          phase: 'received',
          lane,
          from: 'captain',
          to: 'worker',
          from_name: LANE_AGENTS[lane].captain.name,
          to_name: LANE_AGENTS[lane].worker.name,
          ts: Date.now(),
        };
        recordFlow(flow);
        broadcast(flow);
        dashboardState.recentFlows.unshift({
          lane, phase: 'received',
          from: 'captain', to: 'worker',
          from_name: flow.from_name, to_name: flow.to_name,
          ts: flow.ts,
        });
        if (dashboardState.recentFlows.length > RECENT_FLOWS_MAX) {
          dashboardState.recentFlows.length = RECENT_FLOWS_MAX;
        }
        scheduleBroadcast();
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

// Per-agent budget.jsonl tailer. Captain BRC-29 createAction txs are written
// here with `details.txid`, but they DON'T appear in records.jsonl.txids
// (which is worker-only). Without this tailer, captain txs only enter
// dashboardState via the 20s rebuildAggregatesFromDisk rescan — too slow,
// the user sees frozen counters during captain phases. This tailer fires
// per new line, calls addTxid + scheduleBroadcast immediately.
const budgetTailers = new Map();  // key `${lane}:${role}` → tailer fn

function ensureBudgetTailer(lane, role) {
  const key = `${lane}:${role}`;
  if (budgetTailers.has(key)) return budgetTailers.get(key);
  const tailer = makeJsonlTailer(
    () => latestTaskBudget(lane, role),
    (entry) => {
      const txid = entry && entry.details && entry.details.txid;
      if (typeof txid !== 'string' || txid.length !== 64 || !/^[a-f0-9]+$/.test(txid)) return;
      const added = addTxid(lane, txid);
      if (added) {
        const slot = ensureLaneSlot(lane);
        const cost = (entry && typeof entry.sats === 'number') ? entry.sats : 0;
        if (cost > 0 && slot.agents[role]) {
          slot.agents[role].sats = (slot.agents[role].sats || 0) + cost;
        }
        // Categorize this tx into the live txCategories map so the UI
        // breakdown panel updates per-event, not just on 20s rescan.
        const cat = categorizeBudgetEntry(entry);
        bumpCategory(cat, cost);
        dashboardState.recentTxs.unshift({
          lane,
          cycle_dir: 'budget',
          txid,
          ts: Date.now(),
          role,
          category: cat,
        });
        if (dashboardState.recentTxs.length > RECENT_TXS_MAX) {
          dashboardState.recentTxs.length = RECENT_TXS_MAX;
        }
        scheduleBroadcast();
      }
    },
    // Budget files grow line-by-line as the agent acts. Replay the last
    // 64KB on first sight so an in-flight task's recent txs land
    // immediately rather than waiting for the next new line.
    { replayTailBytes: 64 * 1024 },
  );
  budgetTailers.set(key, tailer);
  return tailer;
}

function pollAgentBudgets() {
  for (const lane of LANES) {
    for (const role of ['captain', 'worker', 'synthesis']) {
      ensureBudgetTailer(lane.id, role)();
    }
  }
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
            // ALSO reset the dashboardState slot so snapshot-mode clients
            // immediately drop the stale terminal state (iter, lastTool,
            // sats, "→ upload_to_nanostore" etc) from the prior task.
            // Without this, agents that hung on a previous cycle keep
            // showing stale state until the new task's first event lands.
            const slot = dashboardState.perLane.get(lane.id);
            if (slot && slot.agents[role]) {
              slot.agents[role] = {
                state: 'idle',
                phase: 'idle',
                active: false,
                lastTool: null,
                lastToolAt: null,
                iter: 0,
                sats: 0,
                sessionStart: null,
                taskId: null,
                name: LANE_AGENTS[lane.id][role].name,
                port: LANE_AGENTS[lane.id][role].server_port,
                recentEvents: [],
              };
              scheduleBroadcast();
            }
            // Also reset the budget tailer for this agent so it picks up
            // the new task's budget.jsonl from the start, not the prior
            // task's stale offset. The tailer's internal state.file !==
            // newPath check handles this naturally on next poll.
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
        // dashboardState: fresh aggregate arrived — recompute aggregate fields
        // (idempotent) and schedule a broadcast.
        rebuildAggregatesFromDisk();
        scheduleBroadcast();
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
              const ev = {
                kind: 'proof_emitted',
                lane: lane.id,
                cycle_dir: entry.name,
                txid,
              };
              // Legacy: ring buffer + per-event broadcast
              recentTxs.unshift(ev);
              if (recentTxs.length > RECENT_TXS_MAX) recentTxs.length = RECENT_TXS_MAX;
              broadcast(ev);
              // New: dashboardState union + recentTxs ring + debounced snapshot
              const added = addTxid(lane.id, txid);
              if (added) {
                const laneSlot = ensureLaneSlot(lane.id);
                laneSlot.cycle_dir = entry.name;
                // Worker proof_batch txs are attributed to the
                // "scrape_proofs" category (1 tx = 200 sats fixed).
                bumpCategory('scrape_proofs', 200);
                dashboardState.recentTxs.unshift({
                  lane: lane.id,
                  cycle_dir: entry.name,
                  txid,
                  ts: Date.now(),
                  category: 'scrape_proofs',
                });
                if (dashboardState.recentTxs.length > RECENT_TXS_MAX) {
                  dashboardState.recentTxs.length = RECENT_TXS_MAX;
                }
                scheduleBroadcast();
              }
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
    pollAgentBudgets();
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
          // Mirror into dashboardState
          dashboardState.walletHealth[key] = {
            sats: result.sats,
            utxos: result.utxos,
            updatedAt: Date.now(),
          };
        }
        if (pending === 0 && updates.length > 0) {
          broadcast({ kind: 'wallet_health', updates });
          scheduleBroadcast();
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
    // New path: rebuild dashboardState and broadcast snapshot
    rebuildDashboardFromDisk();
    scheduleBroadcast();
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

  // Replay recent proof_emitted events so the Live TX Stream panel is
  // immediately populated instead of showing "waiting for live txs…"
  // until the next proof lands (which during a synthesis cycle can be
  // several minutes of silence). Send OLDEST FIRST so the client's
  // prependTxItem() inserts them in chronological order — newest ends
  // up at the top, matching the normal stream ordering.
  // Tagged with `_replay: true` so the client populates the tx stream
  // panel without incrementing live counters — these txs are ALREADY
  // counted in historical.perLane, so incrementing live.txs would
  // double-count (and appear to "drop" on the next historical rescan).
  if (recentTxs.length > 0) {
    const ordered = recentTxs.slice().reverse(); // oldest first
    for (const ev of ordered) {
      res.write(`data: ${JSON.stringify({ ...ev, _replay: true })}\n\n`);
    }
  }

  // Replay recent message_flow events so fresh clients see the most
  // recent captain → worker delegate handoffs instead of an empty activity
  // feed until the next cycle (2-6 min per lane). Tagged with `_replay`
  // so the client can show them in the activity feed without triggering
  // the live pulse animation.
  if (recentFlows.length > 0) {
    const ordered = recentFlows.slice().reverse();
    for (const ev of ordered) {
      res.write(`data: ${JSON.stringify({ ...ev, _replay: true })}\n\n`);
    }
  }

  // Send initial snapshot so clients using the new architecture have
  // immediate state. Clients using the legacy path simply ignore it
  // because they don't register a handler for `kind: 'snapshot'`.
  try {
    res.write(`data: ${JSON.stringify({ kind: 'snapshot', state: computeSnapshot() })}\n\n`);
  } catch { /* ignore */ }

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
  // GET /api/state — returns the current dashboardState snapshot as JSON.
  // Used for debugging (compare against what the client shows) and for
  // any non-SSE consumers that want one-shot state.
  if (pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(computeSnapshot()));
    return;
  }

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
// New path: rebuild dashboardState from disk so the FIRST snapshot broadcast
// is immediately accurate, no lazy fill-in.
rebuildDashboardFromDisk();

// Prime the recentTxs ring buffer from disk at boot so the FIRST cold-start
// SSE client sees an already-populated Live TX Stream. Without this, the
// ring buffer is empty until the next fresh proof lands — which during a
// synthesis cycle can mean several minutes of "waiting for live txs…".
// Walks each current-config lane's most recent cycle dirs, grabs the tail
// of records.jsonl.txids, and pushes ordered by mtime (newest first).
function primeRecentTxs() {
  const candidates = []; // { mtimeMs, lane, cycle_dir, txid }
  for (const lane of LANES) {
    const dir = path.join(SHARED_DIR, lane.id);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const cycleDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('cycle-'))
      .map((e) => {
        const p = path.join(dir, e.name, 'records.jsonl.txids');
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(p).mtimeMs; } catch { return null; }
        return { name: e.name, path: p, mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 3); // last 3 cycles per lane is plenty to fill 50 slots
    for (const cd of cycleDirs) {
      let content;
      try { content = fs.readFileSync(cd.path, 'utf8'); } catch { continue; }
      const lines = content.split('\n').filter((l) => {
        const t = l.trim();
        return t.length === 64 && /^[a-f0-9]+$/.test(t);
      });
      for (const line of lines) {
        candidates.push({
          mtimeMs: cd.mtimeMs,
          lane: lane.id,
          cycle_dir: cd.name,
          txid: line.trim(),
        });
      }
    }
  }
  // Newest first, cap at RECENT_TXS_MAX. Same shape the tailer produces.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates.slice(0, RECENT_TXS_MAX)) {
    recentTxs.push({
      kind: 'proof_emitted',
      lane: c.lane,
      cycle_dir: c.cycle_dir,
      txid: c.txid,
    });
    // Mirror into dashboardState.recentTxs (newest first, compact shape).
    dashboardState.recentTxs.push({
      lane: c.lane,
      cycle_dir: c.cycle_dir,
      txid: c.txid,
      ts: c.mtimeMs,
    });
  }
  console.log(`[ui] recentTxs primed: ${recentTxs.length} entries`);
}
primeRecentTxs();

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
