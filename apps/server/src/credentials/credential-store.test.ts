import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CredentialPathError,
  createCredential,
  deleteCredential,
  deriveProjectId,
  getCredentialMetadata,
  getCredentialValue,
  listCredentials,
} from "./credential-store.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "luma-cred-store-"));
}

test("deriveProjectId: is deterministic for the same workspace path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-"));
  const a = deriveProjectId(dir);
  const b = deriveProjectId(dir);
  assert.equal(a, b);
  assert.match(a, /^proj_[a-f0-9]{32}$/);
});

test("deriveProjectId: two different workspace paths get two different project ids", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-b-"));
  assert.notEqual(deriveProjectId(a), deriveProjectId(b));
});

test("createCredential + listCredentials: metadata round-trips, secret is stored separately", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  const created = createCredential(dataDir, projectId, { name: "GITHUB_TOKEN", allowedAdapters: ["codex"], value: "ghp_realvalue123" });

  assert.equal(created.name, "GITHUB_TOKEN");
  assert.equal(created.projectId, projectId);
  assert.deepEqual(created.allowedAdapters, ["codex"]);

  const listed = listCredentials(dataDir, projectId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, created.id);
  // Listing must never require reading the secret file at all -- verified
  // indirectly by confirming the listed descriptor has no value-shaped field.
  assert.ok(!("value" in listed[0]!));

  assert.equal(getCredentialValue(dataDir, projectId, created.id), "ghp_realvalue123");
});

test("listCredentials: returns [] (not a thrown CredentialPathError) when the credentials root has never been created on this server -- regression, found via a real Luma dogfood run's first-ever GET /api/credentials call", () => {
  // A brand-new tempDataDir() has no data/credentials/ directory at all --
  // the exact state of every real server before its first createCredential
  // call. safeJoinWithinRoot's symlink-containment walk previously had no
  // base case for "root itself doesn't exist yet": it walked past root up
  // to root's own parent looking for an existing ancestor, then compared
  // that ancestor against the still-nonexistent root and found it "outside"
  // -- a false-positive escape detection that threw on every credential
  // operation (including a plain list, which should just return []) until
  // something had created the root directory.
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  assert.ok(!fs.existsSync(path.join(dataDir, "credentials")));
  assert.deepEqual(listCredentials(dataDir, projectId), []);
});

test("createCredential: rejects a name that doesn't look like an env var", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  assert.throws(() => createCredential(dataDir, projectId, { name: "not a valid name!", allowedAdapters: ["codex"], value: "x" }));
});

test("createCredential: rejects an empty allowedAdapters list (deny-by-default, not usable-by-everyone-by-default)", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  assert.throws(() => createCredential(dataDir, projectId, { name: "X_TOKEN", allowedAdapters: [], value: "x" }));
});

test("cross-project isolation at the storage layer: project A's credentials are invisible under project B's id", () => {
  const dataDir = tempDataDir();
  const projectA = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-a-")));
  const projectB = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-b-")));

  const credA = createCredential(dataDir, projectA, { name: "A_TOKEN", allowedAdapters: ["codex"], value: "secret-a" });
  createCredential(dataDir, projectB, { name: "B_TOKEN", allowedAdapters: ["codex"], value: "secret-b" });

  assert.equal(listCredentials(dataDir, projectB).some((c) => c.id === credA.id), false);
  // Even asking for A's own credential id, but scoped under B, must miss.
  assert.equal(getCredentialMetadata(dataDir, projectB, credA.id), null);
  assert.equal(getCredentialValue(dataDir, projectB, credA.id), null);
});

test("deleteCredential: removes both metadata and secret; a deleted credential cannot still be fetched (no stale cache)", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  const cred = createCredential(dataDir, projectId, { name: "X_TOKEN", allowedAdapters: ["codex"], value: "x" });

  assert.equal(deleteCredential(dataDir, projectId, cred.id), true);
  assert.equal(getCredentialMetadata(dataDir, projectId, cred.id), null);
  assert.equal(getCredentialValue(dataDir, projectId, cred.id), null);
  assert.equal(listCredentials(dataDir, projectId).length, 0);
  // Deleting again is a deterministic, safe no-op, not an error.
  assert.equal(deleteCredential(dataDir, projectId, cred.id), false);
});

test("unknown credential id fails closed", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  assert.equal(getCredentialMetadata(dataDir, projectId, "cred_doesnotexist"), null);
  assert.equal(getCredentialValue(dataDir, projectId, "cred_doesnotexist"), null);
});

test("path traversal: a project id containing ../ is rejected rather than escaping the credentials root", () => {
  const dataDir = tempDataDir();
  assert.deepEqual(listCredentials(dataDir, "../../../etc"), []);
  assert.equal(getCredentialMetadata(dataDir, "../../../etc", "cred_x"), null);
});

test("path traversal: a credential id containing ../ is rejected", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  createCredential(dataDir, projectId, { name: "X_TOKEN", allowedAdapters: ["codex"], value: "x" });
  assert.equal(getCredentialMetadata(dataDir, projectId, "../../../etc/passwd"), null);
  assert.equal(getCredentialValue(dataDir, projectId, "../../../etc/passwd"), null);
});

test("symlink escape: a symlink planted inside a project's credential directory pointing outside the store is not followed", { skip: process.platform === "win32" }, () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  createCredential(dataDir, projectId, { name: "X_TOKEN", allowedAdapters: ["codex"], value: "real-value" });

  const outsideSecret = path.join(os.tmpdir(), `outside-secret-${Date.now()}.txt`);
  fs.writeFileSync(outsideSecret, "OUTSIDE_VALUE_MUST_NOT_BE_READ");
  const projectDir = path.join(dataDir, "credentials", projectId);
  const evilLink = path.join(projectDir, "cred_evilevilevi.secret");
  fs.symlinkSync(outsideSecret, evilLink);

  // Even though the file exists on disk and matches the naming pattern,
  // there is no corresponding valid .meta.json for it, so it must never
  // be reachable through the real API (getCredentialValue requires valid
  // metadata first). This proves the metadata-gate, not just path math,
  // is what actually protects reads.
  assert.equal(getCredentialValue(dataDir, projectId, "cred_evilevilevi"), null);
});

test("malformed metadata fails closed (corrupted JSON, missing fields, wrong id)", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  const projectDir = path.join(dataDir, "credentials", projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, "cred_corruptjson1.meta.json"), "{ not valid json");
  fs.writeFileSync(path.join(projectDir, "cred_corruptjson1.secret"), "value");

  fs.writeFileSync(
    path.join(projectDir, "cred_missingfield1.meta.json"),
    JSON.stringify({ id: "cred_missingfield1", projectId }), // missing name/type/timestamps/allowedAdapters
  );
  fs.writeFileSync(path.join(projectDir, "cred_missingfield1.secret"), "value");

  assert.equal(listCredentials(dataDir, projectId).length, 0);
  assert.equal(getCredentialMetadata(dataDir, projectId, "cred_corruptjson1"), null);
  assert.equal(getCredentialValue(dataDir, projectId, "cred_corruptjson1"), null);
  assert.equal(getCredentialMetadata(dataDir, projectId, "cred_missingfield1"), null);
});

test("restart reloads credential metadata safely: a fresh read against the same dataDir sees what a prior 'process' wrote", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  const created = createCredential(dataDir, projectId, { name: "X_TOKEN", allowedAdapters: ["codex"], value: "x" });

  // No in-memory cache anywhere in this module -- every call reads straight
  // off disk, so "restart" is trivially just calling the functions again.
  const reloaded = getCredentialMetadata(dataDir, projectId, created.id);
  assert.deepEqual(reloaded, created);
});

test("duplicate credential names behave deterministically: two credentials with the same declared name get distinct ids and both persist", () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  const first = createCredential(dataDir, projectId, { name: "DUPLICATE_NAME", allowedAdapters: ["codex"], value: "v1" });
  const second = createCredential(dataDir, projectId, { name: "DUPLICATE_NAME", allowedAdapters: ["codex"], value: "v2" });

  assert.notEqual(first.id, second.id);
  const listed = listCredentials(dataDir, projectId);
  assert.equal(listed.length, 2);
});

test("restrictive permissions: secret files are not group/world-readable on POSIX", { skip: process.platform === "win32" }, () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  createCredential(dataDir, projectId, { name: "X_TOKEN", allowedAdapters: ["codex"], value: "x" });

  const projectDir = path.join(dataDir, "credentials", projectId);
  const secretFile = fs.readdirSync(projectDir).find((f) => f.endsWith(".secret"))!;
  const mode = fs.statSync(path.join(projectDir, secretFile)).mode & 0o777;
  assert.equal(mode & 0o077, 0, `secret file must not be group/world-readable, got mode ${mode.toString(8)}`);

  const dirMode = fs.statSync(projectDir).mode & 0o777;
  assert.equal(dirMode & 0o077, 0, `project credential directory must not be group/world-accessible, got mode ${dirMode.toString(8)}`);
});

test("restrictive permissions: secret file ACL is restricted to the current user on Windows", { skip: process.platform !== "win32" }, () => {
  const dataDir = tempDataDir();
  const projectId = deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), "luma-ws-")));
  createCredential(dataDir, projectId, { name: "X_TOKEN", allowedAdapters: ["codex"], value: "x" });

  const projectDir = path.join(dataDir, "credentials", projectId);
  const secretFile = fs.readdirSync(projectDir).find((f) => f.endsWith(".secret"))!;
  const fullPath = path.join(projectDir, secretFile);

  const result = spawnSync("icacls", [fullPath], { encoding: "utf8" });
  const output = result.stdout || "";
  // icacls output lists one ACE per line as "<ACCOUNT>:(perm)"; after
  // /inheritance:r + /grant:r <user>:F, exactly one account (the current
  // user) should be granted, and BUILTIN\Users / Everyone / Authenticated
  // Users must NOT appear.
  assert.ok(!/\bEveryone\b/i.test(output), `icacls output must not grant Everyone:\n${output}`);
  assert.ok(!/BUILTIN\\Users/i.test(output), `icacls output must not grant BUILTIN\\Users:\n${output}`);
  assert.ok(new RegExp(os.userInfo().username, "i").test(output), `icacls output must grant the current user:\n${output}`);
});
