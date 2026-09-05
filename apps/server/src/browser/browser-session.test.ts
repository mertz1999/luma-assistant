import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createBrowserSessionIdentity, isSessionUsableByProject, projectIdForWorkspace } from "./browser-session.js";

test("a session is usable by the project that created it", () => {
  const workspace = path.join(os.tmpdir(), "luma-browser-test-project-a");
  const session = createBrowserSessionIdentity(workspace, "READ_ONLY_BROWSER");
  assert.equal(isSessionUsableByProject(session, session.projectId), true);
});

test("a session is NOT usable by a different project (cross-project isolation)", () => {
  const workspaceA = path.join(os.tmpdir(), "luma-browser-test-project-a");
  const workspaceB = path.join(os.tmpdir(), "luma-browser-test-project-b");
  const session = createBrowserSessionIdentity(workspaceA, "READ_ONLY_BROWSER");
  const otherProjectId = projectIdForWorkspace(workspaceB);
  assert.notEqual(session.projectId, otherProjectId);
  assert.equal(isSessionUsableByProject(session, otherProjectId), false);
});

test("a session is NOT usable when the requesting project id is unknown/null (fail closed)", () => {
  const workspace = path.join(os.tmpdir(), "luma-browser-test-project-a");
  const session = createBrowserSessionIdentity(workspace, "READ_ONLY_BROWSER");
  assert.equal(isSessionUsableByProject(session, null), false);
  assert.equal(isSessionUsableByProject(session, undefined), false);
  assert.equal(isSessionUsableByProject(session, ""), false);
});

test("two sessions created for the same workspace get distinct session ids", () => {
  const workspace = path.join(os.tmpdir(), "luma-browser-test-project-a");
  const s1 = createBrowserSessionIdentity(workspace, "READ_ONLY_BROWSER");
  const s2 = createBrowserSessionIdentity(workspace, "READ_ONLY_BROWSER");
  assert.notEqual(s1.browserSessionId, s2.browserSessionId);
  assert.equal(s1.projectId, s2.projectId);
});

test("projectIdForWorkspace is deterministic for the same path", () => {
  const workspace = path.join(os.tmpdir(), "luma-browser-test-project-a");
  assert.equal(projectIdForWorkspace(workspace), projectIdForWorkspace(workspace));
});
