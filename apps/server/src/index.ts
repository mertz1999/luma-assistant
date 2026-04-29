import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { IPty } from "node-pty";
import {
  approvalPolicySchema,
  rerunSchema,
  setWorkspaceSchema,
  startRunSchema,
  type ApiResponse,
  type ApprovalQueueItem,
  type AppBootstrap,
  type CodexAccountStatusResponse,
  type CodexCommandStatus,
  type CodexMcpStatusResponse,
  type CodexSystemStatusResponse,
  type CodexTokenStatus,
  type DiffSnapshot,
  type FileTreeNode,
  type RunConfig,
  type RunEventEntry,
  type RunRecord,
  type SessionHistoryEntry,
  type SseEvent,
  type TerminalSessionSnapshot,
  type WorkspaceOption,
} from "@agentic/shared";

const rootDir = path.resolve(process.env.INIT_CWD || process.cwd());
dotenv.config({ path: path.resolve(rootDir, ".env") });
const require = createRequire(import.meta.url);

const APP_STATE_PATH = path.resolve(rootDir, "data/ui-state.json");
const RUNS_PATH = path.resolve(rootDir, "data/runs.json");

const API_PORT = Number(process.env.API_PORT || 9001);
const WEB_PORT = Number(process.env.WEB_PORT || 5175);
const HOST = process.env.HOST || "0.0.0.0";
const CODEX_PATH = process.env.CODEX_PATH || "codex";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-5.3-codex";
const DEFAULT_REASONING_EFFORT = process.env.DEFAULT_REASONING_EFFORT || "high";
const DEFAULT_SANDBOX = resolveDefaultSandboxMode();
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS || 8);

type PersistedUiState = {
  activeWorkspace: string;
  manualWorkspaces: string[];
};

type ActiveRun = {
  process: ChildProcess;
  stdoutBuffer: string;
  stopRequested: boolean;
};

type ActiveTerminal =
  | {
      mode: "pty";
      pty: IPty;
      session: TerminalSessionSnapshot;
    }
  | {
      mode: "process";
      child: ChildProcess;
      session: TerminalSessionSnapshot;
    };

type NodePtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) => IPty;
};

const nodePty = loadNodePty();

const TERMINAL_HISTORY_MAX_CHARS = Number(process.env.TERMINAL_HISTORY_MAX_CHARS || 220000);

function runSessionId(run: RunRecord): string {
  return run.sessionId || run.threadId || run.id;
}

function normalizeSandboxMode(input: string | undefined): "read-only" | "workspace-write" | "danger-full-access" {
  const value = (input || "").trim();
  if (!value) return "read-only";

  const lower = value.toLowerCase();
  if (lower === "read-only" || lower === "readonly") return "read-only";
  if (lower === "workspace-write" || lower === "workspacewrite") return "workspace-write";
  if (lower === "danger-full-access" || lower === "dangerfullaccess") return "danger-full-access";
  return "read-only";
}

function isTruthy(input: string | undefined): boolean {
  const lower = (input || "").trim().toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

function resolveDefaultSandboxMode(): "read-only" | "workspace-write" | "danger-full-access" {
  const explicit = normalizeSandboxMode(process.env.DEFAULT_SANDBOX);
  const legacy = normalizeSandboxMode(process.env.DEFAULT_SANDBOX_TYPE);
  const networkEnabled = isTruthy(process.env.DEFAULT_NETWORK_ACCESS);

  const base = process.env.DEFAULT_SANDBOX ? explicit : (process.env.DEFAULT_SANDBOX_TYPE ? legacy : "read-only");
  if (!networkEnabled) return base;

  // Legacy env compatibility: DEFAULT_NETWORK_ACCESS=true implies unrestricted network runtime.
  return "danger-full-access";
}

function loadNodePty(): NodePtyModule | null {
  try {
    return require("node-pty") as NodePtyModule;
  } catch {
    return null;
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function getChildPids(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function resolveTerminalShell(): string {
  const configured = process.env.TERMINAL_SHELL?.trim();
  const candidates = [
    configured,
    process.platform === "win32" ? "powershell.exe" : "/bin/bash",
    process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    process.platform === "win32" ? "powershell" : "bash",
    process.platform === "win32" ? "cmd" : "sh",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    if (commandExists(candidate)) return candidate;
  }

  throw new Error(
    "No terminal shell found. Expected /bin/bash or /bin/sh. You can also set TERMINAL_SHELL explicitly in .env.",
  );
}

class RunManager extends EventEmitter {
  private runs = new Map<string, RunRecord>();

  private approvals = new Map<string, ApprovalQueueItem>();

  private diffs = new Map<string, DiffSnapshot>();

  private activeRuns = new Map<string, ActiveRun>();

  constructor(private codexPath: string) {
    super();
  }

  loadPersisted(runs: RunRecord[], approvals: ApprovalQueueItem[]): void {
    for (const run of runs) {
      this.runs.set(run.id, {
        ...run,
        sessionId: typeof run.sessionId === "string"
          ? run.sessionId
          : typeof run.threadId === "string"
            ? run.threadId
            : null,
        archivedAt: typeof run.archivedAt === "number" ? run.archivedAt : null,
      });
    }
    for (const item of approvals) this.approvals.set(item.id, item);
  }

  getRuns(includeArchived = true): RunRecord[] {
    return [...this.runs.values()]
      .filter((run) => includeArchived || run.archivedAt === null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId) || null;
  }

  getApprovals(): ApprovalQueueItem[] {
    return [...this.approvals.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getDiff(runId: string): DiffSnapshot | null {
    return this.diffs.get(runId) || null;
  }

  archiveSession(sessionId: string): { archivedRuns: number } | null {
    const sessionRuns = this.getSessionRuns(sessionId);
    if (sessionRuns.length === 0) return null;
    if (this.hasActiveRunInSession(sessionId)) {
      throw new Error("Cannot archive a session with a running task");
    }

    const archivedAt = Date.now();
    for (const run of sessionRuns) {
      this.runs.set(run.id, { ...run, archivedAt, updatedAt: archivedAt });
    }

    this.removeApprovalsForRunIds(new Set(sessionRuns.map((run) => run.id)));
    this.persistState();
    return { archivedRuns: sessionRuns.length };
  }

  deleteSession(sessionId: string): { removedRuns: number; removedApprovals: number } | null {
    const sessionRuns = this.getSessionRuns(sessionId);
    if (sessionRuns.length === 0) return null;
    if (this.hasActiveRunInSession(sessionId)) {
      throw new Error("Cannot delete a session with a running task");
    }

    const runIds = new Set(sessionRuns.map((run) => run.id));
    for (const runId of runIds) {
      this.runs.delete(runId);
      this.diffs.delete(runId);
    }

    const removedApprovals = this.removeApprovalsForRunIds(runIds);
    this.persistState();
    return { removedRuns: runIds.size, removedApprovals };
  }

  hasCapacity(): boolean {
    return this.activeRuns.size < MAX_CONCURRENT_RUNS;
  }

  startRun(config: RunConfig): RunRecord {
    if (!this.hasCapacity()) {
      throw new Error(`Maximum concurrent runs reached (${MAX_CONCURRENT_RUNS})`);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const prompt = config.planMode ? `${PLAN_MODE_PREAMBLE}\n\n${config.prompt}` : config.prompt;

    const record: RunRecord = {
      id: runId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "queued",
      config,
      sessionId: config.sessionId || null,
      threadId: null,
      summary: prompt.slice(0, 140),
      events: [],
      lastError: null,
      changedFiles: [],
      archivedAt: null,
      usage: null,
    };

    this.runs.set(runId, record);

    const args = config.sessionId
      ? [
          "exec",
          "resume",
          "--json",
          "--skip-git-repo-check",
          "-m",
          config.model,
          "-c",
          `reasoning_effort=${JSON.stringify(DEFAULT_REASONING_EFFORT)}`,
          "-c",
          `approval_policy=${JSON.stringify(config.approvalPolicy)}`,
          "-c",
          `sandbox_mode=${JSON.stringify(config.sandbox)}`,
          config.sessionId,
          prompt,
        ]
      : [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "-C",
          config.workspace,
          "-m",
          config.model,
          "-c",
          `reasoning_effort=${JSON.stringify(DEFAULT_REASONING_EFFORT)}`,
          "-s",
          config.sandbox,
          "-c",
          `approval_policy=${JSON.stringify(config.approvalPolicy)}`,
          prompt,
        ];

    const child = spawn(this.codexPath, args, {
      cwd: config.workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      throw new Error("Failed to initialize codex process streams");
    }

    this.activeRuns.set(runId, { process: child, stdoutBuffer: "", stopRequested: false });
    this.updateRun(runId, { status: "running" });
    this.emitSse({ kind: "run.started", runId, at: Date.now(), payload: { config } });

    child.stdout.on("data", (chunk: Buffer) => {
      const active = this.activeRuns.get(runId);
      if (!active) return;
      active.stdoutBuffer += chunk.toString("utf8");
      let idx = active.stdoutBuffer.indexOf("\n");
      while (idx >= 0) {
        const line = active.stdoutBuffer.slice(0, idx).trim();
        active.stdoutBuffer = active.stdoutBuffer.slice(idx + 1);
        if (line.length > 0) this.handleStdoutLine(runId, line);
        idx = active.stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (isBenignCodexStderr(line)) continue;
        const rendered = `${line}\n`;
        this.appendEvent(runId, { source: "stderr", text: rendered });
        this.emitSse({ kind: "run.stderr", runId, at: Date.now(), payload: { text: rendered } });
        this.checkApprovalSignal(runId, line, null);
      }
    });

    child.on("exit", (code) => {
      const active = this.activeRuns.get(runId);
      const stopRequested = Boolean(active?.stopRequested);
      this.activeRuns.delete(runId);

      const run = this.runs.get(runId);
      if (!run) return;

      if (stopRequested) {
        this.updateRun(runId, { status: "stopped" });
        this.emitSse({ kind: "run.stopped", runId, at: Date.now() });
      } else if (code === 0 && run.status !== "failed") {
        this.updateRun(runId, { status: "completed" });
        this.emitSse({ kind: "run.completed", runId, at: Date.now() });
      } else if (run.status !== "stopped") {
        this.updateRun(runId, { status: "failed" });
        this.emitSse({ kind: "run.failed", runId, at: Date.now(), payload: { code } });
      }

      this.refreshDiff(runId);
      this.persistState();
    });

    this.persistState();
    return record;
  }

  stopRun(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active) return false;

    active.stopRequested = true;
    active.process.kill("SIGINT");

    setTimeout(() => {
      const running = this.activeRuns.get(runId);
      if (!running) return;
      running.process.kill("SIGTERM");
      setTimeout(() => {
        const stillRunning = this.activeRuns.get(runId);
        if (!stillRunning) return;
        stillRunning.process.kill("SIGKILL");
      }, 2500);
    }, 2500);

    return true;
  }

  acceptApproval(id: string): ApprovalQueueItem | null {
    const item = this.approvals.get(id);
    if (!item) return null;
    item.status = "accepted";
    this.approvals.set(id, item);
    this.persistState();
    return item;
  }

  private handleStdoutLine(runId: string, line: string): void {
    this.appendEvent(runId, { source: "stdout", text: line });
    this.emitSse({ kind: "run.stdout", runId, at: Date.now(), payload: { text: line } });

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const run = this.runs.get(runId);
    if (!run) return;

    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "thread.started" && typeof parsed.thread_id === "string") {
      const patch: Partial<RunRecord> = { threadId: parsed.thread_id };
      if (!run.sessionId) {
        patch.sessionId = parsed.thread_id;
      }
      this.updateRun(runId, patch);
    }

    if (type === "turn.completed") {
      const usage = parsed.usage as Record<string, unknown> | undefined;
      this.updateRun(runId, {
        usage: usage
          ? {
              inputTokens: toOptionalNumber(usage.input_tokens),
              outputTokens: toOptionalNumber(usage.output_tokens),
              cachedInputTokens: toOptionalNumber(usage.cached_input_tokens),
            }
          : null,
      });
    }

    if (type.startsWith("item.")) {
      const item = parsed.item as Record<string, unknown> | undefined;
      const itemType = typeof item?.type === "string" ? item.type : "unknown";
      this.emitSse({ kind: "run.item", runId, at: Date.now(), payload: { type, item } });

      if (itemType === "agent_message") {
        const text = typeof item?.text === "string" ? item.text : "";
        if (text) this.updateRun(runId, { summary: text.slice(0, 240) });
      }

      if (itemType === "file_change") {
        const changes = Array.isArray(item?.changes) ? item.changes : [];
        const current = new Set(run.changedFiles);
        for (const change of changes) {
          const row = change as Record<string, unknown>;
          if (typeof row.path === "string") current.add(row.path);
        }
        this.updateRun(runId, { changedFiles: [...current] });
        this.refreshDiff(runId);
      }

      if (itemType === "command_execution") {
        const output = typeof item?.aggregated_output === "string" ? item.aggregated_output : "";
        const status = typeof item?.status === "string" ? item.status : "";
        if (status === "failed" && output) {
          this.updateRun(runId, { lastError: output.slice(0, 600) });
          this.checkApprovalSignal(runId, output, item || null);
        }
      }

      if (itemType === "error") {
        const message = typeof item?.message === "string" ? item.message : "Unknown error";
        this.updateRun(runId, { lastError: message, status: "failed" });
        this.checkApprovalSignal(runId, message, item || null);
      }
    }
  }

  private checkApprovalSignal(runId: string, text: string, item: Record<string, unknown> | null): void {
    const lower = text.toLowerCase();
    if (!looksLikeApprovalIssue(lower)) return;

    const command = item && typeof item.command === "string" ? item.command : null;
    const suggestedSandbox =
      lower.includes("read-only") || lower.includes("operation not permitted") ? "workspace-write" : "danger-full-access";

    const approval: ApprovalQueueItem = {
      id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      runId,
      createdAt: Date.now(),
      reason: text.slice(0, 600),
      suggestedSandbox,
      suggestedApprovalPolicy: "on-request",
      command,
      status: "pending",
    };

    this.approvals.set(approval.id, approval);
    this.persistState();
    this.emitSse({ kind: "run.approvalQueued", runId, at: Date.now(), payload: approval as unknown as Record<string, unknown> });
  }

  private refreshDiff(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;

    const isGitRepo = isGitRepository(run.config.workspace);
    if (isGitRepo) {
      const result = spawnSync("git", ["-C", run.config.workspace, "diff", "--no-color"], {
        encoding: "utf8",
      });
      const snapshot: DiffSnapshot = {
        runId,
        at: Date.now(),
        isGitRepo: true,
        diffText: result.stdout || "",
        changedFiles: run.changedFiles,
        fallbackMessage: null,
      };
      this.diffs.set(runId, snapshot);
      this.emitSse({ kind: "run.diffUpdated", runId, at: Date.now(), payload: snapshot as unknown as Record<string, unknown> });
      return;
    }

    const snapshot: DiffSnapshot = {
      runId,
      at: Date.now(),
      isGitRepo: false,
      diffText: "",
      changedFiles: run.changedFiles,
      fallbackMessage: "No git repository detected. Showing changed file paths only.",
    };
    this.diffs.set(runId, snapshot);
    this.emitSse({ kind: "run.diffUpdated", runId, at: Date.now(), payload: snapshot as unknown as Record<string, unknown> });
  }

  private appendEvent(runId: string, partial: Pick<RunEventEntry, "source" | "text">): void {
    const run = this.runs.get(runId);
    if (!run) return;

    const events = [...run.events, { id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), ...partial }];
    const capped = events.length > 1500 ? events.slice(events.length - 1500) : events;
    this.updateRun(runId, { events: capped });
  }

  private updateRun(runId: string, patch: Partial<RunRecord>): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const next = { ...run, ...patch, updatedAt: Date.now() };
    this.runs.set(runId, next);
    this.persistState();
  }

  private emitSse(evt: SseEvent): void {
    this.emit("sse", evt);
  }

  private getSessionRuns(sessionId: string): RunRecord[] {
    return [...this.runs.values()].filter((run) => runSessionId(run) === sessionId);
  }

  private hasActiveRunInSession(sessionId: string): boolean {
    return this.getSessionRuns(sessionId).some((run) => this.activeRuns.has(run.id));
  }

  private removeApprovalsForRunIds(runIds: Set<string>): number {
    let removed = 0;
    for (const [approvalId, approval] of this.approvals.entries()) {
      if (!runIds.has(approval.runId)) continue;
      this.approvals.delete(approvalId);
      removed += 1;
    }
    return removed;
  }

  private persistState(): void {
    persistRuns(this.getRuns(true), this.getApprovals());
  }
}

class TerminalManager extends EventEmitter {
  private terminals = new Map<string, ActiveTerminal>();

  constructor(private readonly getDefaultWorkspace: () => string) {
    super();
  }

  getSession(sessionId: string): TerminalSessionSnapshot | null {
    const active = this.terminals.get(sessionId);
    if (!active) return null;
    return { ...active.session };
  }

  startSession(sessionId: string, workspace: string): TerminalSessionSnapshot {
    const existing = this.terminals.get(sessionId);
    if (existing?.session.status === "running") {
      return { ...existing.session };
    }

    const resolvedWorkspace = path.resolve(workspace || this.getDefaultWorkspace());
    const shell = resolveTerminalShell();
    const shellName = path.basename(shell).toLowerCase();
    const useShellRc = process.env.TERMINAL_USE_SHELL_RC === "1";
    let shellArgs: string[] = [];
    if (process.platform !== "win32") {
      if (useShellRc) {
        shellArgs = ["-i"];
      } else if (shellName.includes("zsh")) {
        shellArgs = ["-f", "-i"];
      } else if (shellName.includes("bash")) {
        shellArgs = ["--noprofile", "--norc", "-i"];
      }
    }

    const usePty = process.env.TERMINAL_DISABLE_PTY !== "1" && nodePty !== null;
    const terminalEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      COLORTERM: process.env.COLORTERM || "truecolor",
      PS1: process.env.TERMINAL_PS1 || "$ ",
      PROMPT: process.env.TERMINAL_PS1 || "$ ",
      PROMPT_EOL_MARK: "",
    };

    const now = Date.now();
    const snapshot: TerminalSessionSnapshot = {
      sessionId,
      status: "running",
      workspace: resolvedWorkspace,
      shell,
      pid: null,
      createdAt: now,
      updatedAt: now,
      output: "",
    };

    let active: ActiveTerminal | null = null;
    let ptyFailureMessage: string | null = null;

    if (usePty && nodePty) {
      try {
        const pty = nodePty.spawn(shell, shellArgs, {
          name: process.env.TERM || "xterm-256color",
          cols: Number(process.env.TERMINAL_COLS || 160),
          rows: Number(process.env.TERMINAL_ROWS || 40),
          cwd: resolvedWorkspace,
          env: terminalEnv,
        });
        snapshot.pid = pty.pid ?? null;
        active = { mode: "pty", pty, session: snapshot };
      } catch (error) {
        ptyFailureMessage = error instanceof Error ? error.message : String(error);
      }
    }

    if (!active) {
      try {
        const child = spawn(shell, shellArgs, {
          cwd: resolvedWorkspace,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: terminalEnv,
        });

        if (!child.stdin || !child.stdout || !child.stderr) {
          throw new Error("Failed to initialize terminal streams");
        }
        snapshot.pid = child.pid ?? null;
        active = { mode: "process", child, session: snapshot };
      } catch (error) {
        const base = error instanceof Error ? error.message : String(error);
        if (ptyFailureMessage) {
          throw new Error(`Terminal startup failed (pty: ${ptyFailureMessage}; fallback: ${base})`);
        }
        throw new Error(`Terminal startup failed: ${base}`);
      }
    }

    if (ptyFailureMessage) {
      const fallbackNote = `$ PTY unavailable (${ptyFailureMessage}). Using fallback terminal mode.\n`;
      snapshot.output = fallbackNote;
      snapshot.shell = `fallback:${shell}`;
    } else if (active.mode === "pty") {
      snapshot.shell = `pty:${shell}`;
    }

    this.terminals.set(sessionId, active);
    this.emitSse({
      kind: "terminal.started",
      at: now,
      sessionId,
      payload: { terminal: snapshot },
    });

    if (active.mode === "pty") {
      const pty = active.pty;
      pty.onData((chunk: string) => {
        this.handleOutputChunk(sessionId, "stdout", chunk);
      });
      pty.onExit((event: { exitCode: number; signal?: number }) => {
        this.onTerminalExit(sessionId, event.exitCode ?? null, event.signal ?? null);
      });
    } else {
      const child = active.child;
      child.stdout?.on("data", (chunk: Buffer) => {
        this.handleOutputChunk(sessionId, "stdout", chunk.toString("utf8"));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        this.handleOutputChunk(sessionId, "stderr", chunk.toString("utf8"));
      });

      child.on("exit", (code, signal) => {
        this.onTerminalExit(sessionId, code ?? null, signal ?? null);
      });
    }

    return { ...snapshot };
  }

  writeInput(sessionId: string, input: string): boolean {
    const active = this.terminals.get(sessionId);
    if (!active || active.session.status !== "running") return false;
    if (active.mode === "pty") {
      active.pty.write(input);
    } else {
      if (!active.child.stdin) return false;
      active.child.stdin.write(input);
    }
    active.session = { ...active.session, updatedAt: Date.now() };
    this.terminals.set(sessionId, active);
    return true;
  }

  interruptSession(sessionId: string): TerminalSessionSnapshot | null {
    const active = this.terminals.get(sessionId);
    if (!active) return null;
    if (active.session.status !== "running") return { ...active.session };
    if (active.mode === "process") {
      try {
        active.child.stdin?.write("\u0003");
      } catch {
        // best-effort
      }
      this.signalProcessTree(active.child.pid, "SIGINT");
    }
    this.sendSignal(active, "SIGINT");
    return { ...active.session };
  }

  stopSession(sessionId: string): TerminalSessionSnapshot | null {
    const active = this.terminals.get(sessionId);
    if (!active) return null;

    if (active.session.status !== "running") {
      return { ...active.session };
    }

    if (active.mode === "pty") {
      const targetPid = active.pty.pid;
      this.sendSignal(active, "SIGTERM");
      setTimeout(() => {
        const current = this.terminals.get(sessionId);
        if (!current || current.session.status !== "running" || current.mode !== "pty" || current.pty.pid !== targetPid) return;
        this.sendSignal(current, "SIGKILL");
      }, 1500);
    } else {
      const targetPid = active.child.pid;
      this.signalProcessTree(targetPid, "SIGTERM");
      this.sendSignal(active, "SIGTERM");

      setTimeout(() => {
        const current = this.terminals.get(sessionId);
        if (!current || current.session.status !== "running" || current.mode !== "process" || current.child.pid !== targetPid) return;
        this.signalProcessTree(targetPid, "SIGKILL");
        this.sendSignal(current, "SIGKILL");
      }, 1500);
    }

    return { ...active.session };
  }

  removeSession(sessionId: string): void {
    const active = this.terminals.get(sessionId);
    if (!active) return;
    if (active.session.status === "running") {
      this.sendSignal(active, "SIGKILL");
    }
    this.terminals.delete(sessionId);
  }

  private handleOutputChunk(sessionId: string, stream: "stdout" | "stderr", text: string): void {
    if (!text) return;
    const cleaned = sanitizeTerminalChunk(text);
    if (!cleaned) return;
    const active = this.terminals.get(sessionId);
    if (!active) return;

    const merged = `${active.session.output}${cleaned}`;
    const output = merged.length > TERMINAL_HISTORY_MAX_CHARS
      ? merged.slice(merged.length - TERMINAL_HISTORY_MAX_CHARS)
      : merged;

    const nextSession: TerminalSessionSnapshot = {
      ...active.session,
      output,
      updatedAt: Date.now(),
    };
    this.terminals.set(sessionId, { ...active, session: nextSession });

    this.emitSse({
      kind: "terminal.output",
      at: Date.now(),
      sessionId,
      payload: {
        sessionId,
        stream,
        text: cleaned,
      },
    });
  }

  private emitSse(evt: SseEvent): void {
    this.emit("sse", evt);
  }

  private onTerminalExit(sessionId: string, code: number | null, signal: number | string | null): void {
    const current = this.terminals.get(sessionId);
    if (!current) return;
    const stoppedSession: TerminalSessionSnapshot = {
      ...current.session,
      status: "stopped",
      pid: null,
      updatedAt: Date.now(),
    };
    this.terminals.set(sessionId, {
      ...current,
      session: stoppedSession,
    });

    this.emitSse({
      kind: "terminal.stopped",
      at: Date.now(),
      sessionId,
      payload: {
        terminal: stoppedSession,
        code,
        signal,
      },
    });
  }

  private sendSignal(active: ActiveTerminal, signal: NodeJS.Signals): void {
    if (active.mode === "pty") {
      try {
        if (signal === "SIGINT") {
          active.pty.write("\u0003");
        } else {
          active.pty.kill(signal);
        }
      } catch {
        // ignore signal errors
      }
      return;
    }

    const pid = active.child.pid;
    if (!pid) return;
    try {
      if (process.platform !== "win32") {
        // Try the whole process group first (foreground command + shell).
        process.kill(-pid, signal);
        return;
      }
      active.child.kill(signal);
    } catch {
      // ignore and retry direct pid below
    }

    try {
      if (process.platform !== "win32") {
        // Fallback to direct child pid if process-group signal failed.
        process.kill(pid, signal);
        return;
      }
      active.child.kill(signal);
    } catch {
      // ignore signal errors
    }
  }

  private signalProcessTree(rootPid: number | undefined, signal: NodeJS.Signals): void {
    if (!rootPid || rootPid <= 0 || process.platform === "win32") return;
    const visited = new Set<number>();
    const queue: number[] = [rootPid];

    while (queue.length > 0) {
      const pid = queue.shift();
      if (!pid || visited.has(pid)) continue;
      visited.add(pid);
      for (const child of getChildPids(pid)) {
        if (!visited.has(child)) queue.push(child);
      }
    }

    const ordered = [...visited].sort((a, b) => b - a);
    for (const pid of ordered) {
      try {
        process.kill(pid, signal);
      } catch {
        // ignore missing-process or permission errors
      }
    }
  }
}

const PLAN_MODE_PREAMBLE = `Plan Mode is enabled. You must:
1) Explore first with non-mutating actions.
2) Clarify assumptions before implementation.
3) Produce explicit implementation steps before execution.
4) Do not skip risk/edge-case analysis.`;

function looksLikeApprovalIssue(lower: string): boolean {
  return (
    lower.includes("operation not permitted") ||
    lower.includes("read-only") ||
    lower.includes("rejected by user approval settings") ||
    lower.includes("network access is restricted") ||
    lower.includes("sandbox") ||
    lower.includes("outside of the project") ||
    lower.includes("not permitted")
  );
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

function sanitizeTerminalChunk(input: string): string {
  if (!input) return "";

  let text = input;
  // Remove OSC sequences (title updates, etc.).
  text = text.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
  // Remove CSI/control escape sequences.
  text = text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
  // Remove carriage-return redraw artifacts.
  text = text.replace(/\r/g, "");

  while (/[^\n]\u0008/.test(text)) {
    text = text.replace(/[^\n]\u0008/g, "");
  }
  text = text.replace(/\u0008/g, "");
  return text;
}

function isBenignCodexStderr(text: string): boolean {
  const lower = stripAnsi(text).toLowerCase();
  return lower.includes("failed to record rollout items: thread")
    && lower.includes(" not found");
}

function toOptionalNumber(input: unknown): number | undefined {
  return typeof input === "number" ? input : undefined;
}

function isGitRepository(workspace: string): boolean {
  const res = spawnSync("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  return res.status === 0 && res.stdout.trim() === "true";
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function ensureDataDir(): void {
  fs.mkdirSync(path.dirname(APP_STATE_PATH), { recursive: true });
}

function loadPersistedUiState(defaultWorkspace: string): PersistedUiState {
  ensureDataDir();
  if (!fs.existsSync(APP_STATE_PATH)) {
    return { activeWorkspace: defaultWorkspace, manualWorkspaces: [] };
  }
  const parsed = safeJsonParse<PersistedUiState>(fs.readFileSync(APP_STATE_PATH, "utf8"), {
    activeWorkspace: defaultWorkspace,
    manualWorkspaces: [],
  });
  return {
    activeWorkspace: parsed.activeWorkspace || defaultWorkspace,
    manualWorkspaces: Array.isArray(parsed.manualWorkspaces) ? parsed.manualWorkspaces : [],
  };
}

function persistUiState(state: PersistedUiState): void {
  ensureDataDir();
  fs.writeFileSync(APP_STATE_PATH, JSON.stringify(state, null, 2));
}

function loadPersistedRuns(): { runs: RunRecord[]; approvals: ApprovalQueueItem[] } {
  ensureDataDir();
  if (!fs.existsSync(RUNS_PATH)) return { runs: [], approvals: [] };
  return safeJsonParse<{ runs: RunRecord[]; approvals: ApprovalQueueItem[] }>(fs.readFileSync(RUNS_PATH, "utf8"), {
    runs: [],
    approvals: [],
  });
}

function persistRuns(runs: RunRecord[], approvals: ApprovalQueueItem[]): void {
  ensureDataDir();
  fs.writeFileSync(RUNS_PATH, JSON.stringify({ runs, approvals }, null, 2));
}

function findUpFile(startDir: string, fileName: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveConfigWorkspaces(): { defaultWorkspace: string; options: WorkspaceOption[] } {
  const configPath = findUpFile(rootDir, "config.yaml") || path.resolve(rootDir, "config.yaml");
  if (!fs.existsSync(configPath)) {
    const cwd = process.cwd();
    return {
      defaultWorkspace: cwd,
      options: [
        {
          id: "cwd",
          name: "Current Workspace",
          path: cwd,
          source: "manual",
        },
      ],
    };
  }

  const text = fs.readFileSync(configPath, "utf8");
  const lines = text.split(/\r?\n/);

  let defaultWorkspace = process.cwd();
  const options: WorkspaceOption[] = [];
  let inRepos = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("default_workspace:")) {
      const value = line.split(":").slice(1).join(":").trim().replace(/^['"]|['"]$/g, "");
      if (value) {
        defaultWorkspace = expandHome(value);
        options.push({
          id: "default_workspace",
          name: "Default Workspace",
          path: defaultWorkspace,
          source: "config-default",
        });
      }
      continue;
    }

    if (line.trim() === "repos:") {
      inRepos = true;
      continue;
    }

    if (!inRepos) continue;
    const match = line.match(/^\s{2}([^:]+):\s*(.+)$/);
    if (!match) continue;
    const name = match[1].trim();
    const repoPath = expandHome(match[2].trim().replace(/^['"]|['"]$/g, ""));

    options.push({
      id: `repo_${name}`,
      name,
      path: repoPath,
      source: "config-repo",
    });
  }

  const dedup = new Map<string, WorkspaceOption>();
  for (const option of options) dedup.set(option.path, option);

  return {
    defaultWorkspace,
    options: [...dedup.values()],
  };
}

function expandHome(value: string): string {
  if (!value.startsWith("~")) return value;
  return path.join(os.homedir(), value.slice(1));
}

function listTree(root: string, relativePath: string, depth: number): FileTreeNode[] {
  const resolved = path.resolve(root, relativePath || ".");
  if (!resolved.startsWith(path.resolve(root))) return [];
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return [];

  const ignored = new Set([".git", "node_modules", "dist", ".next", "coverage", ".turbo"]);
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => !ignored.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map((entry) => {
    const childPath = path.join(resolved, entry.name);
    const rel = path.relative(root, childPath) || ".";
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: rel,
        type: "directory" as const,
        children: depth > 0 ? listTree(root, rel, depth - 1) : [],
      };
    }
    return {
      name: entry.name,
      path: rel,
      type: "file" as const,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function looksLikeEnvelopeMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.startsWith("<user_instructions>")
    || normalized.startsWith("<environment_context>")
    || normalized.startsWith("<ide_context>");
}

function normalizeSessionTitle(raw: string, fallback: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;

  const dashIndex = collapsed.indexOf("---");
  const trimmed = dashIndex >= 0 ? collapsed.slice(0, dashIndex).trim() : collapsed;
  const title = trimmed || fallback;

  return title.length > 160 ? `${title.slice(0, 157)}...` : title;
}

function extractFirstUserMessage(lines: string[]): string {
  let fallback = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const row = safeJsonParse<Record<string, unknown>>(line, {});
    if (row.type !== "message" || row.role !== "user") continue;

    const content = Array.isArray(row.content) ? row.content : [];
    const textParts: string[] = [];
    for (const part of content) {
      if (!isRecord(part) || part.type !== "input_text") continue;
      if (typeof part.text === "string" && part.text.trim()) {
        textParts.push(part.text);
      }
    }

    const candidate = textParts.join("\n").trim();
    if (!candidate) continue;
    if (!fallback) fallback = candidate;
    if (!looksLikeEnvelopeMessage(candidate)) return candidate;
  }

  return fallback;
}

function loadCodexSessionHistory(limit = 0): SessionHistoryEntry[] {
  const root = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(root)) return [];

  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const selected = limit > 0 ? files.slice(0, limit) : files;

  const out: SessionHistoryEntry[] = [];
  for (const file of selected) {
    if (file.toLowerCase().includes(`${path.sep}archived${path.sep}`)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let payload: Record<string, unknown> | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      const row = safeJsonParse<Record<string, unknown>>(line, {});
      if (row.type !== "session_meta" || !isRecord(row.payload)) continue;
      payload = row.payload;
      break;
    }

    if (!payload) continue;

    const id = typeof payload.id === "string" ? payload.id : path.basename(file);
    const timestamp = typeof payload.timestamp === "string" ? payload.timestamp : new Date(fs.statSync(file).mtimeMs).toISOString();
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    const source = typeof payload.source === "string" ? payload.source : "unknown";
    const firstMessage = extractFirstUserMessage(lines);
    const summary = normalizeSessionTitle(firstMessage, `Session in ${cwd || "unknown cwd"}`);

    out.push({
      id,
      timestamp,
      cwd,
      source,
      model: typeof payload.model === "string" ? payload.model : undefined,
      cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
      summary,
    });
  }

  return out;
}

const { defaultWorkspace, options: configWorkspaceOptions } = resolveConfigWorkspaces();
let uiState = loadPersistedUiState(defaultWorkspace);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: [
      `http://localhost:${WEB_PORT}`,
      `http://127.0.0.1:${WEB_PORT}`,
      `http://0.0.0.0:${WEB_PORT}`,
    ],
    credentials: false,
  }),
);

const runManager = new RunManager(CODEX_PATH);
const persisted = loadPersistedRuns();
runManager.loadPersisted(persisted.runs, persisted.approvals);
const terminalManager = new TerminalManager(() => uiState.activeWorkspace);

const sseClients = new Set<express.Response>();
runManager.on("sse", (event: SseEvent) => {
  const data = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(data);
});
terminalManager.on("sse", (event: SseEvent) => {
  const data = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(data);
});

setInterval(() => {
  const evt: SseEvent = { kind: "heartbeat", at: Date.now() };
  const data = `event: heartbeat\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const client of sseClients) client.write(data);
}, 10000);

function apiOk<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function apiErr(message: string): ApiResponse<never> {
  return { ok: false, error: { message } };
}

function runCodexCommandStatus(args: string[]): CodexCommandStatus {
  const command = [CODEX_PATH, ...args].join(" ");
  const result = spawnSync(CODEX_PATH, args, {
    cwd: uiState.activeWorkspace,
    encoding: "utf8",
    timeout: 15000,
  });

  const statusCode = typeof result.status === "number" ? result.status : 1;
  const errorText = result.error ? (result.error instanceof Error ? result.error.message : String(result.error)) : "";
  const stdout = (result.stdout || "").trim();
  const stderr = [result.stderr || "", errorText].filter(Boolean).join("\n").trim();

  return {
    command,
    ok: statusCode === 0,
    exitCode: statusCode,
    stdout,
    stderr,
  };
}

function extractRemainingTokens(raw: string): number | null {
  const patterns = [
    /remaining\s+tokens?\s*[:=]\s*([0-9][0-9,]*)/i,
    /tokens?\s+remaining\s*[:=]\s*([0-9][0-9,]*)/i,
    /remaining\s*[:=]\s*([0-9][0-9,]*)\s*tokens?/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function resolveTokenStatus(accountStatus: CodexCommandStatus): CodexTokenStatus {
  if (!accountStatus.ok) {
    return {
      source: "codex-login-status",
      remainingTokens: null,
      note: "Unable to read account status from Codex CLI.",
    };
  }

  const combined = `${accountStatus.stdout}\n${accountStatus.stderr}`.trim();
  const remainingTokens = extractRemainingTokens(combined);
  if (remainingTokens !== null) {
    return {
      source: "codex-login-status",
      remainingTokens,
      note: null,
    };
  }

  return {
    source: "codex-login-status",
    remainingTokens: null,
    note: "Codex CLI does not expose remaining tokens for this account.",
  };
}

function getWorkspaces(): WorkspaceOption[] {
  const merged = new Map<string, WorkspaceOption>();
  for (const option of configWorkspaceOptions) merged.set(option.path, option);

  for (const manual of uiState.manualWorkspaces) {
    merged.set(manual, {
      id: `manual_${manual}`,
      name: path.basename(manual) || manual,
      path: manual,
      source: "manual",
    });
  }

  if (!merged.has(uiState.activeWorkspace)) {
    merged.set(uiState.activeWorkspace, {
      id: `active_${uiState.activeWorkspace}`,
      name: path.basename(uiState.activeWorkspace) || uiState.activeWorkspace,
      path: uiState.activeWorkspace,
      source: "manual",
    });
  }

  return [...merged.values()];
}

app.get("/api/bootstrap", (_req, res) => {
  const payload: AppBootstrap = {
    defaults: {
      model: DEFAULT_MODEL,
      sandbox: DEFAULT_SANDBOX as "read-only" | "workspace-write" | "danger-full-access",
    },
    activeWorkspace: uiState.activeWorkspace,
    workspaces: getWorkspaces(),
    runs: runManager.getRuns(false),
    approvals: runManager.getApprovals(),
  };
  res.json(apiOk(payload));
});

app.get("/api/workspaces", (_req, res) => {
  res.json(apiOk({ activeWorkspace: uiState.activeWorkspace, workspaces: getWorkspaces() }));
});

app.get("/api/system/mcp-status", (_req, res) => {
  const payload: CodexMcpStatusResponse = {
    at: Date.now(),
    mcp: runCodexCommandStatus(["mcp", "list"]),
  };
  res.json(apiOk(payload));
});

app.get("/api/system/account-status", (_req, res) => {
  const account = runCodexCommandStatus(["login", "status"]);
  const payload: CodexAccountStatusResponse = {
    at: Date.now(),
    account,
    tokenStatus: resolveTokenStatus(account),
  };
  res.json(apiOk(payload));
});

app.get("/api/system/status", (_req, res) => {
  const account = runCodexCommandStatus(["login", "status"]);
  const payload: CodexSystemStatusResponse = {
    at: Date.now(),
    account,
    mcp: runCodexCommandStatus(["mcp", "list"]),
    tokenStatus: resolveTokenStatus(account),
  };
  res.json(apiOk(payload));
});

app.post("/api/workspaces/active", (req, res) => {
  const parsed = setWorkspaceSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid workspace payload"));
    return;
  }

  const workspace = path.resolve(parsed.data.workspace);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    res.status(400).json(apiErr("Workspace does not exist or is not a directory"));
    return;
  }

  uiState = {
    ...uiState,
    activeWorkspace: workspace,
    manualWorkspaces: parsed.data.persist
      ? Array.from(new Set([...uiState.manualWorkspaces, workspace]))
      : uiState.manualWorkspaces,
  };
  persistUiState(uiState);

  res.json(apiOk({ activeWorkspace: workspace, workspaces: getWorkspaces() }));
});

app.get("/api/runs", (_req, res) => {
  res.json(apiOk({ runs: runManager.getRuns(false), approvals: runManager.getApprovals() }));
});

app.post("/api/runs/start", (req, res) => {
  const parsed = startRunSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid run payload"));
    return;
  }

  const workspace = path.resolve(parsed.data.workspace || uiState.activeWorkspace);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    res.status(400).json(apiErr("Workspace does not exist"));
    return;
  }

  try {
    const run = runManager.startRun({
      workspace,
      prompt: parsed.data.prompt,
      model: parsed.data.model,
      sandbox: parsed.data.sandbox,
      approvalPolicy: parsed.data.approvalPolicy,
      planMode: parsed.data.planMode,
      sessionId: parsed.data.sessionId,
    });

    res.json(apiOk({ run }));
  } catch (error) {
    res.status(409).json(apiErr(error instanceof Error ? error.message : "Failed to start run"));
  }
});

app.post("/api/runs/:runId/stop", (req, res) => {
  const { runId } = req.params;
  const ok = runManager.stopRun(runId);
  if (!ok) {
    res.status(404).json(apiErr("Run is not active"));
    return;
  }
  res.json(apiOk({ stopped: true }));
});

app.post("/api/runs/:runId/rerun", (req, res) => {
  const { runId } = req.params;
  const baseRun = runManager.getRun(runId);
  if (!baseRun) {
    res.status(404).json(apiErr("Run not found"));
    return;
  }

  const parsed = rerunSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid rerun payload"));
    return;
  }

  try {
    const run = runManager.startRun({
      ...baseRun.config,
      sandbox: parsed.data.sandbox || baseRun.config.sandbox,
      approvalPolicy: parsed.data.approvalPolicy || baseRun.config.approvalPolicy,
      sessionId: baseRun.sessionId || undefined,
    });

    const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId : null;
    if (approvalId) runManager.acceptApproval(approvalId);

    res.json(apiOk({ run }));
  } catch (error) {
    res.status(409).json(apiErr(error instanceof Error ? error.message : "Failed to rerun"));
  }
});

app.post("/api/runs/:runId/approval/:approvalId/accept", (req, res) => {
  const parsedPolicy = approvalPolicySchema.safeParse(req.body?.approvalPolicy ?? "on-request");
  if (!parsedPolicy.success) {
    res.status(400).json(apiErr("Invalid approval policy"));
    return;
  }

  const approval = runManager.acceptApproval(req.params.approvalId);
  if (!approval) {
    res.status(404).json(apiErr("Approval item not found"));
    return;
  }

  const baseRun = runManager.getRun(req.params.runId);
  if (!baseRun) {
    res.status(404).json(apiErr("Run not found"));
    return;
  }

  try {
    const run = runManager.startRun({
      ...baseRun.config,
      sandbox: approval.suggestedSandbox,
      approvalPolicy: parsedPolicy.data,
      sessionId: baseRun.sessionId || undefined,
    });
    res.json(apiOk({ run, approval }));
  } catch (error) {
    res.status(409).json(apiErr(error instanceof Error ? error.message : "Failed to run escalation"));
  }
});

app.get("/api/runs/:runId", (req, res) => {
  const run = runManager.getRun(req.params.runId);
  if (!run) {
    res.status(404).json(apiErr("Run not found"));
    return;
  }

  const approvals = runManager.getApprovals().filter((item) => item.runId === run.id);
  res.json(apiOk({ run, approvals }));
});

app.get("/api/runs/:runId/diff", (req, res) => {
  const diff = runManager.getDiff(req.params.runId);
  if (!diff) {
    res.status(404).json(apiErr("Diff not available yet for this run"));
    return;
  }
  res.json(apiOk(diff));
});

app.post("/api/sessions/:sessionId/archive", (req, res) => {
  try {
    const result = runManager.archiveSession(req.params.sessionId);
    if (!result) {
      res.status(404).json(apiErr("Session not found"));
      return;
    }
    terminalManager.removeSession(req.params.sessionId);
    res.json(apiOk({ sessionId: req.params.sessionId, archivedRuns: result.archivedRuns }));
  } catch (error) {
    res.status(409).json(apiErr(error instanceof Error ? error.message : "Failed to archive session"));
  }
});

app.delete("/api/sessions/:sessionId", (req, res) => {
  try {
    const result = runManager.deleteSession(req.params.sessionId);
    if (!result) {
      res.status(404).json(apiErr("Session not found"));
      return;
    }
    terminalManager.removeSession(req.params.sessionId);
    res.json(apiOk({ sessionId: req.params.sessionId, ...result }));
  } catch (error) {
    res.status(409).json(apiErr(error instanceof Error ? error.message : "Failed to delete session"));
  }
});

app.get("/api/terminals/:sessionId", (req, res) => {
  const terminal = terminalManager.getSession(req.params.sessionId);
  res.json(apiOk({ terminal }));
});

app.post("/api/terminals/:sessionId/start", (req, res) => {
  const workspaceRaw = typeof req.body?.workspace === "string" && req.body.workspace.trim()
    ? req.body.workspace
    : uiState.activeWorkspace;
  const workspace = path.resolve(workspaceRaw);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    res.status(400).json(apiErr("Workspace does not exist"));
    return;
  }

  try {
    const terminal = terminalManager.startSession(req.params.sessionId, workspace);
    res.json(apiOk({ terminal }));
  } catch (error) {
    res.status(409).json(apiErr(error instanceof Error ? error.message : "Failed to start terminal"));
  }
});

app.post("/api/terminals/:sessionId/stop", (req, res) => {
  const terminal = terminalManager.stopSession(req.params.sessionId);
  if (!terminal) {
    res.status(404).json(apiErr("Terminal session not found"));
    return;
  }
  res.json(apiOk({ terminal }));
});

app.post("/api/terminals/:sessionId/interrupt", (req, res) => {
  const terminal = terminalManager.interruptSession(req.params.sessionId);
  if (!terminal) {
    res.status(404).json(apiErr("Terminal session not found"));
    return;
  }
  res.json(apiOk({ terminal }));
});

app.post("/api/terminals/:sessionId/input", (req, res) => {
  const input = typeof req.body?.input === "string" ? req.body.input : "";
  if (!input) {
    res.status(400).json(apiErr("Input is required"));
    return;
  }

  const accepted = terminalManager.writeInput(req.params.sessionId, input);
  if (!accepted) {
    res.status(404).json(apiErr("Terminal is not running for this session"));
    return;
  }

  res.json(apiOk({ accepted: true }));
});

app.get("/api/files/tree", (req, res) => {
  const relativePath = typeof req.query.path === "string" ? req.query.path : ".";
  const depth = Number(req.query.depth ?? 2);

  const workspace = uiState.activeWorkspace;
  const nodes = listTree(workspace, relativePath, Number.isFinite(depth) ? Math.min(Math.max(depth, 0), 5) : 2);
  res.json(apiOk({ root: relativePath, nodes }));
});

app.get("/api/sessions/history", (_req, res) => {
  const codex = loadCodexSessionHistory(0);
  const localBySession = new Map<string, { latest: RunRecord; firstPrompt: string; firstCreatedAt: number }>();
  for (const run of runManager.getRuns(false)) {
    const key = run.sessionId || run.threadId || run.id;
    const existing = localBySession.get(key);
    if (!existing) {
      localBySession.set(key, {
        latest: run,
        firstPrompt: run.config.prompt || "",
        firstCreatedAt: run.createdAt,
      });
      continue;
    }
    if (run.createdAt < existing.firstCreatedAt && run.config.prompt.trim()) {
      existing.firstPrompt = run.config.prompt;
      existing.firstCreatedAt = run.createdAt;
    }
    if (run.updatedAt > existing.latest.updatedAt) {
      existing.latest = run;
    }
  }

  const local: SessionHistoryEntry[] = [...localBySession.entries()].map(([id, row]) => ({
    id,
    timestamp: new Date(row.latest.updatedAt || row.latest.createdAt).toISOString(),
    cwd: row.latest.config.workspace,
    source: "agentic-cli",
    model: row.latest.config.model,
    cliVersion: undefined,
    summary: normalizeSessionTitle(row.firstPrompt || row.latest.summary || "", `Session in ${row.latest.config.workspace || "unknown cwd"}`),
  }));

  const mergedById = new Map<string, SessionHistoryEntry>();
  for (const entry of [...codex, ...local]) {
    const existing = mergedById.get(entry.id);
    if (!existing) {
      mergedById.set(entry.id, entry);
      continue;
    }

    const currentTime = Date.parse(existing.timestamp) || 0;
    const nextTime = Date.parse(entry.timestamp) || 0;
    const existingScore = existing.summary.startsWith("Session in ") ? 0 : 1;
    const nextScore = entry.summary.startsWith("Session in ") ? 0 : 1;

    if (nextTime > currentTime || (nextTime === currentTime && nextScore > existingScore)) {
      mergedById.set(entry.id, entry);
    }
  }

  const merged = [...mergedById.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  res.json(apiOk({ entries: merged }));
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);
  res.write(`event: heartbeat\ndata: ${JSON.stringify({ kind: "heartbeat", at: Date.now() })}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.listen(API_PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[agentic-cli/server] listening on http://${HOST}:${API_PORT}`);
});
