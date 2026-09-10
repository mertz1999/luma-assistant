# Event-generation fencing

## Problem

`RunManager.loadPersisted()` (index.ts) already reconciles a crashed run's
own status to `"failed"` on restart via `reconcileStaleRunPid()`
(recovery.ts) — correctly: it checks whether the recorded pid is genuinely
still alive, and terminates it if it looks like a real orphaned Codex/
Claude/openclaude process. What it does **not** do on its own is stop an
asynchronous event that was scheduled under an *older* spawn attempt (a
process `exit`/`error` handler, a timeout escalation) from later mutating
that same run's state, if such an event could ever still fire after a
newer attempt or controller instance has taken ownership.

```
controller generation A
    ↓
starts run R
    ↓
controller restarts
    ↓
controller generation B takes ownership
    ↓
an event captured under generation A arrives late
    ↓
without fencing, it could mutate run R incorrectly
```

Goal: **old ownership must not be able to mutate current run state.**

## Ownership model

- `RunRecord.ownerGeneration?: number` (packages/shared/src/index.ts) —
  which controller-process generation currently owns this run.
- `RunManager.controllerGeneration` — the current process's own generation,
  computed once in `loadPersisted()` via
  `computeNextControllerGeneration()` (recovery-generation.ts): one more
  than the highest `ownerGeneration` already present among the runs being
  loaded. Always strictly higher than anything an earlier process (whose
  `runs.json` this process inherited) ever used.
- A freshly-created run (`RunManager.startRun`) is stamped with the current
  `controllerGeneration` at creation time; that value is captured once into
  a local `runGeneration` const, which every closure created for that spawn
  attempt (process `error`/`exit` handlers, the timeout escalation timer)
  closes over.
- A run reconciled during `loadPersisted()` (found `"queued"`/`"running"`
  from before this process started) is stamped with the *new* process's
  `controllerGeneration` — this is the actual "ownership transfer after
  restart" moment.
- A run persisted before this field existed has no `ownerGeneration` at
  all; it is normalized to `0` wherever it's read, which is lower than any
  real controller generation (`computeNextControllerGeneration` always
  returns at least `1`) — so a legacy run is never mistaken for
  "owned by the current process" until this process actually spawns or
  reclaims it.

## The mutation guard

`RunManager.updateRunIfCurrentGeneration(runId, expectedGeneration, patch)`
is `updateRun()`'s fenced counterpart. It re-reads the run's *currently*
persisted `ownerGeneration` (never a value closed over earlier) and applies
`patch` only if it still equals `expectedGeneration` — otherwise it logs a
low-noise `run.stale_event_rejected` audit event and returns `false` without
mutating anything.

The actual comparison (`shouldApplyEvent`) and the generation-derivation
logic (`computeNextControllerGeneration`) live in
`apps/server/src/recovery-generation.ts` as small, pure, independently
tested functions — the same pattern already used in this codebase for
`missions/mission-state.ts`, `resources/resource-watchdog.ts`, and
`policy/policy-engine.ts`: the decision logic is pure and tested; the
imperative process-spawning/event-wiring code that calls it stays in
`index.ts`.

**Atomicity**: Node's single-threaded event loop makes the
read-current-generation-then-write check inside
`updateRunIfCurrentGeneration` atomic *within this process* — no `await`
separates the read from `updateRun()`'s own read+write of the in-memory
`Map`, so nothing else in this process can interleave. This is the local
equivalent of a conditional `UPDATE ... WHERE generation = ?` — a
zero-row-affected outcome (mismatch) is treated as stale ownership and
silently skipped, never as a fatal error.

## Fenced events

| Event | Runner(s) | Fenced? |
|---|---|---|
| Process `error` (spawn failure) | codex, claude, qwythos | Yes |
| Process `exit` → completed/failed/stopped | codex (inline), claude/qwythos (`finishClaudeExecution`) | Yes |
| Timeout escalation (`scheduleRunTimeout`) | all three (shared) | Yes — and the follow-on `stopRun()` call is skipped entirely if the fenced mutation was rejected, so a stale timeout cannot kill a current-generation process either |
| Qwythos pre-flight health-check failure | qwythos | Yes — the one pre-spawn path with a real `await` gap (health check) between record creation and the mutation |
| Qwythos initial `"running"` + pid assignment | qwythos | Yes — same reasoning: it follows that same `await` |
| Codex/Claude executable-resolve failure | codex, claude | **Not fenced** — fully synchronous from record creation through this point (no `await` in between), so no other generation can have taken ownership yet |
| Codex/Claude initial `"running"` + pid assignment | codex, claude | **Not fenced** — same reasoning |
| Mid-stream progress updates (`summary`, `changedFiles`, `usage`, individual stdout/stderr lines, the mid-stream Claude/Qwythos "result" message setting `lastError`/`status: "failed"`) | all | **Not fenced** — high-frequency, low-risk; fencing every one would add a comparison per streamed token for no real safety benefit, and finalization (`finishClaudeExecution`/the Codex exit handler) already re-derives the correct terminal status from the exit code regardless of what a mid-stream update left behind |
| Restart-time reconciliation itself (`reconcileStaleRunPid` inside `loadPersisted`) | all | **Not a candidate for rejection** — this *is* the mechanism that defines what's current; it's exempt by construction, and is exactly what bumps a reclaimed run's `ownerGeneration` |

## Duplicate-controller limitation

Agent Orchestrator's own daemon exposed a real, live-witnessed
daemon-singleton weakness during the earlier Cline+AO evaluation (a stale
daemon silently kept running while a new one picked a fallback port instead
of erroring). Luma cannot assume two controller processes can never briefly
overlap either — pm2 restarts, a manual double-start, or a crash-then-relaunch
window are all real possibilities.

**What this change protects**: within one continuous controller process,
no stale in-memory closure (an event captured under an earlier
`controllerGeneration` this same process once used — a defensive guarantee,
since in practice `controllerGeneration` is constant for a process's whole
lifetime) can mutate current run state. `computeNextControllerGeneration`
also guarantees a *newly-started* process always picks a generation
strictly higher than anything an *earlier* process already persisted, so
runs the new process creates can never collide with an old process's
in-flight generation number.

**What this change does not protect**: if two controller processes are
*simultaneously alive*, each holds its own independent in-memory `Map` of
runs, and each debounces its own writes to the same `data/runs.json` file
via `writeJsonAtomicSync` — whole-array overwrites, not row-level
conditional writes. The *last writer wins* at the file level; there is no
cross-process read-before-write generation check. Closing that gap for
real would need either a per-write on-disk compare-and-swap (re-reading
each run's current on-disk generation immediately before every persist and
refusing to overwrite a strictly-newer one) or a real advisory lock/
transactional store — both explicitly out of scope for this "small-medium
lifecycle hardening" task (see the non-negotiable rules: no Redis, no
distributed consensus, no leader election). Luma's existing "one mutating
run per workspace" guard is a separate, coarser mitigation for a related
but different failure mode (two runs targeting the same workspace
concurrently), not a fix for this gap either.

## Live process-death gap (unchanged, documented as follow-up)

A known remaining gap, unrelated to generation fencing and not solved by
it: if an ACTIVE mission's worker process dies while the controller itself
stays alive (no restart), nothing currently detects that until something
else notices (a subsequent `getRun`/API read still shows whatever the last
real event set, since no exit event ever fires for a process that dies in
a way Node's `child_process` doesn't observe — e.g. the OS unexpectedly
reaping the process out from under the parent). Fixing this would need live
process-liveness polling, not just fencing already-firing events — out of
scope here per the task's own instruction to document rather than silently
claim it's solved.

## Worktree-isolation follow-up (unchanged, documented as follow-up)

Also not implemented here, per instruction. AO's tested one-worktree-per-
worker pattern remains a real, valuable, but higher-migration-risk P1 given
BotolaIQ and Dalilfinance are live repositories with their own existing git
state — see the earlier Cline+AO evaluation's findings for the full
reasoning.
