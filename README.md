<p align="center">
  <img src="apps/web/public/favicon.svg" alt="Luma Assistant logo" width="96" height="96" />
</p>

<h1 align="center">Luma Assistant</h1>

<p align="center">
  Self-hosted Codex workspace with agents, Tehran-time schedules, repo skills, MCP tools, Telegram automation, terminals, and persistent session history.
</p>

## What It Is

Luma Assistant wraps Codex in a browser workspace and local API server. It is built for running Codex against real repositories while keeping prompts, sessions, tool activity, approvals, terminals, scheduled agents, and MCP integrations visible in one operator-focused UI.

## Capabilities

- `Codex web workspace`: start new sessions, continue old ones, stream live output, review diffs, and inspect grouped tool activity.
- `Agents`: discover repo-owned agents from `agents/<slug>/AGENT.md` and run the latest prompt body manually or on a schedule.
- `Tehran schedules`: create daily `Asia/Tehran` schedules that snapshot workspace, model, sandbox, approval policy, and selected skills.
- `Repo skill sync`: copy managed repo skills from `skills/**/SKILL.md` into `~/.codex/skills` without overwriting unmanaged global skills.
- `MCP visibility`: surface MCP calls, web searches, shell commands, file changes, and run status in the normal session timeline.
- `Telegram MCP`: run a local Telegram MCP server for sending rendered Markdown messages and generated files to Telegram topics.
- `Terminal`: open a per-session terminal with command history from the same app window.
- `Auth`: protect the browser UI with a password and JWT-backed local browser session.
- `History`: keep local runtime data under `data/` and show compatible Codex history alongside in-app sessions.

## Stack

- `Root package`: `luma-assistant`
- `Server`: Express, TypeScript, `node-pty`, JWT auth, SSE
- `Web`: React, Vite, TypeScript, Tailwind-style UI utilities
- `Shared types`: `@luma/shared`
- `Telegram MCP`: `@luma/telegram-mcp`
- `Process management`: PM2
- `Proxy`: Nginx example config
- `Landing page`: independent Vite + React + Tailwind app in `landing-page/`

## Requirements

- Node.js `>= 22`
- npm
- Codex CLI available in `PATH`, or set through `CODEX_PATH`
- A Unix-like host for the best terminal experience

Authenticate Codex before using the app:

```bash
codex login
```

## Quick Start

```bash
cp .env.example .env
npm install
make run
```

Open the web app:

```text
http://localhost:5175
```

If you change `HOST` or `WEB_PORT`, use that address instead.

## Configuration

The root `.env` controls the local runtime:

```env
API_PORT=9001
WEB_PORT=5175
HOST=0.0.0.0
CODEX_PATH=codex
PASSWORD=change_me
JWT_SECRET=change_me_too
AUTH_TOKEN_TTL_SECONDS=86400
DEFAULT_MODEL=gpt-5.3-codex
DEFAULT_SANDBOX=danger-full-access
MAX_CONCURRENT_RUNS=8
```

Important variables:

- `PASSWORD`: browser login password.
- `JWT_SECRET`: secret used to sign auth tokens.
- `CODEX_PATH`: path to the Codex executable if it is not simply `codex`.
- `DEFAULT_MODEL`: default Codex model for new sessions and new schedules.
- `DEFAULT_SANDBOX`: default sandbox mode for new sessions.
- `MAX_CONCURRENT_RUNS`: server-side cap for active Codex runs.
- `TERMINAL_DISABLE_PTY=1`: force plain-pipe terminal mode.
- `TERMINAL_SHELL=/bin/bash`: choose the shell used by session terminals.

Legacy browser storage keys and local session sources are tolerated so existing sessions, auth, theme, and queued prompts are not dropped during the rename.

## Agents

Agents live in the repository and are not copied into Codex home:

```text
agents/
  my-agent/
    AGENT.md
```

`AGENT.md` supports optional frontmatter:

```markdown
---
name: Daily Planner
description: Summarizes today's work.
---

Use the TickTick MCP server and prepare today's plan.
```

The Markdown body after frontmatter is the exact prompt used for scheduled runs. Schedule execution reads the current agent file at run time, so editing `AGENT.md` updates future runs without recreating the schedule.

## Skills

Repo-managed skills are discovered recursively from:

```text
skills/**/SKILL.md
```

On server startup and manual skill reload, Luma Assistant copies each skill folder to:

```text
~/.codex/skills/<slug>
```

Managed copies include a marker file and can be updated safely. If a destination folder already exists without the managed marker, it is reported as a conflict and is not overwritten.

## Telegram MCP

The repo includes a Telegram MCP server registered as `luma-tel` by default. It can send Markdown messages and upload generated files to Telegram group topics.

1. Create a bot with `@BotFather`.
2. Add the bot to your group and grant send permissions.
3. Enable topics, create the target topic, and send one message in that topic.
4. Fetch updates:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Use `message.chat.id` as `TELEGRAM_CHAT_ID`. Use `message.message_thread_id` for the target topic IDs.

```env
TELEGRAM_BOT_TOKEN=123456:abc...
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_MESSAGE_FILE_THREAD_ID=42
TELEGRAM_MESSAGE_TEXT_THREAD_ID=43
TELEGRAM_MCP_PORT=9013
TELEGRAM_MCP_NAME=luma-tel
TELEGRAM_ALLOWED_ROOTS=/Users/applestation/Project
TELEGRAM_MAX_FILE_BYTES=52428800
```

`make run` and `make deploy-start` ensure the local Codex MCP entry points at the Telegram MCP server.

## Development

Useful commands:

```bash
make install
make run
make kill-ports
npm run typecheck
npm run build
```

The root npm workspaces are:

- `@luma/shared`
- `@luma/server`
- `@luma/web`
- `@luma/telegram-mcp`

## Landing Page

The standalone marketing site lives in `landing-page/`.

```bash
npm ci --prefix landing-page
npm run build --prefix landing-page
```

The Vite app uses `base: "/luma-assistant/"` for the default GitHub Pages URL. GitHub Pages deployment is configured in `.github/workflows/deploy-landing-page.yml`.

## Production Deployment

### PM2

Production process definitions live at:

```text
scripts/pm2/ecosystem.config.cjs
```

Start production services:

```bash
make deploy-start
```

Operational commands:

```bash
make deploy-status
make deploy-logs
make deploy-stop
```

PM2 process names are:

- `luma-assistant-server`
- `luma-assistant-web`
- `luma-telegram-mcp`

### Nginx

An example reverse proxy is included at:

```text
scripts/nginx/luma-assistant.conf.example
```

Typical setup:

```bash
sudo cp scripts/nginx/luma-assistant.conf.example /etc/nginx/sites-available/luma-assistant.conf
sudo ln -sf /etc/nginx/sites-available/luma-assistant.conf /etc/nginx/sites-enabled/luma-assistant.conf
sudo nginx -t
sudo systemctl reload nginx
```

Customize `server_name`, TLS certificate paths, and upstream ports before reloading Nginx. The example handles `/api/events` as non-buffered SSE, `/api/*` as API traffic, and `/` as web app traffic.

## Data And Security

Runtime state stays under `data/`, including session metadata, message history, schedules, PM2 logs, and generated app state. Treat `data/` as private runtime state and do not delete it during upgrades unless you intentionally want to reset local history.

Security notes:

- Change `PASSWORD` and `JWT_SECRET` before exposing the app.
- Put the app behind HTTPS when reachable outside localhost.
- Review `DEFAULT_SANDBOX`; `danger-full-access` is convenient for trusted personal hosts but high trust.
- Codex runs with access to the selected workspace and enabled MCP tools.
- Telegram credentials grant bot access to configured chats and topics.

## Repository Layout

```text
agents/          repo-owned agent prompts
apps/
  server/        Express API, scheduler, run manager, auth, SSE, terminal bridge
  telegram-mcp/  local MCP server for Telegram messages and file uploads
  web/           React workspace UI
landing-page/    independent GitHub Pages site
packages/
  shared/        shared schemas and TypeScript types
scripts/
  nginx/         reverse proxy example
  pm2/           production process definitions
skills/          repo-managed Codex skills
data/            private runtime data and logs
```

## Troubleshooting

- `Connection refused` on HTTPS usually means no process is listening on port `443`, the reverse proxy is stopped, or the firewall is rejecting the port.
- `Codex not found` means `CODEX_PATH` does not point at an executable Codex CLI.
- `Skill conflict` means a global `~/.codex/skills/<slug>` exists without Luma Assistant's managed marker and was intentionally left untouched.
- `Schedule skipped` can happen when the global run capacity is full.
