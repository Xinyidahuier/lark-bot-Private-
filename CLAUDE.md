# Flash Home Market Intelligence Bot

## Project Overview
This is a Feishu (Lark) bot for Flash Home (Flash Express Thailand's franchise network). It automatically monitors a market intelligence group chat (MKT group), extracts competitor and broker pricing/strategy information using Claude AI, and writes structured data to Feishu Base (multidimensional table) and Sheets.

## Architecture

### Entry Point
- `bot-server.js` — Main process. Spawns `lark-cli event +subscribe` (WebSocket) to listen for Feishu messages in real-time. Also runs scheduled tasks (daily digest, weekly report, Base enrichment).

### Core Modules
- `market-intel.js` — Intelligence extraction engine. Uses Claude AI to analyze messages, classify by brand/category, detect duplicates, and determine HQ priority. Writes to Base and Sheets.
- `lark-executor.js` — Wrapper around `lark-cli` commands. All Feishu API calls go through this.
- `config.js` — Loads `.env`, exports app config and system prompt.
- `message-filter.js` — Filters which messages the bot should respond to (mentions, DMs).
- `conversation.js` — Manages conversation history for chat Q&A.
- `tools.js` — Tool definitions for the Claude-powered chat (calendar, tasks, etc.).

### Standalone Scripts
- `fill-old-base.js` — One-time/batch script to fill AI analysis on the old Base table (LMZvbR705a9P6gsndJCcoQOVnpc). Run manually when needed.

### Data Files
- `market-intel-db.json` — Local JSON database of all captured intel (for dedup, digest, weekly report).
- `hq-focus.json` — Rules for what counts as "HQ priority" intel.
- `.last-seen-time` — Tracks last processed event time for backfill on restart.

## Key IDs and Resources

### Feishu App
- App ID: `cli_a9414a59dcf8dbb4`
- Bot open_id: `ou_75c15fc6751b52134b5552735d281045`

### Groups
- MKT market intel group: `oc_12fc8f4549a84a7baead445c0dc1eb05`

### Base (Multidimensional Table)
- **New Base (bot-controlled)**: `G0s6bQp3maWmOrsEry3ckCdVnId` / table `tbla6yLcFRaLpbhk`
  - Bot has read/write permission
  - Fields: date, time, brand, category, summary, amount, source, images, AI analysis, duplicate flag, HQ priority flag
- **Old Base (read-only for bot)**: `LMZvbR705a9P6gsndJCcoQOVnpc` / table `tblVMYncStg04W6z`
  - Bot has NO write permission; must use `--as user` for updates
  - `fill-old-base.js` handles this table

### Sheets
- Market intel collection sheet: `CzQJseP6OhchaKtHNjxc8VfqnEp`
- AMBD sheet: `D4FxsO9RvhwbI2txLtFcnsnFnRd` / sheet `I0rTfC`

## External Dependencies
- **lark-cli** (`@larksuite/cli`): Feishu CLI tool. NOT the npm package `lark-cli` (which is empty/unrelated).
- **claude** (Claude Code CLI): Used for AI analysis via `execFileSync`. Uses Claude Code subscription, not API credits (ANTHROPIC_API_KEY is explicitly cleared in child env).
- **pm2**: Process manager for auto-restart and boot persistence.

## Deployment

### Current Server
- Alibaba Cloud ECS: `47.81.57.160` (Bangkok region)
- User: `admin`, home: `/home/admin`
- Code path: `/home/admin/lark-bot/`
- PM2 manages the process with auto-restart on crash and boot

### SSH Access
- SSH key-based auth from Mac. Generate a deploy key and add public key to server's `~/.ssh/authorized_keys`.
- When transferring files: `scp -i deploy_key <files> admin@47.81.57.160:/home/admin/lark-bot/`

### After Code Changes
```bash
# From Mac (or wherever you have the deploy key):
scp -i deploy_key <changed-files> admin@47.81.57.160:/home/admin/lark-bot/
ssh -i deploy_key admin@47.81.57.160 "pm2 restart lark-bot"
```

### IP Allowlist
The Feishu app has an IP allowlist. The server IP `47.81.57.160` must be in the allowlist, otherwise all API calls (Base read/write, image download, message send) will fail with Permission Denied. Manage at: Feishu Open Platform → App → Security Settings → IP Allowlist.

## Important Technical Notes

### Platform Detection
Paths are platform-aware (macOS vs Linux):
- `LARK_CLI`: macOS uses `/opt/homebrew/bin/lark-cli`, Linux uses `lark-cli` (global)
- `CLAUDE_BIN`: macOS uses npx cache path, Linux uses `claude` (global)
- `CHILD_ENV.PATH`: macOS prepends `/opt/homebrew/bin:`, Linux uses system PATH

### lark-cli Gotchas
- `+record-update` does NOT exist. Use `+record-upsert --record-id` instead.
- `--as bot` has NO write permission to the old Base. Use `--as user`.
- Base attachment `file_token`s CANNOT be downloaded via `drive +download` (HTTP 400). Message image keys (`img_v3_*`) CAN be downloaded via `im +messages-resources-download`.
- Old Base uses array format with `field_id_list` — field order changes between pages. Always use field_id indexing, not positional.
- Some `+messages-send` subcommands don't support `--format json`. Use `{noFormat: true}` in lark-executor.

### Claude AI Integration
- The bot calls Claude via CLI (`execFileSync(CLAUDE_BIN, ['-p', prompt, ...])`)
- `ANTHROPIC_API_KEY` is explicitly set to empty string in child env — this makes Claude use the Code subscription instead of API credits
- Timeout: 120 seconds for analysis calls

### Scheduled Tasks
- **Daily digest**: 18:00 Bangkok time → sends to admin DM
- **Weekly report**: Saturday 14:00 Bangkok time → sends to admin DM (test mode)
- **Base enrichment**: Every 30 minutes → fills missing AI fields on Base records

### Backfill Mechanism
On startup, the bot checks `.last-seen-time` and fetches missed MKT group messages via `im +chat-messages-list`. This handles bot restarts and brief outages.

## Brands and Classification

### Brokers (Agents/Platforms)
MySave, Shippop, Me 2 Plus, Point Express, Skybox, Postway, SuperShip, ShipHub, ShipSmile, DPlus, SmallWin, My Express, My Order, Order Plus, WeFast, GoShip, BS Express, iShip, Quick Service, Yod Express, Shipnity, TaibaanShip, POST SABUY, Shipplan, Order Xpress, PEX, Idrop service

### Carriers (Direct Competitors)
KEX, SPX, J&T, DHL, BEST, Thailand Post, Inter Express, Flash, Flash Home, LEX, EMS

### Intel Categories
Price adjustments, VIP pricing, Fruit pricing, Fuel surcharges, Franchise policies, Outlet packages, Promotions, COD policies, Drop Off, Subsidies/Rebates, System features, Competitor moves, Customer complaints

## Known Issues / TODO
- React emoji command (`lark-cli im reactions create`) flag format changed — currently failing silently
- AMBD sheet write (`--as user` auth error on sheet append) — needs investigation
- Old Base image download — Base attachment file_tokens can't be downloaded via drive API
