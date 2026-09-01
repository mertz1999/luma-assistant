/**
 * Timezone-aware daily-recurrence time math, extracted from index.ts
 * unchanged (same algorithm, same call sites) but parameterized by
 * timezone instead of hardcoding Asia/Tehran inline. Two reasons this is
 * worth doing now rather than leaving it embedded: (1) it makes the
 * existing iterative-convergence DST handling actually testable -- Iran
 * itself no longer observes DST, so testing this algorithm against
 * Asia/Tehran specifically would never exercise a real transition; a zone
 * that reliably has DST (e.g. America/New_York) proves the ALGORITHM is
 * correct without inventing new semantics, and (2) the same "next daily
 * occurrence" concept is what the scheduler's missed-run reconciliation
 * needs to reason about below.
 *
 * Preserves the existing scope deliberately: daily time-of-day recurrence
 * only, no cron, no per-schedule timezone in the actual product (every
 * caller still passes Asia/Tehran) -- this file does not add either.
 */

export interface DailyRecurrenceTime {
  hour: number;
  minute: number;
  timezone: string;
}

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function timezoneDateParts(timestamp: number, timezone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/**
 * Converts a local wall-clock time in `timezone` to a UTC timestamp, via
 * iterative convergence (up to 3 corrections) rather than a naive fixed
 * offset -- this is what makes DST transitions produce a deterministic,
 * documented result instead of an accidental one:
 *   - Spring-forward (a local time that never occurred, e.g. 2:30 AM on
 *     the day clocks jump from 2:00 to 3:00): converges on the nearest
 *     representable instant the formatter agrees maps back to a time at
 *     or after the requested wall-clock time -- effectively rolls forward
 *     past the gap, never backward into the prior day.
 *   - Fall-back (a local time that occurs twice, e.g. 1:30 AM when clocks
 *     repeat the 1:00-2:00 hour): converges on the FIRST occurrence,
 *     because the guess starts from the naive UTC interpretation and the
 *     formatter's offset correction stabilizes there first.
 * See schedule-time.test.ts for both cases proven against a real
 * DST-observing zone, not just asserted.
 */
export function localToTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let index = 0; index < 3; index += 1) {
    const actual = timezoneDateParts(guess, timezone);
    const actualLocal = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, 0);
    const desiredLocal = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const diff = actualLocal - desiredLocal;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

export function addLocalDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/** Next occurrence of `time` (a daily wall-clock time-of-day) strictly after `afterTimestamp`. */
export function nextDailyRun(time: DailyRecurrenceTime, afterTimestamp: number): number {
  const parts = timezoneDateParts(afterTimestamp, time.timezone);
  let candidate = localToTimestamp(parts.year, parts.month, parts.day, time.hour, time.minute, time.timezone);
  if (candidate <= afterTimestamp) {
    const nextDay = addLocalDays(parts.year, parts.month, parts.day, 1);
    candidate = localToTimestamp(nextDay.year, nextDay.month, nextDay.day, time.hour, time.minute, time.timezone);
  }
  return candidate;
}

export type MissedRunPolicy = "skip" | "run_once";

export type MissedRunDecision =
  | { action: "none" } // not actually overdue, or already claimed
  | { action: "skip"; missedOccurrenceAt: number }
  | { action: "run_once"; missedOccurrenceAt: number };

/**
 * Pure decision for what to do about a schedule whose persisted
 * `nextRunAt` was already at-or-before `now` when Luma started up --
 * i.e. at least one occurrence became due while the server was offline
 * (or it crashed before ever claiming it -- see occurrenceAlreadyClaimed).
 *
 * `occurrenceAlreadyClaimed` must be true when a durable execution record
 * already exists for (scheduleId, that exact nextRunAt) -- i.e. the
 * occurrence was claimed (and possibly dispatched) before whatever
 * stopped the process, in which case this is NOT a missed occurrence at
 * all, just a normal restart mid-flight (Case B/C): the run's own crash
 * recovery is authoritative, and the scheduler must not treat it as
 * missed or dispatch anything new for it.
 */
export function decideMissedRun(input: {
  nextRunAt: number | null;
  now: number;
  policy: MissedRunPolicy;
  occurrenceAlreadyClaimed: boolean;
}): MissedRunDecision {
  if (input.nextRunAt === null || input.nextRunAt > input.now) return { action: "none" };
  if (input.occurrenceAlreadyClaimed) return { action: "none" };
  return input.policy === "run_once"
    ? { action: "run_once", missedOccurrenceAt: input.nextRunAt }
    : { action: "skip", missedOccurrenceAt: input.nextRunAt };
}
