/**
 * Deterministic browser-action policy engine for the optional BrowserAct
 * adapter (see browseract-adapter.ts). Mirrors policy/policy-engine.ts's
 * shape (ALLOW/DENY/REQUIRE_APPROVAL, {decision, reason, rule}) on purpose
 * -- this is the same "security decisions are plain code, not a model
 * call" principle applied to a second capability, not a competing one.
 *
 * Core principle (per the integration brief): BrowserAct is a tool
 * provider. Luma remains the sole authority over what any given
 * mission/project may do with it -- this file IS that authority for
 * browser actions. Every function here is pure: no filesystem, no process
 * spawn, no network call, so it is trivially unit-testable and cannot
 * itself introduce a side effect a test would miss.
 */

export type BrowserPermissionTier = "READ_ONLY_BROWSER" | "AUTHENTICATED_READ" | "BROWSER_WRITE";

/**
 * Every action BrowserAct (or any future browser provider) can be asked to
 * perform, classified once, here, independent of which provider sits
 * behind the adapter. An action absent from ACTION_TIER is UNCLASSIFIED
 * and therefore always denied (fail-closed) -- never silently treated as
 * read-only just because it's unrecognized.
 */
export type BrowserActionCategory =
  | "navigate_public"
  | "inspect_dom"
  | "capture_screenshot"
  | "inspect_console"
  | "inspect_network"
  | "attach_authenticated_session"
  | "read_authenticated_page"
  | "form_submit"
  | "file_upload"
  | "account_change"
  | "publish_action"
  | "delete_action"
  | "send_action"
  | "approve_action"
  | "configure_action"
  | "profile_import"
  | "proxy_change"
  | "captcha_workflow";

const ACTION_TIER: Record<BrowserActionCategory, BrowserPermissionTier> = {
  navigate_public: "READ_ONLY_BROWSER",
  inspect_dom: "READ_ONLY_BROWSER",
  capture_screenshot: "READ_ONLY_BROWSER",
  inspect_console: "READ_ONLY_BROWSER",
  inspect_network: "READ_ONLY_BROWSER",
  attach_authenticated_session: "AUTHENTICATED_READ",
  read_authenticated_page: "AUTHENTICATED_READ",
  form_submit: "BROWSER_WRITE",
  file_upload: "BROWSER_WRITE",
  account_change: "BROWSER_WRITE",
  publish_action: "BROWSER_WRITE",
  delete_action: "BROWSER_WRITE",
  send_action: "BROWSER_WRITE",
  approve_action: "BROWSER_WRITE",
  configure_action: "BROWSER_WRITE",
  profile_import: "BROWSER_WRITE",
  proxy_change: "BROWSER_WRITE",
  captcha_workflow: "BROWSER_WRITE",
};

const TIER_RANK: Record<BrowserPermissionTier, number> = {
  READ_ONLY_BROWSER: 0,
  AUTHENTICATED_READ: 1,
  BROWSER_WRITE: 2,
};

/**
 * Permanently gated regardless of permission tier or operator
 * authorization at the tier level -- these two categories (account
 * security changes, and CAPTCHA/verification workarounds) are not
 * something this adapter will ever run through a generic "write" path,
 * matching the brief's explicit denial list. There is deliberately no
 * `operatorAuthorized` escape hatch for these two; a route that genuinely
 * needs one is a separate, explicitly-designed feature, not a flag on
 * this function.
 */
const PERMANENTLY_GATED: ReadonlySet<BrowserActionCategory> = new Set(["account_change", "captcha_workflow"]);

export interface BrowserPolicyInput {
  action: BrowserActionCategory;
  /** Permission tier this project is configured for. null/undefined = not configured -> deny (fail closed, never guessed). */
  grantedTier: BrowserPermissionTier | null | undefined;
  /** True only for a scheduled/unattended mission (never an interactive operator session). */
  isScheduled: boolean;
  /**
   * True only when an operator has explicitly authorized THIS action
   * out-of-band. Never set by a model/mission itself -- there is no
   * parameter path from mission input to this flag; only an explicit,
   * separate operator-facing call site may pass true (Phase 21: no
   * self-escalation).
   */
  operatorAuthorized?: boolean;
}

export interface BrowserPolicyDecision {
  decision: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  reason: string;
  rule: string;
}

export function evaluateBrowserActionPolicy(input: BrowserPolicyInput): BrowserPolicyDecision {
  const requiredTier = ACTION_TIER[input.action];
  if (!requiredTier) {
    return {
      decision: "DENY",
      rule: "unclassified-action",
      reason: `Action "${input.action}" is not a recognized browser-action category; unclassified actions are always denied.`,
    };
  }

  if (PERMANENTLY_GATED.has(input.action)) {
    return {
      decision: "DENY",
      rule: "permanently-gated-action",
      reason: `Action "${input.action}" is permanently gated for this adapter and cannot be authorized through the generic permission path.`,
    };
  }

  if (input.isScheduled && requiredTier !== "READ_ONLY_BROWSER") {
    return {
      decision: "DENY",
      rule: "scheduler-read-only-only",
      reason: `Scheduled/unattended missions may only perform READ_ONLY_BROWSER actions; "${input.action}" requires ${requiredTier}.`,
    };
  }

  if (!input.grantedTier) {
    return {
      decision: "DENY",
      rule: "unknown-permission-tier",
      reason: "No browser permission tier is configured for this project; ambiguous permission state is always denied, never guessed.",
    };
  }

  if (TIER_RANK[input.grantedTier] < TIER_RANK[requiredTier]) {
    return {
      decision: "DENY",
      rule: "insufficient-tier",
      reason: `Action "${input.action}" requires ${requiredTier}; this project is only granted ${input.grantedTier}.`,
    };
  }

  if (requiredTier === "BROWSER_WRITE" && !input.operatorAuthorized) {
    return {
      decision: "REQUIRE_APPROVAL",
      rule: "write-requires-operator-authorization",
      reason: `Action "${input.action}" is state-changing; it requires explicit operator authorization even though the project's granted tier permits it.`,
    };
  }

  return {
    decision: "ALLOW",
    rule: "tier-sufficient",
    reason: `Action "${input.action}" requires ${requiredTier}; project is granted ${input.grantedTier}${input.operatorAuthorized ? " (operator-authorized)" : ""}.`,
  };
}
