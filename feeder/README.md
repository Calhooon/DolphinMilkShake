# feeder/ — Reddit cache feeder (the data plane firehose)

Standalone Node process that pulls `/r/<sub>/comments.json?before=<cursor>`
for a configured sub list and writes new comments to per-sub append-only
queues. Agents consume from those queues via atomic watermark advance.

**This is the data plane.** The rest of the fleet (captains, workers,
synthesis) treats Reddit as "already scraped" — they never touch the
network, they just pop records off the queue.

## Why this architecture (summary; full story in PLAN-C-SCALE.md)

1. **No dedup logic anywhere.** Cursors prevent ingest dupes; per-sub
   watermarks prevent consume dupes. Agents have no LRU tables, no
   "have I seen this" checks.
2. **Scales by addition.** Add a sub = edit the feeder sub list. Add an
   agent = spawn it against the same queue dir.
3. **Crash-safe.** Feeder dies → cursor files on disk → restart resumes.
   Agent dies mid-batch → next agent reads watermark → claims next batch.
4. **Rate-limit insulated.** Feeder is the ONLY thing talking to Reddit.
   Aggressive backoff and a single unique User-Agent means the whole
   fleet shares one rate-limit bucket, not N buckets colliding.

## Files

| file | purpose |
|---|---|
| `reddit-cache-feeder.js` | the feeder process (copied from `dolphin-milk@f47c0c3` — keep these in sync if the upstream moves) |
| `subs.json` | production sub list (TBD — Day 1 task) |
| `README.md` | this file |

## Quick start

```bash
# One sub, fast interval, for smoke testing
SUBS=worldnews INTERVAL_MS=2000 node feeder/reddit-cache-feeder.js

# 30-sub production run
node feeder/reddit-cache-feeder.js
```

The feeder writes to `/tmp/dolphinsense-firehose/` by default:

```
/tmp/dolphinsense-firehose/
├── cursors/<sub>.cursor         per-sub `before=` fullname state
├── <sub>/queue.jsonl            append-only per-sub record stream
├── <sub>/queue.jsonl.claimed    byte offset consumed by agents
├── health.json                  last-pull stats, 429 counter, errors
└── events.jsonl                 scrape_start/done events for UI
```

Override with `FIREHOSE_DIR=/path/to/dir node feeder/reddit-cache-feeder.js`.

## User-Agent

Defaults to `DolphinSense/0.1 (+https://dolphinmilk.local; contact: ops@dolphinmilk.local)`.

**Do not change to a Firefox spoof UA.** Reddit rate-limits by (IP, UA)
pair and flags spoofed browsers aggressively. E20d-funding detour proved
that a descriptive UA with contact info is Reddit's preferred pattern AND
it unblocks us from 429 lockouts within seconds.

Per-instance variation for larger fleets: `FEEDER_USER_AGENT="DolphinSense/0.1 lane-XX ..."`.

## Agent consumer pattern

Agents consume records using the `QUEUE_MODE` path in the
`dolphin-milk` test harness (`tests/multi-worm/test_cycle_v2.js`). The
core logic — which dolphinmilkshake's own fleet launcher will replicate
as it matures — is:

```js
// read watermark
const watermark = parseInt(fs.readFileSync(claimPath, 'utf8').trim(), 10) || 0;

// open queue, seek to watermark, read forward up to BATCH_CAP lines
const stat = fs.statSync(queuePath);
const buf = Buffer.alloc(Math.min(stat.size - watermark, 4 * 1024 * 1024));
const fd = fs.openSync(queuePath, 'r');
fs.readSync(fd, buf, 0, buf.length, watermark);
fs.closeSync(fd);

// split on the last newline so we never read a partial line mid-write
const text = buf.toString('utf8');
const completeText = text.slice(0, text.lastIndexOf('\n') + 1);
const lines = completeText.split('\n').filter(Boolean).slice(0, BATCH_CAP);

// advance watermark atomically via tmp+rename
const claimedBytes = lines.reduce((a, l) => a + Buffer.byteLength(l, 'utf8') + 1, 0);
fs.writeFileSync(claimPath + '.tmp', String(watermark + claimedBytes));
fs.renameSync(claimPath + '.tmp', claimPath);
```

The watermark is POSIX-atomic because of the tmp+rename. This means two
agents hitting the same queue will each get their own batch (assuming
they don't race — per lane, only ONE agent consumes from ONE sub's queue;
parallel agents would need a proper lock, not an optimistic watermark).

## Known gaps (to harden for production)

- **No 429 backoff** beyond logging + counting. Should sleep-on-429 for
  N seconds escalating exponentially.
- **No cursor restart logic** — if the feeder dies mid-cursor-save, it
  resumes fine; but if the cursor file is corrupted, it restarts at
  head (100-item backlog). Good enough for POC.
- **No queue compaction** — `queue.jsonl` grows unbounded. For a 24h run
  at 1.5M records × ~1 KB each = ~1.5 GB. Fine on disk. Not fine if we
  ran longer.
- **No health alerting** — `health.json` is updated but nothing watches
  it. Mission Control UI (TODO) should render it + alert when `lastPullAgoMs`
  exceeds a threshold.
- **Single feeder = single point of failure** — for Day 3 production,
  consider running a warm standby feeder on a different IP that can take
  over if the primary dies.

See [../NEXT.md](../NEXT.md) for the full Day 1/2/3 task list.

## Related

- [PLAN-C-SCALE.md](../PLAN-C-SCALE.md) — architecture + scale math
- [WALLETS.md](../WALLETS.md) — operational recipe for the wallet fleet
- `dolphin-milk@f47c0c3:scripts/reddit-cache-feeder.js` — source of truth upstream
