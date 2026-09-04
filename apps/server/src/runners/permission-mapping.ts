import type { ApprovalPolicy, RunConfig, SandboxMode } from "@luma/shared";

/**
 * Pure runner-permission mapping, extracted out of index.ts (2026-09-04)
 * so it is unit-testable without pulling in the whole Express server on
 * import. Verified live through the real server both before and after
 * this extraction (see policy/policy-engine.ts's sibling history for the
 * same pattern) -- this module changes WHERE the logic lives, not what it
 * does.
 */

// -- FULL_MACHINE escalation ------------------------------------------------

/**
 * The one manual-only escalation: forces the effective sandbox to
 * "danger-full-access" regardless of what was separately requested,
 * reusing (not duplicating) the sandbox->runner-args mapping both
 * adapters already have for that value. This is deliberately the ONLY
 * thing FULL_MACHINE changes about the runner-args side -- the project-
 * workspace-binding bypass is a separate, policy-layer decision (see
 * RunManager.startRun), not something this pure function knows about.
 */
export function resolveEffectiveSandbox(sandbox: SandboxMode, permissionProfile: "FULL_MACHINE" | undefined): SandboxMode {
  return permissionProfile === "FULL_MACHINE" ? "danger-full-access" : sandbox;
}

// -- Codex --------------------------------------------------------------

/**
 * On this Codex build (0.151.0) / Windows host, `-s workspace-write -c
 * approval_policy=<never|on-failure|on-request>` deadlocks in headless
 * `codex exec`: there is no interactive channel to grant an approval, so
 * EVERY gated command is rejected outright ("blocked by policy") -- even a
 * plain file read. Verified empirically 2026-09-03 against a throwaway
 * workspace (C:\projects\luma-permission-diagnostics) across all three
 * approval_policy values; `read-only` fails the same way and has no
 * documented workaround. Codex's own `--approve-for-me` flag ("route
 * approval requests through automatic review using the workspace-write
 * sandbox") is the CLI's documented headless-safe equivalent, and was
 * verified end-to-end: read/write/git/subprocess all succeeded. `-s`/
 * `--sandbox` cannot be combined with `--approve-for-me` (the CLI itself
 * rejects that combination), so this substitutes the whole sandbox/approval
 * arg pair rather than adding a flag alongside the broken ones.
 *
 * CORRECTED 2026-09-03 (evening) -- an earlier version of this comment
 * claimed `--approve-for-me` provides real filesystem write-confinement
 * to the workspace, just not network isolation. That was wrong and has
 * been directly disproven: live-tested against two throwaway directories
 * (A as -C workspace, B a sibling), a Codex run under `--approve-for-me`
 * successfully wrote a file into B via BOTH a relative path
 * (`../B/file.txt`) and an absolute path (`C:\...\B\file.txt`) -- no
 * error, no denial, real file on disk. The same test against Claude's
 * `acceptEdits` + workspace-write allowlist (below) had an identical
 * result: the Write tool has no path-boundary check of its own; the
 * allowlist controls which TOOLS run, not WHERE a permitted tool writes.
 *
 * Honest, verified conclusion: on this machine (Windows, Codex CLI
 * 0.151.0, Claude Code 2.1.259), NEITHER runner's "workspace-write"
 * profile provides real OS-level filesystem or network confinement.
 * "workspace-write" vs "danger-full-access" differ in practice only in
 * (a) whether `-C`/cwd is set to the intended project directory, (b) for
 * Claude, which specific tool NAMES are pre-approved, and (c) audit
 * labeling -- not in what either runner can actually reach once invoked.
 * The real boundary that has held in every observed run so far is
 * prompt-level self-restraint (the AGENT.md's own "never touch files
 * outside <workspace>" instruction), not a mechanical one. This is a
 * platform/tooling limitation, not something fixable inside Luma without
 * real OS-level sandboxing (Windows Job Objects/AppContainer or an
 * external sandbox like Windows Sandbox) -- a materially larger,
 * separately-authorized undertaking, not a bounded fix. Flagged to the
 * operator; the KoraIQ weekly schedule that depended on this assumption
 * was paused pending that decision (see agents/koraiq-forward-health/
 * AGENT.md and the session's own morning report for the reasoning).
 *
 * `danger-full-access` carries no such false implication -- it is
 * accurately named and was independently verified to work (the real
 * Dalil Daily Health schedule dispatch), so Dalil's existing schedules
 * (which already use it) are not affected by this correction.
 *
 * `codex exec resume` has no `-s`/`--sandbox` or `--approve-for-me` flag
 * at all (verified via `codex exec resume --help`) -- callers on the
 * resume path do not use this function; see index.ts's resume arg branch
 * for that pre-existing, unaddressed limitation.
 */
export function buildCodexApprovalArgs(sandbox: SandboxMode, approvalPolicy: ApprovalPolicy): string[] {
  if (sandbox === "workspace-write") {
    return ["--approve-for-me"];
  }
  return ["-s", sandbox, "-c", `approval_policy=${JSON.stringify(approvalPolicy)}`];
}

// -- Claude ---------------------------------------------------------------

export const CLAUDE_PLAN_ALLOWED_TOOLS = ["Read", "Glob", "Grep"];
export const CLAUDE_PLAN_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "ExitPlanMode",
  "EnterPlanMode",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "KillShell",
  "Skill",
  "SlashCommand",
];

/**
 * Bounded, non-bypass Claude permission profiles keyed to the same
 * `sandbox` field Codex already uses -- one shared vocabulary across both
 * runners rather than a second, Claude-only concept. `--allowedTools`
 * pre-approves exactly what a project-health/engineering task needs, so
 * nothing in that set ever needs a live approval prompt (there is none in
 * headless `-p` mode -- verified 2026-09-03: with a non-bypass permission
 * mode and no approver, an unlisted tool call is denied outright,
 * `permission_denials` populated, no prompt/hang). `--disallowedTools` is
 * defense in depth for the highest-risk surface, not the primary control
 * (omission from the allowlist already denies it) -- kept explicit so the
 * boundary is self-documenting in the spawned command line and in the
 * audit trail, not just an absence.
 *
 * These allowlists control WHICH TOOLS run (e.g. Write is absent from
 * the read-only list below), never WHERE a permitted tool is allowed to
 * write. Live-tested 2026-09-03: Claude's Write tool under the
 * workspace-write list happily wrote outside the declared workspace via
 * both a relative and an absolute path, `permission_denials: []` --
 * there is no path-boundary enforcement here, same gap as Codex's
 * `--approve-for-me` above. Read this file's Codex section for the full
 * finding; it applies to both runners identically.
 */
export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git branch:*)", "Bash(git rev-parse:*)"];
export const CLAUDE_READ_ONLY_DISALLOWED_TOOLS = ["Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];

export const CLAUDE_WORKSPACE_WRITE_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git branch:*)",
  "Bash(git rev-parse:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(npm run:*)",
  "Bash(npm test:*)",
  "Bash(npm ci:*)",
  "Bash(node:*)",
  "Bash(npx:*)",
  "Bash(python:*)",
  "Bash(python3:*)",
];
export const CLAUDE_WORKSPACE_WRITE_DISALLOWED_TOOLS = ["Bash(git push:*)", "Bash(git reset --hard:*)", "Bash(git clean:*)", "Bash(git checkout --:*)", "Bash(gh:*)", "WebFetch", "WebSearch"];

export type ClaudePermissionMode = "dontAsk" | "bypassPermissions" | "acceptEdits";

/**
 * Permission mode follows the SAME `sandbox` choice Codex already uses,
 * rather than an unconditional bypass -- verified 2026-09-03:
 * `bypassPermissions` was previously hardcoded for every non-planMode
 * run regardless of the caller's requested sandbox, which made `sandbox`
 * meaningless for the Claude runner even though it was faithfully
 * recorded and enforced for Codex. `danger-full-access` is preserved
 * exactly as an explicit, caller-chosen override -- it is never selected
 * merely because no sandbox was specified, since `sandbox` has no such
 * silent fallback in runConfigSchema (the caller/schedule must say so).
 */
export function resolveClaudePermissionMode(sandbox: SandboxMode, planMode: boolean): ClaudePermissionMode {
  if (planMode) return "dontAsk";
  if (sandbox === "danger-full-access") return "bypassPermissions";
  return "acceptEdits";
}

/**
 * The --allowedTools/--disallowedTools pair for the resolved permission
 * mode, or null when the mode needs neither (bypassPermissions has no
 * tool list at all -- everything is allowed).
 */
export function resolveClaudeToolLists(sandbox: SandboxMode, planMode: boolean): { allowed: string[]; disallowed: string[] } | null {
  if (planMode) {
    return { allowed: CLAUDE_PLAN_ALLOWED_TOOLS, disallowed: CLAUDE_PLAN_DISALLOWED_TOOLS };
  }
  if (resolveClaudePermissionMode(sandbox, planMode) !== "acceptEdits") {
    return null;
  }
  return sandbox === "read-only"
    ? { allowed: CLAUDE_READ_ONLY_ALLOWED_TOOLS, disallowed: CLAUDE_READ_ONLY_DISALLOWED_TOOLS }
    : { allowed: CLAUDE_WORKSPACE_WRITE_ALLOWED_TOOLS, disallowed: CLAUDE_WORKSPACE_WRITE_DISALLOWED_TOOLS };
}
