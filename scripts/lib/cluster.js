/**
 * lib/cluster.js — Reusable multi-agent cluster manager for the multi-worm
 * integration test harness.
 *
 * Phase 1 scope (this file):
 *   1. Binary check
 *   2. Parent wallet probe (resolve parent identity key)
 *   3. Per-agent health-probe + spawn (reuse if already running)
 *   4. Identity verification (format check — full wallet cross-check
 *      documented as a Phase 1 limitation below)
 *   5. [STUB] Cert audit + per-role issuance — TODO(phase-2-cert)
 *   6. [STUB] Overlay registration verification — TODO(phase-2-overlay)
 *   7. cluster-state.json emit (atomic)
 *   8. Return ClusterHandle
 *
 * Contract: tests/multi-worm/lib/CONTRACTS.md ("lib/cluster.js" section).
 * Reference implementation to replace: tests/multi-worm/test_three_layer_cascade.js
 * lines ~150-290 (startAgent / stopAgent / stopAll / httpGet / walletPost).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const https = require('https');

const { authGet, authPost } = require('./auth');

// Project root — resolved from RUST_BSV_WORM_DIR env var so dolphinmilkshake
// can consume this lib without a hardcoded relative path. This library was
// originally written for rust-bsv-worm/tests/multi-worm/lib/ and vendored
// here; the env var decouples them.
const PROJECT_ROOT = process.env.RUST_BSV_WORM_DIR
  || `${process.env.HOME}/bsv/rust-bsv-worm`;

// ---------------------------------------------------------------------------
// Low-level HTTP helpers (mirror the shapes used by test_three_layer_cascade.js
// so this module can eventually replace that file's local helpers).
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Plain HTTP GET. Returns `{ status, body }`. Body is JSON-parsed when possible,
 * otherwise the raw string. Rejects on network error or 15s timeout.
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`httpGet timeout: ${url}`));
    });
  });
}

/**
 * Low-level wallet HTTP POST. Mirrors the private walletPost() helper inside
 * lib/auth.js and the one in test_three_layer_cascade.js. Rejects if the
 * wallet returns an error payload or the request times out.
 */
function walletPost(walletPort, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: walletPort,
        path: `/${endpoint}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': `http://localhost:${walletPort}`,
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.error) {
              reject(new Error(`wallet ${endpoint} (port ${walletPort}): ${JSON.stringify(parsed.error)}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`wallet ${endpoint} (port ${walletPort}): bad response: ${raw.substring(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    // 90s timeout (was 15s). BRC-31 auth calls against MetaNet Desktop
    // require manual approval clicks in the UI for each `createSignature`,
    // and with 3 agents × multiple BRC-31 handshakes per cluster startup
    // the user needs generous time to click through. Staggered launches
    // in fleet-cycle.sh also mean multiple lanes might queue approvals.
    req.setTimeout(90000, () => {
      req.destroy();
      reject(new Error(`wallet ${endpoint} (port ${walletPort}): timeout`));
    });
    req.write(data);
    req.end();
  });
}

function logStep(msg) {
  console.log(`[cluster] ${msg}`);
}

function logError(msg) {
  console.error(`[cluster] ${msg}`);
}

function isHex66(s) {
  return typeof s === 'string' && /^[0-9a-fA-F]{66}$/.test(s);
}

// ---------------------------------------------------------------------------
// Step 2: parent wallet probe
// ---------------------------------------------------------------------------

/**
 * Resolve the parent identity key. Tries the bare wallet's `getPublicKey`
 * endpoint first (this is the common case — the parent is a MetaNet Client
 * style wallet, not a dolphin-milk agent). Falls back to BRC-31 authed
 * `/agent` probe if that fails.
 */
async function resolveParentKey(parentWalletPort) {
  // Primary path: direct wallet getPublicKey (matches the cascade test).
  try {
    const resp = await walletPost(parentWalletPort, 'getPublicKey', { identityKey: true });
    const key = resp && resp.publicKey;
    if (isHex66(key)) return key;
    throw new Error(`wallet returned non-hex-66 identity key: ${JSON.stringify(resp)}`);
  } catch (walletErr) {
    // Fallback path: BRC-31 /agent probe, in case the parent is actually a
    // dolphin-milk agent acting as the parent for a sub-cluster.
    try {
      const { status, body } = await authGet(`http://localhost:${parentWalletPort}/agent`, parentWalletPort);
      if (status !== 200) {
        throw new Error(`parent /agent returned ${status}: ${JSON.stringify(body).substring(0, 200)}`);
      }
      const key = body && (body.identity_key || body.identityKey);
      if (!isHex66(key)) {
        throw new Error(`parent /agent returned non-hex-66 identity key: ${JSON.stringify(body).substring(0, 200)}`);
      }
      return key;
    } catch (agentErr) {
      throw new Error(
        `parent wallet probe failed on port ${parentWalletPort}. ` +
        `Wallet getPublicKey: ${walletErr.message}. ` +
        `BRC-31 /agent fallback: ${agentErr.message}. ` +
        `Is the parent wallet running?`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: per-agent health probe + spawn
// ---------------------------------------------------------------------------

/**
 * Check whether an agent is already running and healthy on the given port.
 * Returns the health body if it is, or null otherwise.
 */
async function probeHealth(port) {
  try {
    const { status, body } = await httpGet(`http://localhost:${port}/health`);
    if (status === 200 && body && body.status === 'ok' && body.wallet_connected === true) {
      return body;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wait until an agent at the given port reports healthy, or throw after
 * healthTimeoutMs.
 */
async function waitForHealth(port, healthTimeoutMs, agentName, stderrLogPath) {
  const deadline = Date.now() + healthTimeoutMs;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const { status, body } = await httpGet(`http://localhost:${port}/health`);
      if (status === 200 && body && body.status === 'ok' && body.wallet_connected === true) {
        return body;
      }
      lastError = `status=${status}, body=${JSON.stringify(body).substring(0, 200)}`;
    } catch (e) {
      lastError = e.message;
    }
  }
  // Include stderr tail in the error so the caller can diagnose crashes.
  let stderrTail = '';
  try {
    stderrTail = fs.readFileSync(stderrLogPath, 'utf8').slice(-3000);
  } catch {
    stderrTail = '(stderr log unreadable)';
  }
  throw new Error(
    `[spawn] agent '${agentName}' (port ${port}) failed to become healthy within ${healthTimeoutMs}ms. ` +
    `Last probe: ${lastError}. stderr tail:\n${stderrTail}`
  );
}

/**
 * Spawn a single dolphin-milk agent process. Resolves to the ChildProcess
 * once `/health` reports ok + wallet_connected. Throws on timeout.
 */
async function spawnAgent(config, agent, parentKey) {
  if (!fs.existsSync(agent.workspace)) {
    fs.mkdirSync(agent.workspace, { recursive: true });
  }
  const stdoutLogPath = path.join(agent.workspace, 'server-stdout.log');
  const stderrLogPath = path.join(agent.workspace, 'server-stderr.log');
  // Append mode so supervisor respawns don't clobber prior crash logs —
  // we want the full history in one file to diagnose "crashed 3x in a row"
  // scenarios during the 24h run. Still a fresh file on very first boot
  // (the file didn't exist, so opening 'a' creates it empty).
  const stdoutFd = fs.openSync(stdoutLogPath, 'a');
  const stderrFd = fs.openSync(stderrLogPath, 'a');

  logStep(`spawning '${agent.name}' on port ${agent.port} (wallet ${agent.walletPort}, model ${agent.model})`);

  const env = {
    ...process.env,
    DOLPHIN_MILK_WALLET_URL: `http://localhost:${agent.walletPort}`,
    DOLPHIN_MILK_HEARTBEAT_ENABLED: 'true',
    DOLPHIN_MILK_HEARTBEAT_POLL_SECS: '15',
    DOLPHIN_MILK_OVERLAY_ENABLED: 'true',
    DOLPHIN_MILK_AGENT_NAME: agent.name,
    // Per-role BRC-52 capabilities — dolphin-milk reads this at boot and
    // acquires a parent-signed cert with exactly these caps (revoking stale
    // parent-signed certs from prior runs in the same pass). See
    // src/server/app_state.rs cert provisioning block + CertificateConfig.
    // capabilities docs. cluster.js NO LONGER calls POST /certificates/issue —
    // it configures the natural boot flow and verifies afterwards.
    DOLPHIN_MILK_CERT_CAPABILITIES: (Array.isArray(agent.capabilities) ? agent.capabilities : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .join(','),
    DOLPHIN_MILK_LOG_LEVEL: 'INFO',
    DOLPHIN_MILK_PARENT_KEY: parentKey,
    DOLPHIN_MILK_PARENT_WALLET_URL: `http://localhost:${config.parentWalletPort}`,
    DOLPHIN_MILK_TRUST_CERTIFIERS: parentKey,
    DOLPHIN_MILK_LLM_MODEL: agent.model,
    ...(agent.env || {}),
  };

  const proc = spawn(
    config.binary,
    ['serve', '--port', String(agent.port), '--workspace', agent.workspace],
    {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', stdoutFd, stderrFd],
      detached: false,
    },
  );

  const healthTimeoutMs = config.healthTimeoutMs || 90000;

  try {
    await waitForHealth(agent.port, healthTimeoutMs, agent.name, stderrLogPath);
  } catch (e) {
    // Clean up the half-started process before re-throwing.
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    throw e;
  }

  logStep(`'${agent.name}' healthy (wallet connected)`);

  return { proc, stdoutLogPath, stderrLogPath };
}

/**
 * Attach a supervisor to an agent handle. On unexpected process exit, respawns
 * the agent via `spawnAgent()` with exponential backoff + restart rate limit.
 * No-op when `supervisorState.shuttingDown` is true (intentional teardown).
 *
 * Respawn strategy:
 *   - Max 3 restarts per 60-second window → circuit-breaker to stop hot loops
 *   - Backoff: 2s → 4s → 8s (capped at 60s)
 *   - On respawn success: re-attach supervisor so future crashes are caught
 *   - On respawn failure: log + stop trying (agentHandle.proc stays null)
 *
 * The dolphin-milk boot flow handles cert acquisition and overlay registration
 * on every startup, so a respawn produces a fully-functional agent without
 * the cluster.js bootstrap steps 4/5/6 having to rerun.
 */
function attachSupervisor(agentHandle, config, agent, parentKey, supervisorState) {
  if (!agentHandle.proc) return;
  const proc = agentHandle.proc;

  const onExit = (code, signal) => {
    // Remove reference immediately so callers can tell the proc is dead.
    agentHandle.proc = null;

    if (supervisorState.shuttingDown) {
      // Intentional shutdown — do not respawn.
      return;
    }

    logError(`SUPERVISOR: agent '${agent.name}' exited unexpectedly (code=${code} signal=${signal})`);

    // Rate-limit: max 3 restarts in a rolling 60-second window.
    const now = Date.now();
    const prior = supervisorState.restarts.get(agent.name) || [];
    const recent = prior.filter((t) => now - t < 60_000);
    if (recent.length >= 3) {
      logError(
        `SUPERVISOR: '${agent.name}' exceeded 3 restarts in 60s — circuit breaker TRIPPED, no more respawn attempts`,
      );
      supervisorState.tripped.add(agent.name);
      return;
    }
    recent.push(now);
    supervisorState.restarts.set(agent.name, recent);

    const backoffMs = Math.min(60_000, 2_000 * Math.pow(2, recent.length - 1));
    logStep(`SUPERVISOR: respawning '${agent.name}' in ${backoffMs}ms (attempt ${recent.length}/3)`);

    setTimeout(async () => {
      if (supervisorState.shuttingDown) return;
      try {
        const { proc: newProc, stdoutLogPath, stderrLogPath } = await spawnAgent(
          config,
          agent,
          parentKey,
        );
        agentHandle.proc = newProc;
        agentHandle.stdoutLogPath = stdoutLogPath;
        agentHandle.stderrLogPath = stderrLogPath;
        attachSupervisor(agentHandle, config, agent, parentKey, supervisorState);
        logStep(`SUPERVISOR: '${agent.name}' respawned and healthy`);
        supervisorState.totalRespawns += 1;
      } catch (e) {
        logError(`SUPERVISOR: respawn of '${agent.name}' FAILED: ${e.message}`);
      }
    }, backoffMs);
  };

  proc.once('exit', onExit);
}

/**
 * Health-probe + (reuse or spawn) for a single agent. Returns a partial
 * AgentHandle without cert or overlay fields populated (those come later).
 */
async function startOneAgent(config, agent, parentKey) {
  const existing = await probeHealth(agent.port);
  if (existing) {
    logStep(`reusing already-running agent '${agent.name}' on port ${agent.port}`);
    return {
      name: agent.name,
      port: agent.port,
      walletPort: agent.walletPort,
      workspace: agent.workspace,
      capabilities: agent.capabilities || [],
      identityKey: null, // filled in during step 4
      certHash: null,
      certCapabilities: [],
      overlayRegistered: false,
      overlayRegisteredAt: null,
      spawnedByUs: false,
      proc: null,
      // No log paths for reused agents — we didn't open them.
      stdoutLogPath: null,
      stderrLogPath: null,
    };
  }

  const { proc, stdoutLogPath, stderrLogPath } = await spawnAgent(config, agent, parentKey);
  return {
    name: agent.name,
    port: agent.port,
    walletPort: agent.walletPort,
    workspace: agent.workspace,
    capabilities: agent.capabilities || [],
    identityKey: null,
    certHash: null,
    certCapabilities: [],
    overlayRegistered: false,
    overlayRegisteredAt: null,
    spawnedByUs: true,
    proc,
    stdoutLogPath,
    stderrLogPath,
  };
}

// ---------------------------------------------------------------------------
// Step 4: identity verification
// ---------------------------------------------------------------------------

/**
 * Query the agent's /agent endpoint (BRC-31 authed) and extract its identity
 * key. Asserts the key is a valid 66-char hex string.
 *
 * Phase 1 limitation: the contract calls for an *independent* cross-check
 * by querying the agent's wallet's getPublicKey directly. Because that path
 * is not currently used by test_three_layer_cascade.js (the wallet may not
 * expose identityKey:true for agent wallets the same way it does for the
 * parent), Phase 1 trusts the agent's own /agent response. Phase 2 should
 * add the wallet-side cross-check once the wallet endpoint is confirmed.
 * See TODO(phase-2-identity-xcheck) below.
 */
async function verifyAgentIdentity(agentHandle, parentWalletPort) {
  const { status, body } = await authGet(
    `http://localhost:${agentHandle.port}/agent`,
    parentWalletPort,
  );
  if (status !== 200) {
    throw new Error(
      `[identity] agent '${agentHandle.name}' /agent returned ${status}: ${JSON.stringify(body).substring(0, 200)}`,
    );
  }
  const key = body && (body.identity_key || body.identityKey);
  if (!isHex66(key)) {
    throw new Error(
      `[identity] agent '${agentHandle.name}' returned invalid identity key. ` +
      `Expected 66-char hex. Got: ${JSON.stringify(key)}`,
    );
  }

  // TODO(phase-2-identity-xcheck): Independently query the agent's wallet
  // at agentHandle.walletPort via walletPost(port, 'getPublicKey', { identityKey: true })
  // and assert the result matches `key`. This catches "spawned with wrong wallet"
  // cases silently. The cascade test does not currently do this; confirm the
  // endpoint shape for non-parent wallets before enabling.

  agentHandle.identityKey = key;
  return key;
}

// ---------------------------------------------------------------------------
// Step 5: cert audit + per-role issuance
// ---------------------------------------------------------------------------

/**
 * Extract a usable cert object from a /certificates response. The handler
 * (src/server/handlers/agent.rs:214-242) returns:
 *   { status, valid, certificate, identity_key, is_revoked }
 * where `certificate` is the raw BRC-52 cert JSON (may have `fields`,
 * `certifier`, `subject`, `serialNumber`, `revocationOutpoint`, etc.).
 * Returns `null` if the response doesn't look like a valid parent-signed cert.
 */
function extractCert(certResponseBody) {
  if (!certResponseBody || typeof certResponseBody !== 'object') return null;
  if (certResponseBody.valid !== true) return null;
  if (certResponseBody.is_revoked === true) return null;
  const cert = certResponseBody.certificate;
  if (!cert || typeof cert !== 'object') return null;
  return cert;
}

/**
 * Best-effort capability extraction from a BRC-52 cert JSON blob.
 * Cert field layout varies — `fields.capabilities` is the canonical location,
 * but older self-signed certs may store it on the top-level object or use
 * a comma-separated string. Returns a deduped sorted string[] or [] if
 * nothing parseable was found.
 */
function extractCapabilitiesFromCert(cert) {
  if (!cert || typeof cert !== 'object') return [];
  const candidates = [];
  if (cert.fields && typeof cert.fields === 'object') {
    candidates.push(cert.fields.capabilities);
  }
  candidates.push(cert.capabilities);

  for (const raw of candidates) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      return Array.from(new Set(raw.map((s) => String(s).trim()).filter(Boolean))).sort();
    }
    if (typeof raw === 'string') {
      return Array.from(
        new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)),
      ).sort();
    }
  }
  return [];
}

/**
 * Best-effort cert hash extraction. BRC-52 certs are identified by
 * `serialNumber`; we also accept `hash`, `certHash`, or `serial` for
 * forward-compat with hypothetical future response shapes.
 */
function extractCertHash(cert) {
  if (!cert || typeof cert !== 'object') return null;
  return (
    cert.serialNumber ||
    cert.serial_number ||
    cert.hash ||
    cert.certHash ||
    cert.serial ||
    null
  );
}

/**
 * Check whether a cert's capabilities cover every declared capability.
 */
function capsCoverDeclared(certCaps, declared) {
  if (!Array.isArray(certCaps) || !Array.isArray(declared)) return false;
  const have = new Set(certCaps);
  for (const cap of declared) {
    if (!have.has(cap)) return false;
  }
  return true;
}

/**
 * Issue (or reuse) a parent-signed BRC-52 cert per agent with per-role
 * capabilities. Populates `agent.certHash` and `agent.certCapabilities`
 * on each handle in place.
 *
 * Response shape assumed from POST /certificates/issue
 * (src/server/handlers/agent.rs:371-377):
 *   {
 *     issued: true,
 *     relinquished_self_signed: number,
 *     certificate: { ... BRC-52 cert JSON with fields, serialNumber, ... },
 *     status: { status: "parent_signed" | ..., certificate: {...}, identity_key },
 *     txid: "<64 hex>" | null,
 *   }
 * Capabilities are round-tripped via the `fields.capabilities` (comma-separated
 * string per Agent A investigation, line 43-56). We parse the echoed cert
 * defensively so forward-compat field renames don't break us.
 *
 * Agent F dependency: if the rust-bsv-worm patch landed, the response may
 * embed re-registration info on `certificate.reregistration_result` or a
 * `reregistration` field; we log it but don't rely on it — step 6 verifies
 * independently.
 */
async function issueCertsForAgents(agents, parentWalletPort, config) {
  void config; // reserved for future per-config budget/certifier overrides
  // cluster.js NO LONGER POSTs /certificates/issue. Instead it spawns agents with
  // DOLPHIN_MILK_CERT_CAPABILITIES set, and dolphin-milk's natural boot-time cert
  // provisioning (src/server/app_state.rs) acquires a parent-signed cert with
  // exactly those capabilities, revoking any stale certs in the same pass.
  //
  // This function just POLLs GET /certificates on each agent until the visible
  // cert's capabilities cover the declared set, then populates certHash/certCapabilities
  // on the agent handle. Hard fails on timeout or mismatch.
  //
  // Timing: boot cert acquisition is synchronous inside create_app_state() — by
  // the time /health returns 200, the cert should already be the right one. We
  // poll briefly anyway to tolerate any async settle time.
  // 60s (was 20s) — when 20+ lanes fire at once, 40+ agents hammer the parent
  // wallet for BRC-52 cert issuance simultaneously. Parent wallet signs one
  // createSignature at a time, so tail-latency for the last few agents can
  // easily exceed 20s under contention. 20-lane soak 2026-04-15 killed
  // bsky-en-11 at exactly this line. 60s buys real headroom.
  const POLL_TIMEOUT_MS = 60000;
  const POLL_INTERVAL_MS = 500;

  await Promise.all(
    agents.map(async (agent) => {
      const declared = Array.isArray(agent.capabilities) ? agent.capabilities.slice() : [];
      if (declared.length === 0) {
        throw new Error(
          `[cert] agent '${agent.name}' has no declared capabilities — cannot verify an empty set`,
        );
      }
      const capsString = declared.join(',');

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let lastSeenCaps = null;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const { status, body } = await authGet(
            `http://localhost:${agent.port}/certificates`,
            parentWalletPort,
          );
          if (status === 200) {
            const cert = extractCert(body);
            if (cert) {
              const certCaps = extractCapabilitiesFromCert(cert);
              lastSeenCaps = certCaps;
              if (capsCoverDeclared(certCaps, declared)) {
                const hash = extractCertHash(cert);
                agent.certHash = hash || '(verified-cert-no-hash)';
                agent.certCapabilities = certCaps;
                logStep(
                  `'${agent.name}' verified parent-signed cert (caps: ${certCaps.join(',')})`,
                );
                return;
              }
            }
          } else {
            lastError = `HTTP ${status}`;
          }
        } catch (e) {
          lastError = e.message;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      throw new Error(
        `[cert] agent '${agent.name}' did not converge on desired capabilities within ${POLL_TIMEOUT_MS}ms. ` +
        `Declared: [${capsString}]. Last seen: ${lastSeenCaps ? `[${lastSeenCaps.join(',')}]` : 'none'}. ` +
        `Last error: ${lastError || 'none'}. ` +
        `Check server-stderr.log for BRC-52 acquisition errors (parent wallet reachable? DOLPHIN_MILK_CERT_CAPABILITIES propagated?).`,
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 6: overlay registration verification
// ---------------------------------------------------------------------------

/**
 * Low-level HTTPS GET for the overlay. Returns `{ status, body }` with body
 * JSON-parsed when possible. Rejects on network error or 15s timeout. The
 * overlay is public BRC-100 and does not require BRC-31 auth.
 */
function httpsGetJson(urlStr) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (e) {
      reject(new Error(`invalid overlay URL: ${urlStr} (${e.message})`));
      return;
    }
    const req = https.get(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`overlay lookup timeout: ${urlStr}`));
    });
  });
}

/**
 * Low-level HTTPS POST with JSON body. Mirrors dolphin-milk's own overlay
 * lookup path in src/overlay/lookup.rs: POST {overlay_url}/lookup with
 * `{ service, query }`. Overlay is public, no BRC-31 auth.
 */
function httpsPostJson(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (e) {
      reject(new Error(`invalid overlay URL: ${urlStr} (${e.message})`));
      return;
    }
    const payload = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`overlay lookup timeout: ${urlStr}`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Defensive overlay response walker. The overlay's `/lookup` response shape
 * is unknown at the time of writing (Phase 3 should validate against real
 * responses). We walk common shapes:
 *   - { results: [ { identity_key, ... }, ... ] }
 *   - { agents: [ ... ] }
 *   - { outputs: [ { beef / publicKey / fields / lockingScript / ... } ] }
 *   - bare array of objects
 * and return true if any nested object has an identity-key-ish field
 * matching `expectedKey` exactly (case-insensitive).
 *
 * If Phase 3 reveals a different shape, narrow this down to the real path.
 */
function overlayResponseContainsKey(body, expectedKey) {
  if (!body || typeof body !== 'object') return false;
  const target = String(expectedKey).toLowerCase();
  const KEY_FIELDS = [
    'identity_key',
    'identityKey',
    'identityPublicKey',
    'pubkey',
    'pubKey',
    'publicKey',
    'public_key',
    'agentKey',
    'agent_identity_key',
    'subject',
  ];
  const seen = new WeakSet();
  const stack = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    for (const field of KEY_FIELDS) {
      const v = node[field];
      if (typeof v === 'string' && v.toLowerCase() === target) {
        return true;
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}

/**
 * Verify each agent's overlay registration.
 *
 * The natural dolphin-milk boot flow handles the registration itself:
 * `create_app_state()` acquires a parent-signed cert with the configured
 * capabilities (from `DOLPHIN_MILK_CERT_CAPABILITIES` env) and then the
 * async overlay task calls `register_on_overlay()` with those capabilities.
 * By the time cluster.js reaches step 6, the registration may still be
 * in-flight (broadcast + overlay submit takes a few seconds). We poll the
 * overlay until the agent's identity key appears.
 *
 * Query shape matches `src/overlay/registration.rs::check_registered`:
 * `POST {overlay_url}/lookup` with body `{service: "ls_agent", query: {findByIdentityKey: <hex>}}`.
 * The response is `{type: "output-list", outputs: [{beef: [...], outputIndex: N}, ...]}`.
 * A non-empty `outputs` array means the overlay has indexed this agent. We
 * don't decode BEEF in JS — the capabilities were already verified via
 * GET /certificates in step 5, and the server-stderr log's "Registered on
 * overlay" message confirms the caps that went into registration.
 *
 * Skip entirely when overlay.verifyRegistration === false.
 */
async function verifyOverlayRegistrations(agents, overlay) {
  if (!overlay || overlay.verifyRegistration === false) {
    logStep('overlay verification skipped (overlay.verifyRegistration=false)');
    return;
  }
  const timeoutMs = overlay.registrationTimeoutMs || 30000;
  const overlayUrl = overlay.url;
  if (!overlayUrl) {
    throw new Error('[overlay] overlay.url is required when verifyRegistration=true');
  }
  const lookupUrl = `${overlayUrl.replace(/\/$/, '')}/lookup`;

  await Promise.all(
    agents.map(async (agent) => {
      if (!agent.identityKey) {
        throw new Error(
          `[overlay] agent '${agent.name}' has no identityKey — step 4 must run before step 6`,
        );
      }

      const deadline = Date.now() + timeoutMs;
      let delayMs = 1000;
      let lastStatus = null;
      let lastBodySnippet = '';
      let found = false;

      const body = {
        service: 'ls_agent',
        query: { findByIdentityKey: agent.identityKey },
      };

      while (Date.now() < deadline && !found) {
        try {
          const resp = await httpsPostJson(lookupUrl, body);
          lastStatus = resp.status;
          lastBodySnippet =
            typeof resp.body === 'string'
              ? resp.body.substring(0, 400)
              : JSON.stringify(resp.body).substring(0, 400);
          if (resp.status >= 200 && resp.status < 300) {
            // Overlay returns { type: "output-list", outputs: [...] }.
            // A non-empty outputs array means the agent is indexed.
            const outputs = (resp.body && Array.isArray(resp.body.outputs))
              ? resp.body.outputs
              : [];
            if (outputs.length > 0) {
              found = true;
              break;
            }
          }
        } catch (e) {
          lastBodySnippet = `network error: ${e.message}`;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const nextDelay = Math.min(delayMs, 8000, remaining);
        await sleep(nextDelay);
        delayMs = Math.min(delayMs * 2, 8000);
      }

      if (!found) {
        throw new Error(
          `[overlay] Agent ${agent.name} (${agent.identityKey}) not found on overlay ` +
          `after ${timeoutMs}ms. Boot-time overlay registration may still be in flight, ` +
          `or the registration tx may have failed. Check server-stderr.log for ` +
          `'Registered on overlay' or 'Overlay registration' errors. ` +
          `Last overlay status=${lastStatus}, body=${lastBodySnippet}`,
        );
      }

      logStep(`'${agent.name}' overlay-registered (identity key found on overlay)`);
      agent.overlayRegistered = true;
      agent.overlayRegisteredAt = new Date().toISOString();
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 7: state file emit (atomic)
// ---------------------------------------------------------------------------

function writeClusterStateAtomic(stateFilePath, state) {
  const tmpPath = `${stateFilePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, stateFilePath);
}

function buildStateFilePayload(handle) {
  const agents = {};
  for (const [name, a] of handle.agents.entries()) {
    agents[name] = {
      name: a.name,
      port: a.port,
      walletPort: a.walletPort,
      identityKey: a.identityKey,
      workspace: path.resolve(a.workspace),
      certHash: a.certHash,
      certCapabilities: a.certCapabilities,
      overlayRegistered: a.overlayRegistered,
      overlayRegisteredAt: a.overlayRegisteredAt,
      spawnedByUs: a.spawnedByUs,
      stdoutLogPath: a.stdoutLogPath ? path.resolve(a.stdoutLogPath) : null,
      stderrLogPath: a.stderrLogPath ? path.resolve(a.stderrLogPath) : null,
    };
  }
  return {
    createdAt: handle.createdAt,
    parentKey: handle.parentKey,
    overlayUrl: handle.overlayUrl,
    agents,
  };
}

// ---------------------------------------------------------------------------
// Public: startCluster
// ---------------------------------------------------------------------------

/**
 * Bring up a multi-agent cluster. See CONTRACTS.md "lib/cluster.js" for the
 * full spec. Each step is a hard gate — throws on failure with a clear
 * message indicating which step failed.
 */
async function startCluster(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('[startCluster] config is required');
  }
  if (!config.binary) throw new Error('[startCluster] config.binary is required');
  if (!config.parentWalletPort) throw new Error('[startCluster] config.parentWalletPort is required');
  if (!config.outputDir) throw new Error('[startCluster] config.outputDir is required');
  if (!config.overlay) throw new Error('[startCluster] config.overlay is required');
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error('[startCluster] config.agents must be a non-empty array');
  }

  // Supervisor state — lives on the handle, used by attachSupervisor() to
  // track restart budget + suppress respawn during intentional shutdown.
  // Enabled when config.supervise === true (default false for backward compat).
  const supervisorState = {
    enabled: config.supervise === true,
    shuttingDown: false,
    restarts: new Map(),  // agent.name → [timestamp, ...] (last 60s only)
    tripped: new Set(),   // agent names that exceeded the restart limit
    totalRespawns: 0,     // counter for monitoring
  };

  // --- Step 1: binary check ---------------------------------------------------
  logStep(`step 1 — binary check: ${config.binary}`);
  if (!fs.existsSync(config.binary)) {
    throw new Error(
      `[step 1] binary not found at ${config.binary}. Run \`cargo build --release\` first.`,
    );
  }

  // --- Step 2: parent wallet probe -------------------------------------------
  logStep(`step 2 — parent wallet probe on port ${config.parentWalletPort}`);
  let parentKey;
  try {
    parentKey = await resolveParentKey(config.parentWalletPort);
  } catch (e) {
    throw new Error(`[step 2] ${e.message}`);
  }
  logStep(`parent identity key: ${parentKey.substring(0, 16)}...`);

  // --- Step 3: per-agent health probe + spawn (SEQUENTIAL) -------------------
  //
  // Sequential rather than parallel spawn. Why: each agent's create_app_state()
  // path hits the parent wallet (:3321) to request BRC-52 cert acquisition via
  // acquire_parent_authorization. The parent wallet serializes signCertificate
  // calls internally (SQLite-backed), and 3+ agents hitting it simultaneously
  // can cause request timeouts (~10s each) that force agents to fall back to
  // SELF-SIGNED certs. Those self-signed fallbacks then leave the wallet with
  // stale cert state that confuses LLM safety-reflex (cf. the P4 Coord refusal
  // observed during the Phase 3 cascade refactor on 2026-04-13: Coord's LLM saw
  // a stale handshake-bravo cert in its system prompt, refused to delegate).
  //
  // Sequential spawn trades ~15-20s of boot wall-time for rock-solid parent
  // wallet reliability. For the 25-agent DolphinSense launcher, this is the
  // right trade even at scale — cert acquisition only happens at boot, and the
  // 25-agent cold-start already absorbs multi-second delays per agent from
  // binary launch + health polling. Saving 15-20s of parallelism is not worth
  // the intermittent cert fallback.
  logStep(`step 3 — health probe + spawn ${config.agents.length} agent(s) sequentially`);
  const agentHandles = [];
  try {
    for (const a of config.agents) {
      const handle = await startOneAgent(config, a, parentKey);
      agentHandles.push(handle);
    }
  } catch (e) {
    // Clean up anything we spawned before this one failed.
    for (const spawned of agentHandles) {
      if (spawned.spawnedByUs && spawned.proc) {
        try { spawned.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
    throw new Error(`[step 3] ${e.message}`);
  }

  // Stash them in a Map keyed by name, and ensure no duplicates.
  const agents = new Map();
  for (const h of agentHandles) {
    if (agents.has(h.name)) {
      // Clean up anything we spawned before throwing.
      for (const spawned of agentHandles) {
        if (spawned.spawnedByUs && spawned.proc) {
          try { spawned.proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }
      throw new Error(`[step 3] duplicate agent name '${h.name}' in config.agents`);
    }
    agents.set(h.name, h);
  }

  // --- Step 4: identity verification -----------------------------------------
  // Serialized (not Promise.all) because each verifyAgentIdentity call hits
  // the parent wallet (MetaNet Desktop) twice for BRC-31 — getPublicKey +
  // createSignature. Parallel verification of 3 agents = 6 concurrent parent
  // wallet calls per lane; with multiple lanes staggered it compounds. The
  // dolphinmilkshake fleet runs multiple lane-cycle processes in parallel
  // and MetaNet can't sustain the burst. Sequential here keeps the load
  // per-lane bounded.
  logStep(`step 4 — identity verification (sequential)`);
  try {
    for (const h of agentHandles) {
      await verifyAgentIdentity(h, config.parentWalletPort);
    }
  } catch (e) {
    // Clean up anything we spawned before throwing.
    for (const h of agentHandles) {
      if (h.spawnedByUs && h.proc) {
        try { h.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
    throw new Error(`[step 4] ${e.message}`);
  }
  for (const h of agentHandles) {
    logStep(`'${h.name}' identity ${h.identityKey.substring(0, 16)}...`);
  }

  // --- Step 5: cert issuance -------------------------------------------------
  logStep(`step 5 — cert audit + per-role issuance`);
  try {
    await issueCertsForAgents(agentHandles, config.parentWalletPort, config);
  } catch (e) {
    // Clean up anything we spawned before throwing.
    for (const h of agentHandles) {
      if (h.spawnedByUs && h.proc) {
        try { h.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
    throw new Error(`[step 5] ${e.message}`);
  }

  // --- Step 6: overlay verification ------------------------------------------
  logStep(`step 6 — overlay registration verification`);
  try {
    await verifyOverlayRegistrations(agentHandles, config.overlay);
  } catch (e) {
    // Clean up anything we spawned before throwing.
    for (const h of agentHandles) {
      if (h.spawnedByUs && h.proc) {
        try { h.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
    throw new Error(`[step 6] ${e.message}`);
  }

  // --- Step 7: state file emit -----------------------------------------------
  logStep(`step 7 — emit cluster-state.json`);
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  const stateFile = path.resolve(path.join(config.outputDir, 'cluster-state.json'));
  const createdAt = new Date().toISOString();

  // Build the in-memory handle first, then serialize from it (single source of truth).
  const handle = {
    agents,
    stateFile,
    parentKey,
    overlayUrl: config.overlay.url,
    createdAt,
    supervisorState,
    stop(options) {
      supervisorState.shuttingDown = true;
      return stopCluster(this, options);
    },
  };

  // Attach supervisors AFTER the full cluster bootstrap succeeds — so a
  // failure in step 4/5/6 doesn't leave dangling restart handlers on
  // processes we're about to kill anyway.
  if (supervisorState.enabled) {
    for (const h of agentHandles) {
      // Find the original agent config (by name) to thread into respawn.
      const agentCfg = config.agents.find((a) => a.name === h.name);
      if (agentCfg && h.spawnedByUs && h.proc) {
        attachSupervisor(h, config, agentCfg, parentKey, supervisorState);
      }
    }
    logStep(`supervisor ENABLED — ${agentHandles.length} agents will auto-respawn on crash`);
  }

  try {
    writeClusterStateAtomic(stateFile, buildStateFilePayload(handle));
  } catch (e) {
    // Clean up anything we spawned before throwing.
    for (const h of agentHandles) {
      if (h.spawnedByUs && h.proc) {
        try { h.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
    throw new Error(`[step 7] failed to write ${stateFile}: ${e.message}`);
  }
  logStep(`wrote ${stateFile}`);

  // --- Step 8: return handle -------------------------------------------------
  logStep(`cluster ready — ${agents.size} agent(s) online`);
  return handle;
}

// ---------------------------------------------------------------------------
// Public: stopCluster
// ---------------------------------------------------------------------------

/**
 * Stop one agent's spawned process. Sends SIGTERM, then SIGKILL after 5s.
 * Resolves on process exit. Idempotent — a no-op if proc is null or already
 * exited.
 */
function stopOne(agentHandle) {
  const proc = agentHandle.proc;
  if (!proc) return Promise.resolve();
  if (proc.exitCode !== null && proc.exitCode !== undefined) {
    agentHandle.proc = null;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      agentHandle.proc = null;
      logStep(`stopped '${agentHandle.name}'`);
      resolve();
    };

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 5000);

    proc.on('exit', () => {
      clearTimeout(killTimer);
      done();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(killTimer);
      done();
    }
  });
}

/**
 * Stop a cluster. By default (`onlySpawned: true`) only stops agents that
 * startCluster spawned itself; reused already-running agents are left alone.
 * Safe to call multiple times — agents already stopped become no-ops.
 */
async function stopCluster(handle, options = {}) {
  if (!handle || !handle.agents) return;
  const onlySpawned = options.onlySpawned !== false; // default true
  const toStop = [];
  for (const agent of handle.agents.values()) {
    if (onlySpawned && !agent.spawnedByUs) continue;
    if (!agent.proc) continue;
    toStop.push(agent);
  }
  if (toStop.length === 0) {
    logStep('stopCluster: nothing to stop');
    return;
  }
  logStep(`stopCluster: stopping ${toStop.length} agent(s)`);
  await Promise.all(toStop.map((a) => stopOne(a)));
}

module.exports = {
  startCluster,
  stopCluster,
};
