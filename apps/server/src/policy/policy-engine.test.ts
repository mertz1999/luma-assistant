import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { evaluateCredentialAccessPolicy, evaluateRunStartPolicy, evaluateProjectWorkspaceBinding } from "./policy-engine.js";

function input(workspace: string) {
  return { operation: "run.start" as const, runner: "codex", workspace, sandbox: "danger-full-access", approvalPolicy: "never" };
}

test("evaluateRunStartPolicy: denies a drive/filesystem root", () => {
  const result = evaluateRunStartPolicy(input(path.parse(process.cwd()).root));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "workspace-not-filesystem-root");
});

test("evaluateRunStartPolicy: denies a well-known OS system directory", { skip: process.platform !== "win32" }, () => {
  const result = evaluateRunStartPolicy(input("C:\\Windows"));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "workspace-not-sensitive-system-dir");
});

test("evaluateRunStartPolicy: denies a sensitive dir even with a trailing separator", { skip: process.platform !== "win32" }, () => {
  const result = evaluateRunStartPolicy(input("C:\\Windows\\"));
  assert.equal(result.decision, "DENY");
});

test("evaluateRunStartPolicy: denies the exact home directory (not a project folder inside it)", () => {
  const result = evaluateRunStartPolicy(input(os.homedir()));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "workspace-not-entire-home-directory");
});

test("evaluateRunStartPolicy: allows a real project folder inside the home directory", () => {
  const result = evaluateRunStartPolicy(input(path.join(os.homedir(), "Documents", "some-project")));
  assert.equal(result.decision, "ALLOW");
});

test("evaluateRunStartPolicy: allows a normal, unrelated project path (regression sanity check against this very repo's own workspace)", () => {
  const result = evaluateRunStartPolicy(input(process.cwd()));
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.rule, "default-allow");
});

test("evaluateRunStartPolicy: allows a temp-directory workspace, the shape this session's own runtime-verification runs actually use", () => {
  const result = evaluateRunStartPolicy(input(path.join(os.tmpdir(), "some-run-workspace")));
  assert.equal(result.decision, "ALLOW");
});

test("evaluateCredentialAccessPolicy: unknown credential (no metadata) is denied", () => {
  const result = evaluateCredentialAccessPolicy({
    requestingProjectId: "proj_a",
    adapter: "codex",
    credentialId: "cred_missing",
    credentialMetadata: null,
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "unknown-credential");
});

test("evaluateCredentialAccessPolicy: cross-project access is denied even with a valid credential and adapter", () => {
  const result = evaluateCredentialAccessPolicy({
    requestingProjectId: "proj_b",
    adapter: "codex",
    credentialId: "cred_a1",
    credentialMetadata: { projectId: "proj_a", allowedAdapters: ["codex"] },
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "cross-project-credential-access");
});

test("evaluateCredentialAccessPolicy: same project, adapter not in allowedAdapters is denied", () => {
  const result = evaluateCredentialAccessPolicy({
    requestingProjectId: "proj_a",
    adapter: "claude",
    credentialId: "cred_a1",
    credentialMetadata: { projectId: "proj_a", allowedAdapters: ["codex"] },
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "adapter-not-permitted");
});

test("evaluateCredentialAccessPolicy: same project, allowed adapter is allowed", () => {
  const result = evaluateCredentialAccessPolicy({
    requestingProjectId: "proj_a",
    adapter: "codex",
    credentialId: "cred_a1",
    credentialMetadata: { projectId: "proj_a", allowedAdapters: ["codex", "claude"] },
  });
  assert.equal(result.decision, "ALLOW");
});

// -- evaluateProjectWorkspaceBinding --------------------------------------
// Closes the cross-project defect found 2026-09-03: a "KoraIQ" mission/run
// could declare workspace C:/Dalilfinance and evaluateRunStartPolicy (above)
// would ALLOW it -- that function only ever asks "is this path a system
// dir," never "is this project authorized for this path." These tests
// operate on already-canonicalized strings (the function is pure and does
// no filesystem I/O itself -- canonicalization is the caller's job in
// index.ts via fs.realpathSync.native), matching this file's existing style
// of testing the pure decision logic directly. Forward slashes are used
// throughout (node:path's win32 implementation accepts them identically to
// backslashes) purely to keep these literals simple and unambiguous.

test("evaluateProjectWorkspaceBinding: no project declared -> legacy ALLOW (backward compat, workspace-only path still applies elsewhere)", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: null,
    requestedWorkspace: "C:/Dalilfinance",
    authorizedWorkspace: null,
  });
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.rule, "no-project-declared-legacy");
});

test("evaluateProjectWorkspaceBinding: KoraIQ project + KoraIQ workspace -> ALLOW", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: "botolaiq",
    requestedWorkspace: "C:/BotolaIQ",
    authorizedWorkspace: "C:/BotolaIQ",
  });
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.rule, "project-workspace-match");
});

test("evaluateProjectWorkspaceBinding: KoraIQ project + descendant subfolder -> ALLOW", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: "botolaiq",
    requestedWorkspace: "C:/BotolaIQ/trainer",
    authorizedWorkspace: "C:/BotolaIQ",
  });
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.rule, "project-workspace-match");
});

test("evaluateProjectWorkspaceBinding: KoraIQ project + Dalil workspace -> DENY (the original defect, now closed)", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: "botolaiq",
    requestedWorkspace: "C:/Dalilfinance",
    authorizedWorkspace: "C:/BotolaIQ",
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "cross-project-workspace");
});

test("evaluateProjectWorkspaceBinding: Dalil project + Dalil workspace -> ALLOW", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: "dalilfinance",
    requestedWorkspace: "C:/Dalilfinance",
    authorizedWorkspace: "C:/Dalilfinance",
  });
  assert.equal(result.decision, "ALLOW");
});

test("evaluateProjectWorkspaceBinding: Dalil project + KoraIQ workspace -> DENY (reverse direction)", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: "dalilfinance",
    requestedWorkspace: "C:/BotolaIQ",
    authorizedWorkspace: "C:/Dalilfinance",
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "cross-project-workspace");
});

test("evaluateProjectWorkspaceBinding: unknown/unregistered project -> DENY (fail closed, never silently allowed)", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: "totally-unregistered-project",
    requestedWorkspace: "C:/BotolaIQ",
    authorizedWorkspace: null,
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "unknown-project");
});

test("evaluateProjectWorkspaceBinding: prefix collision -- 'C:/BotolaIQ2' is NOT a descendant of 'C:/BotolaIQ' (naive startsWith would wrongly allow this)", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: "botolaiq",
    requestedWorkspace: "C:/BotolaIQ2",
    authorizedWorkspace: "C:/BotolaIQ",
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "cross-project-workspace");
});

test("evaluateProjectWorkspaceBinding: sibling-prefix collision -- 'C:/BotolaIQ-evil' is NOT a descendant of 'C:/BotolaIQ'", () => {
  const result = evaluateProjectWorkspaceBinding({
    projectId: "botolaiq",
    requestedWorkspace: "C:/BotolaIQ-evil",
    authorizedWorkspace: "C:/BotolaIQ",
  });
  assert.equal(result.decision, "DENY");
});

test("evaluateProjectWorkspaceBinding: traversal that lexically collapses back to the authorized workspace -> ALLOW (path.resolve/realpath already normalizes '..' before this function ever sees it)", () => {
  // Simulates what the caller's canonicalizePath() would have already
  // produced for "C:/BotolaIQ/trainer/..": the lexical/real result IS
  // "C:/BotolaIQ", so this function correctly allows it -- it is not a
  // traversal *escape*, just a verbose way of writing the same root.
  const result = evaluateProjectWorkspaceBinding({
    projectId: "botolaiq",
    requestedWorkspace: "C:/BotolaIQ",
    authorizedWorkspace: "C:/BotolaIQ",
  });
  assert.equal(result.decision, "ALLOW");
});

test("evaluateProjectWorkspaceBinding: traversal that escapes the authorized workspace -> DENY", () => {
  // "C:/BotolaIQ/../Dalilfinance" canonicalizes to "C:/Dalilfinance" --
  // a real cross-project escape via traversal syntax, correctly denied.
  const result = evaluateProjectWorkspaceBinding({
    projectId: "botolaiq",
    requestedWorkspace: "C:/Dalilfinance",
    authorizedWorkspace: "C:/BotolaIQ",
  });
  assert.equal(result.decision, "DENY");
});

test("evaluateProjectWorkspaceBinding: case-variant paths that canonicalize to the same real path -> ALLOW", () => {
  // The caller is responsible for canonicalizing case via
  // fs.realpathSync.native before calling this function; once both sides
  // are canonicalized to the same on-disk casing, plain equality holds.
  const result = evaluateProjectWorkspaceBinding({
    projectId: "botolaiq",
    requestedWorkspace: "C:/BotolaIQ",
    authorizedWorkspace: "C:/BotolaIQ",
  });
  assert.equal(result.decision, "ALLOW");
});
