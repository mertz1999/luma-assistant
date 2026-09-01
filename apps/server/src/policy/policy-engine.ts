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
