import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateBrowserActionPolicy } from "./browser-policy.js";
import { createBrowserSessionIdentity, projectIdForWorkspace } from "./browser-session.js";
import { isAvailable, getCapabilities, navigatePublic, inspectDom, captureScreenshot, readAuthenticatedPage, closeSession } from "./browseract-adapter.js";

// This host does not have browser-act installed (verified separately via
// `where browser-act` / npm registry lookup during the integration work) --
// these tests deliberately exercise the "capability absent" path, which is
// the real, honest state of this environment, rather than mocking presence.

let tmpAuditDir: string;
test.before(() => {
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-browser-audit-"));
});
test.after(() => {
  fs.rmSync(tmpAuditDir, { recursive: true, force: true });
});

function readAuditLines(): unknown[] {
  const file = path.join(tmpAuditDir, "audit.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test("isAvailable() reports false when browser-act is not on PATH (this host's real state)", () => {
  assert.equal(isAvailable(), false);
});

test("getCapabilities() reports unavailable without spawning anything, when browser-act is absent", async () => {
  const caps = await getCapabilities();
  assert.equal(caps.available, false);
  assert.equal(caps.version, null);
  assert.equal(caps.screenshotSupport, "unconfirmed");
});

test("navigatePublic returns BROWSER_CAPABILITY_UNAVAILABLE (not a crash/throw) when browser-act is absent, given an ALLOW policy decision", async () => {
  const workspace = path.join(os.tmpdir(), "luma-browser-test-ws");
  const session = createBrowserSessionIdentity(workspace, "READ_ONLY_BROWSER");
  const policyDecision = evaluateBrowserActionPolicy({ action: "navigate_public", grantedTier: "READ_ONLY_BROWSER", isScheduled: false });
  const result = await navigatePublic({
    action: "navigate_public",
    url: "https://dalilfinance.app",
    policyDecision,
    session,
    requestingProjectId: session.projectId,
    auditDir: tmpAuditDir,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "BROWSER_CAPABILITY_UNAVAILABLE");
});

test("inspectDom is blocked with POLICY_NOT_ALLOWED when the policy decision itself was DENY", async () => {
  const workspace = path.join(os.tmpdir(), "luma-browser-test-ws");
  const session = createBrowserSessionIdentity(workspace, "READ_ONLY_BROWSER");
  const policyDecision = evaluateBrowserActionPolicy({ action: "inspect_dom", grantedTier: null, isScheduled: false });
  assert.equal(policyDecision.decision, "DENY");
  const result = await inspectDom({ action: "inspect_dom", policyDecision, session, requestingProjectId: session.projectId, auditDir: tmpAuditDir });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "POLICY_NOT_ALLOWED");
});

test("captureScreenshot is blocked with SESSION_NOT_OWNED_BY_PROJECT when the session belongs to a different project", async () => {
  const workspaceA = path.join(os.tmpdir(), "luma-browser-test-ws-a");
  const workspaceB = path.join(os.tmpdir(), "luma-browser-test-ws-b");
  const session = createBrowserSessionIdentity(workspaceA, "READ_ONLY_BROWSER");
  const otherProjectId = projectIdForWorkspace(workspaceB);
  const policyDecision = evaluateBrowserActionPolicy({ action: "capture_screenshot", grantedTier: "READ_ONLY_BROWSER", isScheduled: false });
  const result = await captureScreenshot({ action: "capture_screenshot", policyDecision, session, requestingProjectId: otherProjectId, auditDir: tmpAuditDir });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "SESSION_NOT_OWNED_BY_PROJECT");
});

test("readAuthenticatedPage is blocked with POLICY_NOT_ALLOWED for a READ_ONLY_BROWSER session (no auth attach happened)", async () => {
  const workspace = path.join(os.tmpdir(), "luma-browser-test-ws");
  const session = createBrowserSessionIdentity(workspace, "READ_ONLY_BROWSER");
  const policyDecision = evaluateBrowserActionPolicy({ action: "read_authenticated_page", grantedTier: "AUTHENTICATED_READ", isScheduled: false });
  assert.equal(policyDecision.decision, "ALLOW");
  const result = await readAuthenticatedPage({ action: "read_authenticated_page", url: "https://dalilfinance.app/admin", policyDecision, session, requestingProjectId: session.projectId, auditDir: tmpAuditDir });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "POLICY_NOT_ALLOWED");
});

test("closeSession is blocked with SESSION_NOT_OWNED_BY_PROJECT for a cross-project close attempt", async () => {
  const workspaceA = path.join(os.tmpdir(), "luma-browser-test-ws-a");
  const workspaceB = path.join(os.tmpdir(), "luma-browser-test-ws-b");
  const session = createBrowserSessionIdentity(workspaceA, "READ_ONLY_BROWSER");
  const otherProjectId = projectIdForWorkspace(workspaceB);
  const result = await closeSession(session, otherProjectId, tmpAuditDir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "SESSION_NOT_OWNED_BY_PROJECT");
});

test("every blocked attempt in this file produced an audit event, and none contain the literal word 'password' unredacted", async () => {
  const events = readAuditLines() as Array<{ event_type: string; payload: Record<string, unknown> }>;
  assert.ok(events.length >= 5, `expected several audited blocked attempts, got ${events.length}`);
  for (const event of events) {
    assert.ok(event.event_type.startsWith("browser."));
    const serialized = JSON.stringify(event.payload);
    assert.ok(!/\bpassword\b\s*[:=]\s*\w/i.test(serialized), "audit payload must never carry a raw password-shaped value");
  }
});
