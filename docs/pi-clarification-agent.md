# PI Clarification Agent

Implemented on feature/pi-clarification-test-mode. This feature is prepared for testing; it is not deployed. The mailbox defaults to **admin@proimagetx.ai**. No real email has been sent. Keep `PI_CLARIFICATION_SEND_LOCK=true`. Neither the UI, the model, client instructions nor a scope approval can remove that deployment lock.

## Open and test

From this checkout:

```sh
npm ci --include=dev
npm run build
npm run test:pi
npm run demo:pi
npm run demo:pi -- --ppo
npx playwright install --with-deps chromium
npm run test:pi:browser
```

`demo:pi` uses an in-memory database, synthetic email, a deterministic reasoner, a fake read-only Investigator and a simulated outbox. AR completes investigation → focused clarification → client response → immutable spec v1 → explicit exact-version approval → `TASK_READY` → internal handoff. PPO stops at mandatory human escalation. The command prints the complete approved task and `realEmailsSent: 0`; it fails if the expected final state is not reached.

For the UI, configure the existing Luma `APP_PASSWORD`/`PASSWORD`, then run the existing `npm run dev`. Log in, click **Cowork**, then **Test mode → Replay AR TYPE NOT POPULATED**. Select the resulting case and open thread, specifications, approvals, outbound, evidence, timeline and task tabs. Download/copy the complete task. The test workspace has a separate persistent `data/pi-clarification-demo.sqlite`; use **Open real mailbox workspace** to return to the real settings. No fixture is ever automatically used as a live model response.

PI access always requires the Luma owner JWT, even if ordinary Luma authentication is disabled. The existing app has one password-authenticated owner, not shared general-purpose reader/admin RBAC. All PI views and mutations therefore require that owner; Task Manager JWTs cannot access them. Introducing multi-user PI viewer/operator roles requires a separate authentication change. Never share the owner password as a substitute for viewer access.

## Architecture and records

- `packages/shared/src/pi-clarification.ts`: strict Zod contracts, limits, enums and cross-field validation. `pi-clarification-json.ts` exports JSON schemas for external integrations.
- `apps/server/src/pi-clarification/store.ts`: independent SQLite WAL store, foreign keys, unique mailbox/provider-message and mailbox/thread mappings, unique `(caseId,specVersion)` handoffs, append-only events and immutable spec/approval snapshots.
- `knowledge.ts`: scoped lookup of previously approved behavior with immutable evidence IDs; no inferred code facts.
- `workflow.ts`, `policy.ts`, `approval.ts`, `handoff.ts`, `orchestrator.ts`: deterministic state machine and server policy gateway. Model output proposes an enumerated action; it cannot select arbitrary recipients, mutate state, grant authorization or obtain tools.
- `gmail.ts`, `credentials.ts`, `sync.ts`, `outbox.ts`: fixed-host Gmail REST, AES-256-GCM refresh-token vault, service-side synchronization and transactional outbox.
- `runtime.ts`: versioned prompt releases, bounded schema repair, isolated JSON reasoning/investigation clients. There is **no execution of shell commands, coding CLI processes or code edits**. The protected agent is rejected by the ordinary selected-agent resolver and scheduler.
- `service.ts`: durable leases/heartbeats, exponential backoff, failed jobs/admin retry, retention/SLA maintenance, isolated deterministic replay.
- `routes.ts`: owner-authenticated APIs, callback nonce, OIDC-authenticated external push; small registration in existing server index. PI startup/shutdown does not replace schedules, sessions, messages, Tasks or Telegram.
- `apps/web/src/components/cowork/pi-clarification/PIClarification.tsx`: responsive functional Cowork UI; shared authenticated API client; five-second status polling.

All times are stored in UTC. Configured IANA timezone controls outbound business hours; SLA deadlines are stored per case. One process handles a job at a time locally; transactional leases serialize work per case across processes sharing the same local SQLite filesystem. Null-case mailbox jobs are serialized. Heartbeats extend 180-second leases. Pending jobs survive restart; a job-effects ledger commits message/decision effects with domain mutations, preventing re-execution after a crash between the commit and acknowledgment. Outbound reservations also count toward limits. Use local disk (not network filesystems); multi-host workers need a different shared transactional queue/database.

Model providers get a minimal sanitized context, whole relevant retained thread up to 30 messages, last two spec revisions, prior questions, investigation results, role IDs and policy boundaries. No Gmail addresses/credentials, raw MIME, attachments or source tree enter the provider request. Very large threads require explicit human review to ensure earlier context is not lost; the UI retains all messages. Redaction is defense in depth, not a claim of complete PHI detection.

## Gmail setup for periodic receiving

Prerequisites, not present in this checkout:

1. Confirm `admin@proimagetx.ai` is a Gmail/Google Workspace mailbox accessible by the OAuth user. If it is hosted elsewhere, a Gmail API connection will not work; an IMAP/provider adapter is additional work.
2. In a Google Cloud project enable Gmail API and configure an OAuth web client/consent screen. Register the exact `PI_GMAIL_REDIRECT_URI`, normally `https://your-luma-origin/api/cowork/pi-clarification/gmail/oauth/callback` (loopback HTTP only for local development).
3. Set `PI_GMAIL_CLIENT_ID`, `PI_GMAIL_CLIENT_SECRET`, `PI_GMAIL_REDIRECT_URI` and a durable `PI_CREDENTIAL_ENCRYPTION_KEY` (`openssl rand -hex 32`). Store secrets in the deployment secret manager/env; never paste them into chat, UI policy JSON or Git. Keep the encryption key separate from database backups. Key loss makes stored refresh tokens unrecoverable; reconnect OAuth.
4. Start Luma; **Cowork → Settings → Connect Gmail read-only**. Consent as the configured mailbox. The backend checks the returned Gmail profile address before saving the refresh token encrypted in SQLite. OAuth states are random, hashed, single use, and expire after ten minutes. Tokens never go to localStorage, UI, API responses or application logs.
5. Alternatively inject `PI_GMAIL_REFRESH_TOKEN` once with the OAuth client and encryption key. It is encrypted into SQLite on startup; remove the environment entry after successful import. This is a server-side injected-credential adapter, not password authentication.
6. Configure active PI contacts and exact workflow scopes, allowlisted senders/domains, and Gmail query/labels in settings. No real PI sender or approver list is assumed. Configure `workflowRules` such as `[{"workflow":"ar_display","subjectContains":"AR TYPE"}]` to route a multi-workflow contact; otherwise a single scoped workflow is used. Ambiguous routing blocks communication until an owner assigns a workflow in Case review. Model-selected recipients cannot grant case scope. Example contact:

```json
{
  "id": "pi-stakeholder",
  "address": "authorized-person@example.com",
  "organization": "PI",
  "canClarify": true,
  "canApproveScope": true,
  "workflows": ["ar_display"],
  "active": true,
  "verificationSource": "Administrator verified against organization directory"
}
```

7. Complete the legally reviewed data policy/provider agreements outside the software. Configure `privacyReviewed`, `providerAgreementsConfirmed` and `dataPolicyReference` only after that review. The service fails closed before live ingestion/model processing while they are missing.
8. Set `PI_CLARIFICATION_ENABLED=true`, keep mode `draft_only`, send lock `true`, kill switch `true`, dry-run `true`. Restart. Receiving runs server-side every `PI_GMAIL_POLL_SECONDS` (minimum 60; default 120) and continues with the browser closed. The manual **Poll Gmail now** button enqueues reconciliation rather than blocking a request.

The lock-default OAuth flow requests only `gmail.readonly`. `gmail.send` is requested only if a deployment administrator later removes the lock following new user authorization and reconnects. `gmail.modify` is never requested. The adapter supports optional Gmail draft creation, but normal draft-only mode stores drafts locally; no compose scope or Gmail draft write is needed for testing. If a future authorized integration uses `createDraft`, it must explicitly enable draft writes and separately obtain `gmail.compose`. Google classifies some Gmail scopes as restricted; external OAuth publishing may require verification and an independent security assessment. Review the [Gmail authorization scope guidance](https://developers.google.com/workspace/gmail/api/auth/scopes) with your security owner.

Disconnect removes local credentials and attempts Google token revocation. If revocation is unreachable the returned warning explicitly requires revoking app access in the Google account. There is no claim that a failed remote revocation succeeded.

## Optional Pub/Sub push

Configure `PI_GMAIL_PUBSUB_TOPIC=projects/PROJECT/topics/TOPIC`, topic Gmail publisher permissions, and an authenticated push subscription to `/api/webhooks/gmail-pubsub`. Set `PI_GMAIL_PUBSUB_AUDIENCE` to the exact push audience and `PI_GMAIL_PUBSUB_SERVICE_ACCOUNT` to the subscription's dedicated service account email. Google-signed RS256 OIDC tokens are verified against Google public keys, issuer, audience, expiry, exact email and email_verified. A path secret is not sufficient.

A verified notification durably queues a history sync before acknowledgment; notification history IDs never directly overwrite the persisted cursor. Duplicate/out-of-order deliveries are safe. Daily watch renewal and periodic reconciliation recover missed notifications. A history 404 captures a new cursor before bounded enumeration; a recovery exceeding 500 filtered messages stops visibly without advancing the cursor. Narrow filters and retry rather than silently losing messages. History pages are capped at ten per pass; excessive backlogs require operator intervention. See Google's [synchronization guidance](https://developers.google.com/workspace/gmail/api/guides/sync) and [authenticated push guidance](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

## Reasoner and read-only Investigator

Use the direct Anthropic option below, or set `PI_REASONER_URL` to an administrator-controlled HTTPS or loopback HTTP service implementing this JSON contract (optional bearer key in `PI_REASONER_API_KEY`):

```json
{
  "prompt": "versioned agent contract",
  "promptVersion": "sha256",
  "model": "settings model identifier",
  "context": {"case": {}, "thread": [], "specs": [], "questions": [], "investigations": [], "contactRoles": [], "policy": {}, "untrustedEvidence": true},
  "repair": null,
  "responseSchema": {"$schema": "JSON Schema draft 7"}
}
```

Respond with one strict `ClarificationDecision` object, not an envelope or Markdown. No tools are granted. Provider errors/timeouts/invalid JSON get at most two attempts (30 seconds each), then an audited failed run and durable bounded job retries. External schema semantic refinements still run server-side; JSON Schema alone cannot grant actions. No fallback to the permissive Codex/Claude/Cursor CLI is allowed. A hosted model-specific adapter or existing safe internal gateway must be configured; this PR does not invent API credentials or assert that your existing coding subscriptions expose a safe JSON API.

For investigation, set `PI_INVESTIGATOR_URL`/`PI_INVESTIGATOR_API_KEY`, configure repository identifiers, and enable investigations. The external service receives a strict `InvestigationRequest` (`permissions: read_only`) and returns a strict `InvestigationResult`. Its deployment must **actually enforce** read-only checkout/mounts, no production credentials, no network beyond approved providers, no repository writes and no unrestricted shell. Only then set `PI_INVESTIGATOR_READONLY_VERIFIED=true`. The client itself does not create such an external sandbox. Missing/unverified isolation blocks the live investigation action visibly; an owner can reopen and reason from known evidence without inventing findings. A configured but unreachable Investigator records `unavailable`, retains limitations and resumes known-evidence reasoning.

The fake demo Investigator's evidence is labeled `demo:*` and cannot authorize live work. Automatic engineering runs and external Luma Tasks creation remain disabled: the complete internal task queue and downloadable brief are the safe handoff. There is no production deployment route or release permission.

## Approvals and handoff

Approval requests are generated from the canonical immutable spec by the backend and sent only to configured contacts with `canApproveScope` for the exact workflow. Sandbox recipient inclusion is also required, even for preparing drafts. The request records version, SHA-256 digest, outbox ID, confirmed Gmail message ID and deterministic RFC Message-ID. Gmail threading preserves threadId, matching encoded Subject, In-Reply-To and References. CC is retained as context but never automatically copied into recipients. See Google's [sending guidance](https://developers.google.com/workspace/gmail/api/guides/sending).

Only an exact unquoted `APPROVE PI-YYYY-NNNN vN` or `REJECT PI-YYYY-NNNN vN` is accepted. This intentionally conservative first release rejects even `looks good`. The backend verifies active contact, workflow scope, authorized proposal recipient, Gmail-normalized sender/domain authentication evidence, same mailbox/thread, reply linkage to the actual delivered proposal, timestamp and exact digest/version. Forwarded/display-name-only approvals, old versions, quoted approvals, mismatches, silent/non-delivered drafts and unknown/inactive contacts never authorize tasks. DMARC evidence establishes authenticated sending domain; contact onboarding/source verification is separately required and is not replaced by a model's interpretation. Suspicious transport identity escalates. Conflicting approvals/rejections block handoff. Revoked contact permissions are rechecked at handoff.

Any fresh scope reply after approval conservatively returns for clarification, creates a blocked new spec version, invalidates requests and returns/cancels old handoffs. The prior approval evidence remains immutable. No brief can be republished with open questions, missing acceptance/negative tests, mismatched authorization or high risk. Narrow standing regression policies additionally require an actual historically approved spec, current authorized contact, expiry, exact workflow and allowed scope, low risk and verified Investigator reproduction evidence. High-risk changes always escalate in this release; configurable high-risk exceptions are deliberately unavailable until a multi-decision-maker review workflow exists.

A task is idempotent for `(caseId,specVersion)` and contains the complete required ImplementationTask fields. `TASK_READY` links task, case, source Gmail thread, current spec digest/version and immutable approval evidence. Deployment authorization is explicitly false. Future implementors use the owner-authenticated return-for-clarification action or a separately designed least-privilege service account integration; this feature does not grant the ordinary coding CLI PI admin credentials.

## Outbound lock, review and uncertain delivery

During all current testing keep the deployment lock true. Prepare/replay/local drafts work, but live send and Gmail draft transport methods refuse before making a network request. Settings cannot enable autonomous mode or disable kill/dry-run while locked. Pause stops live worker claiming; suspended cases do not automatically resume on replies. Kill switch stops outbound while allowing receipt/triage. No changes in this PR enable real sending.

A future, separately authorized rollout would require reconnecting with send scope, removing the deployment lock, autonomous mode, disabled dry-run/kill switch, privacy approvals, sandbox recipients and active scoped contacts. Every attempted delivery rechecks limits, contact roles, version, case state, cooldown, daily UTC quota and configured business hours. The UI can request send review, but cannot bypass policy. No outbound attachments are supported. Model completion claims are rejected because the clarification workflow has no release/test evidence.

Outbox transitions: prepared → local draft/blocked or sending → sent/uncertain. `sending` is committed before provider I/O. Network errors after a send are ambiguous; they never cause an automatic resend. **Reconcile uncertain delivery** searches Gmail sent mail by the deterministic RFC Message-ID. A match records the provider ID; no match leaves the record uncertain for manual investigation. Eventual consistency means zero matches do not prove non-delivery. Do not manually copy/resend until the mailbox has been checked by an authorized human.

## Operations and retention

Operations shows durable jobs, attempts, last errors, failed-job retry, queue counts, last successful sync, history cursor, watch expiry, prompt version and integration limitations. Case review supports draft request, escalation, suspend/reopen, rejection, close, human owner assignment and implementor questions. Invalid transitions fail visibly. Settings are versioned with audit digests; prompt releases can be rolled back by re-releasing the earlier content. Prompt edits cannot change server privileges. SLA expiry escalates waiting/blocked cases; no notification email or Telegram message is sent.

Mutable messages/outbox bodies and agent/investigation transcripts can be erased after suspending/closing/rejecting a case. Hourly maintenance applies configured retention to those terminal states. Minimal immutable spec snapshots, approval identities/evidence, internal task content and audit events remain for traceability. This is **not complete regulatory erasure**: those artifacts must be de-identified, access controlled and backed by an approved legal retention policy. Full regulated erasure/crypto-shredding of immutable artifacts requires an additional reviewed storage design. SQLite is private file mode 0600; use encrypted disks/backups because the case database is not fully encrypted. Never put PHI in case titles, task titles, Telegram, logs or prompts. Attachments are never automatically ingested into prompts or sent; role-checked safe attachment reads allow only text/plain or text/csv under 256 KB and return sanitized text.

## Migrations and rollback

`pi_migrations` v1 creates the PI tables/indexes/immutability triggers. v2 adds prompt release references and the job-effects ledger. Startup migrations are idempotent and transactional. They are separate from `messages.sqlite` and do not rewrite old Luma sessions/tasks/schedules. Back up `pi-clarification.sqlite` and its encrypted credential key securely before upgrade; use SQLite's backup API or stop workers before copying WAL files. Rollback: pause/disable the worker, restore the previous app build, retain the PI database for re-upgrade; do not attempt to drop individual workflow tables. To remove the feature entirely, disconnect/revoke Gmail first and archive/delete the entire PI database only under the approved retention process. Do not migrate a demo database into live.

## Troubleshooting and current limitations

- Not connected: supply the OAuth client, exact redirect URI and encryption key, consent as the configured mailbox. A mailbox address alone is not a credential.
- No cases: check enabled flag, paused/mode, privacy policy, Gmail query/labels and explicit sender/contact allowlists. No onboarding contacts are guessed.
- Missing permission/401: reconnect and verify enabled Gmail API and correct account. Read-only tokens cannot send. Watch/PubSub requires project IAM configuration.
- Expired cursor: bounded recovery is automatic; excessive backlog stops without cursor advancement. Narrow the mailbox filter and retry the failed job.
- Invalid approver: inspect approval verification reasons and contact workflow scope; require an actual reply to the delivered exact version.
- Duplicate notification: inspect provider IDs/work-item dedupe; do not create a second case. A changed subject does not change the Gmail-thread case mapping.
- Agent failure: configure the isolated JSON provider and correct schema; inspect failed runs/jobs and retry after fixing configuration. No shell fallback exists.
- Investigator missing: inspect the visible limitation; configure verified isolation or have an authorized human review known evidence.
- Attachment rejected: use de-identified text/CSV within limits. Images/PDFs/automatic parsing are not admitted to the model.
- No external task/PR/run: this agent publishes internal immutable briefs only. External Tasks MCP and isolated implementor dispatch are extension points, not claimed live integrations.
- No owner auth configured: PI endpoints return 503; configure the existing Luma password before viewing sensitive case data.

Before live use, external prerequisites remain: Gmail/Workspace OAuth credentials and consent; onboarded PI senders/approvers/workflow scopes; reviewed privacy/data retention policy and applicable provider BAAs; an Anthropic API key/model or isolated JSON model service/key; optionally a verified read-only Investigator; optionally Pub/Sub IAM/OIDC configuration. No external credentials or deployment were verified by the mocked tests.

### Direct Anthropic API option

A custom gateway is optional. Set `PI_REASONER_PROVIDER=anthropic`, `PI_ANTHROPIC_API_KEY` (or reuse a server-side `ANTHROPIC_API_KEY`) and `PI_REASONER_MODEL` to an API model enabled for your account. The existing model field in Cowork settings can override that model identifier. Luma calls the fixed Anthropic Messages API with a single `submit_decision` schema. It only parses the returned proposal; it never executes provider tools, shell, MCP or a coding runner. Incomplete/multiple tool blocks are rejected. This follows Anthropic's [client tool schema contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), using tool output purely as structured data. Privacy/provider policy gates apply before any real model request. OAuth coding subscriptions are not API credentials. This transport is covered by a mocked HTTP test; no live paid model request was made.

Dependency audit comparison (`npm audit --package-lock-only --include=dev`) reports the same 29 findings on the pulled base and this feature (2 low, 4 moderate, 20 high, 3 critical). Dependency remediation is an existing repository maintenance gap; this feature does not resolve it.

### Existing cluster federation and test preview

The optional `PI_GMAIL_FEDERATION_CREDENTIALS_FILE` adapter now supports PI's existing Auth0/Google Workload Identity Federation credential format. It always requests `gmail.readonly`, rejects send/draft operations at transport level, and keeps delegated tokens in memory. With incomplete privacy/contact policy, periodic synchronization performs identifier-only health checks and does not read message bodies or advance the case cursor. See [the running test preview guide](pi-clarification-test-preview.md) for the verified mailbox, access URL, release entrypoint and outstanding business-policy setup. This follow-up test release supersedes the initial report's statement that no instance was deployed; no emails have been sent.

### Production sender-restricted receive-only intake

The live installation now sets `PI_GMAIL_REQUIRED_THREAD_SENDERS=lnqcore@proimagetx.com,tanaki.reza1999@gmail.com`, `PI_CLARIFICATION_RECEIVE_ONLY=true` and `PI_CLARIFICATION_DEMO_ENABLED=false`. This supersedes the earlier metadata-only preview operating state. Explicit owner-authorized receive-only mode stores qualifying messages locally without invoking any model; it does not assert provider/privacy review. Header checks precede body retrieval, and SQLite v3 records the qualifying sender/message evidence. Sample data is removed from the live instance while regression fixtures remain isolated. See [the live inbox guide](pi-clarification-live-inbox.md) for the exact Google permission limitation, role context and real-email test procedure.


## Current Codex/Cursor worker update

The owner requested the existing Luma Codex/Cursor connection, PI repositories under `/home/pi`, implementation and PRs, and prohibited target deployment. The isolated local-worker and reviewed-summary configuration supersedes the earlier blanket receive-only/API-provider requirement. Email sending remains locked. See [local worker setup and exact limitations](pi-clarification-local-workers.md). Provider agreements are not marked confirmed; patient names/DOS are excluded from model thread context through owner-reviewed summaries. Client approver addresses are still required.
