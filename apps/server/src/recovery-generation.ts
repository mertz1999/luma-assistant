/**
 * Pure decision logic for event-generation fencing (spec: "old ownership
 * must not be able to mutate current run state"). Extracted out of
 * RunManager in index.ts -- which owns the actual wiring (capturing
 * `runGeneration` per spawn attempt, routing the specific high-risk
 * mutations through it, persisting `ownerGeneration`) -- the same pattern
 * already used for mission-state.ts, resource-watchdog.ts, and
 * policy-engine.ts: the small, independently-testable comparison/derivation
 * function lives here; the imperative process-spawning/event-handler code
 * that calls it stays in index.ts. See
 * docs/architecture/event-generation-fencing.md for the full design.
 *
 * The problem this closes: RunManager.loadPersisted() already reconciles a
 * crashed run's own status to "failed" on restart via reconcileStaleRunPid()
 * (recovery.ts) -- correctly. What it does NOT do on its own is stop an
 * asynchronous event that was scheduled under an OLDER spawn attempt (a
 * process exit/error handler, a timeout escalation) from later mutating
 * that same run's state, if such an event could somehow still fire after
 * a newer attempt/generation has taken ownership. Every run is stamped
 * with the controller-process generation that owns it
 * (RunRecord.ownerGeneration); every closure created for a given spawn
 * captures that same value; before any of the high-risk mutations those
 * closures produce is applied, the run's CURRENTLY-persisted
 * ownerGeneration is compared against the value the closure captured --
 * see shouldApplyEvent().
 */

/**
 * Whether a mutation produced by an event captured under `eventGeneration`
 * may still be applied to a run whose currently-persisted ownership is
 * `currentGeneration`. Trivial by design -- the whole point of extracting
 * this is that the *comparison* itself must never grow ad-hoc variants
 * scattered across call sites (see RunManager.updateRunIfCurrentGeneration,
 * the single place that calls this).
 */
export function shouldApplyEvent(currentGeneration: number, eventGeneration: number): boolean {
  return currentGeneration === eventGeneration;
}

/**
 * The generation a freshly-starting controller process should use for
 * every run it goes on to create or reclaim, given the ownerGeneration
 * values already present in the runs it just loaded from disk.
 *
 * Always strictly greater than anything already seen: this is what
 * guarantees a new process's events can never be mistaken for current by
 * an older process's still-open runs.json snapshot (see
 * docs/architecture/event-generation-fencing.md's "duplicate controller"
 * section for the limit of what this alone can and cannot protect
 * against), and what guarantees a stale event captured under an OLD
 * process's generation cannot coincidentally match a NEW process's
 * generation for a run that old process never even knew about.
 *
 * Runs with no ownerGeneration at all (persisted before this field
 * existed) are treated as generation 0 -- lower than any generation a
 * real process ever computes for itself (this function always returns at
 * least 1), so a legacy run is never mistaken for "owned by the current
 * process" until something in the current process actually spawns or
 * reclaims it.
 */
export function computeNextControllerGeneration(priorRunGenerations: readonly (number | undefined)[]): number {
  const highestPrior = priorRunGenerations.reduce((max: number, generation) => Math.max(max, generation ?? 0), 0);
  return highestPrior + 1;
}
