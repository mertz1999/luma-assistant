/**
 * Pure mission status state machine (spec CH07: "make failures first
 * class... every task should have explicit states"). Scoped to what this
 * first slice of missions actually is: a persistent entity that owns a set
 * of sessions/runs, not yet a full task graph -- PENDING/READY/WAITING_
 * DEPENDENCY/TIMED_OUT/RECOVERING/BLOCKED from the fuller spec vocabulary
 * belong to individual TASKS inside a mission, which don't exist yet
 * (deliberately not built this phase, see the accompanying commit).
 *
 * Kept separate from mission-manager.ts (which lives in index.ts alongside
 * RunManager, since it needs deep integration with existing run/session
 * persistence) so the actual decision logic -- which transitions are
 * legal -- is a small, pure, independently testable function, matching
 * the same pattern already used for policy-engine.ts and
 * resource-watchdog.ts.
 */

export const MISSION_STATUSES = ["PENDING", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

const ALLOWED_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  PENDING: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["ACTIVE", "COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export interface TransitionCheck {
  allowed: boolean;
  reason: string;
}

/**
 * Whether moving a mission from `from` to `to` is a legal transition.
 * Terminal statuses (COMPLETED/FAILED/CANCELLED) never transition to
 * anything else -- once a mission is done, it stays done; a mistaken
 * completion is corrected by creating a new mission, not by mutating
 * history, matching the append-only spirit used elsewhere in this codebase
 * (the audit log, run event streams).
 */
export function canTransitionMissionStatus(from: MissionStatus, to: MissionStatus): TransitionCheck {
  if (from === to && from === "ACTIVE") {
    return { allowed: true, reason: "ACTIVE -> ACTIVE is allowed (attaching another session to an ongoing mission)." };
  }
  if (TERMINAL_MISSION_STATUSES.includes(from)) {
    return { allowed: false, reason: `Mission is already ${from}, a terminal status; it cannot transition to ${to}.` };
  }
  const allowed = ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
  return {
    allowed,
    reason: allowed
      ? `${from} -> ${to} is a legal transition.`
      : `${from} -> ${to} is not a legal transition. Allowed from ${from}: ${ALLOWED_TRANSITIONS[from]?.join(", ") || "(none)"}.`,
  };
}
