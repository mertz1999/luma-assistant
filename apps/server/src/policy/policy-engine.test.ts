import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { evaluateCredentialAccessPolicy, evaluateRunStartPolicy } from "./policy-engine.js";

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
