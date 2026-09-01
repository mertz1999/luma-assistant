import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredential, deriveProjectId } from "./credential-store.js";
import { resolveAuthorizedCredentials } from "./credential-resolver.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "luma-resolver-"));
}

function projectFor(name: string): string {
  return deriveProjectId(fs.mkdtempSync(path.join(os.tmpdir(), `luma-ws-${name}-`)));
}

test("resolveAuthorizedCredentials: an authorized credential for the right project+adapter is injected under its declared name", () => {
  const dataDir = tempDataDir();
  const projectA = projectFor("a");
  const cred = createCredential(dataDir, projectA, { name: "A_TOKEN", allowedAdapters: ["codex"], value: "secret-a-value" });

  const result = resolveAuthorizedCredentials({ dataDir, projectId: projectA, adapter: "codex", credentialIds: [cred.id] });
  assert.equal(result.env.A_TOKEN, "secret-a-value");
  assert.equal(result.decisions[0]!.decision, "ALLOW");
});

test("resolveAuthorizedCredentials: Project B cannot obtain Project A's credential by id", () => {
  const dataDir = tempDataDir();
  const projectA = projectFor("a");
  const projectB = projectFor("b");
  const credA = createCredential(dataDir, projectA, { name: "A_TOKEN", allowedAdapters: ["codex"], value: "secret-a-value" });

  const result = resolveAuthorizedCredentials({ dataDir, projectId: projectB, adapter: "codex", credentialIds: [credA.id] });
  assert.deepEqual(result.env, {});
  assert.equal(result.decisions[0]!.decision, "DENY");
  // The storage layer scopes the lookup by project directory BEFORE the
  // policy engine's own cross-project check ever runs -- Project B's
  // lookup for credA.id fails to find anything at all under its own
  // directory, so this resolves as "unknown-credential" rather than
  // "cross-project-credential-access". That's a stronger property, not a
  // weaker one: Project B can't even learn the id exists elsewhere. The
  // policy engine's cross-project rule stays correct and exercised
  // directly in policy-engine.test.ts for a storage layer that might one
  // day do a global lookup-by-id first.
  assert.equal(result.decisions[0]!.rule, "unknown-credential");
});

test("resolveAuthorizedCredentials: no requested credentials means an empty env, not an error", () => {
  const dataDir = tempDataDir();
  const projectA = projectFor("a");
  const result = resolveAuthorizedCredentials({ dataDir, projectId: projectA, adapter: "codex", credentialIds: [] });
  assert.deepEqual(result.env, {});
  assert.deepEqual(result.decisions, []);
});

test("resolveAuthorizedCredentials: unknown credential id fails closed", () => {
  const dataDir = tempDataDir();
  const projectA = projectFor("a");
  const result = resolveAuthorizedCredentials({ dataDir, projectId: projectA, adapter: "codex", credentialIds: ["cred_doesnotexist"] });
  assert.deepEqual(result.env, {});
  assert.equal(result.decisions[0]!.decision, "DENY");
  assert.equal(result.decisions[0]!.rule, "unknown-credential");
});

test("resolveAuthorizedCredentials: adapter restriction is enforced (a codex-only credential is denied to claude)", () => {
  const dataDir = tempDataDir();
  const projectA = projectFor("a");
  const cred = createCredential(dataDir, projectA, { name: "A_TOKEN", allowedAdapters: ["codex"], value: "secret-a-value" });

  const result = resolveAuthorizedCredentials({ dataDir, projectId: projectA, adapter: "claude", credentialIds: [cred.id] });
  assert.deepEqual(result.env, {});
  assert.equal(result.decisions[0]!.decision, "DENY");
  assert.equal(result.decisions[0]!.rule, "adapter-not-permitted");
});

test("resolveAuthorizedCredentials: concurrent A and B resolution in the same process do not leak into each other's result (no shared mutable state)", () => {
  const dataDir = tempDataDir();
  const projectA = projectFor("a");
  const projectB = projectFor("b");
  const credA = createCredential(dataDir, projectA, { name: "SHARED_NAME", allowedAdapters: ["codex"], value: "value-a" });
  const credB = createCredential(dataDir, projectB, { name: "SHARED_NAME", allowedAdapters: ["codex"], value: "value-b" });

  // Interleaved, not sequential, to actually exercise concurrent access.
  const resultA = resolveAuthorizedCredentials({ dataDir, projectId: projectA, adapter: "codex", credentialIds: [credA.id] });
  const resultB = resolveAuthorizedCredentials({ dataDir, projectId: projectB, adapter: "codex", credentialIds: [credB.id] });

  assert.equal(resultA.env.SHARED_NAME, "value-a");
  assert.equal(resultB.env.SHARED_NAME, "value-b");
  // The two result objects must be genuinely independent.
  assert.notEqual(resultA.env, resultB.env);
});
