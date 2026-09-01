import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { evaluateResourcePolicy, getResourceSnapshot } from "./resource-watchdog.js";

test("getResourceSnapshot: reports real, plausible values for this actual machine", () => {
  const snapshot = getResourceSnapshot(process.cwd());
  assert.ok(snapshot.totalMemBytes > 0);
  assert.ok(snapshot.freeMemBytes > 0);
  assert.ok(snapshot.freeMemBytes <= snapshot.totalMemBytes);
  assert.ok(snapshot.freeMemPercent > 0 && snapshot.freeMemPercent <= 1);
  assert.ok(snapshot.cpuCount >= 1);
  // This machine has a real, statfs-able filesystem at cwd.
  assert.ok(snapshot.diskFreeBytes === null || snapshot.diskFreeBytes > 0);
});

test("evaluateResourcePolicy: allows when limits are set far below what this real machine actually has", () => {
  const result = evaluateResourcePolicy(process.cwd(), { minFreeMemoryBytes: 1, minFreeDiskBytes: 1 });
  assert.equal(result.decision, "ALLOW");
});

test("evaluateResourcePolicy: denies when the memory floor is set impossibly high", () => {
  const result = evaluateResourcePolicy(process.cwd(), {
    minFreeMemoryBytes: Number.MAX_SAFE_INTEGER,
    minFreeDiskBytes: 1,
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "min-free-memory");
});

test("evaluateResourcePolicy: denies when the disk floor is set impossibly high", () => {
  const result = evaluateResourcePolicy(process.cwd(), {
    minFreeMemoryBytes: 1,
    minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.decision, "DENY");
  assert.equal(result.rule, "min-free-disk");
});

test("evaluateResourcePolicy: memory is checked before disk (memory denial reported first when both would fail)", () => {
  const result = evaluateResourcePolicy(process.cwd(), {
    minFreeMemoryBytes: Number.MAX_SAFE_INTEGER,
    minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.rule, "min-free-memory");
});

test("evaluateResourcePolicy: an unstatfs-able path is treated as 'unknown', never as 'no space' -- does not spuriously deny", () => {
  const bogusPath = `${os.tmpdir()}/definitely-does-not-exist-${Date.now()}`;
  const result = evaluateResourcePolicy(bogusPath, { minFreeMemoryBytes: 1, minFreeDiskBytes: 1 });
  assert.equal(result.snapshot.diskFreeBytes, null);
  assert.equal(result.decision, "ALLOW");
});
