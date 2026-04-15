/**
 * reddit-proxy — Cloudflare Worker that fetches Reddit JSON through CF edge IPs.
 *
 * Why this exists: our residential IP got rate-limited by Reddit after a
 * ~4.5h run of the cache feeder (527 cumulative 429s). Since CF Workers
 * run from Cloudflare's edge, the "client IP" Reddit sees is a CF datacenter
 * IP with fresh rate budget. Routing feeder fetches through this worker
 * bypasses our IP block without needing VPN/proxy rotation.
 *
 * Protocol:
 *   GET /r/<sub>/<endpoint>.json?limit=100&before=<fullname>
 *
 *   The worker forwards the exact path + query to https://www.reddit.com
 *   and returns whatever Reddit returns (JSON body + status code).
 *
 * Example:
 *   GET https://reddit-proxy.<subdomain>.workers.dev/r/worldnews/comments.json?limit=100&before=t1_abc
 *   → fetches https://www.reddit.com/r/worldnews/comments.json?limit=100&before=t1_abc
 *   → returns the JSON body to the caller
 *
 * Security: no auth. Read-only. Only allows paths starting with /r/.
 * Not committable to a public CF account without a token, not harmful
 * if leaked (it's just a public-Reddit proxy).
 *
 * Deploy: wrangler deploy (requires CLOUDFLARE_API_TOKEN env).
 */

const REDDIT_BASE = 'https://www.reddit.com';
// Reddit API etiquette: <platform>:<app_id>:<version> (by /u/<username>)
// Using a format that matches what's worked from our residential IP earlier.
const UA = 'node:dolphinsense:v0.1.21 (by /u/dolphinmilk)';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'reddit-proxy',
          version: '0.1.0',
          usage: 'GET /r/<sub>/comments.json?limit=100&before=<fullname>',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Only allow /r/<sub>/... paths
    if (!url.pathname.startsWith('/r/')) {
      return new Response(
        JSON.stringify({ error: 'path must start with /r/<sub>/' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    // Forbid path traversal / weird chars
    if (url.pathname.includes('..') || url.pathname.includes('//')) {
      return new Response('bad request', { status: 400 });
    }

    // Construct upstream URL preserving path + query
    const upstream = `${REDDIT_BASE}${url.pathname}${url.search}`;

    try {
      const resp = await fetch(upstream, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
        },
        // Don't cache Reddit responses — we want fresh cursor-paged data
        cf: { cacheTtl: 0, cacheEverything: false },
      });

      // Pass through the body + status. Force content-type to application/json
      // so our Node feeder's JSON.parse doesn't choke on edge-case content types.
      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'x-reddit-proxy-upstream-status': String(resp.status),
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'upstream_fetch_failed', message: String(err && err.message) }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
    }
  },
};
