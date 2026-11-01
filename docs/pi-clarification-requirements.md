# PI Clarification acceptance map

Source: LUMA_PI_CLARIFICATION_CODEX_PROMPT.md (November 1, 2026), with the user's stricter instruction that **no email may be sent during testing**. Code is on the feature branch; the running installed app is not replaced or deployed.

| Requirement | Implementation / verification |
| --- | --- |
| A–C: dedicated agent and end-to-end journey | Protected `agents/pi-clarification/AGENT.md`, functional Cowork navigation, deterministic AR and PPO scenarios, backend and browser journey tests. |
| D: modular architecture | `apps/server/src/pi-clarification/`: independent store, state machine, policy, Gmail, sync, credentials, outbox, runtime, approval, handoff, knowledge, worker and routes. |
| E: Gmail | Fixed-host REST, encrypted OAuth refresh tokens, refresh/disconnect/revoke, profile mailbox check, watch/history, daily renewal, bounded 404 recovery, polling and OIDC push. Full thread context, body normalization, restricted safe text attachments, send headers/idempotency, uncertain result reconciliation. Live credentials not supplied or verified. |
| F–G: durable workflow | Explicit state graph, WAL SQLite v1/v2 migration, append-only events, immutable spec/approval snapshots, transactional revisions, unique mappings, per-case job leases/heartbeats, retries and crash-effect ledger. |
| H: persona | Agent prompt contains identity, procedure, classification, proposal/spec/approval/standing rules, privacy, untrusted content, communication and tool boundaries. Ordinary coding-runner selection and scheduler execution reject the protected agent. |
| I: contracts | Strict shared Zod types and external JSON schemas for decisions, specs, tasks, approvals and investigation. Backend checks current case/version, evidence, contact workflow roles and exact authorization. Task contains complete spec including dependencies/risks. |
| J: capabilities | Structured proposals are executed by the server policy gateway, never arbitrary model-selected tools. Context includes scoped approved knowledge. Gmail actions are encapsulated and owner-authorized. No shell, repo writes, deployment or general MCP grants. |
| K: authorization/privacy | Verified roles and reply evidence, exact version/digest, explicit command, narrow historical standing policies, high-risk escalation, data-policy/provider gates, allowlists, quota/cooldown, business hours, dry-run and deployment send lock. |
| L: UI | Metrics, filters/search/sort, full case thread/timeline, spec revisions/diffs/editor, approval/outbound/runs/evidence/task panels, owner review controls, settings/prompt releases, replay and reply simulation, operations/retry. Desktop/mobile Playwright coverage. |
| M: API/control | Owner-authenticated PI API (including when general app auth is disabled), validated requests/limits, OAuth state, independently OIDC-authenticated webhook, pause/resume and server-side worker. |
| N: integration | Agent discovery, internal immutable task queue with `TASK_READY`, download/copy full brief, return-for-clarification and incident linking; correlation across records. External Tasks publishing and implementor/release dispatch remain disabled extension points. |
| O: operations | Durable retries/dead letters, cursor/watch health, graceful shutdown, hourly retention/SLA maintenance, settings/prompt history, documented migration/rollback/setup/troubleshooting. |
| P: tests | Node unit/integration tests plus Playwright desktop/mobile smoke journeys; all-workspace typecheck/build and CLI AR/PPO demos. No paid provider or live mailbox calls in the tests. |
| Q–R: delivery | Repo pulled on feature branch; modular source, tests, CI, env examples, operations guide, requirement map and reviewable PR. Final report records actual checks and external prerequisites. |

## Deliberate safe limits and external prerequisites

- The address `admin@proimagetx.ai` alone does not grant Gmail access. OAuth client ID/secret, consent, encryption key and Workspace hosting confirmation are required. Periodic receiving is implemented but cannot be honestly called connected before those are configured.
- Direct Anthropic reasoning uses an API key and an administrator-selected API model; an isolated JSON HTTP provider is also supported. No coding-subscription OAuth secret is extracted or invented. Privacy policy and applicable provider agreements/BAAs must be reviewed first.
- Real PI contacts, workflow routing and approver verification must be provided. Fixtures are isolated and cannot approve live work.
- A live Investigator requires a separately enforced read-only service/sandbox and an explicit isolation-verification deployment flag. Unavailable/unverified investigation is surfaced, never silently treated as evidence.
- Every high-risk change escalates in this release. Multi-stakeholder narrow exceptions are not enabled. Scope approval never grants production release rights.
- The current Luma login is a single owner password. A separate PI viewer/operator RBAC system is not introduced; all PI access requires the owner JWT. No anonymous PI data is exposed.
- Immutable specs, approvals, tasks and events retain de-identified evidence. Mutable-body retention/erasure is implemented; complete regulated erasure/crypto-shredding needs a separately reviewed storage policy/design. Encrypted disk/backups are required for database content beyond encrypted tokens.
- Very large threads retain all messages in the UI but only the last 30 sanitized messages go to reasoning. Earlier material requires human review. Recovery bounds stop visibly without cursor advancement rather than silently discarding a backlog.
- Settings are functional validated JSON editors, following the full shared contract. No secret-entry UI is added; credentials remain server-side.
- No real email, paid model request, production data connection, external task publication, merge or deployment is part of verification.

Follow-up: the user subsequently authorized a test deployment and reuse of the cluster email credentials. The existing Auth0/Google federation is now integrated and read-only Gmail access is live-verified. The test URL, operating mode and remaining policy/model setup are documented in [pi-clarification-test-preview.md](pi-clarification-test-preview.md). Earlier statements about missing Gmail credentials/no test instance describe the initial delivery, not the current verified preview.
