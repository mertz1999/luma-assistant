# PI workers using the existing Luma Codex/Cursor logins

This supersedes the earlier requirement for a separately configured API reasoner. The ordinary Luma coding runner remains unsuitable for raw-email automation because it inherits broad tools and environment. The PI adapter uses the existing CLI login through a separate, isolated proposal-only process.

## Current operating boundary

- Primary worker: Codex. Cursor is supported through `PI_LOCAL_RUNNER=cursor`; both passed synthetic connectivity checks using saved login. No separate API key was added or used.
- All PI workers are protected from ordinary agent selection and scheduling: `pi-clarification`, `pi-investigator`, `pi-implementor`.
- Real mailbox intake remains restricted to threads containing an actual From message from `LNQCore@proimagetx.com` or `tanaki.reza1999@gmail.com`.
- Email sending and Gmail draft writes remain locked. Local clarification drafts can have no recipient while client identities are awaiting configuration; those records are permanently `local_only` and are never queued for Gmail delivery.
- Names and dates of service are treated as sensitive. The deployed model-input mode requires an owner-reviewed de-identified business summary. Raw message bodies, subjects, attachments, addresses and unreviewed specification text do not enter the reasoning thread context. Regex redaction is not a guarantee of de-identification: a human must review the summary.
- Privacy-review/provider-agreement fields remain unconfirmed. The reviewed-summary lane is an explicit, restricted workflow and does not claim that an account is approved for raw patient information. Automatic raw-email analysis requires a separately established policy/provider configuration.
- A summary is bound to a digest of the actual latest thread and specification versions. New messages or a new specification invalidate the review. Source changes while a review form is open reject the save.
- No PI target application deployment, merge, release, image publication, workflow dispatch or production database action is permitted.

## Architecture and enforcement

`local-runner.ts` runs Codex/Cursor inside a Bubblewrap mount/PID/user namespace with a minimal environment and a temporary home. Only runtime libraries, the CLI installation, its own login material and a scratch directory are visible. Host home, app `.env`, GitHub credentials, Kubernetes service-account tokens, cloud credentials, Docker sockets and target repositories are not mounted. Ordinary user/project configs, MCP connections and coding tools are excluded/disabled. Codex uses ephemeral sessions and structured output; Cursor uses ask mode with tool permissions denied. Raw diagnostics are not copied into events. A trusted parent persists refreshed login tokens only when the existing source login still matches the worker’s initial snapshot; changed accounts/concurrent logins are not intentionally overwritten. Scratch material is removed after completion or failure. No unrestricted fallback is attempted if isolation fails.

The read-only investigator receives bounded, filtered source excerpts at exact local origin-tracking commits. It cannot execute repository scripts. Confirmed facts must cite exact supplied references; fabricated file/commit/PR citations are rejected. Static inspection does not establish a reproduction or passing tests. Excluded paths include data, fixtures, uploads, secrets, deployment/infra files and binaries. Source may be incomplete or stale; results disclose those limitations.

The implementation worker proposes source contents only. The backend requires a verified exact-version approved handoff and the latest reviewed input, then creates a separate checkout. Changes outside allowed source paths, symlinks, deployment/workflow files, redacted/incompletely supplied existing files and unauthorized repositories fail. Server-configured validation commands execute in a separate namespace **without network or host credentials**, not inside the model worker. Failed or missing checks stop publication. Successful checks bind an exact source digest; subsequent edits or authorization changes invalidate publication. Artifacts remain available for owner diff review.

PR publication is a separate explicit owner action after diff review. The backend verifies that the remote base still matches the inspected commit and checks workflow triggers before any push. Unsupported automatic events, broad branch pushes and PR workflows containing deployment/credential/delegated-workflow risks block publication. Commits carry `[skip ci]`, PRs are drafts, and uncertain publication results require manual reconciliation. There is no merge/deployment action. Existing repository automation is not modified implicitly.

**Identified blocker:** PI invoicing has a staging deployment workflow triggered by `pull_request`; the publisher rejects it. Review/change that trigger separately before enabling PR publication there. Repository instructions asking for deployment never override the owner's prohibition.

## Repository setup

Run `python3 scripts/pi-clarification-repositories.py` to inventory primary PI Git directories under `/home/pi`. It de-duplicates remotes, excludes existing feature worktrees, preserves administrator settings, and writes private `data/pi-repositories.json`. This installation discovers 17 distinct repositories. Infra is inspection-only. No target checkout is changed by inventory or inspection.

Each registry entry contains an ID, canonical path, base branch, implementation flag and validation commands. Detected Python test directories receive a pytest command. This does not establish that dependencies are installed, that every test is suitable, or that a suite passed. Complete the appropriate isolated dependency/test setup for a specific approved task before publishing a PR. Missing/failed checks remain visible and block publication. Do not insert deployment, release or network commands into validation profiles. Model output and normal settings APIs cannot edit these profiles.

Snapshots use local `origin/<branch>` refs and may lag remote changes. PR publication verifies the live base SHA and rejects stale work. Refresh the relevant local origin-tracking ref and regenerate work when this happens; never silently change the approved implementation's base.

## How to test

1. Send a non-sensitive request from either allowed sender to `admin@proimagetx.ai`; wait two minutes or use Operations → Poll Gmail now.
2. Open Cowork → Cases → select the received case → review.
3. In Reviewed AI input, write the business issue and expected behavior without names, dates of service, identifiers or secrets. Review the latest thread/specification, check the confirmation, and save.
4. Click Request agent draft. Review the decision/evidence, specification and outbound panels. Any clarification is a short, local draft; nothing is sent to Gmail.
5. New messages or specifications require a new summary review. Use short generic examples when testing; no live patient input is necessary.
6. After actual client contacts and exact scope approval exist, publish the approved task. Select an authorized repository in the review panel, generate/validate changes, inspect the full diff, and explicitly create a draft PR. Unsafe workflows, stale bases, missing dependencies/checks or unapproved/high-risk scope stop the operation.

Do not mistake a general request to enable implementation for approval of every incoming requirement. Client addresses and authority are still required. Reza, Mahdi and Hossein are developers, not clients. No client identities or approvals have been invented.

## Validation

Backend/integration tests cover reviewed-input isolation and invalidation, local-only drafts, safe paths, untrusted citations, workflow deployment blockers, an actual OS isolation probe, and a synthetic source change validated in a separate checkout. Live Codex and Cursor checks used synthetic `{ok:true}` inputs, with no mailbox/patient data. Existing fixture/browser tests remain separate from live mailbox records. Target application tests and real PR creation are not claimed until an approved task actually completes those steps.

Codex automation controls were checked against the [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference); these describe structured output, saved login reuse, ephemeral runs and tool configuration. OS isolation and server authorization are additional application controls.

Cursor restrictions follow its [permissions reference](https://prod.cursor.com/docs/cli/reference/permissions) and [configuration reference](https://prod.cursor.com/docs/cli/reference/configuration): explicit deny patterns, allowlist approval mode, workspace-only tool reads, and an explicit isolated config directory. Both supported CLI config locations receive the same deny policy; ordinary user permissions and MCP configuration are not reused.
