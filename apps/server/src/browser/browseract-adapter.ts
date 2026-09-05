import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "../audit/audit-log.js";
import { resolveCommandPath, resolveExecutableForSpawn, killProcessTree } from "../platform/process-utils.js";
import { redactKnownSecretValues } from "../security/secret-redaction.js";
import { evaluateBrowserActionPolicy, type BrowserActionCategory, type BrowserPolicyDecision } from "./browser-policy.js";
import { isSessionUsableByProject, type BrowserSessionIdentity } from "./browser-session.js";

/**
 * Optional BrowserAct browser-adapter (see docs/commerce-agents-gap-analysis.md
 * for the sibling pattern this follows: study the real thing, adopt a
 * narrow, bounded, testable slice of it, never the whole surface).
 *
 * BrowserAct (github.com/browser-act/skills) is distributed as a local
 * CLI ("browser-act") discovered/invoked as an agent Skill -- it is NOT an
 * npm package or an importable SDK, and at the time this adapter was
 * written it was not installed on this host (confirmed: not on PATH, and
 * not published under this name on the public npm registry either). Its
 * README documents `stealth-extract`, `browser open <id> <url>`, `state`,
 * `click <index>`, `input <index> "..."`, and a `get-skills core
 * --skill-version X` capability-discovery call, but does NOT document
 * dedicated screenshot/console/network subcommands the way this
 * integration's brief assumed. Rather than invent a CLI surface BrowserAct
 * was never confirmed to expose, capture_screenshot/inspect_console/
 * inspect_network below report NOT_SUPPORTED unless a live
 * getCapabilities() call explicitly confirms them -- "unsupported
 * functionality fails gracefully," not "fails by pretending to work."
 *
 * Every method here requires a pre-evaluated ALLOW BrowserPolicyDecision
 * and a BrowserSessionIdentity scoped to the calling project -- this is
 * deliberate defense in depth: the HTTP/mission layer is expected to call
 * evaluateBrowserActionPolicy itself, but this adapter independently
 * refuses to spawn anything without proof that check already happened
 * and passed, and without proof the session belongs to the caller's own
 * project. A caller bug upstream cannot turn into a policy bypass here.
 */

const BROWSERACT_COMMAND = "browser-act";
const DEFAULT_TIMEOUT_MS = 20_000;
const SIGTERM_GRACE_MS = 2_500;

export interface BrowserCapabilities {
  available: boolean;
  version: string | null;
  chromeSupport: "confirmed" | "unconfirmed";
  sessionSupport: "confirmed" | "unconfirmed";
  screenshotSupport: "confirmed" | "unconfirmed";
  consoleInspectionSupport: "confirmed" | "unconfirmed";
  networkInspectionSupport: "confirmed" | "unconfirmed";
  rawDiscoveryOutput: string | null;
}

export type BrowserAdapterResult =
  | { ok: true; output: string }
  | { ok: false; reason: "BROWSER_CAPABILITY_UNAVAILABLE" | "POLICY_NOT_ALLOWED" | "SESSION_NOT_OWNED_BY_PROJECT" | "NOT_SUPPORTED" | "PROCESS_ERROR"; detail: string };

function isBrowserActAvailable(): boolean {
  return resolveCommandPath(BROWSERACT_COMMAND) !== "";
}

/** Public availability check (Phase 11/29): never throws, never spawns anything. */
export function isAvailable(): boolean {
  try {
    return isBrowserActAvailable();
  } catch {
    return false;
  }
}

/**
 * Bounded child-process invocation of the browser-act CLI. Reuses Luma's
 * existing Windows-safe executable resolution and whole-tree kill
 * (platform/process-utils.ts) rather than re-deriving either -- this is
 * "use the existing process manager where possible" (Phase 10) applied at
 * the level that actually exists today: browser-act runs are one bounded
 * CLI invocation per action, not a persistent RunManager-tracked run, so
 * this does not force them through that class's mission/run data model,
 * which does not fit a single short-lived subprocess.
 */
function runBrowserActCommand(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let resolved = { command: BROWSERACT_COMMAND, prependArgs: [] as string[] };
    try {
      resolved = resolveExecutableForSpawn(BROWSERACT_COMMAND);
    } catch {
      resolve({ code: null, stdout: "", stderr: "browser-act executable could not be resolved for spawn", timedOut: false });
      return;
    }

    const child = spawn(resolved.command, [...resolved.prependArgs, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const hardTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => killProcessTree(child.pid, "SIGKILL"), SIGTERM_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      clearTimeout(hardTimer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(hardTimer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
}

/**
 * Runtime capability discovery (Phase 12): queries browser-act's own
 * `get-skills core` output rather than assuming any feature exists.
 * Conservative by construction -- a capability is only ever "confirmed"
 * when the discovery text itself names it; anything else, including a
 * parse failure, stays "unconfirmed" and every call site must treat
 * unconfirmed the same as absent.
 */
export async function getCapabilities(): Promise<BrowserCapabilities> {
  if (!isAvailable()) {
    return {
      available: false,
      version: null,
      chromeSupport: "unconfirmed",
      sessionSupport: "unconfirmed",
      screenshotSupport: "unconfirmed",
      consoleInspectionSupport: "unconfirmed",
      networkInspectionSupport: "unconfirmed",
      rawDiscoveryOutput: null,
    };
  }

  const result = await runBrowserActCommand(["get-skills", "core"], DEFAULT_TIMEOUT_MS);
  const text = `${result.stdout}\n${result.stderr}`;
  const confirms = (needle: RegExp) => (needle.test(text) ? "confirmed" : "unconfirmed");
  const versionMatch = text.match(/skill-version[:\s]+([0-9][\w.-]*)/i);

  return {
    available: true,
    version: versionMatch ? versionMatch[1] : null,
    chromeSupport: confirms(/\bchrome\b/i),
    sessionSupport: confirms(/\bsession\b/i),
    screenshotSupport: confirms(/screenshot/i),
    consoleInspectionSupport: confirms(/\bconsole\b/i),
    networkInspectionSupport: confirms(/\bnetwork\b/i),
    rawDiscoveryOutput: result.stdout || result.stderr || null,
  };
}

interface ActionRequest {
  action: BrowserActionCategory;
  policyDecision: BrowserPolicyDecision;
  session: BrowserSessionIdentity;
  requestingProjectId: string;
  /** Same audit directory the rest of Luma already writes to (index.ts's AUDIT_DIR) -- passed explicitly, matching audit-log.ts's own convention of taking auditDir as a parameter rather than an adapter-local env var. */
  auditDir: string;
  /** Values (if any) this action is authorized to see in its own output -- redacted before the result is returned or audited. */
  knownSecretValues?: readonly string[];
}

function guard(request: ActionRequest): BrowserAdapterResult | null {
  if (request.policyDecision.decision !== "ALLOW") {
    auditBrowserAction({ auditDir: request.auditDir, action: request.action, session: request.session, permissionTier: request.session.permissionProfile, success: false, detail: `blocked: ${request.policyDecision.rule}` });
    return { ok: false, reason: "POLICY_NOT_ALLOWED", detail: `Policy decision for "${request.action}" was ${request.policyDecision.decision}, not ALLOW: ${request.policyDecision.reason}` };
  }
  if (!isSessionUsableByProject(request.session, request.requestingProjectId)) {
    auditBrowserAction({ auditDir: request.auditDir, action: request.action, session: request.session, permissionTier: request.session.permissionProfile, success: false, detail: "blocked: cross-project-session" });
    return { ok: false, reason: "SESSION_NOT_OWNED_BY_PROJECT", detail: "This browser session does not belong to the requesting project." };
  }
  if (!isAvailable()) {
    auditBrowserAction({ auditDir: request.auditDir, action: request.action, session: request.session, permissionTier: request.session.permissionProfile, success: false, detail: "blocked: browser-act-unavailable" });
    return { ok: false, reason: "BROWSER_CAPABILITY_UNAVAILABLE", detail: "browser-act is not installed/available on this host." };
  }
  return null;
}

function auditBrowserAction(input: {
  auditDir: string;
  action: BrowserActionCategory;
  session: BrowserSessionIdentity;
  urlOrDomain?: string;
  permissionTier: string;
  success: boolean;
  detail?: string;
}): void {
  appendAuditEvent(input.auditDir, {
    event_type: `browser.${input.action}`,
    actor: "browser-adapter",
    payload: {
      project_id: input.session.projectId,
      browser_session_id: input.session.browserSessionId,
      permission_tier: input.permissionTier,
      action_category: input.action,
      url_or_domain: input.urlOrDomain || null,
      success: input.success,
      detail: input.detail || null,
      authenticated_session_used: input.session.permissionProfile !== "READ_ONLY_BROWSER",
    },
  });
}

async function redactedResult(request: ActionRequest, raw: { code: number | null; stdout: string; stderr: string; timedOut: boolean }, urlOrDomain?: string): Promise<BrowserAdapterResult> {
  const secretValues = request.knownSecretValues || [];
  const output = redactKnownSecretValues(raw.timedOut ? `${raw.stdout}\n[TIMED OUT]` : raw.stdout || raw.stderr, secretValues);
  const success = !raw.timedOut && raw.code === 0;
  auditBrowserAction({ auditDir: request.auditDir, action: request.action, session: request.session, urlOrDomain, permissionTier: request.session.permissionProfile, success, detail: success ? undefined : redactKnownSecretValues(raw.stderr, secretValues).slice(0, 500) });
  if (!success) return { ok: false, reason: "PROCESS_ERROR", detail: raw.timedOut ? "browser-act command timed out" : `browser-act exited with code ${raw.code}` };
  return { ok: true, output };
}

// -- READ_ONLY_BROWSER --------------------------------------------------

export async function navigatePublic(request: ActionRequest & { action: "navigate_public"; url: string }): Promise<BrowserAdapterResult> {
  const blocked = guard(request);
  if (blocked) return blocked;
  const sessionName = request.session.browserSessionId;
  const raw = await runBrowserActCommand(["--session", sessionName, "browser", "open", randomUUID(), request.url]);
  return redactedResult(request, raw, safeUrlForAudit(request.url));
}

export async function inspectDom(request: ActionRequest & { action: "inspect_dom" }): Promise<BrowserAdapterResult> {
  const blocked = guard(request);
  if (blocked) return blocked;
  const raw = await runBrowserActCommand(["--session", request.session.browserSessionId, "state"]);
  return redactedResult(request, raw);
}

export async function captureScreenshot(request: ActionRequest & { action: "capture_screenshot" }): Promise<BrowserAdapterResult> {
  const blocked = guard(request);
  if (blocked) return blocked;
  const capabilities = await getCapabilities();
  if (capabilities.screenshotSupport !== "confirmed") {
    return { ok: false, reason: "NOT_SUPPORTED", detail: "browser-act's own capability discovery did not confirm screenshot support; refusing to invent an unverified subcommand." };
  }
  const raw = await runBrowserActCommand(["--session", request.session.browserSessionId, "screenshot"]);
  return redactedResult(request, raw);
}

export async function inspectConsole(request: ActionRequest & { action: "inspect_console" }): Promise<BrowserAdapterResult> {
  const blocked = guard(request);
  if (blocked) return blocked;
  const capabilities = await getCapabilities();
  if (capabilities.consoleInspectionSupport !== "confirmed") {
    return { ok: false, reason: "NOT_SUPPORTED", detail: "browser-act's own capability discovery did not confirm console-inspection support." };
  }
  const raw = await runBrowserActCommand(["--session", request.session.browserSessionId, "console"]);
  return redactedResult(request, raw);
}

export async function inspectNetwork(request: ActionRequest & { action: "inspect_network" }): Promise<BrowserAdapterResult> {
  const blocked = guard(request);
  if (blocked) return blocked;
  const capabilities = await getCapabilities();
  if (capabilities.networkInspectionSupport !== "confirmed") {
    return { ok: false, reason: "NOT_SUPPORTED", detail: "browser-act's own capability discovery did not confirm network-inspection support." };
  }
  const raw = await runBrowserActCommand(["--session", request.session.browserSessionId, "network"]);
  // Network output redaction is defense-in-depth beyond known-secret-value
  // stripping: also strip common header/cookie value patterns outright
  // rather than relying solely on an exact-match secret list, since a
  // network log's auth headers are not necessarily values Luma itself
  // ever held as a "known secret."
  const stripped = raw.stdout
    .replace(/(authorization:\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(cookie:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(set-cookie:\s*)[^\r\n]+/gi, "$1[REDACTED]");
  return redactedResult(request, { ...raw, stdout: stripped });
}

// -- AUTHENTICATED_READ ---------------------------------------------------

export async function readAuthenticatedPage(request: ActionRequest & { action: "read_authenticated_page"; url: string }): Promise<BrowserAdapterResult> {
  // Checked before guard()'s availability probe on purpose: a session-tier
  // mismatch is a caller/authorization bug, independent of whether
  // browser-act happens to be installed on this particular host, and
  // should be reported as such rather than masked by an infrastructure-
  // availability error when both happen to be true at once.
  if (request.session.permissionProfile !== "AUTHENTICATED_READ" && request.session.permissionProfile !== "BROWSER_WRITE") {
    auditBrowserAction({ auditDir: request.auditDir, action: request.action, session: request.session, permissionTier: request.session.permissionProfile, success: false, detail: "blocked: session-not-authenticated-read" });
    return { ok: false, reason: "POLICY_NOT_ALLOWED", detail: "This session is not an approved authenticated-read session." };
  }
  const blocked = guard(request);
  if (blocked) return blocked;
  const raw = await runBrowserActCommand(["--session", request.session.browserSessionId, "browser", "open", randomUUID(), request.url]);
  return redactedResult(request, raw, safeUrlForAudit(request.url));
}

// closeSession is READ_ONLY-tier housekeeping, always permitted once a
// session exists -- it is the one lifecycle action with no meaningful
// "write" implication, so it is not routed through evaluateBrowserActionPolicy.
export async function closeSession(session: BrowserSessionIdentity, requestingProjectId: string, auditDir: string): Promise<BrowserAdapterResult> {
  if (!isSessionUsableByProject(session, requestingProjectId)) {
    auditBrowserAction({ auditDir, action: "navigate_public", session, permissionTier: session.permissionProfile, success: false, detail: "blocked: cross-project-session (close)" });
    return { ok: false, reason: "SESSION_NOT_OWNED_BY_PROJECT", detail: "This browser session does not belong to the requesting project." };
  }
  if (!isAvailable()) {
    auditBrowserAction({ auditDir, action: "navigate_public", session, permissionTier: session.permissionProfile, success: false, detail: "blocked: browser-act-unavailable (close)" });
    return { ok: false, reason: "BROWSER_CAPABILITY_UNAVAILABLE", detail: "browser-act is not installed/available on this host." };
  }
  const raw = await runBrowserActCommand(["--session", session.browserSessionId, "close"]);
  auditBrowserAction({ auditDir, action: "navigate_public", session, permissionTier: session.permissionProfile, success: raw.code === 0, detail: "session-close" });
  return raw.code === 0 ? { ok: true, output: "" } : { ok: false, reason: "PROCESS_ERROR", detail: `close exited with code ${raw.code}` };
}

/** Never audits a full URL with query strings intact -- origin+path only, matching the "no accidental secret capture via query params" concern (Phase 27). */
function safeUrlForAudit(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

export type { BrowserPolicyDecision } from "./browser-policy.js";
export { evaluateBrowserActionPolicy } from "./browser-policy.js";
