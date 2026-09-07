import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRunRunner, normalizeReasoningEffort, normalizeSelectedSkillRefs } from "./run-config-normalize.js";

// -- normalizeRunRunner ------------------------------------------------------
// Regression coverage for the qwythos-runner integration: before this fix,
// normalizeRunRunner's fallback ("anything not exactly 'claude' is 'codex'")
// would have silently mapped "qwythos" -> "codex" everywhere this function
// is used, including mission/schedule JSON persistence -- meaning a
// persisted qwythos mission would silently re-load as a codex mission.

test("normalizeRunRunner: 'qwythos' normalizes to 'qwythos' (the actual defect this fixed)", () => {
  assert.equal(normalizeRunRunner("qwythos"), "qwythos");
});

test("normalizeRunRunner: 'claude' still normalizes to 'claude', unchanged", () => {
  assert.equal(normalizeRunRunner("claude"), "claude");
});

test("normalizeRunRunner: 'codex' still normalizes to 'codex', unchanged", () => {
  assert.equal(normalizeRunRunner("codex"), "codex");
});

test("normalizeRunRunner: unknown/garbage input falls back to 'codex' (the safe default), not qwythos or claude", () => {
  assert.equal(normalizeRunRunner("not-a-real-runner"), "codex");
  assert.equal(normalizeRunRunner(undefined), "codex");
  assert.equal(normalizeRunRunner(null), "codex");
  assert.equal(normalizeRunRunner(42), "codex");
  assert.equal(normalizeRunRunner({}), "codex");
});

test("normalizeRunRunner: never falls back to a cloud-only runner name that doesn't exist in the enum", () => {
  // Anything not recognized must land on one of the three real runners,
  // never pass through unchanged as an arbitrary string (which could open a
  // path to routing on an unvalidated provider name downstream).
  const result = normalizeRunRunner("openai");
  assert.ok(result === "codex" || result === "claude" || result === "qwythos");
});

// -- normalizeReasoningEffort / normalizeSelectedSkillRefs -------------------
// Not touched by the qwythos change, but covered here since this is the
// first dedicated test file for run-config-normalize.ts.

test("normalizeReasoningEffort: valid values pass through unchanged", () => {
  for (const value of ["low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(normalizeReasoningEffort(value), value);
  }
});

test("normalizeReasoningEffort: invalid/missing values fall back to 'high'", () => {
  assert.equal(normalizeReasoningEffort("ultra"), "high");
  assert.equal(normalizeReasoningEffort(undefined), "high");
});

test("normalizeSelectedSkillRefs: filters out malformed entries and de-duplicates by id+path", () => {
  const result = normalizeSelectedSkillRefs([
    { id: "a", path: "/skills/a" },
    { id: "a", path: "/skills/a" },
    { id: "b" },
    "not-an-object",
    { id: "  ", path: "/skills/c" },
    { id: "d", path: "/skills/d" },
  ]);
  assert.deepEqual(result, [
    { id: "a", path: "/skills/a" },
    { id: "d", path: "/skills/d" },
  ]);
});

test("normalizeSelectedSkillRefs: non-array input returns an empty array", () => {
  assert.deepEqual(normalizeSelectedSkillRefs(undefined), []);
  assert.deepEqual(normalizeSelectedSkillRefs("nope"), []);
});
