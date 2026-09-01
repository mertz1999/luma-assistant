import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isProcessAlive, killProcessTree } from "./platform/process-utils.js";
import { reconcileStaleRunPid } from "./recovery.js";

test("reconcileStaleRunPid: no recorded pid at all -> not an orphan, generic restart message", () => {
  const result = reconcileStaleRunPid({ pid: null, config: { runner: "codex" } });
  assert.equal(result.orphanKilled, false);
  assert.match(result.message, /no live process is attached/);
});

test("reconcileStaleRunPid: recorded pid is already dead -> not an orphan", () => {
  const result = reconcileStaleRunPid({ pid: 999999, config: { runner: "codex" } });
  assert.equal(result.orphanKilled, false);
  assert.match(result.message, /no live process is attached/);
});

test("reconcileStaleRunPid: pid alive and command line matches the runner -> confirmed orphan, killed for real", async () => {
  // A real process whose command line contains "codex" -- via a script
  // filename argument, standing in for what a real Codex CLI invocation's
  // command line would contain.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "codex-marker"], {
    stdio: "ignore",
  });
  assert.ok(child.pid);
  await new Promise((r) => setTimeout(r, 300));

  try {
    const result = reconcileStaleRunPid({ pid: child.pid!, config: { runner: "codex" } });
    assert.equal(result.orphanKilled, true);
    assert.match(result.message, /orphaned process.*was found and terminated/);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessAlive(child.pid!)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(isProcessAlive(child.pid!), false, "the confirmed orphan must actually be terminated, not just reported as such");
  } finally {
    killProcessTree(child.pid, "SIGKILL"); // safety net if the assertion above failed
  }
});

test("reconcileStaleRunPid: pid alive but command line does NOT match the runner -> left untouched (do not kill an unrelated process)", async () => {
  // Deliberately does not mention "codex" or "claude" anywhere in its argv,
  // standing in for an unrelated process that happens to reuse a recorded pid.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "totally-unrelated-process"], {
    stdio: "ignore",
  });
  assert.ok(child.pid);
  await new Promise((r) => setTimeout(r, 300));

  try {
    const result = reconcileStaleRunPid({ pid: child.pid!, config: { runner: "codex" } });
    assert.equal(result.orphanKilled, false);
    assert.match(result.message, /left untouched to avoid terminating an unrelated process/);
    assert.equal(isProcessAlive(child.pid!), true, "an unconfirmed process must NOT be killed -- this is the fail-closed guarantee");
  } finally {
    killProcessTree(child.pid, "SIGKILL"); // test cleanup, not part of what's under test
  }
});

test("reconcileStaleRunPid: is idempotent -- calling it again after the pid is already dead does not error or re-kill anything", () => {
  const first = reconcileStaleRunPid({ pid: 999998, config: { runner: "claude" } });
  const second = reconcileStaleRunPid({ pid: 999998, config: { runner: "claude" } });
  assert.deepEqual(first, second);
});
