<p align="center">
  <img src="apps/web/public/favicon.svg" alt="Luma Assistant logo" width="96" height="96" />
</p>

<h1 align="center">Luma Assistant</h1>

<p align="center">
  Self-hosted web application for Codex and Claude Code with remote URL access, cron-style jobs, sandbox terminals, offline voice-to-text, MCP, plan mode, agents, skills, and persistent session history.
</p>

## What It Is

Luma Assistant connects to Codex and Claude Code on your machine or server and gives them a browser UI. You can install it on a server, protect it with authentication and HTTPS, and use your coding workspace from anywhere with a URL.

It keeps the core coding-agent workflow available in the app: runner selection, model and thinking controls, plan mode, MCP tools, workspace instructions such as `AGENTS.md`, agents, skills, approvals, terminal access, voice input, inline tool output, and session history.

## Capabilities

- `Choose Codex or Claude Code`: create each new session with the runner you want, while keeping live output, plan mode, MCP, and session history visible.
- `Claude-like workspace`: use a compact dark coding UI with centered messages, right-aligned user bubbles, collapsible left navigation, and a right dock that opens only when Terminal, Approvals, or Context is selected.
- `Runner controls`: change runner, model, and thinking effort from the new-session flow and composer strip. Codex and Claude use their own defaults.
- `Use it anywhere by URL`: deploy Luma Assistant on a server and access your workspace from desktop, phone, or another machine.
- `Cron-style jobs`: schedule specific assistant work for specific moments and inspect each run as a normal Codex session.
- `Browser terminal`: open a controlled terminal from the browser, type directly in the terminal surface, interrupt commands, and close the dock when you are done.
- `Offline voice-to-text`: dictate prompts into the assistant without relying on a remote transcription service.
- `Luma Tasks`: use the standalone `/taskmanager` PWA for projects, task lists, priorities, deadlines, timezone-aware Today views, admin-managed users, and Telegram-ready reports.
- `Agents and instructions`: use Codex workspace instructions such as `AGENTS.md`, plus repo-owned scheduled agents from `agents/<slug>/AGENT.md`; the Agents area is available from the left navigation.
- `Inline tool transcript`: surface MCP calls, web searches, shell commands, file changes, and run status as compact rows like `Ran 5 commands`, expandable inline instead of opening a modal.
- `Image render MCP`: let agents call `luma-images.show_image` to attach validated local or HTTP(S) images to the current chat; the web UI lazy-loads image bytes only after the user clicks `Load image`.
- `Repo skill sync`: copy managed repo skills from `skills/**/SKILL.md` into `~/.codex/skills` and `~/.claude/skills` without overwriting unmanaged global skills.
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
- Claude Code authentication or Anthropic credentials when using the Claude Code runner
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
DEFAULT_MODEL=gpt-5.5
DEFAULT_RUNNER=codex
CLAUDE_DEFAULT_MODEL=sonnet
DEFAULT_REASONING_EFFORT=high
CLAUDE_CODE_EXECUTABLE=
CLAUDE_AUTH_MODE=oauth
DEFAULT_SANDBOX=danger-full-access
ATTACHMENT_MAX_BYTES=15728640
IMAGE_MCP_PORT=9015
IMAGE_MCP_NAME=luma-images
IMAGE_MCP_MAX_BYTES=3145728
IMAGE_MCP_MAX_HEIGHT=1200
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
- `DEFAULT_RUNNER`: default runner for new sessions. Use `codex` or `claude`.
- `DEFAULT_MODEL`: default Codex model for new sessions and new scheduled jobs.
- `CLAUDE_DEFAULT_MODEL`: default Claude model when the Claude Code runner is selected.
- `DEFAULT_REASONING_EFFORT`: default thinking effort for new sessions. Use `low`, `medium`, `high`, or `xhigh` for Codex extra high; it can also be changed in the new-session dialog.
- `CLAUDE_CODE_EXECUTABLE`: optional path to the Claude Code CLI. If omitted, Luma uses `claude` from `PATH`.
- `CLAUDE_AUTH_MODE`: Claude auth mode. Defaults to `oauth`, which uses your logged-in Claude Code account and strips inherited Anthropic API-key variables from the Claude subprocess. Set `api_key` to intentionally use `ANTHROPIC_API_KEY`.
- `DEFAULT_SANDBOX`: default sandbox mode for new sessions.
- `ATTACHMENT_MAX_BYTES`: max browser attachment upload size in bytes. Defaults to 15 MB.
- `IMAGE_MCP_PORT` / `IMAGE_MCP_NAME`: local MCP server used by agents to render images in chat.
- `IMAGE_MCP_MAX_BYTES`: max image size accepted by the image MCP and server-side image renderer. Defaults to 3 MB.
- `IMAGE_MCP_MAX_HEIGHT`: max image height accepted by the image MCP and server-side image renderer. Defaults to 1200 px.
- `MAX_CONCURRENT_RUNS`: server-side cap for active Codex runs.
- `TERMINAL_DISABLE_PTY=1`: force plain-pipe terminal mode.
- `TERMINAL_SHELL=/bin/bash`: choose the shell used by session terminals.

Legacy browser storage keys and local session sources are tolerated so existing sessions, auth, theme, and queued prompts are not dropped during upgrades.

## Claude Code Runner

Luma Assistant includes Claude Code as a second runner by spawning the `claude` CLI directly. Select `Codex` or `Claude Code` in Run defaults before creating a new session. Existing sessions keep their original runner.

By default, Claude runs use your normal Claude Code OAuth login. If the server shell has `ANTHROPIC_API_KEY` set, Luma removes it from the Claude subprocess so a paid Claude Code plan is not accidentally bypassed. To intentionally use API-key billing instead, set `CLAUDE_AUTH_MODE=api_key`.

Normal Claude Code runs use autonomous `bypassPermissions` CLI mode. Plan mode wraps the prompt with `plan.md`, uses `dontAsk`, and limits Claude to read/search tools. Luma captures raw Claude stream JSON/stderr plus normalized chat, tool, status, session, and usage events.

Claude effort is passed with `--effort` when the installed CLI supports it. Older CLI builds that reject the flag receive `CLAUDE_CODE_EFFORT_LEVEL=<effort>` and Luma emits a warning in the run log because enforcement depends on the installed Claude Code version.

More implementation notes are in:

```text
docs/claude-cli.md
```

## Web Interface

The main web app now uses a Claude Code-inspired layout while keeping Luma-specific functionality:

- Dark mode is the default on every load.
- The left sidebar can be collapsed and reopened.
- The right dock starts closed and opens from the top Terminal, Approvals, and Context buttons.
- Session lists show the first 15 items and can load more history from the session-type selector.
- The bottom-left app status shows backend connection state and whether the app is running locally or deployed.
- The composer strip shows the active runner, model, and thinking effort with compact controls sized to their text.
- Commands, MCP calls, web searches, file edits, and tool batches appear inline in the chat transcript.
- Copy buttons sit outside message boxes so assistant and user messages stay visually clean.
- The account menu under `Luma Assistant` includes sign out and theme settings.

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
~/.claude/skills/<slug>
```

Managed copies include a marker file and can be updated safely. If a destination folder already exists without the managed marker, it is reported as a conflict and is not overwritten. Claude Code reads `~/.claude/skills`, so Claude runner sessions can discover the same repo-managed skills natively; selected skills are also injected into the prompt for the active turn.

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

`make run` and `make deploy-start` ensure the local MCP entries point at `luma-tel`, `luma-tasks`, and `luma-images` where supported.

## Luma Images MCP

The repo includes an image-render MCP server registered as `luma-images` by default. Agents should call `show_image` when the user asks to see an image or when a generated image file should appear in the active Luma chat.

`show_image` accepts:

- `session_id`: the current Luma session id injected into the run prompt.
- `source`: a local image path or HTTP(S) image URL.
- `caption`: optional message text shown with the image.
- `alt`: optional accessibility text.

Guardrails are enforced by both the MCP server and the Luma API:

- PNG, JPEG, WebP, and GIF only.
- Maximum size: `IMAGE_MCP_MAX_BYTES`, default 3 MB.
- Maximum height: `IMAGE_MCP_MAX_HEIGHT`, default 1200 px.
- HTTP(S) URLs must return an image content type and private/localhost network targets are blocked.

Accepted images are copied into `data/session-images/` and attached to the session. In the web chat, image attachments render first as compact placeholders with filename, dimensions, and size; the browser fetches the actual image bytes only when the user clicks `Load image`. After loading, the preview can be opened larger in the in-app lightbox and downloaded. `make run` and `make deploy-start` register this MCP for Codex and, when the Claude CLI is available, Claude Code.

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
- `@luma/image-mcp`

## Landing Page

The standalone GitHub Pages landing site lives in `landing-page/`. It presents the current Claude-like workspace, Codex and Claude runner support, plan mode, inline tools, terminal dock, skills, agents, and Luma Tasks without exposing private session screenshots.

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
- `luma-image-mcp`

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
  image-mcp/     local MCP server for rendering images in Luma chat
  web/           React workspace UI
landing-page/    independent GitHub Pages site
packages/
  shared/        shared schemas and TypeScript types
scripts/
  nginx/         reverse proxy example
  pm2/           production process definitions
skills/          repo-managed Codex and Claude skills
data/            private runtime data and logs
```

## Troubleshooting

- `Connection refused` on HTTPS usually means no process is listening on port `443`, the reverse proxy is stopped, or the firewall is rejecting the port.
- `Codex not found` means `CODEX_PATH` does not point at an executable Codex CLI.
- `Skill conflict` means a global `~/.codex/skills/<slug>` or `~/.claude/skills/<slug>` exists without Luma Assistant's managed marker and was intentionally left untouched.
- `Scheduled job skipped` can happen when the global run capacity is full.
