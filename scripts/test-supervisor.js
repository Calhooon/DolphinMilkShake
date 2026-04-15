#!/usr/bin/env node
/**
 * test-supervisor.js — focused integration test for cluster.js auto-restart.
 *
 * Spawns ONE dolphin-milk agent via startCluster({supervise:true}), kills
 * its child process, and verifies the supervisor respawns + the new
 * process becomes healthy. Tests the full real-world path: spawn →
 * kill → backoff → respawn → /health probe.
 *
 * Uses wallet 3414 (synthesis-wiki-en) because it has a clean state and
 * isn't tied to any in-flight test_cycle state.
 *
 * Run: node scripts/test-supervisor.js
 * Pass: exit 0. Fail: exit 1 with diagnostic output.
 */

'use strict';

const path = require('path');
const http = require('http');
const { startCluster } = require('./lib/cluster');

const PARENT_WALLET_PORT = 3321;
const BINARY = path.resolve(process.env.HOME, 'bsv/rust-bsv-worm/target/release/dolphin-milk');
const OVERLAY_URL = process.env.OVERLAY_URL || 'https://rust-overlay.dev-a3e.workers.dev';
const WORKSPACE = path.resolve(process.env.HOME, 'bsv/rust-bsv-worm/test-workspaces/supervisor-test');
const AGENT_PORT = 8200; // use a high port that's unlikely to clash
const WALLET_PORT = 3414; // synthesis-wiki-en wallet (clean, unused in prior runs)

function probeHealth(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve({ ok: res.statusCode === 200, body: JSON.parse(body) }); }
          catch { resolve({ ok: false, body: null }); }
        });
      },
    );
    req.on('error', () => resolve({ ok: false, body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: null }); });
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function log(msg) { console.log(`[test-supervisor] ${new Date().toISOString().slice(11, 23)} ${msg}`); }

async function main() {
  log('starting 1-agent cluster with supervise:true');

  let handle;
  try {
    handle = await startCluster({
      parentWalletPort: PARENT_WALLET_PORT,
      binary: BINARY,
      overlay: {
        url: OVERLAY_URL,
        verifyRegistration: true,
        registrationTimeoutMs: 45_000,
      },
      outputDir: WORKSPACE,
      supervise: true,
      agents: [
        {
          role: 'test',
          name: 'supervisor-test-agent',
          port: AGENT_PORT,
          walletPort: WALLET_PORT,
          model: 'gpt-5-mini',
          workspace: path.join(WORKSPACE, 'supervisor-test-agent'),
          capabilities: ['tools', 'wallet', 'llm'],
        },
      ],
    });
  } catch (e) {
    log(`FAIL: startCluster threw: ${e.message}`);
    process.exit(1);
  }

  log('cluster up — agent spawned and healthy');
  log(`supervisor enabled: ${handle.supervisorState.enabled}`);

  const agentHandle = handle.agents.get('supervisor-test-agent');
  if (!agentHandle || !agentHandle.proc) {
    log('FAIL: no agent proc reference');
    await handle.stop();
    process.exit(1);
  }

  const originalPid = agentHandle.proc.pid;
  log(`original pid: ${originalPid}`);

  // Initial health check — should pass
  let h = await probeHealth(AGENT_PORT);
  if (!h.ok) {
    log('FAIL: initial health check failed');
    await handle.stop();
    process.exit(1);
  }
  log(`initial /health: ok version=${h.body?.version || 'unknown'}`);

  // KILL the child process — simulate a crash
  log(`killing pid ${originalPid} with SIGKILL`);
  process.kill(originalPid, 'SIGKILL');

  // Wait for exit handler to fire + supervisor respawn (2s backoff + spawn + health = ~10-15s)
  log('waiting 20s for supervisor to respawn...');
  await sleep(20_000);

  // Verify the handle now has a NEW proc
  const newProc = handle.agents.get('supervisor-test-agent').proc;
  if (!newProc) {
    log('FAIL: agent handle.proc is null after kill — supervisor did not respawn');
    log(`supervisor state: totalRespawns=${handle.supervisorState.totalRespawns} tripped=[${[...handle.supervisorState.tripped].join(',')}]`);
    await handle.stop();
    process.exit(1);
  }
  if (newProc.pid === originalPid) {
    log(`FAIL: proc.pid unchanged (${newProc.pid}) — respawn did not happen`);
    await handle.stop();
    process.exit(1);
  }
  log(`NEW pid: ${newProc.pid} (was ${originalPid})`);

  // Verify health on the respawned agent
  h = await probeHealth(AGENT_PORT);
  if (!h.ok) {
    log('FAIL: /health failed after respawn');
    await handle.stop();
    process.exit(1);
  }
  log(`respawned /health: ok version=${h.body?.version || 'unknown'}`);
  log(`supervisor counters: totalRespawns=${handle.supervisorState.totalRespawns}`);

  log('PASS — supervisor successfully respawned the killed agent');
  await handle.stop();
  log('cluster stopped cleanly');
  process.exit(0);
}

main().catch((e) => {
  console.error('[test-supervisor] FATAL:', e);
  process.exit(1);
});
