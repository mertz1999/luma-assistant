import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSchedule, AgentScheduleExecution, RunRecord } from "@luma/shared";
import { readAuditEvents } from "../audit/audit-log.js";
import { PolicyDeniedError, ResourceLimitError } from "../errors.js";
import { AgentScheduleManager, type AgentDescriptorLike, type PersistedAgentScheduleState } from "./agent-schedule-manager.js";

// AgentScheduleManager arms a REAL setTimeout (scheduleTimer()) whenever any
// schedule it holds has a future nextRunAt -- necessary for the class to
// behave identically to production, but it means every instance created in
// this file must be torn down or the process (and this test run) hangs
// waiting for the event loop to drain. flushSync() clears the timer.
const liveManagers: AgentScheduleManager[] = [];
after(() => {
  for (const manager of liveManagers) manager.flushSync();
});

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function paths() {
  const dir = tempDir("luma-sched-mgr-");
  return { schedulesPath: path.join(dir, "agent-schedules.json"), auditDir: path.join(dir, "audit") };
}

const AGENT: AgentDescriptorLike = { id: "agent_1", path: "/agents/one.md", name: "One", prompt: "do the thing" };

function fakeDiscoverAgents(agents: AgentDescriptorLike[] = [AGENT]): () => AgentDescriptorLike[] {
  return () => agents;
}

function makeSchedule(overrides: Partial<AgentSchedule> = {}, now = Date.UTC(2026, 5, 1, 0, 0, 0)): AgentSchedule {
  return {
    id: overrides.id ?? "schedule_test",
    agentId: AGENT.id,
    agentPath: AGENT.path,
    agentName: AGENT.name,
    status: "active",
    time: { hour: 4, minute: 0, timezone: "Asia/Tehran" },
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    missedRunPolicy: "skip",
    runConfig: {
      runner: "codex",
      workspace: "C:/workspace",
      model: "gpt-test",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      skills: [],
      requestedCredentials: [],
    },
    ...overrides,
  };
}

/** A dispatcher fake that records every call and returns a distinct run id each time. */
function makeDispatcher() {
  const calls: Array<{ schedule: AgentSchedule; prompt: string; execution: AgentScheduleExecution }> = [];
  let n = 0;
  const fn = (schedule: AgentSchedule, prompt: string, execution: AgentScheduleExecution): { run: RunRecord; sessionId: string } => {
    calls.push({ schedule, prompt, execution });
    n += 1;
    return { run: { id: `run_${n}` } as unknown as RunRecord, sessionId: `sess_${n}` };
  };
  return { fn, calls };
}

function makeManager(opts: {
  schedulesPath: string;
  auditDir: string;
  dispatcher?: ReturnType<typeof makeDispatcher>["fn"];
  hasCapacity?: () => boolean;
  agents?: AgentDescriptorLike[];
  now?: () => number;
}): AgentScheduleManager {
  const manager = new AgentScheduleManager(
    { hasCapacity: opts.hasCapacity ?? (() => true) },
    opts.dispatcher ?? makeDispatcher().fn,
    {
      discoverAgentsFn: fakeDiscoverAgents(opts.agents),
      schedulesPath: opts.schedulesPath,
      auditDir: opts.auditDir,
      now: opts.now,
    },
  );
  liveManagers.push(manager);
  return manager;
}

function readPersisted(schedulesPath: string): PersistedAgentScheduleState {
  return JSON.parse(fs.readFileSync(schedulesPath, "utf8"));
}

// ---------------------------------------------------------------------------
// 1 & 3: sequential duplicate attempt for the same occurrence -> one run,
// and the duplicate never reaches the dispatcher.
// ---------------------------------------------------------------------------
test("executeSchedule: sequential duplicate attempts at the same occurrence produce exactly one run and the dispatcher is called exactly once", () => {
  const { schedulesPath, auditDir } = paths();
  const dispatcher = makeDispatcher();
  const manager = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher.fn });
  const schedule = makeSchedule();
  const dueAt = schedule.nextRunAt as number;

  const first = manager.executeSchedule(schedule, dueAt);
  const second = manager.executeSchedule(schedule, dueAt);
  const third = manager.executeSchedule(schedule, dueAt);

  assert.equal(dispatcher.calls.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(second.id, third.id);
  assert.equal(first.status, "running");
  assert.equal(manager.list().executions.length, 1);
});

// ---------------------------------------------------------------------------
// 2: true overlapping/re-entrant attempt, forced from inside the dispatcher
// itself -- the second attempt starts before the first has returned.
// ---------------------------------------------------------------------------
test("executeSchedule: a re-entrant attempt fired from inside the dispatcher (before the first call returns) is rejected as already-claimed", () => {
  const { schedulesPath, auditDir } = paths();
  const schedule = makeSchedule();
  const dueAt = schedule.nextRunAt as number;
  let dispatcherCalls = 0;
  let reentrantResult: AgentScheduleExecution | null = null;

  const manager: AgentScheduleManager = makeManager({
    schedulesPath,
    auditDir,
    dispatcher: (s, _prompt, _execution) => {
      dispatcherCalls += 1;
      // Attempt B fires synchronously WHILE attempt A's dispatch is still
      // in flight (A has claimed the occurrence and called this dispatcher,
      // but has not yet returned/finalized). This is the actual overlap:
      // B re-enters executeSchedule for the identical occurrence before A
      // completes.
      reentrantResult = manager.executeSchedule(s, dueAt);
      return { run: { id: "run_A" } as unknown as RunRecord, sessionId: "sess_A" };
    },
  });

  const outer = manager.executeSchedule(schedule, dueAt);

  assert.equal(dispatcherCalls, 1, "the reentrant attempt must not call the dispatcher a second time");
  assert.ok(reentrantResult, "the reentrant call must have returned something (not thrown/hung)");
  assert.equal((reentrantResult as unknown as AgentScheduleExecution).id, outer.id, "reentrant attempt must resolve to the SAME execution, not a new one");
  assert.equal(manager.list().executions.length, 1, "exactly one execution/run must exist for this occurrence");
  assert.equal(outer.runId, "run_A");
});

// ---------------------------------------------------------------------------
// 4 & 5: occurrence identity is scheduleId + scheduledFor -- a different due
// time for the SAME schedule is a different occurrence and dispatches
// normally.
// ---------------------------------------------------------------------------
test("executeSchedule: a different scheduledFor for the same schedule is a distinct occurrence and dispatches normally", () => {
  const { schedulesPath, auditDir } = paths();
  const dispatcher = makeDispatcher();
  const manager = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher.fn });
  const schedule = makeSchedule();
  const dayOne = schedule.nextRunAt as number;
  const dayTwo = dayOne + 24 * 60 * 60 * 1000;

  manager.executeSchedule(schedule, dayOne);
  manager.executeSchedule(schedule, dayOne); // duplicate of day one, must not add a call
  manager.executeSchedule(schedule, dayTwo); // genuinely new occurrence

  assert.equal(dispatcher.calls.length, 2);
  assert.equal(manager.list().executions.length, 2);
});

// ---------------------------------------------------------------------------
// 6: two different schedules due at the exact same instant both run --
// occurrence identity includes scheduleId, so no cross-schedule collision.
// ---------------------------------------------------------------------------
test("executeSchedule: two different schedules due at the same instant both dispatch independently", () => {
  const { schedulesPath, auditDir } = paths();
  const dispatcher = makeDispatcher();
  const manager = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher.fn });
  const dueAt = Date.UTC(2026, 5, 1, 0, 30, 0);
  const scheduleA = makeSchedule({ id: "schedule_A", nextRunAt: dueAt });
  const scheduleB = makeSchedule({ id: "schedule_B", nextRunAt: dueAt });

  const a = manager.executeSchedule(scheduleA, dueAt);
  const b = manager.executeSchedule(scheduleB, dueAt);

  assert.equal(dispatcher.calls.length, 2);
  assert.notEqual(a.id, b.id);
  assert.equal(a.scheduleId, "schedule_A");
  assert.equal(b.scheduleId, "schedule_B");
});

// ---------------------------------------------------------------------------
// 7: failure during dispatch (dispatcher throws synchronously) is a
// deterministic terminal state -- not silently left claimed-with-no-record,
// and not retried on a later load() since the occurrence is already claimed.
// ---------------------------------------------------------------------------
test("executeSchedule: a generic dispatcher failure marks the occurrence failed (schedule.occurrence_failed), and it is not retried by a later load()", () => {
  const { schedulesPath, auditDir } = paths();
  const manager = makeManager({
    schedulesPath,
    auditDir,
    dispatcher: () => {
      throw new Error("boom: simulated dispatcher crash");
    },
  });
  const schedule = makeSchedule();
  const dueAt = schedule.nextRunAt as number;

  const result = manager.executeSchedule(schedule, dueAt);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "boom: simulated dispatcher crash");

  const events = readAuditEvents(auditDir);
  assert.ok(events.some((e) => e.event_type === "schedule.occurrence_failed"));
  assert.ok(!events.some((e) => e.event_type === "schedule.occurrence_dispatched"));

  // A fresh manager loading the same persisted state must not retry this
  // occurrence -- it's already claimed (an execution record exists for it),
  // regardless of that execution's terminal status being "failed".
  const dispatcher2 = makeDispatcher();
  const manager2 = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher2.fn });
  manager2.load();
  assert.equal(dispatcher2.calls.length, 0);
  assert.equal(manager2.list().executions.filter((e) => e.scheduledFor === dueAt).length, 1);
});

test("executeSchedule: PolicyDeniedError/ResourceLimitError during dispatch is distinguished as schedule.occurrence_denied, not a generic failure", () => {
  const { schedulesPath, auditDir } = paths();
  const manager = makeManager({
    schedulesPath,
    auditDir,
    dispatcher: () => {
      throw new PolicyDeniedError("workspace not allowed");
    },
  });
  const schedule = makeSchedule();
  manager.executeSchedule(schedule, schedule.nextRunAt as number);

  const events = readAuditEvents(auditDir);
  assert.ok(events.some((e) => e.event_type === "schedule.occurrence_denied"));
  assert.ok(!events.some((e) => e.event_type === "schedule.occurrence_failed"));
});

// ---------------------------------------------------------------------------
// Crash-window proof. In the current implementation there is exactly one
// persist() between "claim" and "dispatch complete" -- the claim write
// (execution status "queued", schedule's nextRunAt already advanced past
// this occurrence) -- and no intermediate persist while the dispatcher runs
// or immediately after it returns. That means a crash at ANY point between
// "occurrence claimed" and "dispatch fully recorded" -- whether before the
// dispatcher was even called (Window 1: no run was ever created) or after
// it returned but before the running/runId state was flushed (Window 2: a
// run WAS created upstream) -- leaves the identical on-disk shape: the
// execution still shows "queued". Both windows are therefore proven by the
// same fixture and produce the same, single, deterministic recovery
// behavior: reconciled to "failed" on load, never retried (the schedule's
// own nextRunAt was already advanced past this occurrence before the crash
// window even opened).
// ---------------------------------------------------------------------------
test("crash window (claim persisted, dispatch never completes): restart reconciles the stale 'queued' execution to failed and does NOT create a duplicate run for that occurrence", () => {
  const { schedulesPath, auditDir } = paths();
  const dueAt = Date.UTC(2026, 5, 1, 4, 0, 0);
  const advancedNextRunAt = Date.UTC(2026, 5, 2, 4, 0, 0);

  // Hand-construct exactly what persist() would have written the instant
  // after CLAIM, before the dispatcher (or its completion) was ever
  // recorded -- this is the real on-disk shape for both Window 1 and
  // Window 2 as reasoned above.
  const crashedState: PersistedAgentScheduleState = {
    schedules: [makeSchedule({ nextRunAt: advancedNextRunAt })],
    executions: [{
      id: "agent_exec_crashed",
      scheduleId: "schedule_test",
      agentId: AGENT.id,
      agentName: AGENT.name,
      status: "queued",
      scheduledFor: dueAt,
      startedAt: null,
      completedAt: null,
      sessionId: null,
      runId: null,
      error: null,
    }],
  };
  fs.mkdirSync(path.dirname(schedulesPath), { recursive: true });
  fs.writeFileSync(schedulesPath, JSON.stringify(crashedState, null, 2));

  const dispatcher = makeDispatcher();
  const manager = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher.fn });
  manager.load();

  assert.equal(dispatcher.calls.length, 0, "the crashed occurrence must never be re-dispatched");
  const { executions } = manager.list();
  const crashed = executions.find((e) => e.id === "agent_exec_crashed");
  assert.ok(crashed);
  assert.equal(crashed!.status, "failed");
  assert.equal(crashed!.error, "Server restarted before this scheduled execution completed.");
  assert.equal(executions.filter((e) => e.scheduledFor === dueAt).length, 1, "no second execution was created for the crashed occurrence");

  // The schedule itself resumes normally, armed for a genuinely future
  // occurrence -- never re-armed for the crashed one. (normalizeSchedule
  // unconditionally recomputes nextRunAt fresh from (hour, minute,
  // timezone) against the real current time on every load(), by design --
  // see mission notes from the previous scheduler-durability phase -- so
  // this is intentionally NOT asserted to equal the fixture's hand-picked
  // advancedNextRunAt, only that it is armed strictly in the future and is
  // not the crashed occurrence's own timestamp.)
  const nextDue = manager.list().schedules[0]!.nextRunAt;
  assert.ok(typeof nextDue === "number" && nextDue > Date.now());
  assert.notEqual(nextDue, dueAt);
});

// ---------------------------------------------------------------------------
// Idempotency across repeated recovery: process, reprocess, restart,
// reprocess again -- still exactly one logical run for the occurrence that
// was actually admitted.
// ---------------------------------------------------------------------------
test("idempotency: processing the same occurrence repeatedly, including across a simulated restart, still yields exactly one run", () => {
  const { schedulesPath, auditDir } = paths();
  const dispatcher1 = makeDispatcher();
  const manager1 = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher1.fn });
  const schedule = makeSchedule();
  const dueAt = schedule.nextRunAt as number;

  const first = manager1.executeSchedule(schedule, dueAt);
  manager1.executeSchedule(schedule, dueAt);
  manager1.flushSync();

  // Simulated restart: a brand-new manager instance, same files.
  const dispatcher2 = makeDispatcher();
  const manager2 = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher2.fn });
  manager2.load();
  const persistedSchedule = manager2.list().schedules.find((s) => s.id === schedule.id)!;
  const again = manager2.executeSchedule(persistedSchedule, dueAt);

  assert.equal(dispatcher1.calls.length, 1);
  assert.equal(dispatcher2.calls.length, 0, "restart + reprocessing the same occurrence must not dispatch again");
  assert.equal(again.id, first.id);
  assert.equal(manager2.list().executions.filter((e) => e.scheduledFor === dueAt).length, 1);
});

// ---------------------------------------------------------------------------
// 11: restart duplicate-prevention proof, reproduced directly at this seam
// (the previous phase proved this via real file-patching scripts against a
// real running server; this is the same property proven in-process).
// ---------------------------------------------------------------------------
test("restart duplicate-prevention: a second manager instance loading a file where the occurrence was already dispatched does not redispatch it", () => {
  const { schedulesPath, auditDir } = paths();
  const dispatcher1 = makeDispatcher();
  const manager1 = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher1.fn });
  const schedule = makeSchedule();
  const dueAt = schedule.nextRunAt as number;
  manager1.executeSchedule(schedule, dueAt);
  manager1.flushSync();

  const persistedBefore = readPersisted(schedulesPath);
  assert.equal(persistedBefore.executions.filter((e) => e.scheduledFor === dueAt).length, 1);

  const dispatcher2 = makeDispatcher();
  const manager2 = makeManager({ schedulesPath, auditDir, dispatcher: dispatcher2.fn });
  manager2.load();

  assert.equal(dispatcher2.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 13: two independently-instantiated manager objects over the SAME
// persisted file, both attempting the SAME occurrence. Documented finding
// (not a bug fixed in this phase): the claim is authoritative for restart
// safety within a single process (proven above and in the restart tests),
// but it is an in-memory Map checked against whatever each instance loaded
// -- it is NOT a cross-process/cross-instance lock. Two instances that both
// load() before either claims will both dispatch. This is accepted because
// the product has exactly one supported deployment shape: a single Express
// process per data directory (no cluster/PM2/worker-pool anywhere in this
// codebase) -- see the final report for the explicit reasoning on why this
// was not "fixed" with a cross-process file lock.
// ---------------------------------------------------------------------------
test("DOCUMENTED LIMITATION: two independent manager instances that each load() before either claims will both dispatch the same occurrence (in-memory claim is not cross-instance safe)", () => {
  const { schedulesPath, auditDir } = paths();
  const schedule = makeSchedule();
  const dueAt = schedule.nextRunAt as number;
  fs.mkdirSync(path.dirname(schedulesPath), { recursive: true });
  fs.writeFileSync(schedulesPath, JSON.stringify({ schedules: [schedule], executions: [] }, null, 2));

  const dispatcherA = makeDispatcher();
  const dispatcherB = makeDispatcher();
  const managerA = makeManager({ schedulesPath, auditDir, dispatcher: dispatcherA.fn });
  const managerB = makeManager({ schedulesPath, auditDir, dispatcher: dispatcherB.fn });

  // Both "processes" start up and load the same not-yet-claimed state
  // before either one claims the occurrence.
  managerA.load();
  managerB.load();

  const scheduleA = managerA.list().schedules[0]!;
  const scheduleB = managerB.list().schedules[0]!;
  managerA.executeSchedule(scheduleA, dueAt);
  managerB.executeSchedule(scheduleB, dueAt);

  // This documents the actual (unsafe, for a hypothetical multi-instance
  // deployment) current behavior -- both instances dispatched.
  assert.equal(dispatcherA.calls.length, 1);
  assert.equal(dispatcherB.calls.length, 1);
});

test("single-instance safety is NOT merely an in-memory Set: a second instance that loads AFTER the first has persisted its claim correctly sees it and does not redispatch", () => {
  const { schedulesPath, auditDir } = paths();
  const schedule = makeSchedule();
  const dueAt = schedule.nextRunAt as number;

  const dispatcherA = makeDispatcher();
  const managerA = makeManager({ schedulesPath, auditDir, dispatcher: dispatcherA.fn });
  managerA.executeSchedule(schedule, dueAt);
  managerA.flushSync();

  // Instance B starts up fresh AFTER A's claim is durable on disk --
  // exactly the real restart sequencing (never truly concurrent process
  // starts), which is the deployment model this product actually has.
  const dispatcherB = makeDispatcher();
  const managerB = makeManager({ schedulesPath, auditDir, dispatcher: dispatcherB.fn });
  managerB.load();
  assert.equal(dispatcherB.calls.length, 0);
});
