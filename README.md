<p align="center">
  <img src="apps/web/public/favicon.svg" alt="Luma Assistant logo" width="96" height="96" />
</p>

<h1 align="center">Luma Assistant</h1>

<p align="center">
  Self-hosted web application for your Codex CLI with remote URL access, cron-style jobs, sandbox terminals, offline voice-to-text, MCP, plan mode, agents, skills, and persistent session history.
</p>

## What It Is

Luma Assistant connects to the Codex CLI on your machine or server and gives it a browser UI. You can install it on a server, protect it with authentication and HTTPS, and use your Codex workspace from anywhere with a URL.

It keeps the core Codex CLI workflow available in the app: plan mode, MCP tools, workspace instructions such as `AGENTS.md`, agents, skills, approvals, terminal access, voice input, live tool output, diffs, and session history.

## Capabilities

- `Connect to your Codex CLI`: run Codex from a web app while keeping live output, approvals, diffs, plan mode, MCP, and session history visible.
- `Use it anywhere by URL`: deploy Luma Assistant on a server and access your workspace from desktop, phone, or another machine.
- `Cron-style jobs`: schedule specific assistant work for specific moments and inspect each run as a normal Codex session.
- `Sandbox terminal`: open a controlled terminal from the browser when you need direct command access from your phone or another place.
- `Offline voice-to-text`: dictate prompts into the assistant without relying on a remote transcription service.
- `Luma Tasks`: use the standalone `/taskmanager` PWA for projects, task lists, priorities, deadlines, timezone-aware Today views, admin-managed users, and Telegram-ready reports.
- `Agents and instructions`: use Codex workspace instructions such as `AGENTS.md`, plus repo-owned scheduled agents from `agents/<slug>/AGENT.md`.
- `MCP visibility`: surface MCP calls, web searches, shell commands, file changes, and run status in the normal session timeline.
- `Repo skill sync`: copy managed repo skills from `skills/**/SKILL.md` into `~/.codex/skills` without overwriting unmanaged global skills.
- `Telegram MCP`: run a local Telegram MCP server for sending rendered Markdown messages and generated files to Telegram topics.
- `Luma Tasks MCP`: inspect, search, create, assign, update, and report on Luma Tasks directly from prompts and scheduled agents.
- `Auth and history`: protect the browser UI with a password and keep local runtime data under `data/`.

## Stack

- `Root package`: `luma-assistant`
- `Server`: Express, TypeScript, `node-pty`, JWT auth, SSE
- `Web`: React, Vite, TypeScript, Tailwind-style UI utilities
- `Shared types`: `@luma/shared`
- `Telegram MCP`: `@luma/telegram-mcp`
- `Luma Tasks MCP`: `@luma/taskmanager-mcp`
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

If you deploy it on a server, put it behind HTTPS and open it from your chosen domain or server URL.

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
TASK_MANAGER_ADMIN_USERNAME=admin
TASK_MANAGER_ADMIN_PASSWORD=
TASK_MANAGER_JWT_SECRET=change_task_manager_secret
TASK_MANAGER_TOKEN_TTL_SECONDS=604800
TASK_MANAGER_DEFAULT_TIME_ZONE=Asia/Tehran
DEFAULT_MODEL=gpt-5.3-codex
DEFAULT_SANDBOX=danger-full-access
ATTACHMENT_MAX_BYTES=15728640
MAX_CONCURRENT_RUNS=8
```

Important variables:

- `PASSWORD`: browser login password.
- `JWT_SECRET`: secret used to sign auth tokens.
- `TASK_MANAGER_ADMIN_USERNAME` / `TASK_MANAGER_ADMIN_PASSWORD`: initial admin login for `/taskmanager`. If `TASK_MANAGER_ADMIN_PASSWORD` is omitted, it uses `PASSWORD`.
- `TASK_MANAGER_JWT_SECRET`: secret used to sign task-manager auth tokens. Falls back to `JWT_SECRET` when omitted.
- `TASK_MANAGER_TOKEN_TTL_SECONDS`: task-manager login lifetime in seconds.
- `TASK_MANAGER_DEFAULT_TIME_ZONE`: default timezone for new task-manager users. Users can change their own timezone from `/taskmanager/settings`.
- `CODEX_PATH`: path to the Codex executable if it is not simply `codex`.
- `DEFAULT_MODEL`: default Codex model for new sessions and new scheduled jobs.
- `DEFAULT_SANDBOX`: default sandbox mode for new sessions.
- `ATTACHMENT_MAX_BYTES`: max browser attachment upload size in bytes. Defaults to 15 MB.
- `MAX_CONCURRENT_RUNS`: server-side cap for active Codex runs.
- `TERMINAL_DISABLE_PTY=1`: force plain-pipe terminal mode.
- `TERMINAL_SHELL=/bin/bash`: choose the shell used by session terminals.

Legacy browser storage keys and local session sources are tolerated so existing sessions, auth, theme, and queued prompts are not dropped during upgrades.

## Deployment Migrations

`make deploy-start` runs `npm run migrate` after building and before PM2 starts the production processes. The migration runner currently normalizes JSON persistence under `data/`, including task-manager users, projects, tasks, deadlines, sort order, and timezone fields.

You can run migrations manually with:

```bash
npm run migrate
```

Migrations are idempotent. When a data file needs changes, a backup is written under `data/backups/` before the file is updated.

## Cron-Style Jobs

Scheduled jobs let Luma Assistant run specific assistant work at specific moments. Each execution creates a new Codex session, records status, and can be opened in the normal chat viewer.

Schedule creation snapshots the selected workspace, model, sandbox, approval policy, and selected skills. The agent prompt body is read at run time, so updating the agent file changes future executions.

## Luma Tasks

Luma Tasks is a standalone task manager served from:

```text
/taskmanager
```

It has separate task-manager authentication from the main assistant. The initial admin account comes from `.env`, and additional users are managed inside the task-manager admin screen.

Task-manager data is persisted as JSON under `data/taskmanager/` and is covered by the migration runner used by `make deploy-start`.

Current task-manager capabilities include:

- Project/list columns with project colors and browser-saved project chip ordering.
- Mobile-friendly project chips with one-project-at-a-time task browsing.
- Admin-only user management and per-project user access.
- Tasks with status, priority, assignee, due date, optional time, deadline flag, checklist, comments, and activity.
- Views for My Tasks, Today, Upcoming, Completed, Admin, and Settings.
- Timezone-aware date handling, defaulting to `Asia/Tehran`.
- Desktop collapsed sidebar icons, mobile drawer navigation, refresh control, and light/dark mode.
- Separate PWA metadata for installing Luma Tasks apart from the main Luma Assistant app.
- A Today report endpoint:

```text
/api/taskmanager/reports/today
```

The report endpoint returns plain text that is already formatted for Telegram. The `luma-tasks` MCP server exposes this through `get_today_report` so agents can send the report directly with `luma-tel.send_message`.

## Agents

Repo-owned scheduled agents live here:

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

Use the configured MCP tools and prepare today's plan.
```

The Markdown body after frontmatter is the exact prompt used for scheduled jobs.

Codex workspace instructions such as `AGENTS.md` remain part of the normal Codex CLI workflow and are honored by Codex in the selected workspace.

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

## Luma Tasks MCP

The repo also includes a Luma Tasks MCP server registered as `luma-tasks` by default. It connects to the local Luma Tasks API and exposes tools for prompts and agents:

- `get_today_report`: returns the ready-to-send plain-text Today report.
- `list_users`: lists task-manager users for assignment.
- `list_projects`: lists visible projects and access users.
- `list_tasks`: lists visible tasks with filters.
- `search_tasks`: finds visible tasks by title, description, checklist, project, or assignee.
- `create_project`: creates projects/lists with optional user access.
- `create_task`, `update_task`, `complete_task`, `add_comment`: basic task actions.

Default configuration:

```env
TASK_MANAGER_MCP_PORT=9014
TASK_MANAGER_MCP_NAME=luma-tasks
LUMA_TASKS_API_BASE=http://127.0.0.1:9001
LUMA_TASKS_USERNAME=admin
LUMA_TASKS_PASSWORD=
LUMA_TASKS_AUTH_TOKEN=
```

If `LUMA_TASKS_PASSWORD` is omitted, the MCP server falls back to `TASK_MANAGER_ADMIN_PASSWORD`, then `PASSWORD`. `LUMA_TASKS_AUTH_TOKEN` is optional and can be used instead of username/password, but normal username/password login is preferred because task-manager tokens expire.

`make run` and `make deploy-start` ensure the local Codex MCP entry points at both `luma-tel` and `luma-tasks`.

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
- `@luma/taskmanager-mcp`

## Landing Page

The standalone landing page lives in `landing-page/`.

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
- `luma-taskmanager-mcp`

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

The example also sets:

```nginx
client_max_body_size 20m;
```

This must be higher than `ATTACHMENT_MAX_BYTES`; otherwise Nginx's default 1 MB request limit can reject image uploads before they reach the app. If an already-deployed server rejects a small attachment with `413 Request Entity Too Large`, add or update `client_max_body_size` in `/etc/nginx/sites-available/luma-assistant.conf`, then run:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

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
agents/          repo-owned scheduled agent prompts
apps/
  server/        Express API, scheduler, run manager, auth, SSE, terminal bridge
  taskmanager-mcp/ local MCP server for Luma Tasks reports and task actions
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
- `Scheduled job skipped` can happen when the global run capacity is full.
