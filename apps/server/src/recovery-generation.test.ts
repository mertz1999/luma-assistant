import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldApplyEvent, computeNextControllerGeneration } from "./recovery-generation.js";

// ---------------------------------------------------------------------
// computeNextControllerGeneration -- generation assignment/persistence
// ---------------------------------------------------------------------

test("generation assigned: a controller starting with no persisted runs at all gets generation 1", () => {
  assert.equal(computeNextControllerGeneration([]), 1);
});

test("generation assigned: a controller starting where every persisted run has no ownerGeneration (legacy data) gets generation 1, not 0", () => {
  assert.equal(computeNextControllerGeneration([undefined, undefined, undefined]), 1);
});

test("ownership transfer advances generation: a controller starting where the highest persisted ownerGeneration is 5 gets generation 6", () => {
  assert.equal(computeNextControllerGeneration([1, 3, 5, 2]), 6);
});

test("generation persists / restart semantics: restarting again from what the PREVIOUS restart just computed keeps advancing monotonically, never resetting", () => {
  const gen1 = computeNextControllerGeneration([]); // first-ever boot
  assert.equal(gen1, 1);
  const gen2 = computeNextControllerGeneration([gen1, gen1, gen1]); // next restart sees only gen1-stamped runs
  assert.equal(gen2, 2);
  const gen3 = computeNextControllerGeneration([gen1, gen2]); // a restart after that
  assert.equal(gen3, 3);
});

test("DUPLICATE CONTROLLER scenario: a second process loading the SAME runs.json a first process already stamped never reuses or undercuts that generation", () => {
  // Process A boots, computes its own generation, and (by spawning runs)
  // ends up with persisted runs stamped ownerGeneration=5.
  const processAGeneration = 5;
  // Process B starts later, loading that same file. Whatever B computes
  // for itself must be strictly greater than 5 -- if it were allowed to
  // equal or fall below 5, a still-alive Process A (this is exactly the
  // "duplicate controller" case AO's own daemon-singleton gap
  // demonstrated is real) could later apply an event whose captured
  // generation (5) would then pass B's own fence checks by coincidence.
  const processBGeneration = computeNextControllerGeneration([processAGeneration]);
  assert.equal(processBGeneration, 6);
  assert.ok(processBGeneration > processAGeneration);
});

// ---------------------------------------------------------------------
// shouldApplyEvent -- the actual mutation guard
// ---------------------------------------------------------------------

test("REAL RACE 1 -- stale completion: generation 10 started run R; ownership changed to 11 before 10's SUCCESS event arrived -> rejected", () => {
  const currentGeneration = 11;
  const staleEventGeneration = 10;
  assert.equal(shouldApplyEvent(currentGeneration, staleEventGeneration), false);
});

test("REAL RACE 2 -- stale failure: same setup, generation 10 later reports FAILURE after 11 owns the run -> rejected", () => {
  assert.equal(shouldApplyEvent(11, 10), false);
});

test("REAL RACE 3 -- stale process exit: generation A owned pid X, ownership moved to generation B, then X's exit event arrives -> rejected (same primitive protects process-exit identically to completion/failure, since RunManager routes exit-handler mutations through the same guard)", () => {
  const generationA = 7;
  const generationB = 8;
  assert.equal(shouldApplyEvent(generationB, generationA), false);
});

test("REAL RACE 4 -- stale timeout: generation A's timeout timer fires after generation B took ownership -> rejected, generation B's run is not cancelled", () => {
  assert.equal(shouldApplyEvent(2, 1), false);
});

test("REAL RACE 5 -- stale retry-shaped callback: even though Luma has no retry mechanism today, the SAME primitive would reject any future async callback captured under an old generation identically to completion/failure/exit/timeout -- there is exactly one comparison, not a family of ad-hoc ones per event type", () => {
  assert.equal(shouldApplyEvent(99, 42), false);
});

test("current-generation success path: completion applies when the event's captured generation still matches", () => {
  assert.equal(shouldApplyEvent(4, 4), true);
});

test("current-generation success path: failure applies when the event's captured generation still matches", () => {
  assert.equal(shouldApplyEvent(1, 1), true);
});

test("current-generation success path: timeout escalation applies when the event's captured generation still matches", () => {
  assert.equal(shouldApplyEvent(1000, 1000), true);
});

test("legacy persisted run: a run with no ownerGeneration at all (normalized to 0 by RunManager) never matches any real controller generation (which is always >= 1), so no stale legacy event can be mistaken for current", () => {
  const legacyRunGeneration = 0; // RunManager.loadPersisted()'s `run.ownerGeneration ?? 0` normalization
  const currentControllerGeneration = computeNextControllerGeneration([]); // 1, on a fresh boot
  assert.equal(shouldApplyEvent(legacyRunGeneration, currentControllerGeneration), false);
});

test("legacy persisted run reclaimed by a live controller: once RunManager.loadPersisted() stamps a reconciled legacy run with the CURRENT generation, an event captured under that same current generation is accepted normally", () => {
  const currentControllerGeneration = computeNextControllerGeneration([]); // 1
  // Mirrors what loadPersisted() does for a stale queued/running legacy
  // run: reconciled runs get ownerGeneration = this.controllerGeneration.
  const reclaimedRunGeneration = currentControllerGeneration;
  assert.equal(shouldApplyEvent(reclaimedRunGeneration, currentControllerGeneration), true);
});

test("shouldApplyEvent is a pure, symmetric equality check -- not an ordering comparison (a newer event generation for an OLDER current state is equally rejected, not specially accepted)", () => {
  // Guards against a subtly wrong implementation using >= instead of ===,
  // which would accept an event generation from the FUTURE relative to
  // the run's current state -- not a real scenario in this codebase (an
  // event's captured generation can never exceed the process's own
  // current generation), but the contract should not silently allow it.
  assert.equal(shouldApplyEvent(5, 6), false);
});
