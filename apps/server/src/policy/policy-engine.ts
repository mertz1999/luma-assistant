import os from "node:os";
import path from "node:path";

/**
 * Deterministic policy engine (spec: "Security decisions must be made by
 * deterministic code where possible, not by asking the LLM whether an
 * action is safe"). Plain code evaluating explicit rules, no model call
 * involved anywhere in this file.
 *
 * Scope for this phase: the one real, currently-existing Luma-level
 * control point is starting a run at all -- POST /api/runs/start already
 * accepts a workspace path, sandbox mode, and approval policy, and today
 * accepts any of them uncritically as long as the workspace directory
 * merely exists. Luma does not currently intercept individual tool calls
 * inside a running Codex/Claude session (that happens inside the CLI
 * itself), so a per-tool-call policy engine is not wireable without a much
 * larger change to how those adapters work -- not attempted here. This
 * evaluates run-start requests; more inputs/checkpoints can be added as
 * real enforcement points exist, without changing this shape.
 */

export type PolicyDecisionKind = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface PolicyInput {
  operation: "run.start";
  runner: string;
  workspace: string; // absolute, already-resolved path
  sandbox: string;
  approvalPolicy: string;
}

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
  /** Which rule produced this decision, for the audit trail and for debugging a surprising denial. */
  rule: string;
}

const WINDOWS_SENSITIVE_DIRS = ["c:\\windows", "c:\\windows\\system32", "c:\\program files", "c:\\program files (x86)"];
const UNIX_SENSITIVE_DIRS = ["/etc", "/bin", "/sbin", "/usr", "/usr/bin", "/usr/local", "/var", "/boot", "/system", "/root"];

function isFilesystemRoot(resolved: string): boolean {
  // path.parse(x).root is "C:\\" on Windows for any path under that drive,
  // and "/" on POSIX -- comparing the resolved path to its own root is a
  // platform-agnostic way to ask "is this the top of the drive/filesystem."
  return resolved === path.parse(resolved).root;
}

function isSensitiveSystemDir(resolved: string): boolean {
  const normalized = resolved.toLowerCase();
  const list = process.platform === "win32" ? WINDOWS_SENSITIVE_DIRS : UNIX_SENSITIVE_DIRS;
  return list.some((dir) => normalized === dir || normalized === dir + path.sep);
}

function isExactlyHomeDirectory(resolved: string): boolean {
  const home = path.resolve(os.homedir());
  return path.resolve(resolved) === home;
}

/**
 * Evaluates whether a run may start with the given workspace/sandbox
 * combination. Deliberately conservative in what it denies: only paths no
 * legitimate coding workspace would ever actually be (a drive/filesystem
 * root, a handful of well-known OS system directories, or literally the
 * whole home directory rather than a project folder inside it) -- chosen
 * specifically so this does not break any existing legitimate usage while
 * still closing a real gap (today, nothing stops a danger-full-access run
 * from being rooted at C:\ or the user's entire home directory).
 */
export function evaluateRunStartPolicy(input: PolicyInput): PolicyDecision {
  const resolved = path.resolve(input.workspace);

  if (isFilesystemRoot(resolved)) {
    return {
      decision: "DENY",
      rule: "workspace-not-filesystem-root",
      reason: `Workspace "${resolved}" is a filesystem/drive root, not a project folder. Refusing to start a run there.`,
    };
  }

  if (isSensitiveSystemDir(resolved)) {
    return {
      decision: "DENY",
      rule: "workspace-not-sensitive-system-dir",
      reason: `Workspace "${resolved}" is a well-known OS system directory. Refusing to start a run there.`,
    };
  }

  if (isExactlyHomeDirectory(resolved)) {
    return {
      decision: "DENY",
      rule: "workspace-not-entire-home-directory",
      reason: `Workspace "${resolved}" is the entire home directory, not a project folder inside it. Refusing to start a run there.`,
    };
  }

  return {
    decision: "ALLOW",
    rule: "default-allow",
    reason: "Workspace is a normal project path; no policy rule denied it.",
  };
}

/**
 * Mechanical project-to-workspace binding (closes the cross-project defect
 * found 2026-09-03: a mission/run declaring no more than a raw `workspace`
 * path had nothing tying its claimed project identity to that path -- a
 * "KoraIQ" mission could target C:\Dalilfinance and evaluateRunStartPolicy
 * would ALLOW it, because that function only ever asked "is this path a
 * system dir," never "is this project authorized for this path.")
 *
 * Deliberately additive/opt-in, not a retrofit onto every existing
 * workspace: `projectId` is null for any caller that does not declare a
 * project (ad-hoc workspaces, one-off test fixtures, the pre-existing
 * default-allow behavior in evaluateRunStartPolicy) -- those keep exactly
 * today's behavior. Only when a caller DOES declare a project does this
 * function engage, and once it does, it fails closed: unknown project,
 * missing registration, or a requested workspace outside the project's
 * authorized tree are all DENY, never a silent fallback to "allow anyway."
 *
 * Both `requestedWorkspace` and `authorizedWorkspace` must already be
 * canonicalized by the caller (fs.realpathSync.native -- resolves
 * symlinks/junctions and normalizes Windows case, not merely path.resolve,
 * which only does lexical `.`/`..` collapsing and would miss a symlink
 * escape or a case-only mismatch). Kept a pure function taking
 * already-resolved strings, matching this file's existing style, so it
 * stays trivially unit-testable without touching the filesystem.
 */
export interface ProjectWorkspaceBindingInput {
  /** null/undefined = no project declared on this request -- legacy, unbound path. */
  projectId?: string | null;
  /** Already realpath-canonicalized. */
  requestedWorkspace: string;
  /**
   * Already realpath-canonicalized authorized workspace for `projectId`, or
   * null if `projectId` does not resolve to any registered project.
   * Resolution itself (reading config.yaml's trusted repos: map) is the
   * caller's job -- this function never reads configuration or the
   * filesystem, so a malicious/malformed workspace string can't influence
   * which project it gets checked against.
   */
  authorizedWorkspace: string | null;
}

function isSameOrDescendantPath(authorizedReal: string, requestedReal: string): boolean {
  const rel = path.relative(authorizedReal, requestedReal);
  if (rel === "") return true; // exact match
  // A genuine descendant: relative path is neither absolute (different
  // drive/root on Windows) nor starting with ".." (climbs back out, which
  // also catches the prefix-collision case -- "C:\BotolaIQ2" relative to
  // "C:\BotolaIQ" is "..\\BotolaIQ2", correctly rejected; naive
  // startsWith("C:\\BotolaIQ") would have wrongly allowed it).
  return !path.isAbsolute(rel) && !rel.startsWith("..");
}

export function evaluateProjectWorkspaceBinding(input: ProjectWorkspaceBindingInput): PolicyDecision {
  if (!input.projectId) {
    return {
      decision: "ALLOW",
      rule: "no-project-declared-legacy",
      reason: "No project identity was declared on this request; falling back to the pre-existing workspace-only admission path (evaluateRunStartPolicy still applies).",
    };
  }

  if (!input.authorizedWorkspace) {
    return {
      decision: "DENY",
      rule: "unknown-project",
      reason: `Project "${input.projectId}" is not a registered Luma project (see config.yaml's repos: map). Refusing to bind an unrecognized project identity to any workspace.`,
    };
  }

  if (!isSameOrDescendantPath(input.authorizedWorkspace, input.requestedWorkspace)) {
    return {
      decision: "DENY",
      rule: "cross-project-workspace",
      reason: `Project "${input.projectId}" is authorized only for "${input.authorizedWorkspace}" (or a subfolder of it); refusing to start a run declaring this project at "${input.requestedWorkspace}".`,
    };
  }

  return {
    decision: "ALLOW",
    rule: "project-workspace-match",
    reason: `Requested workspace is project "${input.projectId}"'s authorized workspace (or a subfolder of it).`,
  };
}

/**
 * Per-project credential access (spec: "Credential access must be
 * deny-by-default"). Pure decision logic only -- it takes the requesting
 * project/adapter and the target credential's OWN metadata (already
 * looked up by the caller) and decides; it does not touch the filesystem
 * or the credential store itself, so it's trivially testable with fabricated
 * metadata and stays reusable if credential storage ever changes.
 */
export interface CredentialAccessInput {
  requestingProjectId: string;
  adapter: string;
  credentialId: string;
  /** null means the credential id does not exist at all (unknown credential -> deny). */
  credentialMetadata: { projectId: string; allowedAdapters: string[] } | null;
}

export function evaluateCredentialAccessPolicy(input: CredentialAccessInput): PolicyDecision {
  if (!input.credentialMetadata) {
    return {
      decision: "DENY",
      rule: "unknown-credential",
      reason: `Credential ${input.credentialId} does not exist.`,
    };
  }

  if (input.credentialMetadata.projectId !== input.requestingProjectId) {
    return {
      decision: "DENY",
      rule: "cross-project-credential-access",
      reason: `Credential ${input.credentialId} belongs to a different project; refusing cross-project access.`,
    };
  }

  if (!input.credentialMetadata.allowedAdapters.includes(input.adapter)) {
    return {
      decision: "DENY",
      rule: "adapter-not-permitted",
      reason: `Credential ${input.credentialId} is not authorized for adapter "${input.adapter}" (allowed: ${input.credentialMetadata.allowedAdapters.join(", ") || "none"}).`,
    };
  }

  return {
    decision: "ALLOW",
    rule: "project-and-adapter-match",
    reason: `Credential ${input.credentialId} belongs to this project and is authorized for adapter "${input.adapter}".`,
  };
}
