import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Per-project credential storage.
 *
 * Storage mechanism: filesystem, not an OS-native keychain. Considered and
 * deliberately deferred: adding a keychain binding (Windows Credential
 * Manager / macOS Keychain / libsecret) means a new native dependency
 * (e.g. keytar, itself unmaintained) on a codebase that has stayed
 * dependency-light all session, and per this project's own constraints
 * ("prefer standard libraries and small dependencies"). The real
 * protection here is the same primitive local secrets like SSH private
 * keys already rely on: restrictive filesystem permissions, not a second,
 * locally-stored encryption key masquerading as "encryption at rest" --
 * without OS-keychain-backed key custody, an on-disk encryption key next
 * to the data it decrypts adds complexity without proportionate real
 * protection against the actual local-attacker threat model here.
 *
 * Layout: data/credentials/<projectId>/<credentialId>.meta.json (metadata
 * only -- safe to read/list/log freely) and
 * data/credentials/<projectId>/<credentialId>.secret (the raw value only,
 * read exclusively at injection time). Metadata and secret are ALWAYS two
 * separate files specifically so listing credentials never touches secret
 * material at all.
 *
 * Both projectId and credentialId are server-generated opaque ids (a
 * project id is a deterministic hash of the canonicalized workspace path;
 * a credential id is random) -- never raw user-supplied strings used
 * directly as path segments. Every read/write additionally canonicalizes
 * the resolved path and verifies it stays within the credentials root
 * before touching the filesystem, so even a validation bug elsewhere
 * cannot turn into a traversal/symlink escape by itself.
 */

export interface CredentialDescriptor {
  id: string;
  projectId: string;
  /** Also the exact environment variable name this credential is injected as. */
  name: string;
  type: "env";
  createdAt: number;
  updatedAt: number;
  allowedAdapters: string[];
}

export class CredentialPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialPathError";
  }
}

const CREDENTIAL_ID_PATTERN = /^cred_[a-z0-9]+$/;
const PROJECT_ID_PATTERN = /^proj_[a-f0-9]{32}$/;
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function credentialsRoot(dataDir: string): string {
  return path.resolve(dataDir, "credentials");
}

/**
 * Deterministic, opaque, filesystem-safe project identity derived from a
 * workspace path. The ONLY public way to name a project is by its
 * workspace path (validated the same way run-start already validates a
 * workspace); this is the one place that path gets turned into an id, and
 * it never round-trips back into a raw path for filesystem purposes.
 */
export function deriveProjectId(workspacePath: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(path.resolve(workspacePath));
  } catch {
    canonical = path.resolve(workspacePath);
  }
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `proj_${hash}`;
}

function generateCredentialId(): string {
  return `cred_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Resolves `segments` under `root`, then verifies -- via the canonicalized
 * real path, not just string prefix comparison, so a symlink planted
 * inside the credentials tree cannot point the resolved path somewhere
 * else -- that the result is genuinely still inside `root`. Throws rather
 * than silently clamping, matching "fail closed."
 */
function safeJoinWithinRoot(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments);
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CredentialPathError(`Path escapes credential store root: ${segments.join("/")}`);
  }

  // Canonicalize what actually exists on disk (realpath resolves symlinks)
  // and re-check containment -- catches a symlink planted somewhere along
  // the path that a pure string check on `target` would miss. Walk up to
  // the nearest existing ancestor since the leaf file may not exist yet
  // (e.g. about to be created).
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    realProbe = probe;
  }
  const realRoot = fs.existsSync(rootResolved) ? fs.realpathSync(rootResolved) : rootResolved;
  const realRelative = path.relative(realRoot, realProbe);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new CredentialPathError(`Resolved path escapes credential store root (symlink?): ${segments.join("/")}`);
  }

  return target;
}

/** Best-effort restrictive permissions: owner-only on POSIX, current-user-only ACL on Windows via icacls. Failures are logged, never thrown -- a permissions tightening failure must not block the write it's protecting. */
function restrictToCurrentUser(targetPath: string, isDirectory: boolean): void {
  try {
    if (process.platform === "win32") {
      const username = `${os.userInfo().username}`;
      spawnSync("icacls", [targetPath, "/inheritance:r", "/grant:r", `${username}:F`], { stdio: "ignore" });
    } else {
      fs.chmodSync(targetPath, isDirectory ? 0o700 : 0o600);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[luma-assistant/server] failed to restrict permissions on ${targetPath}:`, (err as Error).message);
  }
}

function ensureProjectDir(dataDir: string, projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new CredentialPathError(`Malformed project id: ${projectId}`);
  }
  const root = credentialsRoot(dataDir);
  fs.mkdirSync(root, { recursive: true });
  restrictToCurrentUser(root, true);
  const projectDir = safeJoinWithinRoot(root, projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  restrictToCurrentUser(projectDir, true);
  return projectDir;
}

function metaPath(dataDir: string, projectId: string, credentialId: string): string {
  if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
    throw new CredentialPathError(`Malformed credential id: ${credentialId}`);
  }
  const projectDir = safeJoinWithinRoot(credentialsRoot(dataDir), projectId);
  return safeJoinWithinRoot(projectDir, `${credentialId}.meta.json`);
}

function secretPath(dataDir: string, projectId: string, credentialId: string): string {
  if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
    throw new CredentialPathError(`Malformed credential id: ${credentialId}`);
  }
  const projectDir = safeJoinWithinRoot(credentialsRoot(dataDir), projectId);
  return safeJoinWithinRoot(projectDir, `${credentialId}.secret`);
}

export interface CreateCredentialInput {
  name: string;
  allowedAdapters: string[];
  value: string;
}

export function createCredential(dataDir: string, projectId: string, input: CreateCredentialInput): CredentialDescriptor {
  if (!ENV_VAR_NAME_PATTERN.test(input.name)) {
    throw new CredentialPathError(`Credential name must look like an environment variable name (e.g. GITHUB_TOKEN): got "${input.name}"`);
  }
  if (!Array.isArray(input.allowedAdapters) || input.allowedAdapters.length === 0) {
    throw new CredentialPathError("allowedAdapters must be a non-empty list -- deny-by-default means a credential is usable by no adapter until explicitly scoped to one.");
  }

  const projectDir = ensureProjectDir(dataDir, projectId);
  const id = generateCredentialId();
  const now = Date.now();
  const descriptor: CredentialDescriptor = {
    id,
    projectId,
    name: input.name,
    type: "env",
    createdAt: now,
    updatedAt: now,
    allowedAdapters: [...input.allowedAdapters],
  };

  const metaFile = safeJoinWithinRoot(projectDir, `${id}.meta.json`);
  const secretFile = safeJoinWithinRoot(projectDir, `${id}.secret`);
  fs.writeFileSync(metaFile, JSON.stringify(descriptor, null, 2));
  restrictToCurrentUser(metaFile, false);
  fs.writeFileSync(secretFile, input.value, { encoding: "utf8" });
  restrictToCurrentUser(secretFile, false);

  return descriptor;
}

export function listCredentials(dataDir: string, projectId: string): CredentialDescriptor[] {
  if (!PROJECT_ID_PATTERN.test(projectId)) return [];
  const projectDir = safeJoinWithinRoot(credentialsRoot(dataDir), projectId);
  if (!fs.existsSync(projectDir)) return [];

  const results: CredentialDescriptor[] = [];
  for (const entry of fs.readdirSync(projectDir)) {
    if (!entry.endsWith(".meta.json")) continue;
    const descriptor = readMetaFileSafely(path.join(projectDir, entry));
    if (descriptor) results.push(descriptor);
  }
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

function readMetaFileSafely(filePath: string): CredentialDescriptor | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      typeof raw?.id !== "string" ||
      !CREDENTIAL_ID_PATTERN.test(raw.id) ||
      typeof raw?.projectId !== "string" ||
      typeof raw?.name !== "string" ||
      !ENV_VAR_NAME_PATTERN.test(raw.name) ||
      raw?.type !== "env" ||
      typeof raw?.createdAt !== "number" ||
      typeof raw?.updatedAt !== "number" ||
      !Array.isArray(raw?.allowedAdapters) ||
      !raw.allowedAdapters.every((a: unknown) => typeof a === "string")
    ) {
      // Malformed metadata fails closed: treated as if the credential does
      // not exist, never partially trusted.
      return null;
    }
    return raw as CredentialDescriptor;
  } catch {
    return null;
  }
}

export function getCredentialMetadata(dataDir: string, projectId: string, credentialId: string): CredentialDescriptor | null {
  try {
    const file = metaPath(dataDir, projectId, credentialId);
    if (!fs.existsSync(file)) return null;
    const descriptor = readMetaFileSafely(file);
    if (!descriptor || descriptor.projectId !== projectId || descriptor.id !== credentialId) return null;
    return descriptor;
  } catch (err) {
    if (err instanceof CredentialPathError) return null;
    throw err;
  }
}

/** Reads the raw secret value. Not cached anywhere -- fetched fresh, exactly once per authorized injection, immediately before building the child process environment. */
export function getCredentialValue(dataDir: string, projectId: string, credentialId: string): string | null {
  const descriptor = getCredentialMetadata(dataDir, projectId, credentialId);
  if (!descriptor) return null;
  try {
    const file = secretPath(dataDir, projectId, credentialId);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err instanceof CredentialPathError) return null;
    throw err;
  }
}

export function deleteCredential(dataDir: string, projectId: string, credentialId: string): boolean {
  const descriptor = getCredentialMetadata(dataDir, projectId, credentialId);
  if (!descriptor) return false;
  try {
    const meta = metaPath(dataDir, projectId, credentialId);
    const secret = secretPath(dataDir, projectId, credentialId);
    if (fs.existsSync(secret)) fs.unlinkSync(secret);
    if (fs.existsSync(meta)) fs.unlinkSync(meta);
    return true;
  } catch (err) {
    if (err instanceof CredentialPathError) return false;
    throw err;
  }
}
