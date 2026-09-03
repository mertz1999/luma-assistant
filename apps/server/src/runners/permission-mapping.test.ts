import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexApprovalArgs,
  resolveClaudePermissionMode,
  resolveClaudeToolLists,
  CLAUDE_PLAN_ALLOWED_TOOLS,
  CLAUDE_PLAN_DISALLOWED_TOOLS,
  CLAUDE_READ_ONLY_ALLOWED_TOOLS,
  CLAUDE_WORKSPACE_WRITE_ALLOWED_TOOLS,
} from "./permission-mapping.js";

// -- buildCodexApprovalArgs -------------------------------------------------
// Regression coverage for the 2026-09-03 fix: `-s workspace-write -c
// approval_policy=X` deadlocks in headless `codex exec` (verified live --
// every gated command, including a plain read, was rejected outright with
// no approver present). These tests pin the substitution so a future edit
// cannot silently reintroduce that deadlock without a test failing.

test("buildCodexApprovalArgs: workspace-write substitutes --approve-for-me regardless of approvalPolicy", () => {
  for (const approvalPolicy of ["never", "on-failure", "on-request", "untrusted"] as const) {
    const args = buildCodexApprovalArgs("workspace-write", approvalPolicy);
    assert.deepEqual(args, ["--approve-for-me"]);
  }
});

test("buildCodexApprovalArgs: read-only uses the raw -s/-c form (still non-functional in headless exec on this platform, but not silently 'fixed' by guessing)", () => {
  const args = buildCodexApprovalArgs("read-only", "never");
  assert.deepEqual(args, ["-s", "read-only", "-c", 'approval_policy="never"']);
});

test("buildCodexApprovalArgs: danger-full-access uses the raw -s/-c form, untouched (verified live via the real Dalil schedule dispatch)", () => {
  const args = buildCodexApprovalArgs("danger-full-access", "never");
  assert.deepEqual(args, ["-s", "danger-full-access", "-c", 'approval_policy="never"']);
});

test("buildCodexApprovalArgs: never returns a bare --sandbox/-s flag for workspace-write (that combination is exactly what deadlocked)", () => {
  const args = buildCodexApprovalArgs("workspace-write", "never");
  assert.ok(!args.includes("-s"), "workspace-write must never emit -s (the broken form), only --approve-for-me");
});

// -- resolveClaudePermissionMode --------------------------------------------
// Regression coverage for the 2026-09-03 fix: bypassPermissions was
// previously hardcoded for every non-planMode run regardless of the
// caller's requested sandbox.

test("resolveClaudePermissionMode: planMode always wins, regardless of sandbox", () => {
  assert.equal(resolveClaudePermissionMode("danger-full-access", true), "dontAsk");
  assert.equal(resolveClaudePermissionMode("workspace-write", true), "dontAsk");
  assert.equal(resolveClaudePermissionMode("read-only", true), "dontAsk");
});

test("resolveClaudePermissionMode: danger-full-access -> bypassPermissions (explicit override, unchanged from before the fix)", () => {
  assert.equal(resolveClaudePermissionMode("danger-full-access", false), "bypassPermissions");
});

test("resolveClaudePermissionMode: workspace-write -> acceptEdits, NOT bypassPermissions (the actual defect this fixed)", () => {
  assert.equal(resolveClaudePermissionMode("workspace-write", false), "acceptEdits");
});

test("resolveClaudePermissionMode: read-only -> acceptEdits, NOT bypassPermissions", () => {
  assert.equal(resolveClaudePermissionMode("read-only", false), "acceptEdits");
});

// -- resolveClaudeToolLists --------------------------------------------------

test("resolveClaudeToolLists: planMode uses the plan-mode lists regardless of sandbox", () => {
  const lists = resolveClaudeToolLists("danger-full-access", true);
  assert.deepEqual(lists, { allowed: CLAUDE_PLAN_ALLOWED_TOOLS, disallowed: CLAUDE_PLAN_DISALLOWED_TOOLS });
});

test("resolveClaudeToolLists: danger-full-access (bypassPermissions) returns null -- bypass mode has no tool list at all", () => {
  assert.equal(resolveClaudeToolLists("danger-full-access", false), null);
});

test("resolveClaudeToolLists: read-only returns the read-only list, which excludes Write/Edit", () => {
  const lists = resolveClaudeToolLists("read-only", false);
  assert.ok(lists);
  assert.deepEqual(lists!.allowed, CLAUDE_READ_ONLY_ALLOWED_TOOLS);
  assert.ok(!lists!.allowed.includes("Write"));
  assert.ok(!lists!.allowed.includes("Edit"));
});

test("resolveClaudeToolLists: workspace-write returns the workspace-write list, which excludes git push (live-verified denied 2026-09-03)", () => {
  const lists = resolveClaudeToolLists("workspace-write", false);
  assert.ok(lists);
  assert.deepEqual(lists!.allowed, CLAUDE_WORKSPACE_WRITE_ALLOWED_TOOLS);
  assert.ok(!lists!.allowed.some((t) => t.includes("git push")), "git push must never be in the allowlist");
  assert.ok(lists!.disallowed.includes("Bash(git push:*)"), "git push must be explicit in the disallowlist (defense in depth)");
});
