/**
 * BRC-31/103/104 authentication client for multi-worm test infrastructure.
 *
 * Signs requests via the parent wallet (MetaNet Client on port 3321)
 * and sends them directly to worm servers. This is NOT AuthFetch —
 * AuthFetch routes through the wallet. This client signs via the wallet
 * but sends to the target server.
 *
 * Protocol: BRC-104 binary serialization, BRC-42 key derivation for signing.
 */

const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Varint encoding (Bitcoin-style, matches BRC-104 spec)
// ---------------------------------------------------------------------------

function writeVarint(n) {
  if (n <= 252) {
    return Buffer.from([n]);
  } else if (n <= 0xFFFF) {
    const b = Buffer.alloc(3);
    b[0] = 0xFD;
    b.writeUInt16LE(n, 1);
    return b;
  } else if (n <= 0xFFFFFFFF) {
    const b = Buffer.alloc(5);
    b[0] = 0xFE;
    b.writeUInt32LE(n, 1);
    return b;
  } else {
    const b = Buffer.alloc(9);
    b[0] = 0xFF;
    b.writeBigUInt64LE(BigInt(n), 1);
    return b;
  }
}

const EMPTY_SENTINEL = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

// ---------------------------------------------------------------------------
// BRC-104 serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an HTTP request into BRC-104 binary format for signing.
 */
function serializeRequest(requestId, method, path, query, headers, body) {
  const parts = [];

  // 1. Raw request ID (32 bytes, NO varint prefix)
  parts.push(requestId);

  // 2. Method
  const methodBuf = Buffer.from(method, 'utf8');
  parts.push(writeVarint(methodBuf.length));
  parts.push(methodBuf);

  // 3. Path
  if (path) {
    const pathBuf = Buffer.from(path, 'utf8');
    parts.push(writeVarint(pathBuf.length));
    parts.push(pathBuf);
  } else {
    parts.push(EMPTY_SENTINEL);
  }

  // 4. Query
  if (query) {
    const queryBuf = Buffer.from(query, 'utf8');
    parts.push(writeVarint(queryBuf.length));
    parts.push(queryBuf);
  } else {
    parts.push(EMPTY_SENTINEL);
  }

  // 5. Headers
  parts.push(writeVarint(headers.length));
  for (const [key, value] of headers) {
    const keyBuf = Buffer.from(key, 'utf8');
    const valBuf = Buffer.from(value, 'utf8');
    parts.push(writeVarint(keyBuf.length));
    parts.push(keyBuf);
    parts.push(writeVarint(valBuf.length));
    parts.push(valBuf);
  }

  // 6. Body
  if (body && body.length > 0) {
    parts.push(writeVarint(body.length));
    parts.push(body);
  } else {
    parts.push(EMPTY_SENTINEL);
  }

  return Buffer.concat(parts);
}

/**
 * Filter and sort headers for BRC-104 signing.
 * Includes: x-bsv-* (except x-bsv-auth-*), authorization, content-type (media type only).
 * Sorted alphabetically by lowercase key.
 */
function filterSignableHeaders(headers) {
  const filtered = [];

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-bsv-auth-')) continue;
    if (lower.startsWith('x-bsv-')) {
      filtered.push([lower, value]);
    } else if (lower === 'authorization') {
      filtered.push([lower, value]);
    } else if (lower === 'content-type') {
      filtered.push([lower, value.split(';')[0].trim()]);
    }
  }

  filtered.sort((a, b) => a[0].localeCompare(b[0]));
  return filtered;
}

// ---------------------------------------------------------------------------
// Wallet HTTP helpers (talk to MetaNet Client on parent wallet port)
// ---------------------------------------------------------------------------

function walletPost(walletPort, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: walletPort,
      path: `/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://localhost:${walletPort}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error || parsed.message) {
            reject(new Error(`Wallet ${endpoint}: ${parsed.error || parsed.message}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Wallet ${endpoint}: bad response: ${raw.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    // 90s (was 10s) — BRC-31 createSignature requires manual approval in
    // MetaNet Desktop UI, and the fleet stagger means approvals queue up.
    // User needs generous click-time. See lib/cluster.js walletPost for the
    // parallel bump.
    req.setTimeout(90000, () => { req.destroy(); reject(new Error(`Wallet ${endpoint}: timeout`)); });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// BRC-31 Session Management
// ---------------------------------------------------------------------------

/** @type {Map<string, { serverNonce: string, serverIdentityKey: string, clientNonce: string }>} */
const sessions = new Map();

/**
 * Perform BRC-31 handshake with a worm server.
 * @param {number} wormPort — worm HTTP port
 * @param {string} identityKey — parent wallet identity key (hex)
 * @returns {Promise<{ serverNonce: string, serverIdentityKey: string, clientNonce: string }>}
 */
async function handshake(wormPort, identityKey) {
  const sessionKey = `localhost:${wormPort}`;
  const existing = sessions.get(sessionKey);
  if (existing) return existing;

  const clientNonce = crypto.randomBytes(32).toString('base64');

  const body = JSON.stringify({
    version: '0.1',
    messageType: 'initialRequest',
    identityKey,
    initialNonce: clientNonce,
  });

  const resp = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: wormPort,
      path: '/.well-known/auth',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { reject(new Error(`Handshake parse error: ${raw.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    // 90s (was 10s) — handshake cascade may include BRC-31 createSignature
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Handshake timeout')); });
    req.write(body);
    req.end();
  });

  if (resp.status !== 200) {
    throw new Error(`Handshake failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }

  const session = {
    serverNonce: resp.body.initialNonce,
    serverIdentityKey: resp.body.identityKey,
    clientNonce,
  };
  sessions.set(sessionKey, session);
  return session;
}

// ---------------------------------------------------------------------------
// Authenticated Request
// ---------------------------------------------------------------------------

/**
 * Make an authenticated HTTP request to a worm server.
 * Signs via the parent wallet, sends directly to the worm.
 *
 * @param {string} method — HTTP method (GET, POST)
 * @param {string} url — full URL (e.g. http://localhost:8080/agent)
 * @param {number} parentWalletPort — parent wallet port for signing
 * @param {object} [bodyObj] — request body (will be JSON-serialized)
 * @returns {Promise<{ status: number, body: any }>}
 */
async function authRequest(method, url, parentWalletPort, bodyObj) {
  const urlObj = new URL(url);
  const wormPort = parseInt(urlObj.port || '80');
  const path = urlObj.pathname;
  const query = urlObj.search || null; // includes '?' prefix

  // 1. Get parent identity key
  const { publicKey: identityKey } = await walletPost(parentWalletPort, 'getPublicKey', { identityKey: true });

  // 2. Handshake if needed
  const session = await handshake(wormPort, identityKey);

  // 3. Generate per-request nonces
  const requestId = crypto.randomBytes(32);
  const requestIdB64 = requestId.toString('base64');
  const msgNonce = crypto.randomBytes(32).toString('base64');

  // 4. Build request headers
  const requestHeaders = {};
  let bodyBuf = null;
  if (bodyObj !== undefined) {
    bodyBuf = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    requestHeaders['content-type'] = 'application/json';
  }

  // 5. Filter and serialize for signing.
  // NOTE: body is NOT included in the signature. The worm server passes body: None
  // to verify_request because axum consumes the body via Json extractor before auth
  // verification. Both client and server must serialize with body = null.
  const signableHeaders = filterSignableHeaders(requestHeaders);
  const serialized = serializeRequest(requestId, method, path, query, signableHeaders, null);

  // 6. Sign via parent wallet
  const keyId = `${msgNonce} ${session.serverNonce}`;
  const sigResp = await walletPost(parentWalletPort, 'createSignature', {
    data: Array.from(serialized), // wallet expects number[]
    protocolID: [2, 'auth message signature'],
    keyID: keyId,
    counterparty: session.serverIdentityKey,
  });

  // Convert signature byte array to hex
  const signatureHex = Buffer.from(sigResp.signature).toString('hex');

  // 7. Build final headers with auth
  const finalHeaders = {
    ...requestHeaders,
    'x-bsv-auth-version': '0.1',
    'x-bsv-auth-identity-key': identityKey,
    'x-bsv-auth-message-type': 'general',
    'x-bsv-auth-nonce': msgNonce,
    'x-bsv-auth-your-nonce': session.serverNonce,
    'x-bsv-auth-signature': signatureHex,
    'x-bsv-auth-request-id': requestIdB64,
  };

  if (bodyBuf) {
    finalHeaders['content-length'] = String(bodyBuf.length);
  }

  // 8. Send to worm server
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: wormPort,
      path: path + (query || ''),
      method,
      headers: finalHeaders,
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    // 120s (was 30s) — auth-signed requests include BRC-31 roundtrip to parent wallet
    req.setTimeout(120000, () => { req.destroy(); reject(new Error(`Auth request timeout: ${method} ${path}`)); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Authenticated GET request.
 */
async function authGet(url, parentWalletPort) {
  return authRequest('GET', url, parentWalletPort);
}

/**
 * Authenticated POST request.
 */
async function authPost(url, data, parentWalletPort) {
  return authRequest('POST', url, parentWalletPort, data);
}

/** Clear cached sessions (call between test runs if needed). */
function clearAuthCache() {
  sessions.clear();
}

module.exports = { authGet, authPost, authRequest, clearAuthCache };
