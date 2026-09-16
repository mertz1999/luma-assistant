<p align="center">
  <img src="apps/web/public/favicon.svg" alt="Luma Assistant logo" width="96" height="96" />
</p>

<h1 align="center">Luma Assistant</h1>

<p align="center">
  Self-hosted web application for Codex and Claude Code with remote URL access, scheduled agents, per-session terminals, browser voice input, MCP integrations, plan mode, reusable skills, Luma Tasks, and persistent session history.
</p>

## What It Is

Luma Assistant connects to Codex and Claude Code on your machine or server and gives them a browser UI. You can install it on a server, protect it with authentication and HTTPS, and use your coding workspace from anywhere with a URL.

It keeps the core coding-agent workflow available in the app: runner selection, model and thinking controls, plan mode, MCP tools, workspace instructions such as `AGENTS.md`, agents, skills, terminal access, voice input, inline tool output, and session history.

## Features

### Assistant Workspace

- `Codex and Claude Code runners`: choose a runner for each new session. Existing sessions retain their runner, model, and thinking configuration when reopened.
- `Runner-specific controls`: select built-in or custom model IDs, set Codex or Claude thinking effort, choose a workspace, and configure sandbox and approval behavior.
- `Real-time conversations`: stream run state and output over SSE, render Markdown and code, group live activity in chronological order, and recover the UI when the connection is interrupted.
- `Responsive Claude-like interface`: use collapsible navigation and Terminal/Context docks on desktop, mobile drawers on smaller screens, light and dark themes, and installable PWA icons for home-screen use.
- `English and Farsi rendering`: detect right-to-left Farsi messages, including mixed Farsi/English replies and messages that begin with code paths, while keeping code and Latin content readable.
- `Workspace-aware sessions`: switch among configured repositories, start a clean draft, and see each session's workspace, runner, source, model, effort, status, and last update.
- `Session history and management`: browse local and imported Codex CLI history, filter by run status, reveal scheduled sessions or all history, page through older chats, inspect token usage, and archive or permanently delete local sessions.
- `Reliable message delivery`: acknowledge sends immediately, persist pending messages in a server-side outbox, retry transient failures, expose retry for failed messages, and preserve per-session browser queues across reloads.
- `Run controls`: stop an active run, rerun a completed or failed request, and keep subsequent prompts queued behind the active run for that session.
- `Rich transcript controls`: copy assistant or user messages and expand grouped shell commands, MCP calls, web searches, file changes, reasoning/plan entries, and tool output inline.
- `File attachments`: select or drag and drop as many as 10 image or text/code files per message. Attachments are scoped to the selected workspace; images can be previewed, opened in a lightbox, or downloaded.
- `Browser voice input`: dictate into the composer with the browser's Web Speech API, with recording state, elapsed time, and a `/speech` compatibility check. Availability and whether recognition is local or remote depend on the browser.
- `Slash commands`: use `/plan`, `/status`, `/account`, `/mcp`, `/speech`, and `/help` for planning and local runtime diagnostics.

### Agentic Workflows

- `Protected plan mode`: arm planning with `/plan`, keep discovery read-only, answer structured clarification questions in the chat, review the proposed plan, request changes, and explicitly approve implementation.
- `Prompt agents`: discover repo-owned definitions from `agents/<slug>/AGENT.md`, select them from the composer, and inject their instructions into an individual turn.
- `Scheduled agents`: create daily schedules with a runner, model, effort, workspace, sandbox, approval policy, and selected skills; pause, resume, delete, or run a schedule immediately and open every execution as a normal session.
- `Reusable skills`: discover workspace and managed skills, select them from the composer, reload the catalog, and synchronize repo-managed skill folders to both Codex and Claude without overwriting unmanaged global skills.
- `Workspace instructions`: retain the normal Codex CLI instruction hierarchy, including repository `AGENTS.md` files in the selected workspace.
- `Per-session terminal`: start an isolated PTY-backed shell in the session workspace, type or paste commands, recall command history, send interrupts, stop the shell, and follow output live from the browser.
- `Operational status`: inspect Codex login/quota details, configured MCP servers, backend connectivity, deployment location, run diagnostics, and debug logs from the interface.

### Built-In Integrations

- `Telegram MCP (luma-tel)`: send Markdown or plain-text messages and generated files to Telegram chats/topics, and retrieve the latest user-uploaded document. A self-hosted Telegram Bot API endpoint can be used for downloads above Telegram's hosted 20 MB limit.
- `Luma Tasks MCP (luma-tasks)`: test connectivity, produce Today reports, list users/projects/tasks, search tasks, create projects and tasks, update or complete tasks, assign work, and add comments. The service is opt-in so the task web app can run without its MCP process.
- `Image render MCP (luma-images)`: publish validated PNG, JPEG, WebP, or GIF files from local paths or public HTTP(S) URLs into the active chat. Images use size, height, content-type, and private-network guardrails, then lazy-load on demand.
- `Cross-runner MCP setup`: development and deployment commands register supported local MCP services for Codex and Claude Code; the Tasks MCP is registered when enabled.

### Luma Tasks

- `Separate task workspace`: open `/taskmanager` as its own responsive, installable PWA with independent login, light/dark mode, mobile navigation, desktop sidebar layouts, automatic background refresh, and a manual refresh control.
- `Projects and access`: create color-coded projects, control per-project user access, archive or delete projects, filter task views by project, and reorder mobile project chips.
- `Complete task records`: manage title, description, to-do/in-progress/completed status, priority, assignee, project, labels, due date and optional time, deadline flag, checklist items, comments, and activity history.
- `Focused views`: work from All Tasks, Today, Upcoming, Completed, Admin, or Settings; admins can filter team work by user or show only their own tasks.
- `Task organization`: use manual ordering or priority-and-due-date sorting, move tasks up or down, and use card actions to complete, reopen, move to today/tomorrow/another date, remove a date, edit, or delete work.
- `Users and timezones`: let admins add users, change roles, deactivate or reactivate accounts, and reset passwords, while each user controls their own IANA timezone for due-date and Today calculations.
- `Reports and automation`: generate a Telegram-ready plain-text Today report through the HTTP API or Tasks MCP for manual use and scheduled agents.

### Persistence, Deployment, and Operations

- `Durable history`: store chat messages in SQLite with indexed page seeks, migrate older JSONL message logs automatically, keep run events in append-only JSONL files, and maintain a small session index for fast startup and chat opening.
- `Long-running server safeguards`: cap hot in-memory sessions and active-run event buffers, limit concurrent runs, auto-archive old finished runs, and suppress benign Codex warnings that should not fail a run.
- `Authentication`: protect the assistant with password/JWT login, browser-persisted sessions, expiration handling, and sign-out; Luma Tasks uses separate users and tokens with an initial admin configured from the environment.
- `Safe migrations`: run idempotent persistence migrations during deployment and write backups before changing existing task-manager data.
- `Production tooling`: build and run all services with npm workspaces and Make targets, manage processes with PM2, and use the included Nginx HTTPS/SSE reverse-proxy example.
- `Public landing site`: build and deploy the independent React/Vite landing page to GitHub Pages without exposing private runtime conversations.

## Stack

- `Root package`: `luma-assistant`
- `Server`: Express, TypeScript, `node-pty`, JWT auth, SSE, SQLite (`better-sqlite3`)
- `Web`: React, Vite, TypeScript, Tailwind-style UI utilities
- `Shared types`: `@luma/shared`
- `Telegram MCP`: `@luma/telegram-mcp`
- `Luma Tasks MCP`: `@luma/taskmanager-mcp`
- `Image render MCP`: `@luma/image-mcp`
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
DEFAULT_MODEL=gpt-5.6-sol
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
- `DEFAULT_RUNNER`: default runner for new sessions. Use `codex`, `claude`, or `cursor`.
- `DEFAULT_MODEL`: default Codex model for new sessions and new scheduled jobs.
- `CLAUDE_DEFAULT_MODEL`: default Claude model when the Claude Code runner is selected.
- `DEFAULT_CURSOR_MODEL`: default Cursor model when the Cursor runner is selected (default `composer-2.5`).
- `DEFAULT_REASONING_EFFORT`: default thinking effort for new sessions. Use `low`, `medium`, `high`, or `xhigh` (Codex extra high). Claude also accepts `max`. Cursor encodes effort as a model bracket when the model supports it.
- `CLAUDE_CODE_EXECUTABLE`: optional path to the Claude Code CLI. If omitted, Luma uses `claude` from `PATH`.
- `CURSOR_PATH` / `CURSOR_EXECUTABLE`: optional path to the Cursor CLI. If omitted, Luma looks for `cursor` on `PATH` (and the macOS app bundle path).
- `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`: Cursor authentication for headless Agent CLI runs.
- `CURSOR_FORCE`: pass `--force` on Cursor runs (default on). Set `0` to disable unless approval policy requires it.
- `CURSOR_APPROVE_MCPS`: pass `--approve-mcps` on Cursor runs (default on).
- `CURSOR_WORKTREE`: set `1` to pass `--worktree` on every Cursor run.
- `CLAUDE_AUTH_MODE`: Claude auth mode. Defaults to `oauth`, which uses your logged-in Claude Code account and strips inherited Anthropic API-key variables from the Claude subprocess. Set `api_key` to intentionally use `ANTHROPIC_API_KEY`.
- `DEFAULT_SANDBOX`: default sandbox mode for new sessions.
- `ATTACHMENT_MAX_BYTES`: max browser attachment upload size in bytes. Defaults to 15 MB.
- `IMAGE_MCP_PORT` / `IMAGE_MCP_NAME`: local MCP server used by agents to render images in chat.
- `IMAGE_MCP_MAX_BYTES`: max image size accepted by the image MCP and server-side image renderer. Defaults to 3 MB.
- `IMAGE_MCP_MAX_HEIGHT`: max image height accepted by the image MCP and server-side image renderer. Defaults to 1200 px.
- `MAX_CONCURRENT_RUNS`: server-side cap for active assistant runs.
- `MESSAGE_STORE_HOT_SESSIONS`: max chat sessions that keep full message bodies in RAM (default `48`). Others stay index-only until opened.
- `RUN_EVENTS_MEMORY_CAP`: max stdout/stderr events kept in RAM per *active* run (default `400`). Full history remains on disk under `data/runs/`.
- `RUN_RETENTION_DAYS`: auto-archive finished runs older than this many days on startup (default `45`; set `0` to disable).
- `ENABLE_TASK_MANAGER_MCP=1`: opt-in to start the Luma Tasks MCP (off by default).
- `TERMINAL_DISABLE_PTY=1`: force plain-pipe terminal mode.
- `TERMINAL_SHELL=/bin/bash`: choose the shell used by session terminals.

Legacy browser storage keys and local session sources are tolerated so existing sessions, auth, theme, and queued prompts are not dropped during upgrades.

## Claude Code Runner

Luma Assistant includes Claude Code as a second runner by spawning the `claude` CLI directly. Select `Codex` or `Claude Code` in Run defaults before creating a new session. Existing sessions keep their original runner.

By default, Claude runs use your normal Claude Code OAuth login. If the server shell has `ANTHROPIC_API_KEY` set, Luma removes it from the Claude subprocess so a paid Claude Code plan is not accidentally bypassed. To intentionally use API-key billing instead, set `CLAUDE_AUTH_MODE=api_key`.

Normal Claude Code runs use autonomous `bypassPermissions` CLI mode plus `--allow-dangerously-skip-permissions`. On root hosts set `CLAUDE_BYPASS_AS_ROOT=1` so Luma also sets `IS_SANDBOX=1` (required by Claude Code). Codex defaults to `danger-full-access` with `approvalPolicy=never`. Plan mode wraps the prompt with `plan.md`, uses `dontAsk`, and limits Claude to read/search tools. There is no Approvals dock; tool escalations are not queued in the UI.

Run metadata is stored in `data/runs.json`. Stream events live in `data/runs/<runId>.jsonl` so the index stays small as history grows. Luma captures raw Claude stream JSON/stderr plus normalized chat, tool, status, session, and usage events.

Claude effort is passed with `--effort` when the installed CLI supports it. Older CLI builds that reject the flag receive `CLAUDE_CODE_EFFORT_LEVEL=<effort>` and Luma emits a warning in the run log because enforcement depends on the installed Claude Code version.

More implementation notes are in:

```text
docs/claude-cli.md
```

## Cursor Agent Runner

Luma Assistant includes Cursor Agent as a third runner by spawning the Cursor CLI (`cursor agent -p --output-format stream-json`). Select `Cursor` in the new-session dialog or composer before creating a session. Existing sessions keep their original runner.

Auth uses `CURSOR_API_KEY` (or a prior `cursor agent login` on the host). Models are loaded from `cursor agent --list-models` when available (`GET /api/cursor/models`). Effort is encoded as a model bracket (for example `claude-opus-4-6[effort=high]`) when the selected model supports it. Plan mode maps to `--plan`; Cursor also has an Ask toggle that maps to `--mode ask`.

MCP servers for Luma telegram/images/(optional tasks) are written into `~/.cursor/mcp.json` by `make ensure-cursor-mcp`. Selected skills/agents are still injected into the prompt; Luma also discovers `~/.cursor/skills-cursor` when present.

More implementation notes are in:

```text
docs/cursor-cli.md
```

## Web Interface

The main web app now uses a Claude Code-inspired layout while keeping Luma-specific functionality:

- Dark mode is the default on every load.
- The left sidebar can be collapsed and reopened.
- The right dock starts closed and opens from the top Terminal and Context buttons.
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

## Scheduled Agents

Scheduled agents let Luma Assistant run specific work every day at a configured time. Each execution uses its selected Codex or Claude runner, creates a normal session, records its status, and can be opened in the chat viewer.

Schedule creation snapshots the selected runner, workspace, model, thinking effort, sandbox, approval policy, and skills. The agent prompt body is read at run time, so updating the agent file changes future executions.

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
- Views for All Tasks, Today, Upcoming, Completed, Admin, and Settings.
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

The repository currently includes ready-to-use agents for:

- Creating new repo-owned agents.
- Producing AI transformation opportunity reports.
- Sending daily article digests to Telegram.
- Pruning unused Docker resources and warning about high disk usage.
- Sending the Luma Tasks Today report to Telegram.
- Building a TickTick briefing for overdue work, today's tasks, and upcoming meetings.

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

Bundled skills currently cover repo-owned agent creation, screen-recordable SaaS demo pages, and exporting a website plus same-site pages into a single Markdown file.

## Telegram MCP

The repo includes a Telegram MCP server registered as `luma-tel` by default. It can send Markdown messages, upload generated files to Telegram group topics, and save/read the latest document uploaded by a user.

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
TELEGRAM_API_BASE=https://api.telegram.org
TELEGRAM_FILE_BASE=https://api.telegram.org
TELEGRAM_ALLOWED_ROOTS=/Users/applestation/Project
TELEGRAM_MAX_FILE_BYTES=52428800
TELEGRAM_DOWNLOAD_DIR=/Users/applestation/Project/.luma/telegram-uploads
TELEGRAM_MAX_TEXT_READ_BYTES=262144
```

The MCP exposes `get_last_uploaded_file` for inbound documents. It reads Telegram's bot update stream, finds the latest user-uploaded document in the configured chat/topic, and saves it under `TELEGRAM_DOWNLOAD_DIR` (or `.luma/telegram-uploads` beneath the first allowed root). Recognized text and code files also return their leading UTF-8 content; binary files return the saved local path. The last downloaded file is cached, so asking for it again returns the saved copy until a newer document arrives.

Telegram's hosted Bot API limits `getFile` downloads to 20 MB. To receive larger documents, run a local Telegram Bot API server and set `TELEGRAM_API_BASE` and `TELEGRAM_FILE_BASE` to its base URL. `TELEGRAM_MAX_FILE_BYTES` remains the MCP's independent local upload/download policy.

For group uploads, disable the bot's privacy mode with `@BotFather` or make the bot an administrator so it can receive ordinary document messages. `getUpdates` cannot be used while a webhook is configured, and this MCP should be the only consumer of the bot's update stream.

`make run` and `make deploy-start` ensure the local Codex MCP entry points at the Telegram MCP server.

## Luma Tasks MCP

The repo also includes a Luma Tasks MCP server (`luma-tasks`). It is **off by default** (to save CPU/RAM); set `ENABLE_TASK_MANAGER_MCP=1` to start it under PM2 and register it for Codex. The `/taskmanager` web app and `/api/taskmanager/*` routes still work without the MCP. When enabled, it connects to the local Luma Tasks API and exposes tools for prompts and agents:

- `get_today_report`: returns the ready-to-send plain-text Today report.
- `list_users`: lists task-manager users for assignment.
- `list_projects`: lists visible projects and access users.
- `list_tasks`: lists visible tasks with filters.
- `search_tasks`: finds visible tasks by title, description, checklist, project, or assignee.
- `create_project`: creates projects/lists with optional user access.
- `create_task`, `update_task`, `complete_task`, `add_comment`: basic task actions.

Default configuration (when enabling):

```env
ENABLE_TASK_MANAGER_MCP=1
TASK_MANAGER_MCP_PORT=9014
TASK_MANAGER_MCP_NAME=luma-tasks
LUMA_TASKS_API_BASE=http://127.0.0.1:9001
LUMA_TASKS_USERNAME=admin
LUMA_TASKS_PASSWORD=
LUMA_TASKS_AUTH_TOKEN=
```

If `LUMA_TASKS_PASSWORD` is omitted, the MCP server falls back to `TASK_MANAGER_ADMIN_PASSWORD`, then `PASSWORD`. `LUMA_TASKS_AUTH_TOKEN` is optional and can be used instead of username/password, but normal username/password login is preferred because task-manager tokens expire.

`make run` and `make deploy-start` ensure the local MCP entries for `luma-tel` and `luma-images` for Codex, Claude Code, and Cursor (Claude uses user-scope registration; Cursor merges into `~/.cursor/mcp.json`). `luma-tasks` is registered only when `ENABLE_TASK_MANAGER_MCP=1`. For local development without PM2, run `npm run dev:taskmanager` in a separate terminal when you need the MCP.

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
- `luma-image-mcp`
- `luma-taskmanager-mcp` (only when `ENABLE_TASK_MANAGER_MCP=1`)

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

Runtime state stays under `data/`, including the SQLite message database, session metadata, run-event logs, schedules, PM2 logs, and generated app state. Treat `data/` as private runtime state and do not delete it during upgrades unless you intentionally want to reset local history.

Security notes:

- Change `PASSWORD` and `JWT_SECRET` before exposing the app.
- Put the app behind HTTPS when reachable outside localhost.
- Review `DEFAULT_SANDBOX`; `danger-full-access` is convenient for trusted personal hosts but high trust.
- Codex and Claude runs have access to the selected workspace and enabled MCP tools according to their configured permission mode.
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
