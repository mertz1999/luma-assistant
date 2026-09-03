import type {
  AgentSchedule,
  AgentScheduleExecution,
  AgentScheduleListResponse,
  AgentScheduleTime,
  ReasoningEffort,
  RunConfig,
  RunRecord,
  RunRunner,
  SelectedSkillRef,
} from "@luma/shared";
import { agentScheduleSchema } from "@luma/shared";
import fs from "node:fs";
import { appendAuditEvent } from "../audit/audit-log.js";
import { PolicyDeniedError, ResourceLimitError } from "../errors.js";
import { safeJsonParse, writeJsonAtomicSync } from "../json-file-utils.js";
import { normalizeReasoningEffort, normalizeRunRunner, normalizeSelectedSkillRefs } from "../run-config-normalize.js";
import { decideMissedRun, nextDailyRun } from "./schedule-time.js";

const TEHRAN_TIMEZONE = "Asia/Tehran";

/**
 * Only what AgentScheduleManager actually reads off a discovered agent.
 * Narrower than the server's own DiscoveredAgent type on purpose: this
 * module never imports from index.ts (importing anything -- even a single
 * named export -- from that file would execute its top-level side effects:
 * `app.listen`, loading real persisted state, registering real process
 * signal handlers). A real DiscoveredAgent structurally satisfies this,
 * so production callers pass it through unchanged.
 */
export type AgentDescriptorLike = { id: string; path: string; name: string; prompt: string };

export type PersistedAgentScheduleState = {
  schedules: AgentSchedule[];
  executions: AgentScheduleExecution[];
};

function loadPersistedAgentSchedules(schedulesPath: string): PersistedAgentScheduleState {
  if (!fs.existsSync(schedulesPath)) {
    return { schedules: [], executions: [] };
  }
  const payload = safeJsonParse<PersistedAgentScheduleState>(fs.readFileSync(schedulesPath, "utf8"), {
    schedules: [],
    executions: [],
  });
  return {
    schedules: Array.isArray(payload.schedules) ? payload.schedules : [],
    executions: Array.isArray(payload.executions) ? payload.executions : [],
  };
}

function nextTehranDailyRun(time: AgentScheduleTime, afterTimestamp: number): number {
  return nextDailyRun(time, afterTimestamp);
}

export class AgentScheduleManager {
  private schedules = new Map<string, AgentSchedule>();

  private executions = new Map<string, AgentScheduleExecution>();

  private executionByRunId = new Map<string, string>();

  private timer: NodeJS.Timeout | null = null;

  private readonly discoverAgentsFn: () => AgentDescriptorLike[];

  private readonly schedulesPath: string;

  private readonly auditDir: string;

  private readonly now: () => number;

  private readonly maxConcurrentRuns: number;

  constructor(
    private readonly runManager: { hasCapacity(): boolean },
    private readonly startScheduledRun: (
      schedule: AgentSchedule,
      prompt: string,
      execution: AgentScheduleExecution,
    ) => { run: RunRecord; sessionId: string },
    deps: {
      discoverAgentsFn: () => AgentDescriptorLike[];
      schedulesPath: string;
      auditDir: string;
      /**
       * Injected purely for isolated occurrence-admission testing (see
       * agent-schedule-manager.test.ts) -- production passes Date.now.
       */
      now?: () => number;
      maxConcurrentRuns?: number;
    },
  ) {
    this.discoverAgentsFn = deps.discoverAgentsFn;
    this.schedulesPath = deps.schedulesPath;
    this.auditDir = deps.auditDir;
    this.now = deps.now ?? Date.now;
    this.maxConcurrentRuns = deps.maxConcurrentRuns ?? Number(process.env.MAX_CONCURRENT_RUNS || 8);
  }

  /** Mirrors RunManager's/MissionManager's own private audit() helper: never throws into a caller. */
  private audit(eventType: string, scheduleId: string | null, payload: Record<string, unknown> = {}): void {
    try {
      appendAuditEvent(this.auditDir, { event_type: eventType, run_id: null, payload: { scheduleId, ...payload } });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[luma-assistant/server] audit log write failed for ${eventType}:`, (err as Error).message);
    }
  }

  private findExecutionForOccurrence(scheduleId: string, scheduledFor: number): AgentScheduleExecution | null {
    for (const execution of this.executions.values()) {
      if (execution.scheduleId === scheduleId && execution.scheduledFor === scheduledFor) return execution;
    }
    return null;
  }

  load(): void {
    const persisted = loadPersistedAgentSchedules(this.schedulesPath);
    const now = this.now();

    // Executions loaded first so the missed-run reconciliation below can
    // see what was already durably claimed before whatever stopped the
    // previous process -- that is the actual "was this occurrence already
    // handled" signal, not the schedule's own nextRunAt value.
    for (const execution of persisted.executions) {
      const staleRunning = execution.status === "running" || execution.status === "queued";
      this.executions.set(execution.id, {
        ...execution,
        status: staleRunning ? "failed" : execution.status,
        startedAt: typeof execution.startedAt === "number" ? execution.startedAt : null,
        completedAt: staleRunning ? now : (typeof execution.completedAt === "number" ? execution.completedAt : null),
        sessionId: typeof execution.sessionId === "string" ? execution.sessionId : null,
        runId: typeof execution.runId === "string" ? execution.runId : null,
        error: staleRunning
          ? "Server restarted before this scheduled execution completed."
          : (typeof execution.error === "string" ? execution.error : null),
      });
      if (execution.runId) this.executionByRunId.set(execution.runId, execution.id);
    }

    // Missed-run reconciliation (spec: a schedule due while Luma was
    // offline must have explicit, not accidental, behavior). Computed
    // BEFORE normalizeSchedule recomputes nextRunAt forward, using the
    // RAW persisted nextRunAt -- that's the actual occurrence that was
    // pending when this process last wrote schedule state.
    const catchUps: Array<{ schedule: AgentSchedule; missedAt: number }> = [];
    for (const raw of persisted.schedules) {
      // Malformed persisted schedule (corrupted/missing/invalid fields)
      // fails safely: skipped entirely, never partially trusted. zod's
      // own .default() on missedRunPolicy/requestedCredentials also means
      // a schedule persisted by an earlier version of this code (neither
      // field existed yet) parses cleanly with policy "skip" -- the exact
      // behavior that version actually had -- rather than needing a
      // separate migration step.
      const parsed = agentScheduleSchema.safeParse(raw);
      if (!parsed.success) {
        this.audit("schedule.load_failed", typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : null, {
          reason: "malformed persisted schedule",
        });
        continue;
      }
      const schedule = parsed.data;
      const originalNextRunAt = schedule.status === "active" ? schedule.nextRunAt : null;
      const alreadyClaimed = originalNextRunAt !== null && this.findExecutionForOccurrence(schedule.id, originalNextRunAt) !== null;

      const decision = decideMissedRun({
        nextRunAt: originalNextRunAt,
        now,
        policy: schedule.missedRunPolicy,
        occurrenceAlreadyClaimed: alreadyClaimed,
      });

      if (decision.action !== "none") {
        this.audit("schedule.missed_occurrence_handled", schedule.id, {
          scheduleId: schedule.id,
          missedOccurrenceAt: decision.missedOccurrenceAt,
          policy: schedule.missedRunPolicy,
          decision: decision.action,
        });
      } else if (alreadyClaimed) {
        this.audit("schedule.recovered", schedule.id, { scheduleId: schedule.id, occurrenceAt: originalNextRunAt });
      }

      const normalized = this.normalizeSchedule(schedule, now);
      this.schedules.set(normalized.id, normalized);
      if (decision.action === "run_once") {
        catchUps.push({ schedule: normalized, missedAt: decision.missedOccurrenceAt });
      }
    }

    this.persist();
    this.scheduleTimer();

    // Catch-up dispatch happens last, after schedules/executions are fully
    // loaded and persistence/timer machinery is armed -- executeSchedule
    // is what actually calls into runManager.startRun (policy, resource
    // watchdog, credential resolution, process manager, audit), so this
    // must never run any earlier than the point the rest of startup
    // already guarantees those are ready.
    for (const item of catchUps) {
      this.executeSchedule(item.schedule, item.missedAt);
    }
  }

  list(): Pick<AgentScheduleListResponse, "schedules" | "upcoming" | "executions"> {
    const schedules = [...this.schedules.values()].sort((a, b) => a.createdAt - b.createdAt);
    const upcoming = schedules
      .filter((schedule) => schedule.status === "active" && schedule.nextRunAt !== null)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
    const executions = [...this.executions.values()]
      .sort((a, b) => Math.max(b.startedAt || 0, b.scheduledFor) - Math.max(a.startedAt || 0, a.scheduledFor))
      .slice(0, 80);
    return { schedules, upcoming, executions };
  }

  getScheduledSessionIds(): Set<string> {
    return new Set(
      [...this.executions.values()]
        .map((execution) => execution.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
  }

  getScheduledRunIds(): Set<string> {
    return new Set(
      [...this.executions.values()]
        .map((execution) => execution.runId)
        .filter((runId): runId is string => Boolean(runId)),
    );
  }

  create(input: {
    agentId: string;
    hour: number;
    minute: number;
    runner: RunRunner;
    workspace: string;
    project?: string;
    model: string;
    sandbox: RunConfig["sandbox"];
    approvalPolicy: RunConfig["approvalPolicy"];
    reasoningEffort: ReasoningEffort;
    skills: SelectedSkillRef[];
    missedRunPolicy: AgentSchedule["missedRunPolicy"];
    requestedCredentials: string[];
  }): AgentSchedule {
    const agent = this.discoverAgentsFn().find((item) => item.id === input.agentId);
    if (!agent) throw new Error("Agent not found");

    const now = this.now();
    const time: AgentScheduleTime = {
      hour: input.hour,
      minute: input.minute,
      timezone: TEHRAN_TIMEZONE,
    };
    const schedule: AgentSchedule = {
      id: `schedule_${now}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: agent.id,
      agentPath: agent.path,
      agentName: agent.name,
      status: "active",
      time,
      nextRunAt: nextTehranDailyRun(time, now),
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      missedRunPolicy: input.missedRunPolicy,
      runConfig: {
        runner: normalizeRunRunner(input.runner),
        workspace: input.workspace,
        project: input.project,
        model: input.model,
        reasoningEffort: normalizeReasoningEffort(input.reasoningEffort),
        sandbox: input.sandbox,
        approvalPolicy: input.approvalPolicy,
        skills: normalizeSelectedSkillRefs(input.skills),
        requestedCredentials: input.requestedCredentials,
      },
    };

    this.schedules.set(schedule.id, schedule);
    this.persist();
    this.audit("schedule.created", schedule.id, {
      scheduleId: schedule.id,
      workspace: schedule.runConfig.workspace,
      hour: input.hour,
      minute: input.minute,
      missedRunPolicy: input.missedRunPolicy,
    });
    this.scheduleTimer();
    return schedule;
  }

  updateStatus(scheduleId: string, status: AgentSchedule["status"]): AgentSchedule | null {
    const current = this.schedules.get(scheduleId);
    if (!current) return null;
    const now = this.now();
    const next: AgentSchedule = {
      ...current,
      status,
      updatedAt: now,
      nextRunAt: status === "active" ? nextTehranDailyRun(current.time, now) : null,
    };
    this.schedules.set(scheduleId, next);
    this.persist();
    this.audit(status === "active" ? "schedule.enabled" : "schedule.disabled", scheduleId, { scheduleId });
    this.scheduleTimer();
    return next;
  }

  delete(scheduleId: string): boolean {
    const deleted = this.schedules.delete(scheduleId);
    if (deleted) {
      this.persist();
      this.audit("schedule.deleted", scheduleId, { scheduleId });
      this.scheduleTimer();
    }
    return deleted;
  }

  runNow(scheduleId: string): AgentScheduleExecution | null {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return null;
    return this.executeSchedule(schedule, this.now());
  }

  onRunLifecycle(event: { kind: "updated" | "completed" | "failed" | "stopped" | "started"; run: RunRecord }): void {
    const executionId = this.executionByRunId.get(event.run.id);
    if (!executionId) return;
    const execution = this.executions.get(executionId);
    if (!execution) return;

    if (event.kind === "updated") {
      const sessionId = event.run.sessionId || event.run.threadId || event.run.id;
      if (sessionId && sessionId !== execution.sessionId) {
        this.executions.set(executionId, { ...execution, sessionId });
        this.persist();
      }
      return;
    }

    if (event.kind !== "completed" && event.kind !== "failed" && event.kind !== "stopped") return;
    const next: AgentScheduleExecution = {
      ...execution,
      status: event.kind,
      completedAt: this.now(),
      sessionId: event.run.sessionId || event.run.threadId || event.run.id,
      error: event.kind === "failed" ? event.run.lastError || "Run failed" : execution.error,
    };
    this.executions.set(executionId, next);
    this.persist();
  }

  flushSync(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    writeJsonAtomicSync(this.schedulesPath, this.snapshot());
  }

  private normalizeSchedule(schedule: AgentSchedule, now: number): AgentSchedule {
    const time: AgentScheduleTime = {
      hour: schedule.time.hour,
      minute: schedule.time.minute,
      timezone: TEHRAN_TIMEZONE,
    };
    return {
      ...schedule,
      time,
      status: schedule.status === "paused" ? "paused" : "active",
      nextRunAt: schedule.status === "paused" ? null : nextTehranDailyRun(time, now),
      runConfig: {
        ...schedule.runConfig,
        runner: normalizeRunRunner(schedule.runConfig.runner),
        reasoningEffort: normalizeReasoningEffort(schedule.runConfig.reasoningEffort),
        skills: normalizeSelectedSkillRefs(schedule.runConfig.skills),
      },
    };
  }

  private scheduleTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextAt = [...this.schedules.values()]
      .filter((schedule) => schedule.status === "active" && schedule.nextRunAt !== null)
      .map((schedule) => schedule.nextRunAt as number)
      .sort((a, b) => a - b)[0];
    if (typeof nextAt !== "number") return;

    const delay = Math.min(Math.max(nextAt - this.now(), 0), 60_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runDueSchedules();
      this.scheduleTimer();
    }, delay);
  }

  private runDueSchedules(): void {
    const now = this.now();
    const due = [...this.schedules.values()]
      .filter((schedule) => schedule.status === "active" && schedule.nextRunAt !== null && schedule.nextRunAt <= now)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));

    for (const schedule of due) {
      this.executeSchedule(schedule, schedule.nextRunAt || now);
    }
  }

  /**
   * The single occurrence-admission + dispatch boundary: every dispatch
   * path (timer tick, runNow, load()'s catch-up dispatch) funnels through
   * here. Not private -- exposed only so occurrence-admission tests
   * (agent-schedule-manager.test.ts) can call it directly and force
   * overlapping/re-entrant attempts at the exact same occurrence. Nothing
   * routes an HTTP request straight to it; it stays reachable only through
   * the same call sites it always was (no new public tick/debug endpoint).
   */
  executeSchedule(schedule: AgentSchedule, scheduledFor: number): AgentScheduleExecution {
    // Idempotency/duplicate-admission guard: one logical occurrence
    // (scheduleId + scheduledFor) is admitted at most once, no matter how
    // many times this is called for it -- overlapping ticks, re-entrant
    // calls, restart recovery replaying the same occurrence, etc. This IS
    // the actual "exactly once" property. It works under re-entrancy
    // because this whole method body is synchronous (no `await` anywhere
    // in it, and startScheduledRun's contract is synchronous too) -- so
    // the write to this.executions two lines below happens, uninterrupted,
    // before any other call into this method can run on Node's single
    // thread, even one triggered synchronously from inside
    // startScheduledRun itself. See the re-entrancy tests for direct proof.
    const existing = this.findExecutionForOccurrence(schedule.id, scheduledFor);
    if (existing) return existing;

    const executionId = `agent_exec_${this.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const execution: AgentScheduleExecution = {
      id: executionId,
      scheduleId: schedule.id,
      agentId: schedule.agentId,
      agentName: schedule.agentName,
      status: "queued",
      scheduledFor,
      startedAt: null,
      completedAt: null,
      sessionId: null,
      runId: null,
      error: null,
    };
    this.executions.set(execution.id, execution);

    const nextSchedule: AgentSchedule = {
      ...schedule,
      lastRunAt: scheduledFor,
      updatedAt: this.now(),
      nextRunAt: schedule.status === "active"
        ? nextTehranDailyRun(schedule.time, Math.max(this.now(), scheduledFor + 60_000))
        : null,
    };
    this.schedules.set(schedule.id, nextSchedule);

    // CLAIM, persisted durably BEFORE any run is created -- closes the
    // crash window between "decided to dispatch this occurrence" and
    // "actually dispatched it." From this instant on, even a crash before
    // startScheduledRun ever runs leaves durable evidence this occurrence
    // was claimed; load()'s missed-run reconciliation checks
    // findExecutionForOccurrence (not nextRunAt) to decide whether an
    // occurrence still needs handling, so this alone is what prevents a
    // duplicate dispatch after restart -- not the order nextRunAt itself
    // gets written in.
    this.persist();
    this.audit("schedule.occurrence_claimed", schedule.id, { scheduleId: schedule.id, scheduledFor });

    const finish = (status: "failed" | "skipped", message: string, eventType: string): AgentScheduleExecution => {
      const failed: AgentScheduleExecution = {
        ...execution,
        status,
        completedAt: this.now(),
        error: message,
      };
      this.executions.set(execution.id, failed);
      this.persist();
      this.audit(eventType, schedule.id, { scheduleId: schedule.id, scheduledFor, reason: message });
      this.scheduleTimer();
      return failed;
    };

    const agent = this.discoverAgentsFn().find((item) => item.id === schedule.agentId && item.path === schedule.agentPath);
    if (!agent || !agent.prompt.trim()) {
      return finish("failed", `Agent file is missing, unreadable, or empty: ${schedule.agentPath}`, "schedule.occurrence_failed");
    }

    if (!this.runManager.hasCapacity()) {
      return finish("skipped", `Maximum concurrent runs reached (${this.maxConcurrentRuns})`, "schedule.occurrence_skipped");
    }

    try {
      const started: AgentScheduleExecution = {
        ...execution,
        status: "running",
        startedAt: this.now(),
      };
      this.executions.set(execution.id, started);
      const { run, sessionId } = this.startScheduledRun(nextSchedule, agent.prompt, started);
      const running: AgentScheduleExecution = {
        ...started,
        runId: run.id,
        sessionId,
      };
      this.executions.set(execution.id, running);
      this.executionByRunId.set(run.id, execution.id);
      this.persist();
      this.audit("schedule.occurrence_dispatched", schedule.id, { scheduleId: schedule.id, scheduledFor, runId: run.id });
      this.scheduleTimer();
      return running;
    } catch (error) {
      // Policy/resource denial is distinguished from a generic failure --
      // spec: "Policy may have changed since schedule creation... Audit
      // the denial" as its own event, not folded into a generic failure.
      const eventType = error instanceof PolicyDeniedError || error instanceof ResourceLimitError
        ? "schedule.occurrence_denied"
        : "schedule.occurrence_failed";
      return finish("failed", error instanceof Error ? error.message : "Failed to start scheduled run", eventType);
    }
  }

  private persist(): void {
    writeJsonAtomicSync(this.schedulesPath, this.snapshot());
  }

  private snapshot(): PersistedAgentScheduleState {
    return {
      schedules: [...this.schedules.values()].sort((a, b) => a.createdAt - b.createdAt),
      executions: [...this.executions.values()]
        .sort((a, b) => Math.max(b.startedAt || 0, b.scheduledFor) - Math.max(a.startedAt || 0, a.scheduledFor))
        .slice(0, 500),
    };
  }
}
