import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransitionMissionStatus, MISSION_STATUSES, TERMINAL_MISSION_STATUSES } from "./mission-state.js";

test("PENDING -> ACTIVE is allowed (first session attached)", () => {
  const result = canTransitionMissionStatus("PENDING", "ACTIVE");
  assert.equal(result.allowed, true);
});

test("PENDING -> CANCELLED is allowed (cancelled before any work started)", () => {
  const result = canTransitionMissionStatus("PENDING", "CANCELLED");
  assert.equal(result.allowed, true);
});

test("PENDING -> COMPLETED is NOT allowed (cannot complete before any session exists)", () => {
  const result = canTransitionMissionStatus("PENDING", "COMPLETED");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not a legal transition/);
});

test("ACTIVE -> ACTIVE is allowed (attaching another session to an ongoing mission)", () => {
  const result = canTransitionMissionStatus("ACTIVE", "ACTIVE");
  assert.equal(result.allowed, true);
});

test("ACTIVE -> COMPLETED/FAILED/CANCELLED are all allowed", () => {
  for (const to of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
    assert.equal(canTransitionMissionStatus("ACTIVE", to).allowed, true, `ACTIVE -> ${to} should be allowed`);
  }
});

test("every terminal status refuses every further transition, including into itself", () => {
  for (const from of TERMINAL_MISSION_STATUSES) {
    for (const to of MISSION_STATUSES) {
      const result = canTransitionMissionStatus(from, to);
      assert.equal(result.allowed, false, `${from} -> ${to} must be refused (terminal state)`);
      assert.match(result.reason, /terminal status/);
    }
  }
});

test("PENDING -> FAILED is NOT allowed (a mission must become ACTIVE before it can fail)", () => {
  const result = canTransitionMissionStatus("PENDING", "FAILED");
  assert.equal(result.allowed, false);
});
