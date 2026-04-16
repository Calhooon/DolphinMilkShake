# DolphinSense UI — Page Agent Handoff Spec

**Scout wave done (2026-04-16).** The shared shell (nav, footer, tokens,
reset, common components) lives in `ui/shared.css`, `ui/shared/nav.html`,
`ui/shared/footer.html`. Multi-page routing is in place. Each of the 5
pages now has a stub that renders the full shell so the site looks alive
on every route. Your job is to fill in the content for ONE of these 5
pages without touching shared primitives or breaking the dashboard.

## Who owns what

| Page | Route | File (owned by page agent) | Priority |
|------|-------|----------------------------|----------|
| Dashboard | `/` | `ui/index.html` | existing — slim refactor only |
| TX Explorer | `/tx` | `ui/pages/tx-explorer.html` | **judge-critical** |
| Articles | `/articles` | `ui/pages/articles.html` | **judge-critical** |
| Fleet / Wallets | `/fleet` | `ui/pages/fleet.html` | |
| Lane Detail | `/lane/:id` | `ui/pages/lane-detail.html` | |

Each page is a **standalone HTML file**. Links `/shared.css`, includes
`{{NAV}}` + `{{FOOTER}}` tokens, owns everything in between (inline
`<style>` + inline `<script>`). Server injects the shell at request time.

## The shared shell

### `ui/shared.css` (owns — do not duplicate)

- **Design tokens**: `--bg`, `--surface`, `--accent`, `--captain`, … —
  consume, never redefine.
- **Global resets**: `* { box-sizing }`, `*:focus-visible`, `::selection`,
  `html, body` background + font stack.
- **Shell chrome**: `.site-nav` + `.site-footer` (z-index 200 / sticky).
  Do not touch. Your page content goes in a `<main>` between them.
- **Shared components** — reuse verbatim:
  - `.panel` + `.panel-head` + `.panel-head .count` + `.panel-head .tab` +
    `.panel-body` — cards with a labeled head and body.
  - `.empty` — placeholder text for empty states.
  - `.tx-item` + `.tx-item .txid` + `.tx-item .lane-tag` — tx stream row.
  - `.status-pill` + `.status-pill.live` + `.status-pill .dot`.
  - `.btn` + `.btn.btn-primary`.
  - `.chip` + `.chip.active`.
  - `code.txid` / `.mono-txid` — monospaced txid spans.
  - `.page-stub` + `.page-stub h2 .owner` — used by the current stubs.
  - Keyframes: `fade-in-up`, `pulse`.
- **Mono font**: `var(--mono)` — `"JetBrains Mono", ui-monospace, …`.

If you find yourself copying these selectors into your page CSS, stop and
use the shared class. If something is *almost* right but needs a tweak,
override in your page's inline `<style>` — do NOT edit `shared.css`.

### `ui/shared/nav.html`

5 links: Dashboard / TX Explorer / Articles / Fleet / Lane. The server's
`renderNav(activePage)` marks the active link via a `data-active` attribute
+ inline script. Active ids: `dashboard | tx | articles | fleet | lane`.
A right-side status pill (`#nav-status`) is pre-wired — call
`window.__dmSetNavStatus('live', 'connected')` once your SSE opens.

### `ui/shared/footer.html`

Tiny footer with git SHA, uptime ticker, repo link. Uptime ticks every
second using `data-start-sec` from the server. No config needed.

## Data the server exposes

### SSE — `GET /events`

Open once per page, listen for JSON events. The same stream powers every
page; you filter client-side.

On connect, the server fires the full state in this order:
1. `{ kind: 'init', lanes: [...] }` — lane config (id, subreddit, source,
   display_prefix, agents[{role, name, server_port}]).
2. `{ kind: 'init_historical', target, scannedAt, txs, sats, articles,
   cycles, articlesList: [...], perLane: {...} }` — lifetime totals.
3. `{ kind: 'feeder_health', data: {...} }` — feeder bar payload.
4. `{ kind: 'wallet_health', updates: [{lane, role, sats, utxos}, ...] }`.
5. `{ kind: 'agent', lane, role, agent, ev }` — replayed most-recent agent
   state (one per agent). After replay, live updates follow the same shape.
6. `{ kind: 'proof_emitted', lane, cycle_dir, txid, _replay?: true }` —
   most-recent txs replayed, then live.
7. `{ kind: 'message_flow', lane, phase, from, to, ..., _replay?: true }`.
8. `{ kind: 'snapshot', state: {...} }` — **server-authoritative state**
   broadcast every 150ms (debounced) + every 1s heartbeat. Prefer this
   for page content — render from `state.*` rather than accumulating
   deltas yourself. `state` shape:
   ```
   {
     schema: 1,
     target: 1500000,
     updatedAt: <ms>,
     totals: { txs, sats, articles, cycles },
     perLane: { [laneId]: { txs, sats, cycles, articles,
                            agents: { captain, worker, synthesis },
                            lastDelegateAt, cycle_dir,
                            cyclePhase, cycleStartMs } },
     articles: [{lane, url, txidsUrl, proofs, cycleId, cycleDir, ts}],
     recentTxs: [{lane, cycle_dir, txid, ts}],
     recentFlows: [{lane, phase, from, to, ...}],
     walletHealth: { '<lane>:<role>': {sats, utxos, updatedAt} },
     feederHealth: {...},
     txCategories: { [category]: {count, sats} },
     lanes: [{id, subreddit, source, display_prefix, agents:[...]}],
   }
   ```

Other live event kinds worth listening for: `agent_state`,
`proof_emitted`, `cycle_aggregate`, `feeder_event`, `feeder_health`,
`wallet_health`, `message_flow`, `init_historical`, `snapshot`.

### HTTP JSON APIs

| Method | Path | Response |
|--------|------|----------|
| GET | `/health` | `{ ok, lanes, clients }` liveness |
| GET | `/api/state` | Full `computeSnapshot()` — same shape as SSE `snapshot.state` |
| GET | `/api/txs?lane=X&offset=N&limit=N` | `{ total, offset, limit, scannedAt, byLaneCounts, txs: [{txid, lane}] }` — paginated txid list. Cap: limit 5000. Useful for **TX Explorer** backing store. |

### Lifetime txid index (for TX Explorer)

Server keeps `allTxidsIndex.flat` — every txid discovered during the
historical scan plus live additions. `/api/txs` pages it. `byLaneCounts`
lets you show filter chips without another round-trip.

## Layout conventions

- Body has `padding: 0 24px 80px` from shared.css (dashboard overrides to
  add internal gap). Put your content in a `<main>` or equivalent.
- Nav is sticky at `top: 0; z-index: 200`. The dashboard's own inner
  `<header>` is sticky at `top: 0; z-index: 100` — it slides under the
  nav. If your page needs its own sticky chrome, use `top:` equal to the
  nav height (~48px) or increase z-index carefully.
- Use the grid pattern from `.lanes` / `.right-panel` when you need a
  responsive grid: `display: grid; grid-template-columns: repeat(auto-fill,
  minmax(Npx, 1fr)); gap: 16px;`.
- Font scale mirrors the dashboard: panel heads 10px uppercase, body 11-
  12px, tx/code 10px mono.
- Colors per domain: mint `--accent` for primary/live, azure `--accent-2`
  for secondary/links, violet `--accent-3` for captain, warn/bad for
  statuses.
- Animate entrances with `fade-in-up 0.6s var(--ease-out-expo) both` —
  consistency with the dashboard.

## Adding new data

If your page needs a field the server doesn't expose, add it in ONE of
two ways (in server.js):

1. **New HTTP endpoint** — add an `if (pathname === '/api/foo')` branch
   in the `http.createServer()` handler (search for `/api/txs` in
   `server.js` as a template). Keep it read-only, JSON, no auth.
2. **New SSE event kind** — write state via existing tailers or a new
   tailer, then `broadcast({ kind: 'my_event', ... })`. Don't forget to
   also send the latest value on SSE connect (`handleSse()`) so fresh
   clients aren't stuck waiting for the next tick.

Don't add fields to `kind: 'snapshot'` without coordinating — the dashboard
treats it as the canonical render source and uses every field.

## DO NOT TOUCH

- `/tmp/dolphinsense-shared/` — fleet-generated evidence, read-only from UI.
- `/tmp/dolphinsense-firehose/` — feeder evidence, read-only from UI.
- `~/bsv/rust-bsv-worm/test-workspaces/fleet/` — agent session transcripts,
  read-only from UI.
- `~/bsv/wallets/fleet/*.env` — wallet daemon config, DO NOT READ (secrets)
  and DO NOT WRITE.
- `~/bsv/wallets/fleet/INVENTORY.json` — read-only via the UI's existing
  tailer.
- `~/bsv/fleet-backup-2026-04-16/` — frozen evidence for the 1.5M-tx demo.
  DO NOT modify ANY file under that tree.
- `fleet/lanes.json` — lane config, read at server startup only. Changes
  require a server restart.

If a page agent ever finds itself about to write to any of those paths,
stop and coordinate with the scout / user.

## Shipping checklist per page

- [ ] File loads without network errors (fonts, `/shared.css`, `/events`).
- [ ] Nav shows the active page highlighted.
- [ ] Footer shows the git SHA and ticking uptime.
- [ ] Content renders from `state.*` on the initial `snapshot` event
      (don't rely on replayed tail events for first paint).
- [ ] Empty state uses `.empty` class with a kind message ("waiting for
      <thing>…").
- [ ] Tx/article/etc links open WhatsOnChain in a new tab where relevant
      (`target="_blank" rel="noopener"`).
- [ ] No inline `background-color: <hex>` — use tokens.
- [ ] curl `localhost:7777/<route>` returns 200 with your content.
- [ ] No console errors in the browser devtools.

## Contact

Scout: this file. If something's unclear, read `ui/server.js` — routes
are in `http.createServer()` near line 1880, and `computeSnapshot()` is
the snapshot shape source of truth.
