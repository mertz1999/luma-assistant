import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMissionEffectiveStatus } from "./derived-status.js";
import { shouldApplyEvent } from "../recovery-generation.js";

/**
 * Regression coverage for the interaction between event-generation fencing
 * and derived-status Phase A (spec: "ensure stale events cannot create
 * fact combinations that produce incorrect effective status" --
 * docs/architecture/event-generation-fencing.md's Derived Status
 * Compatibility section). Both are pure functions, so the composition is
 * fully testable without spinning up RunManager or a real process: this
 * simulates exactly what RunManager.updateRunIfCurrentGeneration()
 * guarantees in practice -- a rejected stale event never lands in
 * `this.runs`, so the run's `status` (the durable fact
 * deriveMissionEffectiveStatus reads) stays whatever it legitimately was.
 */

test("stale failure rejected + current worker still alive -> mission's effective status remains ACTIVE, not STALE_ACTIVE", () => {
  // A stale generation-10 failure event arrives for a run whose current
  // owner is generation 11.
  const eventAccepted = shouldApplyEvent(/* currentGeneration */ 11, /* eventGeneration */ 10);
  assert.equal(eventAccepted, false, "the stale failure must be rejected before it ever reaches run.status");

  // Because it was rejected, the run's persisted status is untouched --
  // still "running" (the current, generation-11 attempt is genuinely
  // still in progress). This is the fact deriveMissionEffectiveStatus
  // actually reads; it has no idea a stale event was even attempted.
  const runStatusAfterRejectedEvent = "running" as const;
  const effectiveStatus = deriveMissionEffectiveStatus({ status: "ACTIVE" }, [{ status: runStatusAfterRejectedEvent }]);

  assert.equal(effectiveStatus, "ACTIVE", "a correctly-fenced stale failure must not turn a genuinely live mission into STALE_ACTIVE");
});

test("stale completion rejected + current worker still alive -> mission's effective status remains ACTIVE", () => {
  const eventAccepted = shouldApplyEvent(5, 4);
  assert.equal(eventAccepted, false);

  const effectiveStatus = deriveMissionEffectiveStatus({ status: "ACTIVE" }, [{ status: "running" }]);
  assert.equal(effectiveStatus, "ACTIVE");
});

test("CONTRAST -- a genuinely current-generation failure IS applied, and derived status correctly reflects it as STALE_ACTIVE (an operator/agent must still close the mission)", () => {
  const eventAccepted = shouldApplyEvent(11, 11);
  assert.equal(eventAccepted, true, "a matching-generation event must be applied, not fenced");

  // Because it was applied, the run's persisted status is now "failed" --
  // this is what actually happens inside updateRunIfCurrentGeneration when
  // shouldApplyEvent returns true.
  const runStatusAfterAppliedEvent = "failed" as const;
  const effectiveStatus = deriveMissionEffectiveStatus({ status: "ACTIVE" }, [{ status: runStatusAfterAppliedEvent }]);

  assert.equal(effectiveStatus, "STALE_ACTIVE", "a genuinely current failure must still surface as a stale-relative-to-mission-status mismatch for an operator to see");
});

test("terminal mission status still wins over any run fact, fenced or not (unchanged from Phase A -- generation fencing adds a new durable fact, it does not touch mission-state.ts's precedence)", () => {
  const effectiveStatus = deriveMissionEffectiveStatus({ status: "COMPLETED" }, [{ status: "running" }]);
  assert.equal(effectiveStatus, "COMPLETED");
});
