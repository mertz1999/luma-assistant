<p align="center">
  <img src="apps/web/public/favicon.svg" alt="Agentic Assistant logo" width="96" height="96" />
</p>

<h1 align="center">Agentic Assistant</h1>

<p align="center">
  A self-hosted web panel for running Codex in real workspaces, reviewing every tool call, managing approvals, and keeping session history in one place.
</p>

## What It Is

Agentic Assistant wraps the Codex CLI with a browser UI and a local server. It is designed for people who want the power of Codex in a persistent, inspectable interface instead of a terminal-only workflow.

You point it at your machine, sign in with a simple password, and get a chat-style workspace where you can:

- start and continue Codex sessions
- watch live tool activity and streamed output
- work with plan mode and explicit approval gates
- open a per-session terminal
- review session history from local app runs and external Codex history
- archive or delete sessions you no longer need

## Features

- `Live Codex sessions`
  Start new runs, continue existing sessions, and see updates stream into the UI through SSE.
- `Session-aware timeline`
  Rendered markdown, reasoning blocks, plan updates, tool output, diffs, errors, and status changes all stay attached to the session that produced them.
- `Tool visibility that scales`
  Consecutive tool messages are grouped into a compact batch, with lazy expansion when you want the details.
- `MCP and web search visibility`
  MCP tool calls and web searches are projected into the same timeline as shell commands and file changes.
- `Plan mode with final approval`
  Planning turns stay read-only until the user grants final approval, which makes it safer to use for higher-risk tasks.
- `Queued follow-up messages`
  If a session is already running, new prompts can queue behind the active run instead of being lost.
- `Per-session terminal`
  Open a terminal tied to the selected session, run commands manually, and reuse recent command history.
- `Imported history`
  The UI can surface local in-app sessions alongside external Codex history, including source badges like `in-app`, `exec`, `cli`, and `vscode`.
- `Copy-friendly chat UI`
  Normal user, assistant, and plan messages can be copied as raw markdown.
- `Session cleanup`
  Archive or delete completed local sessions from the UI.
- `Self-hosted auth`
  A password-protected login page issues a local JWT-backed auth session for browser access.
- `Dark mode support`
  The interface includes a tuned dark theme for long-running operator workflows.

## Stack

- `Web`: React 18, Vite, TypeScript, Tailwind-style utility classes
- `Server`: Express, TypeScript, `node-pty`, JWT auth
- `Shared types`: workspace package under `packages/shared`
- `Process management`: PM2
- `Proxy`: Nginx example config included

## Requirements

- `Node.js >= 22`
- `npm`
- `Codex CLI` installed and available in `PATH`, or configured through `CODEX_PATH`
- A Unix-like environment for the best terminal experience
  PTY is supported, with a fallback mode available if PTY is disabled or unavailable.

Before using the app, make sure Codex itself is authenticated:

```bash
codex login
```

## Quick Start

1. Clone the repository.
2. Copy the environment template.
3. Set a password and JWT secret.
4. Install dependencies.
5. Start the app.

```bash
cp .env.example .env
npm install
make run
```

Then open:

```text
http://localhost:5175
```

If you changed `HOST` or `WEB_PORT` in `.env`, use that address instead.

## Configuration

The root `.env` controls the runtime:

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

- `PASSWORD`: required for browser login
- `JWT_SECRET`: secret used to sign auth tokens
- `CODEX_PATH`: path to the Codex executable if it is not simply `codex`
- `DEFAULT_MODEL`: default model passed to Codex for new runs
- `DEFAULT_SANDBOX`: default sandbox mode for new runs
- `MAX_CONCURRENT_RUNS`: server-side cap for concurrent runs
- `TERMINAL_DISABLE_PTY=1`: force plain-pipe terminal mode
- `TERMINAL_SHELL=/bin/bash`: explicitly choose the shell used by session terminals

### Luma Telegram MCP

The app includes a local MCP server, registered in Codex as `luma-tel` by default, that can send messages and upload generated files to Telegram group topics.

1. Create a Telegram bot with `@BotFather` using `/newbot`.
2. Add the bot to your Telegram group and grant permission to send files.
3. Enable topics in the group, create the target topic, and send a message in that topic.
4. Fetch updates:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Use `message.chat.id` as `TELEGRAM_CHAT_ID`. Use `message.message_thread_id` as `TELEGRAM_MESSAGE_FILE_THREAD_ID` for file uploads and `TELEGRAM_MESSAGE_TEXT_THREAD_ID` for plain text messages.

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

`make run` and `make deploy-start` automatically ensure Codex has a `luma-tel` MCP entry pointing at the local MCP URL. If the old default `telegram-file` entry points at the same URL, the ensure script removes it.

Legacy compatibility is also supported:

- `DEFAULT_SANDBOX_TYPE`
- `DEFAULT_NETWORK_ACCESS`

## Local Development

Useful commands:

```bash
make install
make run
make kill-ports
make deploy-status
```

What they do:

- `make install`: install project dependencies
- `make run`: install-if-needed, register Telegram MCP if needed, free the API/web/MCP ports, then start server, web, and Telegram MCP
- `make deploy-start`: production build plus PM2 start/reload
- `make deploy-stop`: stop PM2 services
- `make deploy-status`: show PM2 process state
- `make deploy-logs`: tail PM2 logs

## Production Deployment

### PM2

The repo includes a PM2 ecosystem file at `scripts/pm2/ecosystem.config.cjs`.

Start production services:

```bash
make deploy-start
```

That flow will:

- ensure dependencies exist
- build the shared package, server, and web app
- start the API with PM2
- serve the web app through `vite preview` with PM2
- write logs to `data/logs`

Operational commands:

```bash
make deploy-status
make deploy-logs
make deploy-stop
```

### Nginx

An example reverse proxy is included at `scripts/nginx/agentic-cli.conf.example`.

Typical setup:

```bash
sudo cp scripts/nginx/agentic-cli.conf.example /etc/nginx/sites-available/agentic-cli.conf
sudo ln -sf /etc/nginx/sites-available/agentic-cli.conf /etc/nginx/sites-enabled/agentic-cli.conf
sudo nginx -t
sudo systemctl reload nginx
```

Before reloading Nginx, customize:

- `server_name`
- `ssl_certificate`
- `ssl_certificate_key`
- upstream ports if you changed `API_PORT` or `WEB_PORT`

The example config is already set up to handle:

- `/api/events` as a non-buffered SSE stream
- `/api/*` API requests
- `/` web app traffic

## Data and Persistence

The app keeps local state under `data/`, including PM2 logs and persisted run/session metadata. It also hydrates external Codex history when available, so the UI can show both local app sessions and sessions created outside the app.

If you are publishing or deploying this project for others, treat `data/` as runtime state, not source code.

## Security Notes

- Change `PASSWORD` and `JWT_SECRET` before exposing the app to a network.
- Put the app behind HTTPS if it is reachable outside localhost.
- Review your default sandbox policy carefully.
  The example `.env` uses `danger-full-access`, which is convenient for a trusted personal machine but not a safe default for every environment.
- Codex runs with access to your selected workspace, so deploy it only where that trust model is acceptable.

## Repository Layout

```text
apps/
  server/        Express API, run manager, auth, SSE, terminal bridge
  telegram-mcp/  local MCP server for Telegram file uploads
  web/           React UI
packages/
  shared/   shared types and schemas
scripts/
  nginx/    reverse proxy example
  pm2/      production process definitions
data/       runtime data and logs
```

## Who This Is For

Agentic Assistant is a strong fit if you want:

- a self-hosted Codex UI on your own machine or server
- more visibility into tool execution than a plain terminal session
- session persistence and reviewability
- a lightweight operator panel instead of a large multi-user platform

It is less suited to multi-tenant SaaS-style deployments without adding your own hardening, user model, and access controls.
