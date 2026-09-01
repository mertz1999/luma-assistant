import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUDIT_GENESIS_HASH,
  appendAuditEvent,
  readAuditEvents,
  verifyAuditChain,
} from "./audit-log.js";

function tempAuditDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "luma-audit-"));
}

test("appendAuditEvent: first entry chains from the genesis hash", () => {
  const dir = tempAuditDir();
  const entry = appendAuditEvent(dir, { event_type: "run.created", run_id: "run_1" });
  assert.equal(entry.seq, 1);
  assert.equal(entry.prev_hash, AUDIT_GENESIS_HASH);
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
});

test("appendAuditEvent: each entry's prev_hash is exactly the previous entry's hash, seq increments", () => {
  const dir = tempAuditDir();
  const a = appendAuditEvent(dir, { event_type: "run.created", run_id: "run_1" });
  const b = appendAuditEvent(dir, { event_type: "run.process_spawned", run_id: "run_1" });
  const c = appendAuditEvent(dir, { event_type: "run.completed", run_id: "run_1" });
  assert.equal(b.seq, 2);
  assert.equal(c.seq, 3);
  assert.equal(b.prev_hash, a.hash);
  assert.equal(c.prev_hash, b.hash);
});

test("appendAuditEvent: default actor is 'system', omitted payload becomes {}", () => {
  const dir = tempAuditDir();
  const entry = appendAuditEvent(dir, { event_type: "run.stopped" });
  assert.equal(entry.actor, "system");
  assert.deepEqual(entry.payload, {});
  assert.equal(entry.run_id, null);
});

test("appendAuditEvent: never stores raw secret-shaped values, redacts by key name", () => {
  const dir = tempAuditDir();
  const entry = appendAuditEvent(dir, {
    event_type: "run.process_spawned",
    payload: {
      password: "hunter2",
      API_KEY: "sk-abc123",
      nested: { authToken: "eyJ...", note: "kept" },
      workspace: "C:/safe/path",
    },
  });
  assert.equal(entry.payload.password, "[REDACTED]");
  assert.equal(entry.payload.API_KEY, "[REDACTED]");
  assert.equal((entry.payload.nested as Record<string, unknown>).authToken, "[REDACTED]");
  assert.equal((entry.payload.nested as Record<string, unknown>).note, "kept");
  assert.equal(entry.payload.workspace, "C:/safe/path");

  const onDisk = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
  assert.ok(!onDisk.includes("hunter2"), "raw secret value must never reach disk");
  assert.ok(!onDisk.includes("sk-abc123"), "raw secret value must never reach disk");
});

test("verifyAuditChain: an untampered chain of many entries verifies ok", () => {
  const dir = tempAuditDir();
  for (let i = 0; i < 20; i += 1) {
    appendAuditEvent(dir, { event_type: "run.process_spawned", run_id: `run_${i}` });
  }
  const result = verifyAuditChain(dir);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 20);
});

test("verifyAuditChain: an empty/nonexistent log verifies ok with zero entries", () => {
  const dir = tempAuditDir();
  const result = verifyAuditChain(dir);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 0);
});

test("verifyAuditChain: detects a tampered payload (hash no longer matches)", () => {
  const dir = tempAuditDir();
  appendAuditEvent(dir, { event_type: "run.created", run_id: "run_1" });
  appendAuditEvent(dir, { event_type: "run.completed", run_id: "run_1" });

  const filePath = path.join(dir, "audit.jsonl");
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[0]!);
  tampered.event_type = "run.stopped"; // change content without recomputing hash
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");

  const result = verifyAuditChain(dir);
  assert.equal(result.ok, false);
  assert.equal(result.firstBrokenSeq, 1);
  assert.match(result.reason!, /hash mismatch/);
});

test("verifyAuditChain: detects a deleted entry (breaks the prev_hash link)", () => {
  const dir = tempAuditDir();
  appendAuditEvent(dir, { event_type: "run.created", run_id: "run_1" });
  appendAuditEvent(dir, { event_type: "run.process_spawned", run_id: "run_1" });
  appendAuditEvent(dir, { event_type: "run.completed", run_id: "run_1" });

  const filePath = path.join(dir, "audit.jsonl");
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  lines.splice(1, 1); // remove the middle entry entirely
  fs.writeFileSync(filePath, lines.join("\n") + "\n");

  const result = verifyAuditChain(dir);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /prev_hash mismatch/);
});

test("readAuditEvents: returns entries in append order", () => {
  const dir = tempAuditDir();
  appendAuditEvent(dir, { event_type: "run.created", run_id: "run_1" });
  appendAuditEvent(dir, { event_type: "run.completed", run_id: "run_1" });
  const events = readAuditEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.event_type, "run.created");
  assert.equal(events[1]!.event_type, "run.completed");
});
