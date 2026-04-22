# Personal Codex Assistant (Vite + Tailwind)

A personal LAN-first Codex assistant with:
- `apps/server`: TypeScript Express bridge for `codex app-server`
- `apps/web`: Vite React TypeScript UI with Telegram-style chat and admin/ops panels
- `packages/shared`: shared API/event contracts + method/risk capability typing

## Stack
- Frontend: Vite, React, TypeScript, Tailwind, Radix Dialog, Zustand, React Query
- Backend: Node.js, Express, TypeScript, SSE
- Shared contracts: TypeScript + Zod

## Features
- One chat = one Codex thread with history and streaming timeline
- Thread power tools: rename, fork, compact, rollback, unsubscribe
- Right panel tabs: `Context`, `Ops`, `Admin`
- Guarded high-risk actions (risk tiers + optional session acceptance + reauth)
- Command execution panel and filesystem workspace panel
- Plugin/config admin inspectors
- Approval dialog for command/file/tool approvals
- ChatGPT auth flow UI (`account/login/start`)
- Slash commands in composer: `/plan`, `/status` (rate limits + active thread token usage)
- MCP server panel (`mcpServerStatus/list`, reload, OAuth)
- Workspace root selector (switch active workspace path at runtime)
- Mobile-responsive drawers for chats/context
- JSON persistence: `data/ui-state.json` and audit logs `data/audit-log-*.jsonl`
- Config-driven repo map in `config.yaml` + `AGENTS.md` sync to default workspace on startup

## Requirements
- Node.js 22+
- `codex` CLI in PATH

## Setup
1. Copy env:

```bash
cp .env.example .env
```

2. Edit `.env` at minimum:
- `APP_PASSWORD`
- `WEB_ORIGIN` (default `http://localhost:5173`)
- `ALLOW_LAN_ORIGINS=true` (recommended for phone/LAN access)

3. Install dependencies:

```bash
npm install
```

## Run (development)

```bash
npm run dev
```

- Web UI: `http://localhost:5173`
- API server: `http://localhost:8787`

Open from phone on LAN using your machine IP:
- `http://<LAN_IP>:5173`

If you prefer strict CORS, set `ALLOW_LAN_ORIGINS=false` and include every allowed origin explicitly in `WEB_ORIGIN` (comma-separated).

## Workspace Config
- Repo config file: `./config.yaml`
- Fixed runtime config file: `~/config/agentic-assistant/config.yaml`
- `npm run dev` / `make run` copy repo config to fixed runtime path automatically.
- `config.yaml` includes:
  - `default_workspace`
  - `repos` map for important local repositories.
- Runtime default workspace precedence:
  - `~/config/agentic-assistant/config.yaml` `default_workspace` (primary)
  - `./config.yaml` `default_workspace` (fallback)
  - `.env DEFAULT_CWD` (fallback)
  - repo root (final fallback)
- `AGENTS.md` explains how to resolve repos from `config.yaml`.
- Startup automation copies this repo's `AGENTS.md` into `default_workspace/AGENTS.md` via:
  - `make run`
  - `npm run dev`
  - `npm run build`
  - `npm run start`

## Run (production-like)

```bash
npm run build
npm run start
```

Server listens on `HOST:PORT` and serves `apps/web/dist` when present.

## API endpoints
- `POST /api/login`
- `POST /api/logout`
- `GET /api/bootstrap`
- `GET /api/capabilities`
- `GET /api/ui-state`
- `POST /api/ui-state`
- `GET /api/workspace`
- `POST /api/workspace`
- `POST /api/rpc`
- `POST /api/server-request/respond`
- `GET /api/events`

## Security
- Password gate is required for all API/SSE routes.
- Intended for trusted LAN only.
- Method groups are controlled with env toggles:
  - `ENABLE_GROUP_READ`
  - `ENABLE_GROUP_THREAD_CONTROL`
  - `ENABLE_GROUP_OPS`
  - `ENABLE_GROUP_CONFIG_WRITE`
  - `ENABLE_GROUP_FILESYSTEM`
  - `ENABLE_GROUP_EXPERIMENTAL`
- Risk acceptance TTL is configurable with `RISK_ACCEPT_TTL_MS`.

## Notes
- Codex thread persistence is managed by `codex app-server` rollout logs.
- This system uses a single shared `codex app-server` process with auto-restart behavior.
- UI state and audit logs are local JSON files under `data/`.
