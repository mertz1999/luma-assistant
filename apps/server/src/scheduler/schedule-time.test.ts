import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addLocalDays,
  decideMissedRun,
  localToTimestamp,
  nextDailyRun,
  timezoneDateParts,
} from "./schedule-time.js";

test("nextDailyRun: a future one-time occurrence today resolves to today at that time", () => {
  // 2026-06-15 12:00:00 UTC == 2026-06-15 in most zones; use a fixed UTC zone for determinism.
  const after = Date.UTC(2026, 5, 15, 8, 0, 0); // 08:00 UTC
  const next = nextDailyRun({ hour: 12, minute: 0, timezone: "UTC" }, after);
  assert.equal(new Date(next).toISOString(), "2026-06-15T12:00:00.000Z");
});

test("nextDailyRun: recurring -- once today's occurrence has passed, the next one is tomorrow at the same time", () => {
  const after = Date.UTC(2026, 5, 15, 14, 0, 0); // after 12:00 UTC has already passed
  const next = nextDailyRun({ hour: 12, minute: 0, timezone: "UTC" }, after);
  assert.equal(new Date(next).toISOString(), "2026-06-16T12:00:00.000Z");
});

test("nextDailyRun: exactly at the due time is treated as already passed (next occurrence is tomorrow, not a re-fire of now)", () => {
  const after = Date.UTC(2026, 5, 15, 12, 0, 0);
  const next = nextDailyRun({ hour: 12, minute: 0, timezone: "UTC" }, after);
  assert.equal(new Date(next).toISOString(), "2026-06-16T12:00:00.000Z");
});

test("localToTimestamp + timezoneDateParts round-trip for a normal (non-DST-boundary) local time", () => {
  const ts = localToTimestamp(2026, 6, 15, 9, 30, "America/New_York");
  const parts = timezoneDateParts(ts, "America/New_York");
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 30);
  assert.equal(parts.day, 15);
});

test("DST spring-forward: a local time inside the skipped hour rolls forward to the equivalent post-jump instant, documented and empirically verified (America/New_York, real 2026 transition on 2026-03-08)", () => {
  // 2:30 AM does not exist on 2026-03-08 in America/New_York (clocks jump 2:00 -> 3:00).
  const ts = localToTimestamp(2026, 3, 8, 2, 30, "America/New_York");
  assert.equal(new Date(ts).toISOString(), "2026-03-08T07:30:00.000Z");
  const parts = timezoneDateParts(ts, "America/New_York");
  // Documented actual behavior: converges to 3:30 AM EDT (the jump amount later), not 1:30 AM and not an error.
  assert.equal(parts.hour, 3);
  assert.equal(parts.minute, 30);
});

test("DST fall-back: a local time inside the repeated hour resolves to the FIRST occurrence, documented and empirically verified (America/New_York, real 2026 transition on 2026-11-01)", () => {
  // 1:30 AM occurs twice on 2026-11-01 in America/New_York (EDT 1:30, then EST 1:30 an hour later).
  const ts = localToTimestamp(2026, 11, 1, 1, 30, "America/New_York");
  // The earlier (EDT) instant, not the later (EST) one -- verified against both real candidate instants.
  assert.equal(new Date(ts).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.notEqual(new Date(ts).toISOString(), "2026-11-01T06:30:00.000Z");
});

test("addLocalDays: crosses a month boundary correctly", () => {
  const result = addLocalDays(2026, 1, 31, 1);
  assert.deepEqual(result, { year: 2026, month: 2, day: 1 });
});

test("addLocalDays: crosses a year boundary correctly", () => {
  const result = addLocalDays(2026, 12, 31, 1);
  assert.deepEqual(result, { year: 2027, month: 1, day: 1 });
});

test("decideMissedRun: not overdue at all -> no action", () => {
  const result = decideMissedRun({ nextRunAt: Date.now() + 60_000, now: Date.now(), policy: "skip", occurrenceAlreadyClaimed: false });
  assert.deepEqual(result, { action: "none" });
});

test("decideMissedRun: no schedule armed (nextRunAt null, e.g. paused) -> no action", () => {
  const result = decideMissedRun({ nextRunAt: null, now: Date.now(), policy: "run_once", occurrenceAlreadyClaimed: false });
  assert.deepEqual(result, { action: "none" });
});

test("decideMissedRun: overdue but already claimed (a real execution record exists) -> no action, existing run-crash-recovery is authoritative", () => {
  const now = Date.now();
  const result = decideMissedRun({ nextRunAt: now - 60_000, now, policy: "run_once", occurrenceAlreadyClaimed: true });
  assert.deepEqual(result, { action: "none" });
});

test("decideMissedRun: overdue, not claimed, policy=skip -> skip", () => {
  const now = Date.now();
  const missedAt = now - 60_000;
  const result = decideMissedRun({ nextRunAt: missedAt, now, policy: "skip", occurrenceAlreadyClaimed: false });
  assert.deepEqual(result, { action: "skip", missedOccurrenceAt: missedAt });
});

test("decideMissedRun: overdue, not claimed, policy=run_once -> run_once for exactly the recorded occurrence (not N historical ones)", () => {
  const now = Date.now();
  const missedAt = now - 3 * 24 * 60 * 60 * 1000; // 3 days overdue, e.g. offline over a long weekend
  const result = decideMissedRun({ nextRunAt: missedAt, now, policy: "run_once", occurrenceAlreadyClaimed: false });
  assert.deepEqual(result, { action: "run_once", missedOccurrenceAt: missedAt });
});
