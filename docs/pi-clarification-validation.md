# PI Clarification validation — November 1, 2026

Base: origin/main `85b7a0f`. Feature: `feature/pi-clarification-test-mode`.

| Check | Actual result |
| --- | --- |
| `npm run test:pi` | 55 tests passed; zero failures/skips. |
| `npm run typecheck` | Passed across shared, server, web, Telegram MCP, Task Manager MCP and Image MCP. |
| `npm run build` | Passed across all six workspaces. |
| `npm run demo:pi` | AR case reached HANDED_OFF with exact-version approval and complete internal task; realEmailsSent = 0. |
| `npm run demo:pi -- --ppo` | PPO case reached ESCALATED; no handoff; realEmailsSent = 0. |
| `PI_BROWSER_CHANNEL=chrome npm run test:pi:browser` | Three Playwright tests passed. Fresh isolated app/fixture root; live worker disabled; no Gmail credentials. |
| `git diff --check` | Passed. |
| Dependency audit | Base and feature each have 29 findings with dev dependencies included: 2 low, 4 moderate, 20 high, 3 critical. No claim that inherited dependency findings were remediated. |

Backend coverage includes deduplication/conversation continuity, unknown/automatic/outbound filtering, investigation failure, strict model schema/timeout retries, scope/digest/contact approval verification, forwarded/quoted/old/ambiguous/rejected approvals, conflicting decisions, immutable versions, scope reopening, historical standing authorization and reproduction checks, risk escalation, MIME threading, recipients/quotas/cooldown/business hours/kill switch, transport lock, uncertain-send reconciliation without duplicate sends, durable leases/restart effects, expired cursor/recovery bounds/watch renewal, encrypted tokens/OAuth state, OIDC signature/audience/identity verification, owner-authenticated routes, source-scope routing, bounded attachments, retention, and new-message invalidation of in-flight reasoning/queued handoffs.

Browser coverage includes missing credential feedback, locked autonomous settings, both deterministic scenarios, task download, all eight case tabs at 390px mobile width with no horizontal overflow, and navigation back to existing Agents and Code modes. Manual browser verification also exercised the same desktop/mobile views. This is not a claim of exhaustive regression coverage for every pre-existing Luma feature.

Known build notices: the existing main web bundle exceeds Vite's 500 KB advisory; Cowork is lazy-loaded. Browserslist data is old. These notices do not fail compilation.

Not verified live: Google OAuth consent, actual Gmail reads/watch/push or sends, paid model requests, PI contact identities, external Investigator isolation, external Tasks publishing, production patient data or deployment. Those require the prerequisites in the operations guide. No real client mail was sent, no existing installed app was replaced, and no production deployment was performed.

## Authorized test-instance follow-up

After the user authorized running a test instance and using the cluster email credentials, the feature gained a read-only Auth0/Google federation adapter and was released at https://pi-clarification-test.deepspring.co through `make release-manual`. A live Gmail profile check verified admin@proimagetx.ai with gmail.readonly; periodic profile/identifier-only checks report actual successful sync health. No email body or attachment was fetched for case processing, no live email was sent, and no paid model request was made. Privacy and authorized-contact gates remain closed until configured.

Updated checks: 58 backend/integration tests passed, all-workspace typecheck/build passed, three repository Playwright tests passed. An additional public-URL smoke verified existing-password login, Cowork send lock, real federation settings, mocked approved AR task, and mobile layout with zero page errors after configuring the active workspace. Kubernetes preview networking allows only the ingress controller to reach the isolated ports. The launcher regression test verifies that inherited PM2 internal fields cannot replace another application's identity.

## Sender-restricted production inbox follow-up

The live instance now enforces an actual From=LNQCore@proimagetx.com message in the Gmail thread before fetching bodies, with case-insensitive exact matching, persisted SQLite v3 eligibility evidence, recovery/known-thread checks, and transport-level guards for message/attachment/reply operations. Receive-only intake stores eligible conversations locally without model calls; sent-mail context does not enqueue replies. Demo mode is disabled, demo API routes reject access, and the separate sample database was removed. The effective prompt now contains the owner-provided developer/client roles.

Validation: **67 backend/integration tests passed**, all-workspace typechecks/build passed, and the three development browser tests passed with isolated fixtures. The public production-inbox browser/API check verified sender/receive-only settings cannot be loosened through the settings API, replay/demo access is rejected, no sample database/cases remain, the effective prompt includes the requested names, mobile has no horizontal overflow, and there are zero page errors. Real Gmail sender-filtered discovery currently returned zero matching inbox identifiers from the last 30 days; a live matching email must still be supplied by the user to exercise real-message ingestion. No email was sent by the assistant. Google credentials remain mailbox-wide read-only; sender/thread isolation is enforced by the application rather than by a sender-specific Google scope.

## Additional allowed sender (2026-11-01)

The live intake list now accepts either `lnqcore@proimagetx.com` or `tanaki.reza1999@gmail.com`. Exact From checks apply to both throughout discovery, header admission, transport reads, and durable eligibility. Discovery uses Gmail's OR group, not an AND. The deployment list overrides legacy single-sender configuration, validates addresses, and remains locked against settings edits. Reza remains a developer, without client approval authority.

All 69 backend/integration tests pass, including both independent qualifying senders, excluded CC-only threads, participant replies, policy-change invalidation, normalized configuration and malformed deployment lists. All workspace type checks pass. Release and live API verification use the existing receive-only mailbox; outbound sending and draft writes remain disabled.
