# PI Clarification implementation map

Baseline: main, pulled November 1, 2026. Express backend is one large index.ts; the global Luma password JWT authenticates a single owner. Task Manager has a separate user store and JWT. PI routes require a valid Luma owner JWT even when ordinary Luma authentication is disabled; no anonymous PI access. Server data is rooted at repository/data. Existing message SQLite migration is independent; PI uses a separate WAL SQLite database and transactional versioned migration. Agent discovery scans agents/**/AGENT.md. Cowork is a placeholder between Agents and Code. There is no reusable Gmail adapter and no existing test runner.

Files and phases:
1. packages/shared/src/pi-clarification.ts: strict contracts, contacts, configuration and public records.
2. apps/server/src/pi-clarification/{store,policy,approval,handoff,orchestrator}.ts: transactional records, explicit state machine, immutable specs/approvals, durable leases and deterministic execution.
3. gmail.ts, sync.ts, credentials.ts: encrypted refresh tokens, OAuth, Gmail transport, polling/history/watch recovery and OIDC authenticated push; hard send lock.
4. runtime.ts and agents/pi-clarification/AGENT.md: versioned prompt, isolated JSON reasoning endpoint (no shell or tool execution), bounded validation repair, read-only investigator interface. Existing permissive CLI runners are intentionally unavailable to this agent.
5. routes.ts: authenticated owner/admin API, replay, settings, controls, audit and task download. Only OAuth callback and OIDC webhook are before app auth.
6. apps/web/src/components/cowork/pi-clarification/: functional dashboard, case details, settings and deterministic replay; tiny App.tsx/nav registration and API client extension.
7. tests, .env.example and docs/pi-clarification-agent.md: mocked complete journey, policy/security/reliability tests, operational setup and remaining external prerequisites.

User constraint: mailbox admin@proimagetx.ai. No live email sends or Gmail draft writes while PI_CLARIFICATION_SEND_LOCK is true (default); polling may be enabled separately. Replay uses an isolated demo mailbox, explicit fixture labels and fake transport. No deployment or patient data connection.
