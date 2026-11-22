import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexCommandLoop, codexExitStatus } from "../src/codex-run.js";

const result = (command: string, output = "same result") => ({ command, aggregated_output: output, exit_code: 0, status: "completed" });

test("identical command results can trigger a stop even with other commands between repeats", () => {
  const loop = new CodexCommandLoop();
  for (let i = 0; i < 4; i++) {
    assert.equal(loop.record(result("ls -a")), false);
    assert.equal(loop.record(result(`read check-${i}`)), false);
  }
  assert.equal(loop.record(result("ls -a")), true);
});

test("changed results, file changes, and explicit waits do not count as a loop", () => {
  const loop = new CodexCommandLoop();
  for (let i = 0; i < 20; i++) {
    assert.equal(loop.record(result("git status", String(i))), false);
    assert.equal(loop.record(result("kubectl rollout status deployment/app")), false);
  }
  for (let i = 0; i < 4; i++) assert.equal(loop.record(result("ls -a")), false);
  loop.reset();
  assert.equal(loop.record(result("ls -a")), false);
  for (let i = 0; i < 45; i++) assert.equal(loop.record(result(`read check-${i}`)), false);
  assert.equal(loop.record(result("ls -a")), false);
});

test("a CLI exit without turn completion cannot be reported as completed", () => {
  const cleanExit = { code: 0, signal: null, stopRequested: false };
  assert.equal(codexExitStatus(cleanExit), "stopped");
  assert.equal(codexExitStatus({ ...cleanExit, code: 130 }), "stopped");
  assert.equal(codexExitStatus({ ...cleanExit, code: null, signal: "SIGTERM" }), "stopped");
  assert.equal(codexExitStatus({ ...cleanExit, turn: "interrupted" }), "stopped");
  assert.equal(codexExitStatus({ ...cleanExit, stopRequested: true, turn: "completed" }), "stopped");
  assert.equal(codexExitStatus({ ...cleanExit, turn: "completed" }), "completed");
  assert.equal(codexExitStatus({ ...cleanExit, turn: "failed" }), "failed");
  assert.equal(codexExitStatus({ ...cleanExit, code: 2 }), "failed");
});
