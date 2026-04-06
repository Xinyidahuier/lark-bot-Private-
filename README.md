# Flash Home Market Intelligence Bot

Feishu bot that automatically monitors the MKT group chat, extracts competitor intelligence using AI, and writes to Feishu Base.

## Quick Start

### Prerequisites
- Node.js 20+
- `@larksuite/cli` (lark-cli) — `sudo npm install -g @larksuite/cli@latest`
- Claude Code CLI — `sudo npm install -g @anthropic-ai/claude-code`
- pm2 — `sudo npm install -g pm2`

### Setup
```bash
git clone <repo-url>
cd lark-bot
cp .env.example .env
# Edit .env with your credentials
npm install
```

### Configure lark-cli
```bash
lark-cli config init          # Enter App ID and App Secret
lark-cli auth login --as user # Authorize user identity (needed for old Base writes)
```

### Run
```bash
pm2 start bot-server.js --name lark-bot --cwd $(pwd)
pm2 save
pm2 startup   # Auto-start on boot
```

### Check Status
```bash
pm2 status
pm2 logs lark-bot --lines 50
```

## How to Maintain This Project

This project is designed to be maintained via **Claude Code** (AI pair programming). Open a terminal in this directory and start Claude Code:

```bash
claude
```

Then describe what you want in natural language. Examples:

- "Add a new broker called XYZ Express to the tracking list"
- "Change the daily digest time from 18:00 to 17:00"
- "Add a new intel category for insurance policies"
- "The bot didn't capture messages from yesterday, help me backfill"
- "Deploy the latest changes to the server"
- "Check the server logs for errors"

Claude will read `CLAUDE.md` to understand the project context and help you make changes.

## Important Notes

1. **IP Allowlist**: The server IP must be in the Feishu app's IP allowlist, or all API calls will fail.
2. **After code changes**: Upload changed files to server and run `pm2 restart lark-bot`.
3. **Don't use `lark-cli`** (the npm package) — use `@larksuite/cli` instead.
4. **Old Base writes**: Must use `--as user` identity (bot has no permission).

## Server Info
- Host: `47.81.57.160` (Alibaba Cloud, Bangkok)
- User: `admin`
- Path: `/home/admin/lark-bot/`
- Process: managed by pm2
