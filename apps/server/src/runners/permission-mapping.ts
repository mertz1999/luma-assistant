import type { ApprovalPolicy, RunConfig, SandboxMode } from "@luma/shared";

/**
 * Pure runner-permission mapping, extracted out of index.ts (2026-09-04)
 * so it is unit-testable without pulling in the whole Express server on
 * import. Verified live through the real server both before and after
 * this extraction (see policy/policy-engine.ts's sibling history for the
 * same pattern) -- this module changes WHERE the logic lives, not what it
 * does.
 */

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
 * Important caveat, reported honestly rather than silently assumed away:
 * `--approve-for-me` does NOT provide network isolation on this build --
 * a real HTTP GET succeeded under it in the same diagnostic session. A
 * caller choosing workspace-write for network isolation (rather than for
 * write-confinement) is not actually getting that from this substitution;
 * only `read-only` (currently non-functional here in headless exec) would.
 * `danger-full-access` is untouched -- it needs no approval channel at
 * all and was independently verified to work (the real Dalil Daily Health
 * schedule dispatch).
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
