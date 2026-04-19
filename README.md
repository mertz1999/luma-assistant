# Personal Codex Assistant (Vite + Tailwind)

A personal LAN-first Codex assistant with:
- `apps/server`: TypeScript Express bridge for `codex app-server`
- `apps/web`: Vite React TypeScript UI with Tailwind and componentized layout
- `packages/shared`: shared API/event contracts

## Stack
- Frontend: Vite, React, TypeScript, Tailwind, Radix Dialog, Zustand, React Query
- Backend: Node.js, Express, TypeScript, SSE
- Shared contracts: TypeScript + Zod

## Features
- Telegram-style thread/chat UX (one chat = one Codex thread)
- Live stream of `turn/*` and `item/*` events
- Approval dialog for command/file/tool approvals
- ChatGPT auth flow UI (`account/login/start`)
- MCP server panel (`mcpServerStatus/list`, reload, OAuth)
- Mobile-responsive drawers for chats/context

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
- `DEFAULT_CWD`
- `WEB_ORIGIN` (default `http://localhost:5173`)

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

If LAN access to Vite is blocked by firewall, allow incoming connections.

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
- `POST /api/rpc`
- `POST /api/server-request/respond`
- `GET /api/events`

## Security
- Password gate is required for all API/SSE routes.
- Intended for trusted LAN only.
- Do not expose directly to the public internet.

## Notes
- Codex thread persistence is managed by `codex app-server` rollout logs.
- This system uses a single shared `codex app-server` process.
