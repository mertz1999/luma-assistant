import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBrowserActionPolicy, type BrowserPolicyInput } from "./browser-policy.js";

function input(overrides: Partial<BrowserPolicyInput> & Pick<BrowserPolicyInput, "action">): BrowserPolicyInput {
  return { grantedTier: "READ_ONLY_BROWSER", isScheduled: false, ...overrides };
}

test("read-only action is ALLOWED with only READ_ONLY_BROWSER granted", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "navigate_public" }));
  assert.equal(result.decision, "ALLOW");
});

test("all five READ_ONLY_BROWSER actions are allowed unattended with READ_ONLY_BROWSER granted", () => {
  for (const action of ["navigate_public", "inspect_dom", "capture_screenshot", "inspect_console", "inspect_network"] as const) {
    const result = evaluateBrowserActionPolicy(input({ action, isScheduled: true }));
    assert.equal(result.decision, "ALLOW", `expected ${action} to be ALLOW`);
  }
});

test("authenticated-read action is DENIED when only READ_ONLY_BROWSER is granted", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "read_authenticated_page" }));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "insufficient-tier");
});

test("authenticated-read action is ALLOWED when AUTHENTICATED_READ is granted", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "read_authenticated_page", grantedTier: "AUTHENTICATED_READ" }));
  assert.equal(result.decision, "ALLOW");
});

test("form_submit REQUIRES_APPROVAL even with BROWSER_WRITE granted, absent explicit operator authorization", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "form_submit", grantedTier: "BROWSER_WRITE" }));
  assert.equal(result.decision, "REQUIRE_APPROVAL");
  assert.equal(result.rule, "write-requires-operator-authorization");
});

test("form_submit is ALLOWED only with BROWSER_WRITE granted AND explicit operator authorization", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "form_submit", grantedTier: "BROWSER_WRITE", operatorAuthorized: true }));
  assert.equal(result.decision, "ALLOW");
});

test("form_submit is DENIED with BROWSER_WRITE granted but the request is scheduled/unattended", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "form_submit", grantedTier: "BROWSER_WRITE", operatorAuthorized: true, isScheduled: true }));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "scheduler-read-only-only");
});

test("account_change is permanently DENIED even with BROWSER_WRITE granted and operator authorization", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "account_change", grantedTier: "BROWSER_WRITE", operatorAuthorized: true }));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "permanently-gated-action");
});

test("captcha_workflow is permanently DENIED even with BROWSER_WRITE granted and operator authorization", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "captcha_workflow", grantedTier: "BROWSER_WRITE", operatorAuthorized: true }));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "permanently-gated-action");
});

test("unknown/unconfigured permission tier is DENIED, never guessed", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "navigate_public", grantedTier: null }));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "unknown-permission-tier");
});

test("an unrecognized action category is DENIED (fail closed on unclassified input)", () => {
  const result = evaluateBrowserActionPolicy(input({ action: "totally_made_up_action" as never, grantedTier: "BROWSER_WRITE", operatorAuthorized: true }));
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "unclassified-action");
});

test("proxy_change and profile_import require operator authorization even with BROWSER_WRITE (no auto-escalation)", () => {
  for (const action of ["proxy_change", "profile_import"] as const) {
    const result = evaluateBrowserActionPolicy(input({ action, grantedTier: "BROWSER_WRITE" }));
    assert.equal(result.decision, "REQUIRE_APPROVAL", `expected ${action} to require approval`);
  }
});
