import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CloudSessions, cloudIdleTimeoutMs } from "../src/cloud-sessions.js";

test("cloud session activity extends the deadline and an expired token cannot be renewed", () => {
  const store = new CloudSessions(":memory:", "test-secret");
  try {
    const start = 10_000;
    const session = store.issue(start);
    assert.equal(session.expiresAt, start + cloudIdleTimeoutMs);
    const activity = session.expiresAt - 1;
    assert.equal(store.expiresAt(session.token, activity), session.expiresAt);
    const renewed = store.recordActivity(session.token, activity);
    assert.equal(renewed, activity + cloudIdleTimeoutMs);
    assert.equal(store.expiresAt(session.token, renewed! - 1), renewed);
    assert.equal(store.expiresAt(session.token, renewed!), null);
    assert.equal(store.recordActivity(session.token, renewed!), null);
  } finally {
    store.close();
  }
});

test("cloud session persists across restarts and sign-out revokes it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "luma-cloud-sessions-"));
  const file = path.join(directory, "auth.sqlite");
  let store = new CloudSessions(file, "test-secret");
  try {
    const session = store.issue();
    const other = store.issue();
    store.close();
    store = new CloudSessions(file, "test-secret");
    assert.equal(store.expiresAt(session.token), session.expiresAt);
    store.revoke(session.token);
    assert.equal(store.expiresAt(session.token), null);
    assert.equal(store.recordActivity(session.token), null);
    assert.equal(store.expiresAt(other.token), other.expiresAt);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
