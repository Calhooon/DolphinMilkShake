# Tool Reference: rust-bsv-worm → DolphinSense Prompts

Use this when writing system prompts. Every tool name in a prompt MUST match a real worm tool name exactly.

## All Available Tools (43 total)

### Always-On (16) — available every iteration

| Tool | Description | Used by |
|------|-------------|---------|
| `execute_bash` | Run shell commands | Classifiers (rule engine), CrossRef (data processing) |
| `file_read` | Read files from workspace | Any agent needing workspace files |
| `file_write` | Write files to workspace | Any agent saving local state |
| `file_search` | Glob/grep workspace files | Any agent |
| `web_fetch` | HTTP GET, 50K char limit, FREE | Scrapers (Reddit, HN, RSS, BSV chain) |
| `continue_task` | Save progress, schedule resumption | Long-running tasks |
| `memory_store` | Persist data for future recall (tantivy) | All agents — store results, track state |
| `memory_search` | Natural language search over stored memories | Captain (report assembly), CrossRef |
| `wallet_balance` | Check sats balance | Captain (budget tracking) |
| `wallet_identity` | Get identity key or derived keys | All agents (discovery) |
| `wallet_call` | Generic BRC-100 wallet RPC | Advanced wallet ops (createAction, etc.) |
| `discover_services` | List x402 paid services | Scrapers (find endpoints) |
| `discover_endpoints` | Get x402 pricing/details | Scrapers (check costs) |
| `x402_call` | Call any x402 service (auto-pay) | Scrapers (X, SEO, Web Reader), Classifiers (Haiku fallback), Writers (Haiku, NanoStore) |
| `search_tools` | Find tools by keyword | Any agent discovering capabilities |
| `list_commands` | List all tools | Any agent |

### Deferred (27) — available via `search_tools`

| Tool | Description | Used by |
|------|-------------|---------|
| `send_message` | BRC-33 MessageBox P2P message | ALL agents — inter-agent communication |
| `check_inbox` | Read incoming P2P messages | ALL agents — receive tasks/results |
| `set_message_permission` | Configure inbox permissions/fees | Optional setup |
| `overlay_lookup` | Query overlay (ls_agent, ls_ship, ls_slap) | Captain, Coordinators — discover agents |
| `discover_agent` | Find agent by identity key or BRC-56 attributes | Captain, Coordinators |
| `verify_agent` | Check BRC-52 certificates | Captain, Coordinators |
| `upload_to_nanostore` | Permanent storage (~730 sats/MB/yr) | Writers — report uploads |
| `browser` | Headless Chrome automation | Scrapers (if needed for JS-heavy sites) |
| `wallet_encrypt` | BRC-100 encryption | Optional |
| `wallet_decrypt` | BRC-100 decryption | Optional |
| `receive_address` | Generate BSV receive address | Funding |
| `fund_from_tx` | Internalize external payment | Receiving inter-agent payments |
| `spawn_agent` | Spawn sub-agent with carved budget | Coordinators could use this |
| `check_agent` | Check sub-agent status | If using spawn_agent |
| `list_agents` | List spawned sub-agents | If using spawn_agent |
| `kill_agent` | Terminate sub-agent | If using spawn_agent |
| `create_schedule` | Recurring scheduled tasks | Captain (hourly/daily cycles) |
| `list_schedules` | List scheduled tasks | Captain |
| `cancel_schedule` | Disable scheduled task | Captain |
| `introspect` | Query own proofs, costs, task history | Captain (metrics) |
| `cost_analysis` | Spending patterns, efficiency, ROI | Captain (budget tracking) |
| `generate_image` | AI image generation via x402 | Writers (report visuals) |
| `check_certificates` | Check BRC-52 cert status | Coordinators (verify workers) |
| `read_tool_output` | Read full previous tool output | Any agent |
| `verify_output` | Analyze tool outputs for consistency | Quality auditors |
| `list_conversations` | List recent conversations | Any agent |
| `read_conversation` | Read conversation messages | Any agent |

## Existing Prompt Errors (MUST FIX)

| Prompt says | Actual tool | Fix |
|-------------|-------------|-----|
| `read_messages` | **`check_inbox`** | Rename in all prompts |
| `wallet_send` | **Does not exist** | Use `pay_agent` (BUG-010, coming soon) or `wallet_call` with createAction params |
| `create_provenance` | **Does not exist** | Proofs are created AUTOMATICALLY by the worm's proof loop every iteration. Remove from prompts — agents don't need to manually create proofs. |

## Key Design Implications for Prompts

### Proofs are automatic — don't instruct agents to create them
The worm creates BRC-18 Decision proofs, MessageSend/Receive proofs, and BRC-48 budget tokens automatically every iteration. Agents do NOT need a `create_provenance` tool. Remove all references to manual proof creation from prompts.

### Payments: use `pay_agent` (BUG-010) when it lands
Currently no clean payment tool. `wallet_call` with raw createAction works but is error-prone for LLMs. BUG-010 adds `pay_agent(recipient, amount_sats, purpose)` — use this in prompts. Until it lands, prompts can reference `pay_agent` and we'll update if the tool name changes.

### Discovery: `overlay_lookup` vs `discover_agent`
Both exist. `overlay_lookup` queries the overlay directly (service: "ls_agent", query: {"findByCapability": "scraping"}). `discover_agent` is a higher-level wrapper. **Use `overlay_lookup`** in prompts — it matches the ARCHITECTURE.md description and is what the E2E tests validate.

### NanoStore: `upload_to_nanostore` vs `x402_call`
Both work. `upload_to_nanostore` is a dedicated tool (~730 sats/MB/yr). `x402_call` to nanostore endpoint also works. **Use `upload_to_nanostore`** — cleaner, purpose-built.

### Inter-agent messaging: `send_message` + `check_inbox`
- `send_message(recipient, message_box, body, sign?, encrypt?)` — send to another agent
- `check_inbox()` — poll for incoming messages
- Messages are FREE (no BSV tx cost for MessageBox delivery itself)
- The worm's heartbeat auto-polls inbox every N seconds, so agents don't need to call check_inbox manually in most cases — new messages trigger task creation automatically

### Scraper tools: `web_fetch` (free) + `x402_call` (paid)
- `web_fetch` for Reddit JSON, HN Firebase, RSS, WhatsOnChain �� FREE
- `x402_call` for X-Research, SEO, Web Reader — PAID per call
- `browser` for JS-heavy sites that web_fetch can't handle — use sparingly

### Agent sub-spawning: `spawn_agent`
Coordinators could use `spawn_agent` to spawn sub-tasks with budget carve-outs instead of MessageBox delegation. Tradeoff: spawn_agent runs in-process (faster, no MessageBox latency) but doesn't generate inter-agent messaging txs. **For DolphinSense, use MessageBox (`send_message`)** — it generates more meaningful txs and demonstrates the multi-agent communication pattern judges want to see.

## Tool Availability by Agent Role

| Role | Key tools |
|------|-----------|
| **Captain** | `overlay_lookup`, `send_message`, `check_inbox`, `memory_store`, `memory_search`, `pay_agent`, `wallet_balance`, `introspect`, `create_schedule` |
| **Coordinators** | `overlay_lookup`, `send_message`, `check_inbox`, `memory_store`, `memory_search`, `verify_agent` |
| **Scrapers** | `web_fetch`, `x402_call`, `send_message`, `memory_store`, `execute_bash` |
| **Classifiers** | `execute_bash`, `x402_call`, `send_message`, `memory_store`, `memory_search` |
| **Cross-Referencers** | `memory_search`, `memory_store`, `send_message`, `execute_bash` |
| **Writers** | `x402_call`, `upload_to_nanostore`, `send_message`, `memory_store`, `memory_search` |
| **Auditors** | `web_fetch`, `execute_bash`, `x402_call`, `send_message`, `verify_output` |
| **Data Broker** | `send_message`, `check_inbox`, `memory_store`, `memory_search` |
