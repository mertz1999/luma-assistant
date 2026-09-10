import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMissionEffectiveStatus, STALE_ACTIVE } from "./derived-status.js";
import type { MissionStatus, RunStatus } from "@luma/shared";

function mission(status: MissionStatus) {
  return { status };
}

function run(status: RunStatus) {
  return { status };
}

test("PENDING mission with no attached runs derives to PENDING", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("PENDING"), []), "PENDING");
});

test("PENDING mission is PENDING even if (illegally) passed run facts -- precedence still checked before runs", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("PENDING"), [run("running")]), "PENDING");
});

test("ACTIVE mission with a running run derives to ACTIVE", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("ACTIVE"), [run("running")]), "ACTIVE");
});

test("ACTIVE mission with a queued run derives to ACTIVE", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("ACTIVE"), [run("queued")]), "ACTIVE");
});

test("REAL INCIDENT -- stale PID: ACTIVE mission whose only run was reconciled to failed after a restart derives to STALE_ACTIVE, not ACTIVE", () => {
  // Mirrors RunManager.loadPersisted()'s real restart-time reconciliation:
  // reconcileStaleRunPid() already flipped this run's own status to
  // "failed" before deriveMissionEffectiveStatus ever runs. The mission's
  // stored status is still "ACTIVE" because nothing re-synced it.
  assert.equal(deriveMissionEffectiveStatus(mission("ACTIVE"), [run("failed")]), STALE_ACTIVE);
});

test("ACTIVE mission whose only run completed derives to STALE_ACTIVE (an operator/agent still needs to close the mission)", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("ACTIVE"), [run("completed")]), STALE_ACTIVE);
});

test("ACTIVE mission whose only run was stopped derives to STALE_ACTIVE", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("ACTIVE"), [run("stopped")]), STALE_ACTIVE);
});

test("ACTIVE mission with zero attached runs derives to STALE_ACTIVE (should not normally happen -- attachRun is what sets ACTIVE -- but must not crash or claim ACTIVE with no evidence)", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("ACTIVE"), []), STALE_ACTIVE);
});

test("CONFLICTING FACTS -- one dead run and one live run attached: the live run wins, mission is genuinely ACTIVE", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("ACTIVE"), [run("failed"), run("running")]), "ACTIVE");
});

test("CONFLICTING FACTS -- multiple dead runs, no live run: STALE_ACTIVE", () => {
  assert.equal(deriveMissionEffectiveStatus(mission("ACTIVE"), [run("completed"), run("failed"), run("stopped")]), STALE_ACTIVE);
});

for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
  test(`REAL INCIDENT -- terminal completion wins: ${terminal} mission stays ${terminal} even with a "live" run fact present (stale worker metadata)`, () => {
    assert.equal(deriveMissionEffectiveStatus(mission(terminal), [run("running")]), terminal);
  });

  test(`${terminal} mission with no run facts at all still derives to ${terminal}`, () => {
    assert.equal(deriveMissionEffectiveStatus(mission(terminal), []), terminal);
  });
}

test("RESTART/RELOAD semantics -- deriving twice on the same already-reconciled facts is stable (pure function, no hidden state)", () => {
  const m = mission("ACTIVE");
  const runs = [run("failed")];
  const first = deriveMissionEffectiveStatus(m, runs);
  const second = deriveMissionEffectiveStatus(m, runs);
  assert.equal(first, STALE_ACTIVE);
  assert.equal(second, STALE_ACTIVE);
  assert.equal(first, second);
});

test("RESTART/RELOAD semantics -- before restart-time reconciliation the same mission read ACTIVE (run still says 'running'); after RunManager's real reconciliation flips the run to 'failed', deriving again with the updated fact changes the result without any code path other than the run's own status changing", () => {
  const m = mission("ACTIVE");
  const beforeRestart = deriveMissionEffectiveStatus(m, [run("running")]);
  assert.equal(beforeRestart, "ACTIVE");
  const afterRestartReconciliation = deriveMissionEffectiveStatus(m, [run("failed")]);
  assert.equal(afterRestartReconciliation, STALE_ACTIVE);
});
