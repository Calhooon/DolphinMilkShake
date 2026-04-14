# ui/ — DolphinSense Mission Control

Tiny hacky live dashboard for watching the fleet work in real time.

- **server.js** — ~320-line Node stdlib HTTP+SSE server. No framework, no dependencies.
- **index.html** — single-file vanilla dashboard. No build step. Dark theme, grid layout, rolling streams.

## What it shows

- **Header counters**: total on-chain txs, total sats spent, total articles published
- **Feeder bar**: per-sub churn rate + queued count, live from `health.json`
- **Lane grid**: one tile per lane. Each tile shows captain / worker / synthesis as a colored strip, with current state (`thinking…`, `→ overlay_lookup + delegate_task`, `✓ ran bash`, `✓ done (97K sats)`), per-agent sats spend, and per-lane tx+sats totals.
- **Live TX stream**: rolling list of the latest 100 on-chain txs as they land. Each txid links to whatsonchain.com. Lane tag on the right. Fresh ones flash green.
- **Latest articles**: rolling list of the latest 20 NanoStore HTML articles. Each one links to its published URL, with a secondary link to its txid manifest.

## What it reads from disk (no mods to dolphin-milk)

| source | used for |
|---|---|
| `fleet/lanes.json` | lane+agent topology, loaded once at startup |
| `/tmp/dolphinsense-firehose/health.json` | feeder status bar |
| `/tmp/dolphinsense-firehose/events.jsonl` | feeder scrape events (currently unused client-side but broadcast) |
| `test-workspaces/fleet/<lane>/<agent-name>/tasks/<latest>/session.jsonl` | per-agent live state (tool_call, tool_result, think_response, session_end) |
| `test-workspaces/fleet/<lane>/cycle-STAMP/aggregate.json` | per-cycle final sats + NanoStore URLs (published to articles feed) |
| `/tmp/dolphinsense-shared/<lane>/cycle-ID/records.jsonl.txids` | data-plane txid stream (published to tx ticker) |

Everything is derived from the same files that `lane-cycle.js` / the test harness reads. Zero instrumentation added to agents.

## Running

```bash
node ui/server.js
```

Then open http://localhost:7777/ in a browser.

Env vars (all optional):

- `PORT` — default 7777
- `POLL_MS` — file poll interval (default 500ms)
- `LANES_FILE` — default `../fleet/lanes.json`
- `INVENTORY_FILE` — default `~/bsv/wallets/fleet/INVENTORY.json`
- `FLEET_WORKSPACE` — default `~/bsv/rust-bsv-worm/test-workspaces/fleet`
- `SHARED_DIR` — default `/tmp/dolphinsense-shared`
- `FIREHOSE_DIR` — default `/tmp/dolphinsense-firehose`

## Tailing discipline

The server uses naive file-poll-with-offset for each source:

- **JSONL tailers** track a byte offset per file. On each tick they seek+read from the offset, split by `\n`, JSON-parse complete lines, buffer partials until the next tick. Lossless even if the file is being written concurrently.
- **Per-agent session.jsonl** tailer picks the LATEST task dir per agent each tick (by mtime). When a new task spawns, the tailer auto-switches to the new file without restart.
- **Cycle aggregate watcher** walks each lane's `cycle-*/` dirs once per tick, reads any `aggregate.json` it hasn't seen before, and broadcasts it as `cycle_aggregate`.
- **Txid stream** tails `records.jsonl.txids` per cycle dir (one txid per line) and broadcasts each new line as `proof_emitted`.

## Known non-features

- **State is session-local on the client**. Refresh the browser and you get live events from THAT moment forward — historical state isn't replayed from the server (tx stream + articles start empty on reconnect). This is fine for demos but not for "open the UI hours into a run" use.
- **No auth.** Server binds to localhost only by default. Don't expose it to the internet.
- **No error/retry panel**. If a lane agent errors out, its tile turns red with a truncated error string — no drill-down.
- **No cost meter vs target budget**. Just the raw totals.
- **AskReddit synthesis partial** from E21-0 will render as "no URL" in the article feed — documented in [experiments/E21-0-stage.md](../experiments/E21-0-stage.md), not a UI bug.

## Development

```bash
# Run with more verbose polling
POLL_MS=200 node ui/server.js

# Point at a different fleet workspace
FLEET_WORKSPACE=/tmp/scratch node ui/server.js
```

Then edit index.html or server.js and refresh the browser / restart the server.

## Future (post-submission)

- Replay from persistent event log instead of session-local state
- Drill-down modal on a lane tile showing full session.jsonl history
- Budget meter with daily spend projection
- Per-agent mini think-token histogram
- Sparkline for tx rate over time
