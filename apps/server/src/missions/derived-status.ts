import type { Mission, MissionStatus, RunRecord, RunStatus } from "@luma/shared";
import { TERMINAL_MISSION_STATUSES } from "./mission-state.js";

/**
 * Derived-only marker: this is never added to the persisted MissionStatus
 * enum or to mission-state.ts's transition table -- a mission's own
 * `status` field and legal transitions are completely unchanged by this
 * module. STALE_ACTIVE only ever appears in the read-time `effectiveStatus`
 * computed below.
 */
export const STALE_ACTIVE = "STALE_ACTIVE" as const;
export type EffectiveMissionStatus = MissionStatus | typeof STALE_ACTIVE;

const LIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"];

/**
 * Pure, deterministic derivation of a mission's *effective* status from
 * durable facts, rather than trusting the persisted `mission.status`
 * directly (the AO evaluation's "derived status from durable facts"
 * concept -- see docs/experiments/cline-ao-evaluation/FINDINGS.md).
 *
 * The gap this closes: RunManager.loadPersisted() (index.ts) already
 * reconciles a crashed run's OWN status to "failed" on restart via
 * reconcileStaleRunPid() (recovery.ts) -- correctly. But nothing ever
 * re-syncs the MISSION that owns that run. A mission attached to a run
 * that has since crashed, completed, or been stopped stays stored as
 * ACTIVE indefinitely unless an operator explicitly calls
 * MissionManager.setStatus(). That's exactly the "stored status is
 * commonly trusted and can become stale" class of bug.
 *
 * Precedence (highest first):
 *   1. mission.status is terminal (COMPLETED/FAILED/CANCELLED) -- terminal
 *      never transitions (mission-state.ts's ALLOWED_TRANSITIONS), and no
 *      run fact can override that. Matches the historical-incident case
 *      "terminal completion wins even with stale worker metadata."
 *   2. mission.status is PENDING -- no run has ever been attached
 *      (MissionManager.attachRun auto-advances PENDING -> ACTIVE on the
 *      first one); there is nothing to derive from yet.
 *   3. mission.status is ACTIVE -- ACTIVE only ever meant "at least one
 *      run was attached," never "a run is currently alive." If any
 *      attached run's own status is still "queued"/"running", the
 *      mission is genuinely in progress: ACTIVE. Otherwise every
 *      attached run has already resolved to a terminal run status
 *      (completed/failed/stopped) -- most commonly because restart-time
 *      reconciliation already marked a crashed run "failed" -- and the
 *      mission's stored ACTIVE is stale: STALE_ACTIVE.
 *
 * Deliberately does no I/O and no live PID check: RunManager.loadPersisted()
 * already performs the one real OS-level liveness check a restart needs,
 * so by the time this runs, `run.status` already reflects reality;
 * re-checking here would duplicate that impurely and make this untestable
 * without mocking the OS. A run that dies mid-session (no restart in
 * between) is a narrower, separate gap this Phase A slice does not close
 * -- see FINDINGS.md's remaining questions.
 */
export function deriveMissionEffectiveStatus(
  mission: Pick<Mission, "status">,
  attachedRuns: readonly Pick<RunRecord, "status">[],
): EffectiveMissionStatus {
  if ((TERMINAL_MISSION_STATUSES as readonly MissionStatus[]).includes(mission.status)) {
    return mission.status;
  }
  if (mission.status === "PENDING") {
    return "PENDING";
  }
  // Only "ACTIVE" remains (MISSION_STATUSES has exactly these five values).
  const hasLiveRun = attachedRuns.some((run) => LIVE_RUN_STATUSES.includes(run.status));
  return hasLiveRun ? "ACTIVE" : STALE_ACTIVE;
}
