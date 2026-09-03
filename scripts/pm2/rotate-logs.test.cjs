// Run: node --test scripts/pm2/rotate-logs.test.cjs
"use strict";
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { rotateLogFile, rotateAllLogs } = require("./rotate-logs.cjs");

// os.tmpdir() on this machine is itself a real path containing a space
// (this Windows account's profile directory has one), so every test
// below already exercises the exact path-with-spaces case the
// pm2-logrotate install failure was about, without needing a synthetic
// fixture. "Luma Logs Test" is added on top so the directory *name*
// component containing the space is unambiguous, not just an ancestor.
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "luma logs test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("rotateLogFile", () => {
  test("path contains a space and rotation still works correctly", () => {
    assert.match(dir, / /, "test fixture must actually contain a space to be a real test");
    const file = path.join(dir, "server.out.log");
    fs.writeFileSync(file, "x".repeat(20));
    const result = rotateLogFile(file, { maxBytes: 10, maxRotations: 3 });
    assert.equal(result.rotated, true);
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(20));
    assert.equal(fs.readFileSync(file, "utf8"), "");
  });

  test("a missing file is not rotated and does not throw", () => {
    const file = path.join(dir, "does-not-exist.log");
    const result = rotateLogFile(file, { maxBytes: 10, maxRotations: 3 });
    assert.equal(result.rotated, false);
    assert.equal(result.reason, "missing");
  });

  test("an empty file is below threshold and is not rotated", () => {
    const file = path.join(dir, "empty.log");
    fs.writeFileSync(file, "");
    const result = rotateLogFile(file, { maxBytes: 10, maxRotations: 3 });
    assert.equal(result.rotated, false);
    assert.equal(result.reason, "below-threshold");
  });

  test("a file below the size threshold is not rotated", () => {
    const file = path.join(dir, "small.log");
    fs.writeFileSync(file, "abc");
    const result = rotateLogFile(file, { maxBytes: 100, maxRotations: 3 });
    assert.equal(result.rotated, false);
    assert.equal(result.reason, "below-threshold");
    assert.equal(fs.readFileSync(file, "utf8"), "abc", "untouched file must be unchanged");
  });

  test("a file at or above the size threshold is rotated", () => {
    const file = path.join(dir, "big.log");
    fs.writeFileSync(file, "y".repeat(100));
    const result = rotateLogFile(file, { maxBytes: 100, maxRotations: 3 });
    assert.equal(result.rotated, true);
    assert.equal(result.sizeBefore, 100);
    assert.ok(fs.existsSync(`${file}.1`));
    assert.equal(fs.readFileSync(file, "utf8"), "", "active file must be reset to empty, not deleted");
  });

  test("existing rotated generations are shifted, not overwritten", () => {
    const file = path.join(dir, "server.out.log");
    fs.writeFileSync(file, "current".padEnd(20, "-"));
    fs.writeFileSync(`${file}.1`, "gen1");
    fs.writeFileSync(`${file}.2`, "gen2");
    rotateLogFile(file, { maxBytes: 10, maxRotations: 3 });
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "current".padEnd(20, "-"), "old active becomes .1");
    assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "gen1", "old .1 becomes .2");
    assert.equal(fs.readFileSync(`${file}.3`, "utf8"), "gen2", "old .2 becomes .3");
  });

  test("retention overflow drops the oldest generation and keeps exactly maxRotations", () => {
    const file = path.join(dir, "server.out.log");
    fs.writeFileSync(file, "current".padEnd(20, "-"));
    fs.writeFileSync(`${file}.1`, "gen1");
    fs.writeFileSync(`${file}.2`, "gen2");
    fs.writeFileSync(`${file}.3`, "gen3-should-be-deleted");
    rotateLogFile(file, { maxBytes: 10, maxRotations: 3 });
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "current".padEnd(20, "-"));
    assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "gen1");
    assert.equal(fs.readFileSync(`${file}.3`, "utf8"), "gen2", "gen2 takes the retention boundary slot");
    assert.equal(fs.existsSync(`${file}.4`), false, "must not create a 4th generation beyond retention");
  });

  test("rotating twice in a row is stable and never loses the newest generation", () => {
    const file = path.join(dir, "server.out.log");
    fs.writeFileSync(file, "first".padEnd(20, "-"));
    rotateLogFile(file, { maxBytes: 10, maxRotations: 3 });
    fs.writeFileSync(file, "second".padEnd(20, "-"));
    rotateLogFile(file, { maxBytes: 10, maxRotations: 3 });
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "second".padEnd(20, "-"));
    assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "first".padEnd(20, "-"));
  });
});

describe("rotateAllLogs", () => {
  test("rotates every *.log file in the directory independently", () => {
    fs.writeFileSync(path.join(dir, "server.out.log"), "a".repeat(20));
    fs.writeFileSync(path.join(dir, "server.err.log"), "b".repeat(2));
    fs.writeFileSync(path.join(dir, "web.out.log"), "c".repeat(20));
    const results = rotateAllLogs(dir, { maxBytes: 10, maxRotations: 3 });
    const byFile = Object.fromEntries(results.map((r) => [path.basename(r.file), r]));
    assert.equal(byFile["server.out.log"].rotated, true);
    assert.equal(byFile["server.err.log"].rotated, false, "small file must stay untouched");
    assert.equal(byFile["web.out.log"].rotated, true);
  });

  test("does not touch already-rotated siblings or unrelated files", () => {
    fs.writeFileSync(path.join(dir, "server.out.log"), "a".repeat(20));
    fs.writeFileSync(path.join(dir, "server.out.log.1"), "old generation, must not be treated as a fresh log");
    fs.writeFileSync(path.join(dir, "notes.txt"), "unrelated file, must never be touched");
    const results = rotateAllLogs(dir, { maxBytes: 10, maxRotations: 3 });
    assert.equal(results.length, 1, "only the one real *.log file should have been considered");
    assert.equal(
      fs.readFileSync(path.join(dir, "notes.txt"), "utf8"),
      "unrelated file, must never be touched",
    );
  });

  test("a missing log directory is handled without throwing", () => {
    const results = rotateAllLogs(path.join(dir, "does-not-exist"), { maxBytes: 10, maxRotations: 3 });
    assert.deepEqual(results, []);
  });
});
