# PI workers using the existing Luma Codex/Cursor logins

This supersedes the earlier requirement for a separately configured API reasoner. The ordinary Luma coding runner remains unsuitable for raw-email automation because it inherits broad tools and environment. The PI adapter uses the existing CLI login through a separate, isolated proposal-only process.

## Current operating boundary

- Primary worker: Codex. Cursor is supported through `PI_LOCAL_RUNNER=cursor`; both passed synthetic connectivity checks using saved login. No separate API key was added or used.
- All PI workers are protected from ordinary agent selection and scheduling: `pi-clarification`, `pi-investigator`, `pi-implementor`.
- Real mailbox intake remains restricted to threads containing an actual From message from `LNQCore@proimagetx.com` or `tanaki.reza1999@gmail.com`.
- Email sending and Gmail draft writes remain locked. Local clarification drafts can have no recipient while client identities are awaiting configuration; those records are permanently `local_only` and are never queued for Gmail delivery.
- The owner explicitly requested automatic analysis without summaries or confirmation clicks. The deployed mode is `automatic`: each eligible message supplies sanitized thread text to the isolated AI worker. Existing redaction removes recognized identifiers, credentials, quotes and unsafe markup; it is not guaranteed de-identification. Residual names/DOS or other patient information may reach the selected AI account. No model summary-review form is shown or required. Attachments and mailbox addresses remain excluded from reasoning thread context.
- Privacy-review/provider-agreement fields remain unconfirmed. Automatic processing records the actual owner instruction as its authorization reference, not a claim of institutional/provider agreement. It is gated to the isolated local runner, restricted sender threads, `draft_only`, and a deployment send lock. Clearing any of those requirements fails closed.
- Optional `reviewed_summary` mode remains available for other installations; its source digests and stale-review protections are retained. It is not used by this automatic installation.
- No PI target application deployment, merge, release, image publication, workflow dispatch or production database action is permitted.

## Architecture and enforcement

`local-runner.ts` runs Codex/Cursor inside a Bubblewrap mount/PID/user namespace with a minimal environment and a temporary home. Only runtime libraries, the CLI installation, its own login material and a scratch directory are visible. Host home, app `.env`, GitHub credentials, Kubernetes service-account tokens, cloud credentials, Docker sockets and target repositories are not mounted. Ordinary user/project configs, MCP connections and coding tools are excluded/disabled. Codex uses ephemeral sessions and structured output; Cursor uses ask mode with tool permissions denied. Raw diagnostics are not copied into events. A trusted parent persists refreshed login tokens only when the existing source login still matches the worker’s initial snapshot; changed accounts/concurrent logins are not intentionally overwritten. Scratch material is removed after completion or failure. No unrestricted fallback is attempted if isolation fails.

The read-only investigator receives bounded, filtered source excerpts at exact local origin-tracking commits. It cannot execute repository scripts. Confirmed facts must cite exact supplied references; fabricated file/commit/PR citations are rejected. Static inspection does not establish a reproduction or passing tests. Excluded paths include data, fixtures, uploads, secrets, deployment/infra files and binaries. Source may be incomplete or stale; results disclose those limitations.

The implementation worker proposes source contents only. The backend requires a verified exact-version approved handoff and the latest authorized input (automatic sanitized thread or optional reviewed summary), then creates a separate checkout. Changes outside allowed source paths, symlinks, deployment/workflow files, redacted/incompletely supplied existing files and unauthorized repositories fail. Server-configured validation commands execute in a separate namespace **without network or host credentials**, not inside the model worker. Failed or missing checks stop publication. Successful checks bind an exact source digest; subsequent edits or authorization changes invalidate publication. Artifacts remain available for owner diff review.

PR publication is a separate explicit owner action after diff review. The backend verifies that the remote base still matches the inspected commit and checks workflow triggers before any push. Unsupported automatic events, broad branch pushes and PR workflows containing deployment/credential/delegated-workflow risks block publication. Commits carry `[skip ci]`, PRs are drafts, and uncertain publication results require manual reconciliation. There is no merge/deployment action. Existing repository automation is not modified implicitly.

**Identified blocker:** PI invoicing has a staging deployment workflow triggered by `pull_request`; the publisher rejects it. Review/change that trigger separately before enabling PR publication there. Repository instructions asking for deployment never override the owner's prohibition.

## Repository setup

Run `python3 scripts/pi-clarification-repositories.py` to inventory primary PI Git directories under `/home/pi`. It de-duplicates remotes, excludes existing feature worktrees, preserves administrator settings, and writes private `data/pi-repositories.json`. This installation discovers 17 distinct repositories. Infra is inspection-only. No target checkout is changed by inventory or inspection.

Each registry entry contains an ID, canonical path, base branch, implementation flag and validation commands. Detected Python test directories receive a pytest command. This does not establish that dependencies are installed, that every test is suitable, or that a suite passed. Complete the appropriate isolated dependency/test setup for a specific approved task before publishing a PR. Missing/failed checks remain visible and block publication. Do not insert deployment, release or network commands into validation profiles. Model output and normal settings APIs cannot edit these profiles.

Snapshots use local `origin/<branch>` refs and may lag remote changes. PR publication verifies the live base SHA and rejects stale work. Refresh the relevant local origin-tracking ref and regenerate work when this happens; never silently change the approved implementation's base.

## How to test

1. Send a non-sensitive request from either allowed sender to `admin@proimagetx.ai`; wait two minutes or use Operations → Poll Gmail now.
2. Open Cowork → Cases and select the case. AI analysis starts automatically; no summary or confirmation is needed.
3. Review evidence, specifications and outbound panels for the AI decision and any local draft. Nothing is sent to Gmail. Clinical/high-risk requests can be escalated; missing details can yield a short local question.
4. Reply in the same qualifying Gmail thread. The next poll ingests it and queues another analysis automatically.
5. After verified client contacts and exact scope approval exist, publish the approved task. Generate/validate changes in an authorized repository, inspect the diff and explicitly create a draft PR. Scope approval and code review remain separate from the removed AI-input review.

Do not mistake a general request to enable implementation for approval of every incoming requirement. Client addresses and authority are still required. Reza, Mahdi and Hossein are developers, not clients. No client identities or approvals have been invented.

## Validation

Backend/integration tests cover reviewed-input isolation and invalidation, local-only drafts, safe paths, untrusted citations, workflow deployment blockers, an actual OS isolation probe, and a synthetic source change validated in a separate checkout. Live Codex and Cursor checks used synthetic `{ok:true}` inputs, with no mailbox/patient data. Existing fixture/browser tests remain separate from live mailbox records. Target application tests and real PR creation are not claimed until an approved task actually completes those steps.

Codex automation controls were checked against the [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference); these describe structured output, saved login reuse, ephemeral runs and tool configuration. OS isolation and server authorization are additional application controls.

Cursor restrictions follow its [permissions reference](https://prod.cursor.com/docs/cli/reference/permissions) and [configuration reference](https://prod.cursor.com/docs/cli/reference/configuration): explicit deny patterns, allowlist approval mode, workspace-only tool reads, and an explicit isolated config directory. Both supported CLI config locations receive the same deny policy; ordinary user permissions and MCP configuration are not reused.
