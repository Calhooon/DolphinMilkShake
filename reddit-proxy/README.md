# reddit-proxy — CF Worker for bypassing Reddit IP rate limits

A ~60-line Cloudflare Worker that accepts `GET /r/<sub>/<endpoint>.json?...`
requests and fetches them from `https://www.reddit.com`. Because the
fetch happens from CF edge infrastructure (not our residential IP),
Reddit sees a different client IP with fresh rate budget.

Built specifically to unblock the DolphinSense feeder after accumulating
~527 429s over 4.5h of run time on 2026-04-14.

## Deploy

Requires the CF API token from `../secrets.md` (gitignored):

```bash
cd reddit-proxy
source ../secrets.md  # exports CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler deploy
```

Output will include the deployed URL, e.g.:
`https://dolphinsense-reddit-proxy.<subdomain>.workers.dev`

## Test

```bash
# Health check (should return {ok: true, ...})
curl https://dolphinsense-reddit-proxy.<sub>.workers.dev/health

# Real fetch
curl 'https://dolphinsense-reddit-proxy.<sub>.workers.dev/r/worldnews/comments.json?limit=5' \
  | jq '.data.children | length'
```

## Wire the feeder to use it

```bash
FEEDER_REDDIT_BASE="https://dolphinsense-reddit-proxy.<sub>.workers.dev" \
  node feeder/reddit-cache-feeder.js
```

(The feeder will need a small patch to accept `FEEDER_REDDIT_BASE` as an
override of `https://www.reddit.com` — TODO next.)

## Security

- No auth (it's a public-Reddit proxy — no secrets leaked by being open)
- Only allows `/r/<sub>/...` paths (blocks path traversal)
- Passes through Reddit's response body as-is; content-type forced to JSON
- Uses its own User-Agent so upstream Reddit sees the proxy, not a spoof
- Zero state — redeploying is safe

## Cost

Free tier: CF Workers give 100k requests/day. At feeder poll rate of
~30 req/min × 24h = ~43k/day, we're well inside the free tier.

## Not-features

- No caching (we explicitly disable it — cursor-paged data needs freshness)
- No retry logic (feeder handles retries client-side)
- No auth / auth gating
- No CORS restriction beyond `access-control-allow-origin: *`
