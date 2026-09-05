import crypto from "node:crypto";
import { deriveProjectId } from "../credentials/credential-store.js";

/**
 * Project-scoped browser session identity (PROJECT_SESSION_ISOLATION =
 * YES). A browser session is bound to exactly one project's derived id --
 * the SAME deriveProjectId() the credential store already uses, so
 * "project identity" is one consistent concept shared across
 * subsystems, not a second, browser-specific notion invented here.
 *
 * This module never accepts a caller-supplied session id for a different
 * project than the one requesting it: creation always mints a session
 * scoped to the requesting workspace, and reuse always re-verifies the
 * stored projectId against the requester before returning anything.
 * That is the mechanical enforcement of "a Dalil mission may never reuse
 * a KoraIQ authenticated browser session, or vice versa."
 */

export interface BrowserSessionIdentity {
  projectId: string;
  /** The canonicalized workspace path this project resolved to at session-creation time -- recorded for audit/debugging, not itself a security check (projectId is). */
  workspaceId: string;
  permissionProfile: string;
  browserSessionId: string;
  createdAt: number;
}

function generateSessionId(): string {
  return `bsess_${crypto.randomBytes(12).toString("hex")}`;
}

export function createBrowserSessionIdentity(workspacePath: string, permissionProfile: string): BrowserSessionIdentity {
  return {
    projectId: deriveProjectId(workspacePath),
    workspaceId: workspacePath,
    permissionProfile,
    browserSessionId: generateSessionId(),
    createdAt: Date.now(),
  };
}

/**
 * Fails closed: a session may only be reused by the exact project that
 * created it. An unknown/missing requesting project id is always denied
 * -- there is no "no project declared, allow anyway" fallback here the
 * way policy-engine.ts's run-start binding has for legacy unbound
 * workspaces, because a browser session with authenticated state is a
 * strictly higher-sensitivity object than a bare run workspace.
 */
export function isSessionUsableByProject(session: BrowserSessionIdentity, requestingProjectId: string | null | undefined): boolean {
  if (!requestingProjectId) return false;
  return session.projectId === requestingProjectId;
}

/** Convenience wrapper so callers derive a requesting project's id the same way sessions do, without importing credential-store directly just for this. */
export function projectIdForWorkspace(workspacePath: string): string {
  return deriveProjectId(workspacePath);
}
