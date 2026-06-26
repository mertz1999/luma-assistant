import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
  query as queryClaudeCode,
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionResult,
  type Query as ClaudeQuery,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPermissionDenial,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import type { IPty } from "node-pty";
import {
  approvalPolicySchema,
  attachmentRefSchema,
  createTaskManagerCommentSchema,
  createTaskManagerLabelSchema,
  createTaskManagerProjectSchema,
  createTaskManagerTaskSchema,
  createTaskManagerUserSchema,
  createAgentScheduleSchema,
  rerunSchema,
  sendMessageSchema,
  setWorkspaceSchema,
  startRunSchema,
  taskManagerLoginSchema,
  updateTaskManagerProfileSchema,
  updateAgentScheduleSchema,
  updateTaskManagerProjectSchema,
  updateTaskManagerTaskSchema,
  updateTaskManagerUserSchema,
  type ApiResponse,
  type AgentListItem,
  type AgentListResponse,
  type AgentSchedule,
  type AgentScheduleExecution,
  type AgentScheduleListResponse,
  type AgentScheduleTime,
  type ApprovalQueueItem,
  type AppBootstrap,
  type AppBootstrapLite,
  type AttachmentRef,
  type ChatMessage,
  type CodexAccountStatusResponse,
  type CodexCommandStatus,
  type CodexMcpStatusResponse,
  type CodexSystemStatusResponse,
  type CodexTokenStatus,
  type RunConfig,
  type ReasoningEffort,
  type RunListItem,
  type RunMessageEntry,
  type RunMessageFileChange,
  type RunEventEntry,
  type RunRecord,
  type RunRunner,
  type RunSourceTag,
  type SelectedAgentRef,
  type SelectedSkillRef,
  type SendMessageAccepted,
  type SendMessageInput,
  type SessionListItem,
  type SessionHistoryEntry,
  type SessionListResponse,
  type SessionMessagesResponse,
  type SessionTranscriptEntry,
  type SessionTranscriptResponse,
  type SessionTokenUsageResponse,
  type SkillSyncResult,
  type SkillListItem,
  type SkillListResponse,
  type SseEvent,
  type TerminalSessionSnapshot,
  type TaskManagerActivity,
  type TaskManagerBootstrap,
  type TaskManagerComment,
  type TaskManagerLabel,
  type TaskManagerPriority,
  type TaskManagerProject,
  type TaskManagerRole,
  type TaskManagerStatus,
  type TaskManagerTask,
  type TaskManagerUser,
  type TokenUsageSummary,
  type WorkspaceOption,
} from "@luma/shared";

const rootDir = path.resolve(process.env.INIT_CWD || process.cwd());
dotenv.config({ path: path.resolve(rootDir, ".env") });
const require = createRequire(import.meta.url);

const APP_STATE_PATH = path.resolve(rootDir, "data/ui-state.json");
const RUNS_PATH = path.resolve(rootDir, "data/runs.json");
const AGENTS_DIR = path.resolve(rootDir, "agents");
const REPO_SKILLS_DIR = path.resolve(rootDir, "skills");
const AGENT_SCHEDULES_PATH = path.resolve(rootDir, "data/agent-schedules.json");
const SESSION_INDEX_PATH = path.resolve(rootDir, "data/session-index.json");
const MESSAGE_STORE_META_PATH = path.resolve(rootDir, "data/message-store-meta.json");
const MESSAGE_OUTBOX_PATH = path.resolve(rootDir, "data/message-outbox.json");
const MESSAGE_LOG_DIR = path.resolve(rootDir, "data/messages");
const TASK_MANAGER_DATA_PATH = path.resolve(rootDir, "data/taskmanager/state.json");
const SESSION_IMAGE_DIR = path.resolve(rootDir, "data/session-images");

const API_PORT = Number(process.env.API_PORT || 9001);
const WEB_PORT = Number(process.env.WEB_PORT || 5175);
const HOST = process.env.HOST || "0.0.0.0";
const CODEX_PATH = process.env.CODEX_PATH || "codex";
const DEFAULT_RUNNER: RunRunner = process.env.DEFAULT_RUNNER === "claude" ? "claude" : "codex";
const DEFAULT_CODEX_MODEL = process.env.DEFAULT_MODEL || process.env.CODEX_DEFAULT_MODEL || "gpt-5.3-codex";
const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_DEFAULT_MODEL || "sonnet";
const DEFAULT_MODEL = DEFAULT_RUNNER === "claude" ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL;
const CLAUDE_AUTH_MODE = process.env.CLAUDE_AUTH_MODE === "api_key" ? "api_key" : "oauth";
const CLAUDE_CODE_EXECUTABLE = resolveClaudeCodeExecutable(process.env.CLAUDE_CODE_EXECUTABLE);
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(process.env.DEFAULT_REASONING_EFFORT);
const DEFAULT_SANDBOX = resolveDefaultSandboxMode();
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS || 8);
const AUTH_PASSWORD = process.env.PASSWORD || process.env.APP_PASSWORD || "";
const AUTH_ENABLED = AUTH_PASSWORD.length > 0;
const AUTH_TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL_SECONDS || 24 * 60 * 60);
const JWT_SECRET = process.env.JWT_SECRET || AUTH_PASSWORD || "luma-assistant-default-jwt-secret";
const TASK_MANAGER_ADMIN_USERNAME = process.env.TASK_MANAGER_ADMIN_USERNAME || "admin";
const TASK_MANAGER_ADMIN_PASSWORD = process.env.TASK_MANAGER_ADMIN_PASSWORD || AUTH_PASSWORD;
const TASK_MANAGER_JWT_SECRET = process.env.TASK_MANAGER_JWT_SECRET || JWT_SECRET;
const TASK_MANAGER_TOKEN_TTL_SECONDS = Number(process.env.TASK_MANAGER_TOKEN_TTL_SECONDS || 7 * 24 * 60 * 60);
const TASK_MANAGER_DEFAULT_TIME_ZONE = process.env.TASK_MANAGER_DEFAULT_TIME_ZONE || "Asia/Tehran";
const PLAN_MODE_FILE_PATH = path.resolve(rootDir, "plan.md");
const ATTACHMENT_STAGING_DIR = path.join(".agentic", "attachments");
const ATTACHMENT_MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES || 15 * 1024 * 1024);
const IMAGE_MCP_MAX_BYTES = Number(process.env.IMAGE_MCP_MAX_BYTES || 3 * 1024 * 1024);
const IMAGE_MCP_MAX_HEIGHT = Number(process.env.IMAGE_MCP_MAX_HEIGHT || 1200);
const ATTACHMENT_MAX_FILES = 10;
const RUN_LIST_PAGE_DEFAULT = Number(process.env.RUN_LIST_PAGE_DEFAULT || 60);
const RUN_LIST_PAGE_MAX = Number(process.env.RUN_LIST_PAGE_MAX || 200);
const RUN_MESSAGE_PAGE_SIZE = 30;
const SESSION_LIST_PAGE_DEFAULT = Number(process.env.SESSION_LIST_PAGE_DEFAULT || 60);
const SESSION_LIST_PAGE_MAX = Number(process.env.SESSION_LIST_PAGE_MAX || 200);
const SESSION_MESSAGE_PAGE_SIZE = 30;
const STORED_EVENT_TEXT_MAX_CHARS = Number(process.env.STORED_EVENT_TEXT_MAX_CHARS || 24000);
const RUNS_PERSIST_DEBOUNCE_MS = Number(process.env.RUNS_PERSIST_DEBOUNCE_MS || 750);
const SESSION_INDEX_PERSIST_DEBOUNCE_MS = Number(process.env.SESSION_INDEX_PERSIST_DEBOUNCE_MS || 500);
const MESSAGE_OUTBOX_RETRY_DELAYS_MS = [1000, 3000, 10000];
const MESSAGE_STORE_SCHEMA_VERSION = 1;
const TEHRAN_TIMEZONE = "Asia/Tehran";
const LOCAL_SESSION_SOURCE = "luma-assistant";
const LEGACY_LOCAL_SESSION_SOURCE = "agentic-cli";
const MANAGED_SKILL_MARKER = ".luma-managed-skill.json";
const LEGACY_MANAGED_SKILL_MARKER = ".agentic-managed-skill.json";

const IMAGE_ATTACHMENT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const IMAGE_ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".csv",
  ".tsv",
  ".log",
  ".svg",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".html",
  ".css",
  ".scss",
]);
const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/yaml",
  "application/x-yaml",
  "application/csv",
  "application/x-sh",
  "image/svg+xml",
]);

type ResolvedAttachment = {
  ref: AttachmentRef;
  absolutePath: string;
};

type ResolvedSkill = {
  item: SkillListItem;
  content: string;
};

type ResolvedAgent = {
  item: DiscoveredAgent;
  content: string;
};

type DiscoveredAgent = AgentListItem & {
  prompt: string;
};

type PersistedAgentScheduleState = {
  schedules: AgentSchedule[];
  executions: AgentScheduleExecution[];
};

type PersistedUiState = {
  activeWorkspace: string;
  manualWorkspaces: string[];
};

type CodexActiveRun = {
  runner: "codex";
  process: ChildProcess;
  stdoutBuffer: string;
  stopRequested: boolean;
};

type ClaudeActiveRun = {
  runner: "claude";
  abortController: AbortController;
  query: ClaudeQuery | null;
  stopRequested: boolean;
};

type ActiveRun = CodexActiveRun | ClaudeActiveRun;

type ClaudePermissionWaiter = {
  runId: string;
  toolName: string;
  toolUseId: string;
  resolve: (result: PermissionResult) => void;
  timer: NodeJS.Timeout;
};

type MessageStoreMeta = {
  schemaVersion: number;
  backfilledAt: number;
};

type SessionState = {
  item: SessionListItem;
  messages: ChatMessage[];
  messageIds: Map<string, number>;
  nextSequence: number;
};

type OutboxStatus = "pending" | "processing" | "failed";

type MessageOutboxItem = {
  id: string;
  sessionId: string;
  provisionalSession: boolean;
  messageId: string;
  clientMessageId: string;
  text: string;
  attachments: AttachmentRef[];
  workspace: string;
  runner: RunRunner;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: RunConfig["sandbox"];
  approvalPolicy: RunConfig["approvalPolicy"];
  planMode: boolean;
  skills: SelectedSkillRef[];
  agents: SelectedAgentRef[];
  attempts: number;
  status: OutboxStatus;
  nextAttemptAt: number | null;
  lastError: string | null;
  latestRunId: string | null;
  createdAt: number;
  updatedAt: number;
};

type PersistedTaskManagerUser = TaskManagerUser & {
  passwordHash: string;
  passwordSalt: string;
};

type PersistedTaskManagerState = {
  users: PersistedTaskManagerUser[];
  projects: TaskManagerProject[];
  labels: TaskManagerLabel[];
  tasks: TaskManagerTask[];
  comments: TaskManagerComment[];
  activity: TaskManagerActivity[];
};

type TaskManagerSession = {
  userId: string;
  role: TaskManagerRole;
  username: string;
};

type TaskManagerRequest = express.Request & {
  taskUser?: TaskManagerSession;
};

type RunLifecycleKind = "started" | "completed" | "failed" | "stopped" | "updated";

type RunLifecycleEvent = {
  kind: RunLifecycleKind;
  run: RunRecord;
  previous: RunRecord | null;
};

type RunParsedEvent = {
  runId: string;
  run: RunRecord;
  parsed: Record<string, unknown>;
};

type RunStderrEvent = {
  runId: string;
  run: RunRecord;
  text: string;
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

function normalizeRunRunner(input: unknown): RunRunner {
  return input === "claude" ? "claude" : "codex";
}

function normalizeReasoningEffort(input: unknown): ReasoningEffort {
  return input === "low" || input === "medium" || input === "high" ? input : "high";
}

function resolveClaudeThinkingConfig(model: string, effort: ReasoningEffort): ClaudeOptions["thinking"] | undefined {
  const lowerModel = model.toLowerCase();
  if (lowerModel.includes("haiku")) return undefined;
  if (effort === "low") return undefined;
  return {
    type: "enabled",
    budgetTokens: effort === "medium" ? 2048 : 4096,
  };
}

function aggregateRunTokenUsage(runs: RunRecord[]): TokenUsageSummary | null {
  let hasUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  for (const run of runs) {
    if (!run.usage) continue;
    hasUsage = true;
    inputTokens += run.usage.inputTokens ?? 0;
    outputTokens += run.usage.outputTokens ?? 0;
    cachedInputTokens += run.usage.cachedInputTokens ?? 0;
  }

  return hasUsage
    ? {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
      }
    : null;
}

function normalizeRunSourceTag(sourceRaw: string, historyOnly: boolean): RunSourceTag {
  if (!historyOnly) return "in-app";

  const normalized = sourceRaw.trim().toLowerCase();
  if (normalized === "vscode") return "vscode";
  if (normalized === "cli" || normalized === LEGACY_LOCAL_SESSION_SOURCE || normalized === LOCAL_SESSION_SOURCE) return "cli";
  if (normalized === "exec") return "exec";
  return "other";
}

function normalizeRunListName(raw: string, fallback: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;

  const dashIndex = collapsed.indexOf("---");
  const trimmed = dashIndex >= 0 ? collapsed.slice(0, dashIndex).trim() : collapsed;
  const title = trimmed || fallback;
  return title.length > 160 ? `${title.slice(0, 157)}...` : title;
}

function encodeCursor(value: number): string {
  return Buffer.from(String(Math.max(0, Math.floor(value))), "utf8").toString("base64url");
}

function decodeCursor(input: unknown): number | null {
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    const decoded = Buffer.from(input, "base64url").toString("utf8");
    const value = Number(decoded);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function clampListLimit(input: unknown, fallback = RUN_LIST_PAGE_DEFAULT, max = RUN_LIST_PAGE_MAX): number {
  const raw = typeof input === "string" ? Number(input) : Number(input ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.floor(raw), 1), max);
}

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const hidden = input.length - maxChars;
  return `${input.slice(0, maxChars)}\n...[truncated ${hidden} chars]`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2));
  await fs.promises.rename(tempPath, filePath);
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function makeTaskManagerId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function hashTaskManagerPassword(password: string, salt = randomBytes(16).toString("hex")): { hash: string; salt: string } {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyTaskManagerPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeTaskManagerTimeZone(timeZone: string | undefined | null): string {
  const candidate = (timeZone || TASK_MANAGER_DEFAULT_TIME_ZONE).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(Date.now());
    return candidate;
  } catch {
    return TASK_MANAGER_DEFAULT_TIME_ZONE;
  }
}

function requireValidTaskManagerTimeZone(timeZone: string): string {
  const normalized = timeZone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(Date.now());
    return normalized;
  } catch {
    throw new Error("Invalid timezone.");
  }
}

function taskManagerZonedParts(timestamp: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(timestamp);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value || "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function taskManagerTimeZoneOffsetMs(timestamp: number, timeZone: string): number {
  const parts = taskManagerZonedParts(timestamp, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - timestamp;
}

function taskManagerZonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = utcGuess - taskManagerTimeZoneOffsetMs(utcGuess, timeZone);
  return utcGuess - taskManagerTimeZoneOffsetMs(first, timeZone);
}

function taskManagerStartOfToday(timeZone: string): number {
  const parts = taskManagerZonedParts(Date.now(), timeZone);
  return taskManagerZonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
}

function taskManagerEndOfToday(timeZone: string): number {
  const parts = taskManagerZonedParts(Date.now(), timeZone);
  return taskManagerZonedTimeToUtc(parts.year, parts.month, parts.day, 23, 59, 59, timeZone);
}

function taskManagerCalendarDateWithOffset(year: number, month: number, day: number, offsetDays: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function taskManagerEndOfTomorrow(timeZone: string): number {
  const parts = taskManagerZonedParts(Date.now(), timeZone);
  const tomorrow = taskManagerCalendarDateWithOffset(parts.year, parts.month, parts.day, 1);
  return taskManagerZonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 23, 59, 59, timeZone);
}

function taskManagerFormatReportDate(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(timestamp);
}

function taskManagerFormatShortDate(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

function taskManagerPriorityIcon(priority: TaskManagerPriority): string {
  if (priority === "urgent") return "🔴";
  if (priority === "high") return "🟠";
  if (priority === "medium") return "🟡";
  return "🟢";
}

function taskManagerCalendarDaySerial(timestamp: number, timeZone: string): number {
  const parts = taskManagerZonedParts(timestamp, timeZone);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function taskManagerDaysUntilDate(timestamp: number, timeZone: string): number {
  return taskManagerCalendarDaySerial(timestamp, timeZone) - taskManagerCalendarDaySerial(Date.now(), timeZone);
}

function taskManagerFormatDaysLeftLabel(daysLeft: number): string {
  if (daysLeft < 0) {
    const overdueDays = Math.abs(daysLeft);
    return `Overdue by ${overdueDays} ${overdueDays === 1 ? "day" : "days"}`;
  }
  if (daysLeft === 0) return "0 days left";
  if (daysLeft === 1) return "1 day left";
  return `${daysLeft} days left`;
}

function publicTaskManagerUser(user: PersistedTaskManagerUser): TaskManagerUser {
  const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...safeUser } = user;
  return safeUser;
}

function loadPersistedTaskManagerState(): PersistedTaskManagerState {
  const fallback: PersistedTaskManagerState = {
    users: [],
    projects: [],
    labels: [],
    tasks: [],
    comments: [],
    activity: [],
  };
  if (!fs.existsSync(TASK_MANAGER_DATA_PATH)) return fallback;
  const parsed = safeJsonParse<PersistedTaskManagerState>(fs.readFileSync(TASK_MANAGER_DATA_PATH, "utf8"), fallback);
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    labels: Array.isArray(parsed.labels) ? parsed.labels : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    activity: Array.isArray(parsed.activity) ? parsed.activity : [],
  };
}

class TaskManagerStore {
  private users = new Map<string, PersistedTaskManagerUser>();
  private projects = new Map<string, TaskManagerProject>();
  private labels = new Map<string, TaskManagerLabel>();
  private tasks = new Map<string, TaskManagerTask>();
  private comments = new Map<string, TaskManagerComment>();
  private activity = new Map<string, TaskManagerActivity>();

  constructor() {
    const persisted = loadPersistedTaskManagerState();
    for (const user of persisted.users) this.users.set(user.id, { ...user, timeZone: normalizeTaskManagerTimeZone(user.timeZone) });
    for (const project of persisted.projects) this.projects.set(project.id, { ...project, userIds: project.userIds ?? [] });
    for (const label of persisted.labels) this.labels.set(label.id, label);
    for (const task of persisted.tasks) {
      this.tasks.set(task.id, {
        ...task,
        isDeadline: task.isDeadline ?? false,
        sortOrder: typeof task.sortOrder === "number" ? task.sortOrder : task.createdAt || task.updatedAt || Date.now(),
      });
    }
    for (const comment of persisted.comments) this.comments.set(comment.id, comment);
    for (const item of persisted.activity) this.activity.set(item.id, item);
    this.ensureAdminUser();
    this.ensureDefaults();
  }

  snapshot(): PersistedTaskManagerState {
    return {
      users: [...this.users.values()].sort((a, b) => a.createdAt - b.createdAt),
      projects: [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt),
      labels: [...this.labels.values()].sort((a, b) => a.createdAt - b.createdAt),
      tasks: [...this.tasks.values()].sort((a, b) => a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt),
      comments: [...this.comments.values()].sort((a, b) => a.createdAt - b.createdAt),
      activity: [...this.activity.values()].sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  flushSync(): void {
    writeJsonAtomicSync(TASK_MANAGER_DATA_PATH, this.snapshot());
  }

  authenticate(username: string, password: string): { user: TaskManagerUser; token: string; expiresAt: number; expiresInSeconds: number } | null {
    const normalized = username.trim().toLowerCase();
    const user = [...this.users.values()].find((item) => item.username.toLowerCase() === normalized);
    if (!user || !user.active) return null;
    if (!verifyTaskManagerPassword(password, user.passwordSalt, user.passwordHash)) return null;
    const now = Date.now();
    user.lastLoginAt = now;
    user.updatedAt = now;
    this.persist();
    const nowSeconds = Math.floor(now / 1000);
    const expiresIn = Math.max(60, TASK_MANAGER_TOKEN_TTL_SECONDS);
    const token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, scope: "taskmanager", iat: nowSeconds },
      TASK_MANAGER_JWT_SECRET,
      { expiresIn },
    );
    return {
      user: publicTaskManagerUser(user),
      token,
      expiresAt: (nowSeconds + expiresIn) * 1000,
      expiresInSeconds: expiresIn,
    };
  }

  getSessionUser(session: TaskManagerSession): TaskManagerUser | null {
    const user = this.users.get(session.userId);
    if (!user || !user.active) return null;
    return publicTaskManagerUser(user);
  }

  bootstrap(session: TaskManagerSession): TaskManagerBootstrap {
    const currentUser = this.requireCurrentUser(session);
    const visibleTasks = [...this.tasks.values()].filter((task) => this.canAccessTask(session, task));
    const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
    const visibleProjects = [...this.projects.values()].filter((project) => this.canAccessProject(session, project));
    return {
      currentUser,
      users: [...this.users.values()].map(publicTaskManagerUser).sort((a, b) => a.displayName.localeCompare(b.displayName)),
      projects: visibleProjects.sort((a, b) => a.name.localeCompare(b.name)),
      labels: [...this.labels.values()].sort((a, b) => a.name.localeCompare(b.name)),
      tasks: visibleTasks.sort((a, b) => a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt),
      comments: [...this.comments.values()].filter((comment) => visibleTaskIds.has(comment.taskId)),
      activity: [...this.activity.values()].filter((item) => visibleTaskIds.has(item.taskId)).sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  todayReport(session: TaskManagerSession, input: { timeZone?: string; onlyMine?: boolean; assigneeId?: string; projectId?: string }): { report: string; timeZone: string } {
    const currentUser = this.requireCurrentUser(session);
    const timeZone = input.timeZone ? requireValidTaskManagerTimeZone(input.timeZone) : normalizeTaskManagerTimeZone(currentUser.timeZone);
    const todayEnd = taskManagerEndOfToday(timeZone);
    const tomorrowEnd = taskManagerEndOfTomorrow(timeZone);

    const visibleTasks = [...this.tasks.values()]
      .filter((task) => this.canAccessTask(session, task))
      .filter((task) => task.status !== "done")
      .filter((task) => task.dueAt !== null && (task.dueAt <= todayEnd || task.isDeadline))
      .filter((task) => !input.onlyMine || task.assigneeId === session.userId)
      .filter((task) => !input.assigneeId || task.assigneeId === input.assigneeId)
      .filter((task) => !input.projectId || task.projectId === input.projectId)
      .sort((a, b) => {
        const priorityOrder: Record<TaskManagerPriority, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
        const dueDiff = (a.dueAt || Number.MAX_SAFE_INTEGER) - (b.dueAt || Number.MAX_SAFE_INTEGER);
        if (dueDiff !== 0) return dueDiff;
        return priorityOrder[b.priority] - priorityOrder[a.priority] || a.title.localeCompare(b.title);
      });

    const usersById = new Map([...this.users.values()].map((user) => [user.id, user]));
    const projectsById = new Map([...this.projects.values()].map((project) => [project.id, project]));
    const grouped = new Map<string, { name: string; tasks: TaskManagerTask[] }>();

    for (const task of visibleTasks) {
      const userId = task.assigneeId || task.createdBy || "unassigned";
      const user = usersById.get(userId);
      const name = user?.displayName || user?.username || "Unassigned";
      const existing = grouped.get(userId);
      if (existing) {
        existing.tasks.push(task);
      } else {
        grouped.set(userId, { name, tasks: [task] });
      }
    }

    const separator = "———————————-";
    const lines = [
      separator,
      "Luma Tasks - Today",
      `${taskManagerFormatReportDate(Date.now(), timeZone)} · ${timeZone}`,
      separator,
      "",
    ];

    if (grouped.size === 0) {
      lines.push("No tasks for today.");
      return { report: lines.join("\n"), timeZone };
    }

    const groups = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
    groups.forEach((group, groupIndex) => {
      lines.push(`${group.name}:`, "");
      group.tasks.forEach((task, taskIndex) => {
        const projectName = task.projectId ? projectsById.get(task.projectId)?.name || "No project" : "No project";
        lines.push(`${taskIndex + 1}. ${taskManagerPriorityIcon(task.priority)} ${task.title} - ${this.reportDateLabel(task, timeZone, todayEnd, tomorrowEnd)} - ${projectName}`);
      });
      if (groupIndex < groups.length - 1) lines.push("");
    });

    return { report: lines.join("\n"), timeZone };
  }

  createUser(input: { username: string; displayName: string; password: string; role: TaskManagerRole }): TaskManagerUser {
    const normalized = input.username.trim();
    if ([...this.users.values()].some((user) => user.username.toLowerCase() === normalized.toLowerCase())) {
      throw new Error("Username already exists.");
    }
    const now = Date.now();
    const password = hashTaskManagerPassword(input.password);
    const user: PersistedTaskManagerUser = {
      id: makeTaskManagerId("tm_user"),
      username: normalized,
      displayName: input.displayName.trim(),
      role: input.role,
      active: true,
      timeZone: TASK_MANAGER_DEFAULT_TIME_ZONE,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      passwordHash: password.hash,
      passwordSalt: password.salt,
    };
    this.users.set(user.id, user);
    this.persist();
    return publicTaskManagerUser(user);
  }

  updateUser(id: string, input: { displayName?: string; role?: TaskManagerRole; active?: boolean; password?: string; timeZone?: string }): TaskManagerUser {
    const user = this.users.get(id);
    if (!user || user.username === TASK_MANAGER_ADMIN_USERNAME) throw new Error("User not found.");
    if (input.displayName !== undefined) user.displayName = input.displayName.trim();
    if (input.role !== undefined) user.role = input.role;
    if (input.active !== undefined) user.active = input.active;
    if (input.timeZone !== undefined) user.timeZone = requireValidTaskManagerTimeZone(input.timeZone);
    if (input.password !== undefined) {
      const password = hashTaskManagerPassword(input.password);
      user.passwordHash = password.hash;
      user.passwordSalt = password.salt;
    }
    user.updatedAt = Date.now();
    this.persist();
    return publicTaskManagerUser(user);
  }

  updateProfile(session: TaskManagerSession, input: { timeZone: string }): TaskManagerUser {
    const user = this.users.get(session.userId);
    if (!user || !user.active) throw new Error("User not found.");
    user.timeZone = requireValidTaskManagerTimeZone(input.timeZone);
    user.updatedAt = Date.now();
    this.persist();
    return publicTaskManagerUser(user);
  }

  createProject(input: { name: string; color: string; userIds?: string[] }, userId: string): TaskManagerProject {
    const now = Date.now();
    const creator = this.users.get(userId);
    const allowedUserIds = this.normalizeProjectUserIds(input.userIds || []);
    if (creator?.role !== "admin" && !allowedUserIds.includes(userId)) allowedUserIds.push(userId);
    const project: TaskManagerProject = {
      id: makeTaskManagerId("tm_project"),
      name: input.name.trim(),
      color: input.color,
      archived: false,
      createdBy: userId,
      userIds: allowedUserIds,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    this.persist();
    return project;
  }

  updateProject(id: string, input: { name?: string; color?: string; archived?: boolean; userIds?: string[] }, session?: TaskManagerSession): TaskManagerProject {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    if (input.name !== undefined) project.name = input.name.trim();
    if (input.color !== undefined) project.color = input.color;
    if (input.archived !== undefined) project.archived = input.archived;
    if (input.userIds !== undefined && session?.role !== "admin") throw new Error("Only admins can update project access.");
    if (input.userIds !== undefined) project.userIds = this.normalizeProjectUserIds(input.userIds);
    project.updatedAt = Date.now();
    this.persist();
    return project;
  }

  deleteProject(id: string): { deleted: boolean } {
    const project = this.projects.get(id);
    if (!project) throw new Error("Project not found.");
    this.projects.delete(id);
    for (const task of this.tasks.values()) {
      if (task.projectId === id) {
        task.projectId = null;
        task.updatedAt = Date.now();
      }
    }
    this.persist();
    return { deleted: true };
  }

  createLabel(input: { name: string; color: string }): TaskManagerLabel {
    const label: TaskManagerLabel = {
      id: makeTaskManagerId("tm_label"),
      name: input.name.trim(),
      color: input.color,
      createdAt: Date.now(),
    };
    this.labels.set(label.id, label);
    this.persist();
    return label;
  }

  createTask(input: {
    title: string;
    description: string;
    status: TaskManagerStatus;
    priority: TaskManagerPriority;
    projectId: string | null;
    assigneeId: string | null;
    dueAt: number | null;
    isDeadline: boolean;
    sortOrder?: number;
    labelIds: string[];
    checklist: TaskManagerTask["checklist"];
  }, userId: string): TaskManagerTask {
    const now = Date.now();
    const task: TaskManagerTask = {
      id: makeTaskManagerId("tm_task"),
      title: input.title.trim(),
      description: input.description,
      status: input.status,
      priority: input.priority,
      projectId: this.canUseProject(userId, input.projectId) ? input.projectId : null,
      assigneeId: this.users.has(input.assigneeId || "") ? input.assigneeId : null,
      createdBy: userId,
      dueAt: input.dueAt,
      isDeadline: input.isDeadline,
      sortOrder: input.sortOrder || now,
      labelIds: input.labelIds.filter((id) => this.labels.has(id)),
      checklist: input.checklist,
      createdAt: now,
      updatedAt: now,
      completedAt: input.status === "done" ? now : null,
    };
    this.tasks.set(task.id, task);
    this.recordActivity(task.id, userId, "created", "Task created");
    this.persist();
    return task;
  }

  updateTask(id: string, input: Partial<Omit<TaskManagerTask, "id" | "createdAt" | "updatedAt" | "createdBy">>, session: TaskManagerSession): TaskManagerTask {
    const task = this.tasks.get(id);
    if (!task || !this.canAccessTask(session, task)) throw new Error("Task not found.");
    const beforeStatus = task.status;
    if (input.title !== undefined) task.title = input.title.trim();
    if (input.description !== undefined) task.description = input.description;
    if (input.status !== undefined) task.status = input.status;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.projectId !== undefined) task.projectId = this.canUseProject(session.userId, input.projectId) ? input.projectId : null;
    if (input.assigneeId !== undefined) task.assigneeId = this.users.has(input.assigneeId || "") ? input.assigneeId : null;
    if (input.dueAt !== undefined) task.dueAt = input.dueAt;
    if (input.isDeadline !== undefined) task.isDeadline = input.isDeadline;
    if (input.sortOrder !== undefined) task.sortOrder = input.sortOrder;
    if (input.labelIds !== undefined) task.labelIds = input.labelIds.filter((labelId) => this.labels.has(labelId));
    if (input.checklist !== undefined) task.checklist = input.checklist;
    if (input.completedAt !== undefined) task.completedAt = input.completedAt;
    if (input.status !== undefined && input.completedAt === undefined) task.completedAt = input.status === "done" ? Date.now() : null;
    task.updatedAt = Date.now();
    this.recordActivity(task.id, session.userId, beforeStatus !== task.status ? "status_changed" : "updated", beforeStatus !== task.status ? `${beforeStatus} -> ${task.status}` : "Task updated");
    this.persist();
    return task;
  }

  deleteTask(id: string, session: TaskManagerSession): { deleted: boolean } {
    const task = this.tasks.get(id);
    if (!task || !this.canAccessTask(session, task)) throw new Error("Task not found.");
    this.tasks.delete(id);
    for (const [commentId, comment] of this.comments) {
      if (comment.taskId === id) this.comments.delete(commentId);
    }
    for (const [activityId, item] of this.activity) {
      if (item.taskId === id) this.activity.delete(activityId);
    }
    this.persist();
    return { deleted: true };
  }

  createComment(taskId: string, body: string, session: TaskManagerSession): TaskManagerComment {
    const task = this.tasks.get(taskId);
    if (!task || !this.canAccessTask(session, task)) throw new Error("Task not found.");
    const now = Date.now();
    const comment: TaskManagerComment = {
      id: makeTaskManagerId("tm_comment"),
      taskId,
      userId: session.userId,
      body: body.trim(),
      createdAt: now,
    };
    this.comments.set(comment.id, comment);
    this.recordActivity(taskId, session.userId, "commented", "Comment added");
    this.persist();
    return comment;
  }

  private ensureAdminUser(): void {
    const username = TASK_MANAGER_ADMIN_USERNAME.trim() || "admin";
    const existing = [...this.users.values()].find((user) => user.username.toLowerCase() === username.toLowerCase());
    const now = Date.now();
    const passwordValue = TASK_MANAGER_ADMIN_PASSWORD || "change_me_task_admin";
    const password = hashTaskManagerPassword(passwordValue, existing?.passwordSalt);
    const admin: PersistedTaskManagerUser = {
      id: existing?.id || "tm_admin",
      username,
      displayName: existing?.displayName || "Task Manager Admin",
      role: "admin",
      active: true,
      timeZone: normalizeTaskManagerTimeZone(existing?.timeZone),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastLoginAt: existing?.lastLoginAt || null,
      passwordHash: password.hash,
      passwordSalt: password.salt,
    };
    this.users.set(admin.id, admin);
    this.persist();
  }

  private ensureDefaults(): void {
    if (this.projects.size === 0) {
      const now = Date.now();
      this.projects.set("tm_project_inbox", {
        id: "tm_project_inbox",
        name: "Inbox",
        color: "#12867d",
        archived: false,
        createdBy: "tm_admin",
        userIds: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    if (this.labels.size === 0) {
      const now = Date.now();
      for (const [id, name, color] of [
        ["tm_label_followup", "Follow up", "#f97316"],
        ["tm_label_client", "Client", "#0ea5e9"],
        ["tm_label_internal", "Internal", "#64748b"],
      ]) {
        this.labels.set(id, { id, name, color, createdAt: now });
      }
    }
    this.persist();
  }

  private requireCurrentUser(session: TaskManagerSession): TaskManagerUser {
    const user = this.getSessionUser(session);
    if (!user) throw new Error("Unauthorized");
    return user;
  }

  private canAccessTask(session: TaskManagerSession, task: TaskManagerTask): boolean {
    const project = task.projectId ? this.projects.get(task.projectId) : null;
    return session.role === "admin" || task.createdBy === session.userId || task.assigneeId === session.userId || Boolean(project && this.canAccessProject(session, project));
  }

  private canAccessProject(session: TaskManagerSession, project: TaskManagerProject): boolean {
    return session.role === "admin" || project.createdBy === session.userId || project.userIds.includes(session.userId);
  }

  private canUseProject(userId: string, projectId: string | null): boolean {
    if (!projectId) return false;
    const project = this.projects.get(projectId);
    if (!project || project.archived) return false;
    const user = this.users.get(userId);
    return user?.role === "admin" || project.createdBy === userId || project.userIds.includes(userId);
  }

  private normalizeProjectUserIds(userIds: string[]): string[] {
    return [...new Set(userIds)].filter((id) => {
      const user = this.users.get(id);
      return Boolean(user?.active && user.role !== "admin");
    });
  }

  private reportDateLabel(task: TaskManagerTask, timeZone: string, todayEnd: number, tomorrowEnd: number): string {
    if (!task.dueAt) return task.isDeadline ? "No date (deadline)" : "No date";
    if (task.isDeadline) return `${taskManagerFormatDaysLeftLabel(taskManagerDaysUntilDate(task.dueAt, timeZone))} (deadline)`;
    let label = "";
    if (task.dueAt < taskManagerStartOfToday(timeZone)) {
      label = "Overdue";
    } else if (task.dueAt <= todayEnd) {
      label = "Today";
    } else if (task.dueAt <= tomorrowEnd) {
      label = "Tomorrow";
    } else {
      label = taskManagerFormatShortDate(task.dueAt, timeZone);
    }
    return label;
  }

  private recordActivity(taskId: string, userId: string, action: string, detail: string): void {
    const item: TaskManagerActivity = {
      id: makeTaskManagerId("tm_activity"),
      taskId,
      userId,
      action,
      detail,
      createdAt: Date.now(),
    };
    this.activity.set(item.id, item);
  }

  private persist(): void {
    writeJsonAtomicSync(TASK_MANAGER_DATA_PATH, this.snapshot());
  }
}

function compactJsonForStorage(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > STORED_EVENT_TEXT_MAX_CHARS
      ? truncateText(value, STORED_EVENT_TEXT_MAX_CHARS)
      : value;
  }
  if (depth >= 5) return "[truncated depth]";
  if (Array.isArray(value)) {
    const capped = value.slice(0, 100).map((item) => compactJsonForStorage(item, depth + 1));
    if (value.length > capped.length) capped.push(`[truncated ${value.length - capped.length} items]`);
    return capped;
  }
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    next[key] = compactJsonForStorage(item, depth + 1);
    count += 1;
    if (count >= 100) {
      next.__truncated__ = `additional fields omitted (${Object.keys(value).length - count})`;
      break;
    }
  }
  return next;
}

function sanitizeStoredStdoutLine(line: string): string {
  if (line.length <= STORED_EVENT_TEXT_MAX_CHARS) return line;
  try {
    return JSON.stringify(compactJsonForStorage(JSON.parse(line) as unknown));
  } catch {
    return truncateText(line, STORED_EVENT_TEXT_MAX_CHARS);
  }
}

function normalizeAttachmentRefs(input: unknown): AttachmentRef[] {
  if (!Array.isArray(input)) return [];

  const next: AttachmentRef[] = [];
  for (const value of input) {
    const parsed = attachmentRefSchema.safeParse(value);
    if (parsed.success) next.push(parsed.data);
    if (next.length >= ATTACHMENT_MAX_FILES) break;
  }
  return next;
}

function normalizeSelectedSkillRefs(input: unknown): SelectedSkillRef[] {
  if (!Array.isArray(input)) return [];

  const next: SelectedSkillRef[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string") continue;
    const id = value.id.trim();
    const skillPath = value.path.trim();
    if (!id || !skillPath) continue;
    const key = `${id}\n${skillPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ id, path: skillPath });
    if (next.length >= 20) break;
  }
  return next;
}

function normalizeSelectedAgentRefs(input: unknown): SelectedAgentRef[] {
  if (!Array.isArray(input)) return [];

  const next: SelectedAgentRef[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string") continue;
    const id = value.id.trim();
    const agentPath = value.path.trim();
    if (!id || !agentPath) continue;
    const key = `${id}\n${agentPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ id, path: agentPath });
    if (next.length >= 10) break;
  }
  return next;
}

function normalizeMimeType(input: string | undefined): string {
  const raw = (input || "").split(";")[0]?.trim().toLowerCase();
  return raw || "application/octet-stream";
}

function classifyAttachment(name: string, mimeType: string): "image" | "text" | null {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const extension = path.extname(name).toLowerCase();

  if (IMAGE_ATTACHMENT_MIME_TYPES.has(normalizedMimeType) || IMAGE_ATTACHMENT_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (
    normalizedMimeType.startsWith("text/") ||
    TEXT_ATTACHMENT_MIME_TYPES.has(normalizedMimeType) ||
    TEXT_ATTACHMENT_EXTENSIONS.has(extension)
  ) {
    return "text";
  }

  return null;
}

function sanitizeAttachmentName(input: string): string {
  const base = path.basename(input || "").trim();
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return safe || "attachment";
}

function ensurePathInsideWorkspace(workspace: string, targetPath: string): boolean {
  const relative = path.relative(workspace, targetPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function createStoredAttachmentRelativePath(workspace: string, attachmentId: string, name: string): string {
  const date = new Date();
  const dayStamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const safeName = sanitizeAttachmentName(name);
  const absolutePath = path.join(workspace, ATTACHMENT_STAGING_DIR, dayStamp, `${attachmentId}_${safeName}`);
  const relative = path.relative(workspace, absolutePath);
  return relative.split(path.sep).join(path.posix.sep);
}

function resolveStoredAttachmentPath(workspace: string, relativePath: string): string {
  const absolutePath = path.resolve(workspace, relativePath);
  if (!ensurePathInsideWorkspace(workspace, absolutePath)) {
    throw new Error(`Attachment path is outside the workspace: ${relativePath}`);
  }
  return absolutePath;
}

function createStoredSessionImageRelativePath(attachmentId: string, name: string): string {
  const date = new Date();
  const dayStamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const safeName = sanitizeAttachmentName(name);
  return path.join("session-images", dayStamp, `${attachmentId}_${safeName}`).split(path.sep).join(path.posix.sep);
}

function resolveStoredSessionImagePath(relativePath: string): string {
  const absolutePath = path.resolve(rootDir, "data", relativePath);
  const relative = path.relative(SESSION_IMAGE_DIR, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Image path is outside Luma image storage.");
  }
  return absolutePath;
}

function imageMimeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function imageDimensionsFromBuffer(buffer: Buffer): { width: number; height: number } | null {
  const mime = imageMimeFromBuffer(buffer);
  if (mime === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      if (
        (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  if (mime === "image/webp" && buffer.length >= 30) {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function validateImageGuardrails(buffer: Buffer): { mimeType: string; width: number; height: number } {
  if (buffer.byteLength > IMAGE_MCP_MAX_BYTES) {
    throw new Error(`Image is too large. Maximum size is ${IMAGE_MCP_MAX_BYTES} bytes.`);
  }
  const mimeType = imageMimeFromBuffer(buffer);
  if (!mimeType) {
    throw new Error("Unsupported image type. Use PNG, JPEG, WebP, or GIF.");
  }
  const dimensions = imageDimensionsFromBuffer(buffer);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error("Could not read image dimensions.");
  }
  if (dimensions.height > IMAGE_MCP_MAX_HEIGHT) {
    throw new Error(`Image is too tall. Maximum height is ${IMAGE_MCP_MAX_HEIGHT}px.`);
  }
  return { mimeType, ...dimensions };
}

function buildPromptWithAttachments(prompt: string, attachments: ResolvedAttachment[]): string {
  if (attachments.length === 0) return prompt;

  const lines = ["The user attached the following files:"];
  for (const attachment of attachments) {
    const location = attachment.ref.kind === "image"
      ? `attached directly and stored at ${attachment.ref.relativePath}`
      : `stored at ${attachment.ref.relativePath}`;
    lines.push(`- ${attachment.ref.name} (${attachment.ref.kind}, ${location})`);
  }
  lines.push("Use these attachments as part of the request.");
  lines.push("");
  lines.push(prompt);
  return lines.join("\n");
}

function resolveRunAttachments(config: RunConfig): ResolvedAttachment[] {
  const attachments = normalizeAttachmentRefs(config.attachments);
  return attachments.map((ref) => {
    const absolutePath = resolveStoredAttachmentPath(config.workspace, ref.relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`Attachment not found: ${ref.name}`);
    }
    return { ref, absolutePath };
  });
}

class SkillResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillResolutionError";
  }
}

class AgentResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentResolutionError";
  }
}

function skillIdForPath(skillPath: string): string {
  const normalized = path.resolve(skillPath).split(path.sep).join(path.posix.sep);
  return `skill_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function canonicalizeExistingPath(inputPath: string): string | null {
  try {
    return fs.realpathSync(path.resolve(inputPath));
  } catch {
    return null;
  }
}

function parseSkillMetadata(content: string, skillPath: string): { name: string; description: string } {
  let body = content.replace(/\r\n/g, "\n");
  let frontmatterName = "";
  let frontmatterDescription = "";

  if (body.startsWith("---\n")) {
    const endIndex = body.indexOf("\n---", 4);
    if (endIndex >= 0) {
      const frontmatter = body.slice(4, endIndex).split("\n");
      for (const line of frontmatter) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match) continue;
        const key = match[1].toLowerCase();
        const value = match[2].trim().replace(/^['"]|['"]$/g, "");
        if (key === "name") frontmatterName = value;
        if (key === "description") frontmatterDescription = value;
      }
      body = body.slice(endIndex + 4);
    }
  }

  const firstHeading = body
    .split("\n")
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim() || "")
    .find(Boolean) || "";

  const firstParagraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith("#") && !block.startsWith("```"))[0] || "";

  const fallbackName = path.basename(path.dirname(skillPath)) || path.basename(skillPath);
  return {
    name: frontmatterName || firstHeading || fallbackName,
    description: frontmatterDescription || firstParagraph.replace(/\s+/g, " ").slice(0, 280),
  };
}

function getSkillRoots(workspace: string): Array<{ root: string; source: string; scope: string }> {
  return [
    { root: path.join(os.homedir(), ".codex", "skills"), source: "codex", scope: "user" },
    { root: path.join(os.homedir(), ".claude", "skills"), source: "claude", scope: "user" },
    { root: path.join(workspace, ".codex", "skills"), source: "codex repo", scope: "repo" },
    { root: path.join(workspace, ".claude", "skills"), source: "claude repo", scope: "repo" },
  ];
}

function scanSkillRoot(root: string, source: string, scope: string, seenPaths: Set<string>, seenDirs: Set<string>): SkillListItem[] {
  const canonicalRoot = canonicalizeExistingPath(root);
  if (!canonicalRoot) return [];

  const results: SkillListItem[] = [];
  const visit = (directory: string) => {
    const canonicalDirectory = canonicalizeExistingPath(directory);
    if (!canonicalDirectory || seenDirs.has(canonicalDirectory)) return;
    seenDirs.add(canonicalDirectory);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !/^skill\.md$/i.test(entry.name)) continue;

      const canonicalPath = canonicalizeExistingPath(entryPath);
      if (!canonicalPath || seenPaths.has(canonicalPath)) continue;

      let content = "";
      try {
        content = fs.readFileSync(canonicalPath, "utf8");
      } catch {
        continue;
      }

      const metadata = parseSkillMetadata(content, canonicalPath);
      seenPaths.add(canonicalPath);
      results.push({
        id: skillIdForPath(canonicalPath),
        name: metadata.name,
        description: metadata.description,
        path: canonicalPath,
        source,
        scope,
      });
    }
  };

  visit(canonicalRoot);
  return results;
}

function discoverSkills(workspace: string): SkillListItem[] {
  const seenPaths = new Set<string>();
  const seenDirs = new Set<string>();
  const skills = getSkillRoots(workspace).flatMap((root) => scanSkillRoot(root.root, root.source, root.scope, seenPaths, seenDirs));
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function parseSimpleFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  let body = content.replace(/\r\n/g, "\n");
  const frontmatter: Record<string, string> = {};

  if (!body.startsWith("---\n")) {
    return { frontmatter, body };
  }

  const endIndex = body.indexOf("\n---", 4);
  if (endIndex < 0) {
    return { frontmatter, body };
  }

  for (const line of body.slice(4, endIndex).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1].toLowerCase()] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }

  body = body.slice(endIndex + 4).replace(/^\s+/, "");
  return { frontmatter, body };
}

function fallbackTitleFromMarkdown(body: string, fallback: string): string {
  const heading = body
    .split("\n")
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim() || "")
    .find(Boolean);
  if (heading) return heading.slice(0, 120);

  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : fallback;
}

function agentIdForPath(agentPath: string): string {
  const normalized = path.resolve(agentPath).split(path.sep).join(path.posix.sep);
  return `agent_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function slugForRelativeDir(relativeDir: string): string {
  const normalized = relativeDir.split(path.sep).join(path.posix.sep).replace(/^\.\/?/, "");
  const slug = normalized
    .split("/")
    .filter(Boolean)
    .join("__")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

function discoverAgents(): DiscoveredAgent[] {
  const canonicalRoot = canonicalizeExistingPath(AGENTS_DIR);
  if (!canonicalRoot) return [];

  const agents: DiscoveredAgent[] = [];
  const visit = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    const agentFile = entries.find((entry) => entry.isFile() && /^agent\.md$/i.test(entry.name));
    if (agentFile) {
      const agentPath = path.join(directory, agentFile.name);
      const canonicalPath = canonicalizeExistingPath(agentPath);
      if (!canonicalPath) return;

      try {
        const stat = fs.statSync(canonicalPath);
        const content = fs.readFileSync(canonicalPath, "utf8");
        const parsed = parseSimpleFrontmatter(content);
        const prompt = parsed.body.trim();
        const relativeDir = path.relative(canonicalRoot, path.dirname(canonicalPath));
        const slug = slugForRelativeDir(relativeDir);
        const name = parsed.frontmatter.name || fallbackTitleFromMarkdown(prompt, slug);
        const firstParagraph = prompt
          .split(/\n\s*\n/)
          .map((block) => block.trim())
          .filter((block) => block && !block.startsWith("#") && !block.startsWith("```"))[0] || "";
        agents.push({
          id: agentIdForPath(canonicalPath),
          slug,
          name,
          description: parsed.frontmatter.description || firstParagraph.replace(/\s+/g, " ").slice(0, 280),
          path: canonicalPath,
          promptPreview: prompt.replace(/\s+/g, " ").slice(0, 220),
          updatedAt: stat.mtimeMs,
          prompt,
        });
      } catch {
        return;
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      visit(path.join(directory, entry.name));
    }
  };

  visit(canonicalRoot);
  return agents.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function publicAgents(agents = discoverAgents()): AgentListItem[] {
  return agents.map(({ prompt: _prompt, ...agent }) => agent);
}

function discoverRepoSkillDirectories(): Array<{ slug: string; sourcePath: string }> {
  const canonicalRoot = canonicalizeExistingPath(REPO_SKILLS_DIR);
  if (!canonicalRoot) return [];

  const results: Array<{ slug: string; sourcePath: string }> = [];
  const visit = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isFile() && /^skill\.md$/i.test(entry.name))) {
      const canonicalPath = canonicalizeExistingPath(directory);
      if (canonicalPath) {
        results.push({
          slug: slugForRelativeDir(path.relative(canonicalRoot, canonicalPath)),
          sourcePath: canonicalPath,
        });
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      visit(path.join(directory, entry.name));
    }
  };

  visit(canonicalRoot);
  return results.sort((a, b) => a.slug.localeCompare(b.slug));
}

function readManagedSkillMarker(targetPath: string): boolean {
  for (const markerName of [MANAGED_SKILL_MARKER, LEGACY_MANAGED_SKILL_MARKER]) {
    const markerPath = path.join(targetPath, markerName);
    if (!fs.existsSync(markerPath)) continue;
    try {
      const payload = safeJsonParse<Record<string, unknown>>(fs.readFileSync(markerPath, "utf8"), {});
      if (payload.managedBy === "luma-assistant" || payload.managedBy === "agentic-assistant") return true;
    } catch {
      return false;
    }
  }
  return false;
}

function writeManagedSkillMarker(targetPath: string, sourcePath: string): void {
  fs.writeFileSync(
    path.join(targetPath, MANAGED_SKILL_MARKER),
    JSON.stringify(
      {
        managedBy: "luma-assistant",
        sourcePath,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function syncRepoSkillTarget(
  skill: { slug: string; sourcePath: string },
  targetRoot: string,
  targetLabel: string,
  result: SkillSyncResult,
): void {
  const targetPath = path.join(targetRoot, skill.slug);
  const label = `${targetLabel}:${skill.slug}`;
  try {
    if (fs.existsSync(targetPath)) {
      if (!readManagedSkillMarker(targetPath)) {
        result.conflicts.push({
          slug: label,
          sourcePath: skill.sourcePath,
          targetPath,
          reason: `Target exists without ${MANAGED_SKILL_MARKER}`,
        });
        return;
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.cpSync(skill.sourcePath, targetPath, { recursive: true });
      writeManagedSkillMarker(targetPath, skill.sourcePath);
      result.updated.push(label);
      return;
    }

    fs.mkdirSync(targetRoot, { recursive: true });
    fs.cpSync(skill.sourcePath, targetPath, { recursive: true });
    writeManagedSkillMarker(targetPath, skill.sourcePath);
    result.copied.push(label);
  } catch (error) {
    result.errors.push({
      slug: label,
      sourcePath: skill.sourcePath,
      message: error instanceof Error ? error.message : "Failed to sync skill",
    });
  }
}

function syncRepoSkills(): SkillSyncResult {
  const result: SkillSyncResult = {
    copied: [],
    updated: [],
    conflicts: [],
    errors: [],
  };
  const targets = [
    { root: path.join(os.homedir(), ".codex", "skills"), label: "codex" },
    { root: path.join(os.homedir(), ".claude", "skills"), label: "claude" },
  ];

  for (const skill of discoverRepoSkillDirectories()) {
    for (const target of targets) {
      syncRepoSkillTarget(skill, target.root, target.label, result);
    }
  }

  return result;
}

function resolveSelectedSkills(workspace: string, selected: unknown): ResolvedSkill[] {
  const refs = normalizeSelectedSkillRefs(selected);
  if (refs.length === 0) return [];

  const catalogByPath = new Map(discoverSkills(workspace).map((skill) => [skill.path, skill]));
  const resolved = new Map<string, ResolvedSkill>();
  for (const ref of refs) {
    const canonicalPath = canonicalizeExistingPath(ref.path);
    if (!canonicalPath) {
      throw new SkillResolutionError(`Selected skill is not readable or no longer exists: ${ref.path}`);
    }

    const expectedId = skillIdForPath(canonicalPath);
    if (ref.id !== expectedId) {
      throw new SkillResolutionError(`Selected skill id does not match path: ${ref.path}`);
    }

    const item = catalogByPath.get(canonicalPath);
    if (!item) {
      throw new SkillResolutionError(`Selected skill is outside the configured skill roots: ${ref.path}`);
    }

    let content = "";
    try {
      content = fs.readFileSync(canonicalPath, "utf8");
    } catch {
      throw new SkillResolutionError(`Selected skill is not readable: ${ref.path}`);
    }

    resolved.set(canonicalPath, { item, content });
  }

  return [...resolved.values()].sort((a, b) => a.item.path.localeCompare(b.item.path));
}

function resolveSelectedAgents(selected: unknown): ResolvedAgent[] {
  const refs = normalizeSelectedAgentRefs(selected);
  if (refs.length === 0) return [];

  const catalogByPath = new Map(discoverAgents().map((agent) => [agent.path, agent]));
  const resolved = new Map<string, ResolvedAgent>();
  for (const ref of refs) {
    const canonicalPath = canonicalizeExistingPath(ref.path);
    if (!canonicalPath) {
      throw new AgentResolutionError(`Selected agent is not readable or no longer exists: ${ref.path}`);
    }

    const expectedId = agentIdForPath(canonicalPath);
    if (ref.id !== expectedId) {
      throw new AgentResolutionError(`Selected agent id does not match path: ${ref.path}`);
    }

    const item = catalogByPath.get(canonicalPath);
    if (!item) {
      throw new AgentResolutionError(`Selected agent is outside the configured agents root: ${ref.path}`);
    }

    if (!item.prompt.trim()) {
      throw new AgentResolutionError(`Selected agent is empty: ${ref.path}`);
    }

    resolved.set(canonicalPath, { item, content: item.prompt });
  }

  return [...resolved.values()].sort((a, b) => a.item.path.localeCompare(b.item.path));
}

function buildSkillBackedPrompt(prompt: string, skills: ResolvedSkill[]): string {
  if (skills.length === 0) return prompt;

  const lines = [
    "Selected skills are active for this turn only.",
    "Apply the following SKILL.md instructions before answering the user request.",
    "",
    "Active skills:",
    ...skills.map((skill, index) => `${index + 1}. ${skill.item.name} (${skill.item.path})`),
    "",
  ];

  for (const skill of skills) {
    lines.push(`--- BEGIN SKILL: ${skill.item.name} ---`);
    lines.push(`Path: ${skill.item.path}`);
    lines.push("");
    lines.push(skill.content.trimEnd());
    lines.push(`--- END SKILL: ${skill.item.name} ---`);
    lines.push("");
  }

  lines.push("Original user request:");
  lines.push(prompt);
  return lines.join("\n");
}

function buildAgentBackedPrompt(prompt: string, agents: ResolvedAgent[]): string {
  if (agents.length === 0) return prompt;

  const lines = [
    "Selected repo agents are active for this turn only.",
    "Apply the following AGENT.md instructions as specialized role/context before answering the user request.",
    "",
    "Active agents:",
    ...agents.map((agent, index) => `${index + 1}. ${agent.item.name} (${agent.item.path})`),
    "",
  ];

  for (const agent of agents) {
    lines.push(`--- BEGIN AGENT: ${agent.item.name} ---`);
    lines.push(`Path: ${agent.item.path}`);
    lines.push("");
    lines.push(agent.content.trimEnd());
    lines.push(`--- END AGENT: ${agent.item.name} ---`);
    lines.push("");
  }

  lines.push("Original user request:");
  lines.push(prompt);
  return lines.join("\n");
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
  return Boolean(resolveCommandPath(command));
}

function resolveCommandPath(command: string): string {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return "";
  return result.stdout.trim().split(/\r?\n/)[0]?.trim() || "";
}

function resolveClaudeCodeExecutable(configured: string | undefined): string {
  const explicit = (configured || "").trim();
  if (explicit) return explicit;
  return resolveCommandPath("claude");
}

function buildClaudeEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  if (CLAUDE_AUTH_MODE === "oauth") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
    return env;
  }

  env.CLAUDE_AGENT_SDK_CLIENT_APP = process.env.CLAUDE_AGENT_SDK_CLIENT_APP || "luma-assistant";
  return env;
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

  private claudePermissionWaiters = new Map<string, ClaudePermissionWaiter>();

  private activeRuns = new Map<string, ActiveRun>();

  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private codexPath: string) {
    super();
  }

  loadPersisted(runs: RunRecord[], approvals: ApprovalQueueItem[]): void {
    const now = Date.now();
    const staleRunIds = new Set<string>();
    for (const run of runs) {
      const staleActiveRun = run.status === "queued" || run.status === "running";
      if (staleActiveRun) staleRunIds.add(run.id);
      const restartMessage = "Server restarted before this run completed. Marked as failed because no live Codex process is attached.";
      const events = staleActiveRun
        ? [
            ...run.events,
            {
              id: `evt_${now}_${Math.random().toString(36).slice(2, 8)}`,
              at: now,
              source: "system" as const,
              text: restartMessage,
            },
          ].slice(-1500)
        : run.events;
      this.runs.set(run.id, {
        ...run,
        status: staleActiveRun ? "failed" : run.status,
        updatedAt: staleActiveRun ? now : run.updatedAt,
        config: {
          ...run.config,
          runner: normalizeRunRunner(run.config?.runner),
          reasoningEffort: normalizeReasoningEffort(run.config?.reasoningEffort),
          attachments: normalizeAttachmentRefs(run.config?.attachments),
          skills: normalizeSelectedSkillRefs(run.config?.skills),
          agents: normalizeSelectedAgentRefs(run.config?.agents),
        },
        events,
        lastError: staleActiveRun ? restartMessage : run.lastError,
        sessionId: typeof run.sessionId === "string"
          ? run.sessionId
          : typeof run.threadId === "string"
            ? run.threadId
            : null,
        archivedAt: typeof run.archivedAt === "number" ? run.archivedAt : null,
      });
    }
    for (const item of approvals) {
      if (staleRunIds.has(item.runId)) continue;
      this.approvals.set(item.id, item);
    }
    if (staleRunIds.size > 0) this.persistState();
  }

  getRuns(includeArchived = true): RunRecord[] {
    return [...this.runs.values()]
      .filter((run) => includeArchived || run.archivedAt === null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId) || null;
  }

  getSessionTokenUsage(sessionId: string): TokenUsageSummary | null {
    return aggregateRunTokenUsage(this.getSessionRuns(sessionId).filter((run) => run.archivedAt === null));
  }

  getApprovals(): ApprovalQueueItem[] {
    return [...this.approvals.values()].sort((a, b) => b.createdAt - a.createdAt);
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
    }

    const removedApprovals = this.removeApprovalsForRunIds(runIds);
    this.persistState();
    return { removedRuns: runIds.size, removedApprovals };
  }

  hasCapacity(): boolean {
    return this.activeRuns.size < MAX_CONCURRENT_RUNS;
  }

  isSessionActive(sessionId: string): boolean {
    return this.hasActiveRunInSession(sessionId);
  }

  startRun(config: RunConfig): RunRecord {
    if (!this.hasCapacity()) {
      throw new Error(`Maximum concurrent runs reached (${MAX_CONCURRENT_RUNS})`);
    }

    const effectiveConfig = resolveEffectiveRunConfig(config);
    const resolvedAttachments = resolveRunAttachments(effectiveConfig);
    const resolvedSkills = resolveSelectedSkills(effectiveConfig.workspace, effectiveConfig.skills);
    const resolvedAgents = resolveSelectedAgents(effectiveConfig.agents);
    const imageSessionId = effectiveConfig.sessionId || "";
    const promptWithImageContext = imageSessionId
      ? buildImageRenderContextPrompt(effectiveConfig.prompt, imageSessionId)
      : effectiveConfig.prompt;
    const promptBase = buildPromptWithAttachments(promptWithImageContext, resolvedAttachments);
    const planModeInstructions = effectiveConfig.planMode ? readPlanModeInstructions() : "";
    const promptWithPlan = effectiveConfig.planMode && effectiveConfig.runner !== "claude"
      ? buildPlanModePrompt(promptBase, planModeInstructions)
      : promptBase;
    const promptWithAgents = buildAgentBackedPrompt(promptWithPlan, resolvedAgents);
    const prompt = buildSkillBackedPrompt(promptWithAgents, resolvedSkills);
    const imageArgs = resolvedAttachments
      .filter((attachment) => attachment.ref.kind === "image")
      .flatMap((attachment) => ["-i", attachment.absolutePath]);
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const record: RunRecord = {
      id: runId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "queued",
      config: effectiveConfig,
      sessionId: effectiveConfig.sessionId || null,
      threadId: null,
      summary: effectiveConfig.prompt.slice(0, 140),
      events: [],
      lastError: null,
      changedFiles: [],
      archivedAt: null,
      usage: null,
    };

    this.runs.set(runId, record);

    if (effectiveConfig.runner === "claude") {
      this.startClaudeExecution(runId, effectiveConfig, prompt, planModeInstructions);
      this.persistState();
      return record;
    }

    const args = effectiveConfig.sessionId
      ? [
          "exec",
          "resume",
          "--json",
          "--skip-git-repo-check",
          "-m",
          effectiveConfig.model,
          "-c",
          `reasoning_effort=${JSON.stringify(effectiveConfig.reasoningEffort)}`,
          "-c",
          `approval_policy=${JSON.stringify(effectiveConfig.approvalPolicy)}`,
          "-c",
          `sandbox_mode=${JSON.stringify(effectiveConfig.sandbox)}`,
          ...imageArgs,
          "--",
          effectiveConfig.sessionId,
          prompt,
        ]
      : [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "-C",
          effectiveConfig.workspace,
          "-m",
          effectiveConfig.model,
          "-c",
          `reasoning_effort=${JSON.stringify(effectiveConfig.reasoningEffort)}`,
          "-s",
          effectiveConfig.sandbox,
          "-c",
          `approval_policy=${JSON.stringify(effectiveConfig.approvalPolicy)}`,
          ...imageArgs,
          "--",
          prompt,
        ];

    const child = spawn(this.codexPath, args, {
      cwd: effectiveConfig.workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      throw new Error("Failed to initialize codex process streams");
    }

    this.activeRuns.set(runId, { runner: "codex", process: child, stdoutBuffer: "", stopRequested: false });
    this.updateRun(runId, { status: "running" });
    this.emitSse({ kind: "run.started", runId, at: Date.now(), payload: { config: effectiveConfig } });
    const startedRun = this.runs.get(runId);
    if (startedRun) {
      this.emit("run.lifecycle", { kind: "started", run: startedRun, previous: null } as RunLifecycleEvent);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const active = this.activeRuns.get(runId);
      if (!active || active.runner !== "codex") return;
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
        const rendered = truncateText(`${line}\n`, STORED_EVENT_TEXT_MAX_CHARS);
        this.appendEvent(runId, { source: "stderr", text: rendered });
        this.emitSse({ kind: "run.stderr", runId, at: Date.now(), payload: { text: rendered } });
        const currentRun = this.runs.get(runId);
        if (currentRun) {
          this.emit("run.stderrLine", { runId, run: currentRun, text: rendered } as RunStderrEvent);
        }
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
        const stoppedRun = this.runs.get(runId);
        if (stoppedRun) {
          this.emit("run.lifecycle", { kind: "stopped", run: stoppedRun, previous: run } as RunLifecycleEvent);
        }
      } else if (code === 0 && run.status !== "failed") {
        this.updateRun(runId, { status: "completed" });
        this.emitSse({ kind: "run.completed", runId, at: Date.now() });
        const completedRun = this.runs.get(runId);
        if (completedRun) {
          this.emit("run.lifecycle", { kind: "completed", run: completedRun, previous: run } as RunLifecycleEvent);
        }
      } else if (run.status !== "stopped") {
        this.updateRun(runId, { status: "failed" });
        this.emitSse({ kind: "run.failed", runId, at: Date.now(), payload: { code } });
        const failedRun = this.runs.get(runId);
        if (failedRun) {
          this.emit("run.lifecycle", { kind: "failed", run: failedRun, previous: run } as RunLifecycleEvent);
        }
      }

      this.persistState();
    });

    this.persistState();
    return record;
  }

  private startClaudeExecution(runId: string, effectiveConfig: RunConfig, prompt: string, planModeInstructions = ""): void {
    const abortController = new AbortController();
    const options: ClaudeOptions = {
      cwd: effectiveConfig.workspace,
      model: effectiveConfig.model,
      abortController,
      permissionMode: effectiveConfig.planMode ? "plan" : "bypassPermissions",
      allowDangerouslySkipPermissions: !effectiveConfig.planMode,
      env: buildClaudeEnvironment(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: { type: "preset", preset: "claude_code" },
    };
    const thinking = resolveClaudeThinkingConfig(effectiveConfig.model, effectiveConfig.reasoningEffort);
    if (thinking) options.thinking = thinking;
    if (effectiveConfig.planMode) {
      options.planModeInstructions = planModeInstructions;
      options.canUseTool = this.createClaudeCanUseTool(runId, effectiveConfig);
    }
    if (effectiveConfig.sessionId) options.resume = effectiveConfig.sessionId;
    if (CLAUDE_CODE_EXECUTABLE) options.pathToClaudeCodeExecutable = CLAUDE_CODE_EXECUTABLE;

    const active: ClaudeActiveRun = { runner: "claude", abortController, query: null, stopRequested: false };
    const claudeQuery = queryClaudeCode({ prompt, options });
    active.query = claudeQuery;
    this.activeRuns.set(runId, active);
    this.updateRun(runId, { status: "running" });
    this.emitSse({ kind: "run.started", runId, at: Date.now(), payload: { config: effectiveConfig } });
    const startedRun = this.runs.get(runId);
    if (startedRun) {
      this.emit("run.lifecycle", { kind: "started", run: startedRun, previous: null } as RunLifecycleEvent);
    }

    void this.consumeClaudeQuery(runId, claudeQuery).catch((error) => {
      const stillActive = this.activeRuns.get(runId);
      const stopRequested = Boolean(stillActive?.stopRequested);
      if (!stopRequested) {
        const message = error instanceof Error ? error.message : "Claude Code run failed";
        this.appendEvent(runId, { source: "stderr", text: message });
        this.emitSse({ kind: "run.stderr", runId, at: Date.now(), payload: { text: message } });
        this.updateRun(runId, { status: "failed", lastError: message });
      }
    }).finally(() => {
      this.finishClaudeExecution(runId);
    });
  }

  private async consumeClaudeQuery(runId: string, claudeQuery: ClaudeQuery): Promise<void> {
    for await (const message of claudeQuery) {
      this.handleClaudeMessage(runId, message);
    }
  }

  private finishClaudeExecution(runId: string): void {
    const active = this.activeRuns.get(runId);
    const stopRequested = Boolean(active?.stopRequested);
    this.activeRuns.delete(runId);
    this.rejectClaudePermissionWaitersForRun(runId, "Claude run ended before permission was approved.");

    const run = this.runs.get(runId);
    if (!run) return;

    if (stopRequested) {
      this.updateRun(runId, { status: "stopped" });
      this.emitSse({ kind: "run.stopped", runId, at: Date.now() });
      const stoppedRun = this.runs.get(runId);
      if (stoppedRun) {
        this.emit("run.lifecycle", { kind: "stopped", run: stoppedRun, previous: run } as RunLifecycleEvent);
      }
    } else if (run.status !== "failed" && run.status !== "stopped") {
      this.updateRun(runId, { status: "completed" });
      this.emitSse({ kind: "run.completed", runId, at: Date.now() });
      const completedRun = this.runs.get(runId);
      if (completedRun) {
        this.emit("run.lifecycle", { kind: "completed", run: completedRun, previous: run } as RunLifecycleEvent);
      }
    } else if (run.status === "failed") {
      this.emitSse({ kind: "run.failed", runId, at: Date.now(), payload: { code: 1 } });
      const failedRun = this.runs.get(runId);
      if (failedRun) {
        this.emit("run.lifecycle", { kind: "failed", run: failedRun, previous: run } as RunLifecycleEvent);
      }
    }

    this.persistState();
  }

  private handleClaudeMessage(runId: string, message: SDKMessage): void {
    const storedLine = truncateText(JSON.stringify(message), STORED_EVENT_TEXT_MAX_CHARS);
    this.appendEvent(runId, { source: "stdout", text: storedLine });
    this.emitSse({ kind: "run.stdout", runId, at: Date.now(), payload: { text: storedLine } });

    this.trackClaudeSessionId(runId, message);

    switch (message.type) {
      case "assistant":
        this.handleClaudeAssistantMessage(runId, message);
        return;
      case "result":
        this.handleClaudeResultMessage(runId, message);
        return;
      case "user":
        this.handleClaudeUserMessage(runId, message);
        return;
      case "system":
        this.handleClaudeSystemMessage(runId, message);
        return;
      case "auth_status":
        this.handleClaudeAuthStatusMessage(runId, message as unknown as Record<string, unknown>);
        return;
      case "prompt_suggestion":
      case "rate_limit_event":
      case "stream_event":
        return;
      default:
        return;
    }
  }

  private trackClaudeSessionId(runId: string, message: SDKMessage): void {
    const record = message as unknown as Record<string, unknown>;
    const sessionId = typeof record.session_id === "string" ? record.session_id : "";
    if (sessionId) {
      const run = this.runs.get(runId);
      if (run) {
        const patch: Partial<RunRecord> = { threadId: sessionId };
        if (!run.sessionId) patch.sessionId = sessionId;
        this.updateRun(runId, patch);
        this.emitClaudeParsed(runId, { type: "thread.started", thread_id: sessionId });
      }
    }
  }

  private handleClaudeAssistantMessage(runId: string, message: SDKAssistantMessage): void {
    const text = readClaudeAssistantText(message as unknown as Record<string, unknown>);
    const toolUses = readClaudeToolUses(message as unknown as Record<string, unknown>);
    for (const toolUse of toolUses) {
      this.emitClaudeParsed(runId, {
        type: "item.completed",
        item: {
          id: toolUse.id,
          type: "mcp_tool_call",
          status: "completed",
          server: "claude",
          tool: toolUse.name,
          arguments: toolUse.input,
        },
      });
    }
    if (message.error) {
      this.emitClaudeParsed(runId, {
        type: "item.completed",
        item: {
          id: message.uuid,
          type: "error",
          message: `Claude assistant error: ${message.error}`,
        },
      });
    }
    if (text.trim()) {
      this.updateRun(runId, { summary: text.slice(0, 240) });
      this.emitClaudeParsed(runId, {
        type: "item.completed",
        item: {
          id: message.uuid,
          type: "agent_message",
          text,
        },
      });
    }
  }

  private handleClaudeResultMessage(runId: string, message: SDKResultMessage): void {
    const record = message as unknown as Record<string, unknown>;
    const usage = readClaudeResultUsage(record);
    const resultText = typeof record.result === "string" ? record.result : "";
    const errors = Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === "string") : [];
    const permissionDenials = Array.isArray(message.permission_denials) ? message.permission_denials : [];
    const isError = message.subtype !== "success" || message.is_error === true;
    if (usage) this.updateRun(runId, { usage });
    if (resultText.trim()) this.updateRun(runId, { summary: resultText.slice(0, 240) });
    for (const denial of permissionDenials) {
      this.emitClaudeParsed(runId, {
        type: "item.completed",
        item: {
          id: denial.tool_use_id || `claude_permission_${Date.now()}`,
          type: "error",
          message: readClaudePermissionDenialText(denial),
        },
      });
    }
    if (isError) {
      const messageText = errors.join("\n") || resultText || "Claude Code run failed";
      this.updateRun(runId, { status: "failed", lastError: messageText.slice(0, 600) });
      this.emitClaudeParsed(runId, {
        type: "item.completed",
        item: {
          id: message.uuid,
          type: "error",
          message: messageText,
        },
      });
    }
    this.emitClaudeParsed(runId, {
      type: "turn.completed",
      usage: {
        input_tokens: usage?.inputTokens,
        output_tokens: usage?.outputTokens,
        cached_input_tokens: usage?.cachedInputTokens,
      },
    });
  }

  private handleClaudeUserMessage(runId: string, message: SDKUserMessage | SDKUserMessageReplay): void {
    if (!("isReplay" in message) || message.isReplay !== true) return;
    const text = readClaudeUserMessageText(message);
    if (!text.trim()) return;
    this.emitClaudeParsed(runId, {
      type: "item.completed",
      item: {
        id: message.uuid || `claude_user_replay_${Date.now()}`,
        type: "agent_message",
        text: `Replayed user message:\n${text}`,
      },
    });
  }

  private handleClaudeSystemMessage(runId: string, message: SDKSystemMessage | (SDKMessage & { type: "system" })): void {
    const record = message as unknown as Record<string, unknown>;
    const subtype = typeof record.subtype === "string" ? record.subtype : "";
    if (subtype === "init") return;

    if (subtype === "permission_denied") {
      const text = readClaudeSystemText(record) || "Claude denied a tool permission request.";
      this.emitClaudeParsed(runId, {
        type: "item.completed",
        item: {
          id: typeof record.uuid === "string" ? record.uuid : `claude_permission_denied_${Date.now()}`,
          type: "error",
          message: text,
        },
      });
      return;
    }

    const text = readClaudeSystemText(record);
    if (text) {
      this.emitClaudeParsed(runId, {
        type: "item.completed",
        item: {
          id: typeof record.uuid === "string" ? record.uuid : `claude_system_${Date.now()}`,
          type: "agent_message",
          text,
        },
      });
    }
  }

  private handleClaudeAuthStatusMessage(runId: string, message: Record<string, unknown>): void {
    const output = Array.isArray(message.output) ? message.output.filter((item): item is string => typeof item === "string") : [];
    const error = typeof message.error === "string" ? message.error : "";
    const text = error || output.join("\n");
    if (!text.trim()) return;
    this.emitClaudeParsed(runId, {
      type: "item.completed",
      item: {
        id: typeof message.uuid === "string" ? message.uuid : `claude_auth_${Date.now()}`,
        type: error ? "error" : "agent_message",
        ...(error ? { message: text } : { text }),
      },
    });
  }

  private emitClaudeParsed(runId: string, parsed: Record<string, unknown>): void {
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type.startsWith("item.")) {
      const item = parsed.item as Record<string, unknown> | undefined;
      this.emitSse({ kind: "run.item", runId, at: Date.now(), payload: { type, item } });
    }

    const run = this.runs.get(runId);
    if (run) {
      this.emit("run.parsed", { runId, run, parsed } as RunParsedEvent);
    }
  }

  private createClaudeCanUseTool(runId: string, effectiveConfig: RunConfig): CanUseTool {
    return async (toolName, input, options) => {
      const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const inputPreview = truncateText(JSON.stringify(input, null, 2), 1200);
      const title = options.title || (toolName === "ExitPlanMode" ? "Claude wants to exit plan mode" : `Claude wants to use ${toolName}`);
      const description = options.description || options.decisionReason || "";
      const reason = [title, description, inputPreview ? `Input:\n${inputPreview}` : ""].filter(Boolean).join("\n\n");
      const approval: ApprovalQueueItem = {
        id: approvalId,
        runId,
        createdAt: Date.now(),
        kind: "claude_permission",
        reason,
        suggestedSandbox: effectiveConfig.sandbox,
        suggestedApprovalPolicy: effectiveConfig.approvalPolicy,
        command: options.displayName || toolName,
        toolName,
        toolUseId: options.toolUseID,
        status: "pending",
      };

      this.approvals.set(approval.id, approval);
      this.persistState();
      this.emitSse({ kind: "run.approvalQueued", runId, at: Date.now(), payload: approval as unknown as Record<string, unknown> });

      return await new Promise<PermissionResult>((resolve) => {
        const deny = (message: string): void => {
          const waiter = this.claudePermissionWaiters.get(approvalId);
          if (waiter) {
            clearTimeout(waiter.timer);
            this.claudePermissionWaiters.delete(approvalId);
          }
          const current = this.approvals.get(approvalId);
          if (current?.status === "pending") {
            current.status = "dismissed";
            this.approvals.set(approvalId, current);
            this.persistState();
          }
          resolve({
            behavior: "deny",
            message,
            toolUseID: options.toolUseID,
            decisionClassification: "user_reject",
          });
        };

        const timer = setTimeout(() => {
          deny(`${toolName} was not approved before the permission request timed out.`);
        }, 30 * 60 * 1000);
        this.claudePermissionWaiters.set(approvalId, {
          runId,
          toolName,
          toolUseId: options.toolUseID,
          resolve,
          timer,
        });

        if (options.signal.aborted) {
          deny(`${toolName} permission request was aborted.`);
          return;
        }
        options.signal.addEventListener("abort", () => deny(`${toolName} permission request was aborted.`), { once: true });
      });
    };
  }

  private rejectClaudePermissionWaitersForRun(runId: string, message: string): void {
    for (const [approvalId, waiter] of this.claudePermissionWaiters.entries()) {
      if (waiter.runId !== runId) continue;
      clearTimeout(waiter.timer);
      this.claudePermissionWaiters.delete(approvalId);
      const approval = this.approvals.get(approvalId);
      if (approval?.status === "pending") {
        approval.status = "dismissed";
        this.approvals.set(approvalId, approval);
      }
      waiter.resolve({
        behavior: "deny",
        message,
        toolUseID: waiter.toolUseId,
        decisionClassification: "user_reject",
      });
    }
    this.persistState();
  }

  stopRun(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active) return false;

    active.stopRequested = true;
    if (active.runner === "claude") {
      active.abortController.abort();
      active.query?.close();
      this.rejectClaudePermissionWaitersForRun(runId, "Claude run was stopped before permission was approved.");
      return true;
    }

    active.process.kill("SIGINT");

    setTimeout(() => {
      const running = this.activeRuns.get(runId);
      if (!running || running.runner !== "codex") return;
      running.process.kill("SIGTERM");
      setTimeout(() => {
        const stillRunning = this.activeRuns.get(runId);
        if (!stillRunning || stillRunning.runner !== "codex") return;
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
    if (item.kind === "claude_permission") {
      const waiter = this.claudePermissionWaiters.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.claudePermissionWaiters.delete(id);
        waiter.resolve({
          behavior: "allow",
          toolUseID: waiter.toolUseId,
          decisionClassification: "user_temporary",
        });
      }
    }
    this.persistState();
    return item;
  }

  private handleStdoutLine(runId: string, line: string): void {
    const storedLine = sanitizeStoredStdoutLine(line);
    this.appendEvent(runId, { source: "stdout", text: storedLine });
    this.emitSse({ kind: "run.stdout", runId, at: Date.now(), payload: { text: storedLine } });

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

    const currentRun = this.runs.get(runId);
    if (currentRun) {
      this.emit("run.parsed", { runId, run: currentRun, parsed } as RunParsedEvent);
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
    this.emit("run.lifecycle", { kind: "updated", run: next, previous: run } as RunLifecycleEvent);
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
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      persistRuns(this.getRuns(true), this.getApprovals());
    }, RUNS_PERSIST_DEBOUNCE_MS);
  }

  flushPersistedStateSync(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    persistRuns(this.getRuns(true), this.getApprovals());
  }
}

function tehranDateParts(timestamp: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEHRAN_TIMEZONE,
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

function tehranLocalToTimestamp(year: number, month: number, day: number, hour: number, minute: number): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let index = 0; index < 3; index += 1) {
    const actual = tehranDateParts(guess);
    const actualLocal = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, 0);
    const desiredLocal = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const diff = actualLocal - desiredLocal;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

function addLocalDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function nextTehranDailyRun(time: AgentScheduleTime, afterTimestamp = Date.now()): number {
  const parts = tehranDateParts(afterTimestamp);
  let candidate = tehranLocalToTimestamp(parts.year, parts.month, parts.day, time.hour, time.minute);
  if (candidate <= afterTimestamp) {
    const nextDay = addLocalDays(parts.year, parts.month, parts.day, 1);
    candidate = tehranLocalToTimestamp(nextDay.year, nextDay.month, nextDay.day, time.hour, time.minute);
  }
  return candidate;
}

function loadPersistedAgentSchedules(): PersistedAgentScheduleState {
  if (!fs.existsSync(AGENT_SCHEDULES_PATH)) {
    return { schedules: [], executions: [] };
  }
  const payload = safeJsonParse<PersistedAgentScheduleState>(fs.readFileSync(AGENT_SCHEDULES_PATH, "utf8"), {
    schedules: [],
    executions: [],
  });
  return {
    schedules: Array.isArray(payload.schedules) ? payload.schedules : [],
    executions: Array.isArray(payload.executions) ? payload.executions : [],
  };
}

class AgentScheduleManager {
  private schedules = new Map<string, AgentSchedule>();

  private executions = new Map<string, AgentScheduleExecution>();

  private executionByRunId = new Map<string, string>();

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly runManager: RunManager,
    private readonly startScheduledRun: (
      schedule: AgentSchedule,
      prompt: string,
      execution: AgentScheduleExecution,
    ) => { run: RunRecord; sessionId: string },
  ) {}

  load(): void {
    const persisted = loadPersistedAgentSchedules();
    const now = Date.now();
    for (const schedule of persisted.schedules) {
      const normalized = this.normalizeSchedule(schedule, now);
      this.schedules.set(normalized.id, normalized);
    }
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
    this.persist();
    this.scheduleTimer();
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
    model: string;
    sandbox: RunConfig["sandbox"];
    approvalPolicy: RunConfig["approvalPolicy"];
    reasoningEffort: ReasoningEffort;
    skills: SelectedSkillRef[];
  }): AgentSchedule {
    const agent = discoverAgents().find((item) => item.id === input.agentId);
    if (!agent) throw new Error("Agent not found");

    const now = Date.now();
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
      runConfig: {
        runner: normalizeRunRunner(input.runner),
        workspace: input.workspace,
        model: input.model,
        reasoningEffort: normalizeReasoningEffort(input.reasoningEffort),
        sandbox: input.sandbox,
        approvalPolicy: input.approvalPolicy,
        skills: normalizeSelectedSkillRefs(input.skills),
      },
    };

    this.schedules.set(schedule.id, schedule);
    this.persist();
    this.scheduleTimer();
    return schedule;
  }

  updateStatus(scheduleId: string, status: AgentSchedule["status"]): AgentSchedule | null {
    const current = this.schedules.get(scheduleId);
    if (!current) return null;
    const now = Date.now();
    const next: AgentSchedule = {
      ...current,
      status,
      updatedAt: now,
      nextRunAt: status === "active" ? nextTehranDailyRun(current.time, now) : null,
    };
    this.schedules.set(scheduleId, next);
    this.persist();
    this.scheduleTimer();
    return next;
  }

  delete(scheduleId: string): boolean {
    const deleted = this.schedules.delete(scheduleId);
    if (deleted) {
      this.persist();
      this.scheduleTimer();
    }
    return deleted;
  }

  runNow(scheduleId: string): AgentScheduleExecution | null {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return null;
    return this.executeSchedule(schedule, Date.now());
  }

  onRunLifecycle(event: RunLifecycleEvent): void {
    const executionId = this.executionByRunId.get(event.run.id);
    if (!executionId) return;
    const execution = this.executions.get(executionId);
    if (!execution) return;

    if (event.kind === "updated") {
      const sessionId = runSessionId(event.run);
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
      completedAt: Date.now(),
      sessionId: runSessionId(event.run),
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
    writeJsonAtomicSync(AGENT_SCHEDULES_PATH, this.snapshot());
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

    const delay = Math.min(Math.max(nextAt - Date.now(), 0), 60_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runDueSchedules();
      this.scheduleTimer();
    }, delay);
  }

  private runDueSchedules(): void {
    const now = Date.now();
    const due = [...this.schedules.values()]
      .filter((schedule) => schedule.status === "active" && schedule.nextRunAt !== null && schedule.nextRunAt <= now)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));

    for (const schedule of due) {
      this.executeSchedule(schedule, schedule.nextRunAt || now);
    }
  }

  private executeSchedule(schedule: AgentSchedule, scheduledFor: number): AgentScheduleExecution {
    const executionId = `agent_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
      updatedAt: Date.now(),
      nextRunAt: schedule.status === "active"
        ? nextTehranDailyRun(schedule.time, Math.max(Date.now(), scheduledFor + 60_000))
        : null,
    };
    this.schedules.set(schedule.id, nextSchedule);

    const failExecution = (status: "failed" | "skipped", message: string): AgentScheduleExecution => {
      const failed: AgentScheduleExecution = {
        ...execution,
        status,
        completedAt: Date.now(),
        error: message,
      };
      this.executions.set(execution.id, failed);
      this.persist();
      this.scheduleTimer();
      return failed;
    };

    const agent = discoverAgents().find((item) => item.id === schedule.agentId && item.path === schedule.agentPath);
    if (!agent || !agent.prompt.trim()) {
      return failExecution("failed", `Agent file is missing, unreadable, or empty: ${schedule.agentPath}`);
    }

    if (!this.runManager.hasCapacity()) {
      return failExecution("skipped", `Maximum concurrent runs reached (${MAX_CONCURRENT_RUNS})`);
    }

    try {
      const started: AgentScheduleExecution = {
        ...execution,
        status: "running",
        startedAt: Date.now(),
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
      this.scheduleTimer();
      return running;
    } catch (error) {
      return failExecution("failed", error instanceof Error ? error.message : "Failed to start scheduled run");
    }
  }

  private persist(): void {
    writeJsonAtomicSync(AGENT_SCHEDULES_PATH, this.snapshot());
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

function ensurePlanModeFile(): void {
  if (!fs.existsSync(PLAN_MODE_FILE_PATH) || !fs.statSync(PLAN_MODE_FILE_PATH).isFile()) {
    throw new Error(`Plan mode requires ${PLAN_MODE_FILE_PATH}, but the file was not found.`);
  }
}

function readPlanModeInstructions(): string {
  ensurePlanModeFile();
  return fs.readFileSync(PLAN_MODE_FILE_PATH, "utf8").trim();
}

function buildPlanModePrompt(prompt: string, instructions = readPlanModeInstructions()): string {
  return [
    "Plan mode is enabled for this turn.",
    `Read and follow this file before doing anything else: ${PLAN_MODE_FILE_PATH}`,
    "Act according to that file for the entire response.",
    "If the file cannot be accessed from the current workspace, say so explicitly instead of guessing.",
    "",
    instructions,
    "",
    "User request:",
    prompt,
  ].join("\n");
}

function buildImageRenderContextPrompt(prompt: string, sessionId: string): string {
  if (!sessionId || prompt.includes("Luma image render context:")) return prompt;
  return [
    "Luma image render context:",
    `- Current Luma session_id: ${sessionId}`,
    "- When the user asks to see an image, asks to resend/show a generated image, or when you create an image file that should be shown in chat, call the MCP tool luma-images.show_image with this session_id.",
    "- The image tool accepts a local image path or HTTP(S) image URL, plus optional caption and alt text.",
    "- Do not say an image was sent, shown, displayed, or resent until luma-images.show_image succeeds.",
    "- If luma-images.show_image is unavailable or fails, say that the image display tool is unavailable and include the local file path if you found one.",
    "- The tool will reject images over 3 MB or taller than 1200 px; do not inline base64 images in your text response.",
    "",
    "User request:",
    prompt,
  ].join("\n");
}

function resolveEffectiveRunConfig(config: RunConfig): RunConfig {
  const attachments = normalizeAttachmentRefs(config.attachments);
  const skills = normalizeSelectedSkillRefs(config.skills);
  const agents = normalizeSelectedAgentRefs(config.agents);
  if (!config.planMode) {
    return {
      ...config,
      runner: normalizeRunRunner(config.runner),
      reasoningEffort: normalizeReasoningEffort(config.reasoningEffort),
      attachments,
      skills,
      agents,
    };
  }
  return {
    ...config,
    runner: normalizeRunRunner(config.runner),
    reasoningEffort: normalizeReasoningEffort(config.reasoningEffort),
    attachments,
    skills,
    agents,
    sandbox: "read-only",
    approvalPolicy: "never",
  };
}

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

function readClaudeAssistantText(message: Record<string, unknown>): string {
  const payload = isRecord(message.message) ? message.message : {};
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "thinking" && typeof item.thinking === "string") return item.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function readClaudeToolUses(message: Record<string, unknown>): Array<{ id: string; name: string; input: unknown }> {
  const payload = isRecord(message.message) ? message.message : {};
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((item) => {
      if (!isRecord(item) || item.type !== "tool_use") return null;
      return {
        id: typeof item.id === "string" ? item.id : `claude_tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: typeof item.name === "string" ? item.name : "tool",
        input: item.input,
      };
    })
    .filter((item): item is { id: string; name: string; input: unknown } => item !== null);
}

function readClaudeUserMessageText(message: SDKUserMessage | SDKUserMessageReplay): string {
  const payload = message.message as unknown;
  if (!isRecord(payload)) return "";
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "tool_result" && typeof item.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function readClaudeResultUsage(message: Record<string, unknown>): RunRecord["usage"] {
  const usage = isRecord(message.usage) ? message.usage : null;
  const modelUsage = isRecord(message.modelUsage) ? message.modelUsage : null;
  if (!usage && !modelUsage) return null;

  if (usage) {
    return {
      inputTokens: toOptionalNumber(usage.input_tokens),
      outputTokens: toOptionalNumber(usage.output_tokens),
      cachedInputTokens: toOptionalNumber(usage.cache_read_input_tokens ?? usage.cached_input_tokens),
    };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const value of Object.values(modelUsage || {})) {
    if (!isRecord(value)) continue;
    inputTokens += typeof value.inputTokens === "number" ? value.inputTokens : 0;
    outputTokens += typeof value.outputTokens === "number" ? value.outputTokens : 0;
    cachedInputTokens += typeof value.cacheReadInputTokens === "number" ? value.cacheReadInputTokens : 0;
  }
  return { inputTokens, outputTokens, cachedInputTokens };
}

function readClaudeSystemText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (typeof message.message === "string") return message.message;
  if (message.subtype === "permission_denied") {
    const toolName = typeof message.tool_name === "string" ? message.tool_name : "tool";
    const denial = typeof message.message === "string" ? message.message : "Permission denied";
    return `${toolName}: ${denial}`;
  }
  if (message.subtype === "compact_boundary" && isRecord(message.compact_metadata)) {
    const trigger = typeof message.compact_metadata.trigger === "string" ? message.compact_metadata.trigger : "context";
    const preTokens = typeof message.compact_metadata.pre_tokens === "number" ? message.compact_metadata.pre_tokens : null;
    const postTokens = typeof message.compact_metadata.post_tokens === "number" ? message.compact_metadata.post_tokens : null;
    const tokenText = preTokens !== null ? ` (${preTokens}${postTokens !== null ? ` -> ${postTokens}` : ""} tokens)` : "";
    return `Claude compacted context via ${trigger}${tokenText}.`;
  }
  if (message.subtype === "plugin_install") {
    const status = typeof message.status === "string" ? message.status : "updated";
    const name = typeof message.name === "string" ? ` ${message.name}` : "";
    const error = typeof message.error === "string" ? `: ${message.error}` : "";
    return `Claude plugin install${name} ${status}${error}`;
  }
  if (message.subtype === "worker_shutting_down") {
    const reason = typeof message.reason === "string" ? message.reason : "unknown";
    return `Claude worker is shutting down: ${reason}`;
  }
  if (message.subtype === "api_retry") {
    const attempt = typeof message.attempt === "number" ? message.attempt : null;
    const maxRetries = typeof message.max_retries === "number" ? message.max_retries : null;
    const error = typeof message.error === "string" ? message.error : "API request failed";
    const retry = attempt !== null && maxRetries !== null ? ` (${attempt}/${maxRetries})` : "";
    return `Claude retrying API request${retry}: ${error}`;
  }
  if (message.subtype === "local_command_output" && typeof message.content === "string") return message.content;
  if (message.subtype === "informational" && typeof message.content === "string") return message.content;
  if (message.subtype === "task_started" && typeof message.description === "string") return `Claude started task: ${message.description}`;
  if (message.subtype === "task_progress" && typeof message.description === "string") return `Claude task progress: ${message.description}`;
  if (message.subtype === "task_notification" && typeof message.summary === "string") return `Claude task ${message.status || "updated"}: ${message.summary}`;
  return "";
}

function readClaudePermissionDenialText(denial: SDKPermissionDenial): string {
  const input = truncateText(JSON.stringify(denial.tool_input, null, 2), 800);
  return [`Claude permission denied for ${denial.tool_name}.`, input ? `Input:\n${input}` : ""].filter(Boolean).join("\n\n");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function looksLikeEnvelopeMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.startsWith("<user_instructions>")
    || normalized.startsWith("<environment_context>")
    || normalized.startsWith("<ide_context>")
    || normalized.startsWith("<turn_aborted>")
    || normalized.startsWith("luma image render context:")
    || normalized.startsWith("# agents.md instructions for")
    || normalized.startsWith("plan mode is enabled in the codex exec fallback path.");
}

function unwrapWrappedUserRequest(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("Plan mode is enabled for this turn.")) {
    const marker = "\n\nUser request:\n";
    const markerIndex = trimmed.indexOf(marker);
    if (markerIndex >= 0) {
      return trimmed.slice(markerIndex + marker.length).trim();
    }
  }

  const codexRequestMatch = trimmed.match(/(?:^|\n)## My request for Codex:\s*\n([\s\S]*)$/);
  if (codexRequestMatch?.[1]) {
    return codexRequestMatch[1].trim();
  }

  return trimmed;
}

function normalizeSessionTitle(raw: string, fallback: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;

  const dashIndex = collapsed.indexOf("---");
  const trimmed = dashIndex >= 0 ? collapsed.slice(0, dashIndex).trim() : collapsed;
  const title = trimmed || fallback;

  return title.length > 160 ? `${title.slice(0, 157)}...` : title;
}

function isGeneratedSessionSummary(summary: string): boolean {
  return summary.trim().startsWith("Session in ");
}

function choosePreferredSessionSummary(entries: SessionHistoryEntry[]): string {
  const externalWithRealSummary = entries.find((entry) => !isLocalSessionSource(entry.source) && !isGeneratedSessionSummary(entry.summary));
  if (externalWithRealSummary) return externalWithRealSummary.summary;

  const realSummary = entries.find((entry) => !isGeneratedSessionSummary(entry.summary));
  if (realSummary) return realSummary.summary;

  return entries[0]?.summary || "";
}

function isLocalSessionSource(source: string): boolean {
  return source === LOCAL_SESSION_SOURCE || source === LEGACY_LOCAL_SESSION_SOURCE;
}

function isArchiveWorkspacePath(cwd: string): boolean {
  return /[\\/]archive[\\/]/i.test(cwd);
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const parts = content
    .map((item) => {
      if (!isRecord(item)) return "";
      const type = typeof item.type === "string" ? item.type : "";
      if ((type === "input_text" || type === "output_text" || type === "text") && typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .filter(Boolean);

  return parts.join("").trim();
}

function readSessionMessageRow(row: Record<string, unknown>): { role: "user" | "assistant"; text: string; at: number | null } | null {
  if (row.type === "message" && (row.role === "user" || row.role === "assistant")) {
    const text = extractMessageText(row.content);
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) || null : null;
    return text ? { role: row.role, text, at } : null;
  }

  if (row.type === "response_item" && isRecord(row.payload) && row.payload.type === "message" && (row.payload.role === "user" || row.payload.role === "assistant")) {
    const text = extractMessageText(row.payload.content);
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) || null : null;
    return text ? { role: row.payload.role, text, at } : null;
  }

  return null;
}

function extractFirstUserMessage(lines: string[]): string {
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = safeJsonParse<Record<string, unknown>>(line, {});
    const message = readSessionMessageRow(row);
    if (!message || message.role !== "user") continue;

    const candidate = unwrapWrappedUserRequest(message.text);
    if (!candidate) continue;
    if (!looksLikeEnvelopeMessage(candidate)) return candidate;
  }

  return "";
}

function getCodexSessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

function listCodexSessionFiles(): string[] {
  const root = getCodexSessionsRoot();
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
  return files;
}

function readCodexSessionFile(file: string): { entry: SessionHistoryEntry; lines: string[] } | null {
  if (file.toLowerCase().includes(`${path.sep}archived${path.sep}`)) return null;

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let payload: Record<string, unknown> | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const row = safeJsonParse<Record<string, unknown>>(line, {});
    if (row.type !== "session_meta" || !isRecord(row.payload)) continue;
    payload = row.payload;
    break;
  }

  if (!payload) return null;

  const id = typeof payload.id === "string" ? payload.id : path.basename(file);
  const timestamp = typeof payload.timestamp === "string" ? payload.timestamp : new Date(fs.statSync(file).mtimeMs).toISOString();
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  const source = typeof payload.source === "string" ? payload.source : "unknown";
  const firstMessage = extractFirstUserMessage(lines);
  const summary = normalizeSessionTitle(firstMessage, `Session in ${cwd || "unknown cwd"}`);

  return {
    entry: {
      id,
      timestamp,
      cwd,
      source,
      model: typeof payload.model === "string" ? payload.model : undefined,
      cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
      summary,
    },
    lines,
  };
}

function loadCodexSessionHistory(limit = 0, options?: { includeExec?: boolean }): SessionHistoryEntry[] {
  const files = listCodexSessionFiles();
  const selected = limit > 0 ? files.slice(0, limit) : files;

  const out: SessionHistoryEntry[] = [];
  for (const file of selected) {
    const parsed = readCodexSessionFile(file);
    if (!parsed) continue;
    if (!options?.includeExec && parsed.entry.source === "exec") continue;
    if (!isLocalSessionSource(parsed.entry.source) && isArchiveWorkspacePath(parsed.entry.cwd)) continue;
    out.push(parsed.entry);
  }

  return out;
}

function loadCodexSessionTranscript(sessionId: string): SessionTranscriptResponse | null {
  for (const file of listCodexSessionFiles()) {
    const parsed = readCodexSessionFile(file);
    if (!parsed || parsed.entry.id !== sessionId) continue;

    const baseAt = Date.parse(parsed.entry.timestamp) || fs.statSync(file).mtimeMs || Date.now();
    const entries: SessionTranscriptEntry[] = [];
    let index = 0;

    for (const line of parsed.lines) {
      if (!line.trim()) continue;
      const row = safeJsonParse<Record<string, unknown>>(line, {});
      const message = readSessionMessageRow(row);
      if (!message) continue;

      const text = message.role === "user" ? unwrapWrappedUserRequest(message.text) : message.text.trim();
      if (!text) continue;
      if (message.role === "user" && looksLikeEnvelopeMessage(text)) continue;

      entries.push({
        key: `${sessionId}_${index}`,
        role: message.role,
        text,
        at: message.at ?? (baseAt + index),
      });
      index += 1;
    }

    return {
      session: parsed.entry,
      entries,
    };
  }

  return null;
}

function readRunListItems(includeHistory: boolean): RunListItem[] {
  const localRuns = runManager.getRuns(false)
    .filter((run) => run.archivedAt === null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const groupedLocalRuns = new Map<string, RunRecord[]>();
  for (const run of localRuns) {
    const sessionKey = runSessionId(run);
    const existing = groupedLocalRuns.get(sessionKey) || [];
    existing.push(run);
    groupedLocalRuns.set(sessionKey, existing);
  }

  const localItems = [...groupedLocalRuns.entries()].map(([sessionId, runs]) => {
    const orderedDesc = [...runs].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    const orderedAsc = [...runs].sort((a, b) => a.createdAt - b.createdAt);
    const latestRun = orderedDesc[0];
    const fallback = latestRun?.summary.trim() || "Session";
    const firstPrompt = orderedAsc.find((run) => run.config.prompt.trim())?.config.prompt.trim() || "";

    return {
      id: sessionId,
      name: normalizeRunListName(firstPrompt || fallback, fallback),
      status: latestRun?.status || "completed",
      updatedAt: latestRun ? (latestRun.updatedAt || latestRun.createdAt) : 0,
      runner: normalizeRunRunner(latestRun?.config.runner),
      sourceTag: "in-app" as const,
      sourceRaw: "in-app",
      sessionId,
      latestRunId: latestRun?.id || null,
      runCount: runs.length,
      workspace: latestRun?.config.workspace || "",
      historyOnly: false,
    };
  });

  if (!includeHistory) return localItems;

  const localConversationIds = new Set(localItems.map((item) => item.sessionId));
  const historyItems = loadCodexSessionHistory(0, { includeExec: true })
    .filter((entry) => !localConversationIds.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: normalizeRunListName(entry.summary, entry.id),
      status: "completed" as const,
      updatedAt: Date.parse(entry.timestamp) || 0,
      runner: "codex" as const,
      sourceTag: normalizeRunSourceTag(entry.source, true),
      sourceRaw: entry.source,
      sessionId: entry.id,
      latestRunId: null,
      runCount: 0,
      workspace: entry.cwd,
      historyOnly: true,
    }));

  return [...localItems, ...historyItems].sort((a, b) => b.updatedAt - a.updatedAt);
}

function sliceRunListItems<T>(items: T[], limit: number, cursor: string | null): { items: T[]; nextCursor: string | null } {
  const offset = decodeCursor(cursor) ?? 0;
  const safeOffset = Math.min(Math.max(offset, 0), items.length);
  const nextItems = items.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + nextItems.length;
  return {
    items: nextItems,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
  };
}

function readTextField(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "text" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readToolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return stringifyToolValue(value);

  if (typeof value.output === "string" && value.output.trim()) return value.output;

  const contentText = readTextField(value.content);
  if (contentText.trim()) return contentText;

  if (value.structured_content !== null && value.structured_content !== undefined) {
    return stringifyToolValue(value.structured_content);
  }

  return stringifyToolValue(value);
}

function formatMcpToolCommand(server: unknown, tool: unknown, args: unknown): string {
  const serverName = typeof server === "string" && server.trim() ? server : "mcp";
  const toolName = typeof tool === "string" && tool.trim() ? tool : "tool";
  const argsText = stringifyToolValue(args) || "{}";
  return `${serverName}.${toolName}(${argsText})`;
}

function formatWebSearchCommand(item: Record<string, unknown>): string {
  const query = typeof item.query === "string" && item.query.trim() ? item.query : "search";
  return `search("${query}")`;
}

function parseRunFileChanges(item: Record<string, unknown>): RunMessageFileChange[] {
  const raw = Array.isArray(item.changes) ? item.changes : [];
  const result: RunMessageFileChange[] = [];
  for (const change of raw) {
    if (!isRecord(change)) continue;
    const filePath = typeof change.path === "string" ? change.path : "";
    if (!filePath) continue;
    result.push({
      kind: typeof change.kind === "string" ? change.kind : "modify",
      path: filePath,
      added: typeof change.added === "number" ? change.added : 0,
      removed: typeof change.removed === "number" ? change.removed : 0,
    });
  }
  return result;
}

function isPlanLike(itemType: string): boolean {
  const normalized = itemType.toLowerCase();
  return normalized === "plan" || normalized === "reasoning" || normalized.includes("todo");
}

function resolvePlanText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  if (typeof item.explanation === "string" && item.explanation.trim()) return item.explanation;

  if (Array.isArray(item.plan)) {
    const steps = item.plan
      .map((step) => {
        if (!isRecord(step)) return "";
        const text = typeof step.step === "string" ? step.step : "";
        const status = typeof step.status === "string" ? step.status : "pending";
        return text ? `- [${status}] ${text}` : "";
      })
      .filter(Boolean);
    if (steps.length) return `Plan steps:\n${steps.join("\n")}`;
  }

  return readTextField(item.content);
}

function truncatePreview(input: string, max = 120): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function buildRunMessageEntries(run: RunRecord): RunMessageEntry[] {
  const entries: RunMessageEntry[] = [];

  if (run.config.prompt.trim()) {
    entries.push({
      key: `${run.id}_user`,
      role: "user",
      title: "You",
      text: run.config.prompt.trim(),
      pending: false,
      at: run.createdAt,
      attachments: normalizeAttachmentRefs(run.config.attachments),
      meta: { runId: run.id },
    });
  }

  const commandByItemId = new Map<
    string,
    {
      itemId: string;
      at: number;
      command: string;
      output: string;
      status: string;
      exitCode: number | null;
      pending: boolean;
    }
  >();

  const fileChangeByItemId = new Map<
    string,
      {
        itemId: string;
        at: number;
        status: string;
        pending: boolean;
        changes: RunMessageFileChange[];
        errorMessage?: string;
        path?: string;
        durationMs?: number;
      }
    >();

  const mcpToolByItemId = new Map<
    string,
      {
        itemId: string;
        at: number;
        status: string;
        pending: boolean;
        server: string;
        tool: string;
        command: string;
        output: string;
        errorMessage?: string;
      }
    >();

  const webSearchByItemId = new Map<
    string,
      {
        itemId: string;
        at: number;
        status: string;
        pending: boolean;
        query: string;
        command: string;
        output: string;
      }
    >();

  const dedupe = new Set<string>();
  const orderedEvents = [...run.events].sort((a, b) => a.at - b.at);

  for (const event of orderedEvents) {
    const raw = (event.text || "").trim();
    if (!raw) continue;
    if (event.source === "stderr") continue;

    const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
    if (!parsed || typeof parsed.type !== "string") continue;

    const parsedType = parsed.type;
    const item = isRecord(parsed.item) ? parsed.item : null;
    const itemId = item && typeof item.id === "string" ? item.id : `item_${event.id}`;
    const itemType = item && typeof item.type === "string" ? item.type : "";

    if (item) {
      const dedupeKey = `${run.id}:${itemId}:${parsedType}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);
    }

    if (itemType === "agent_message" && parsedType === "item.completed") {
      const text = typeof item?.text === "string" ? item.text : readTextField(item?.content);
      if (!text.trim()) continue;
      entries.push({
        key: `${run.id}_${itemId}_assistant`,
        role: "assistant",
        title: "Assistant",
        text,
        pending: false,
        at: event.at,
        meta: { runId: run.id },
      });
      continue;
    }

    if (isPlanLike(itemType) && (parsedType === "item.started" || parsedType === "item.updated" || parsedType === "item.completed")) {
      const pending = parsedType === "item.started";
      const text = resolvePlanText(item || {});
      entries.push({
        key: `${run.id}_${itemId}_plan_${parsedType}`,
        role: "plan",
        title: itemType === "reasoning" ? "Reasoning" : "Plan",
        text: text || (pending ? "Planning" : "Plan updated"),
        pending,
        at: event.at,
        meta: { runId: run.id },
      });
      continue;
    }

    if (itemType === "command_execution" && (parsedType === "item.started" || parsedType === "item.completed")) {
      const existing = commandByItemId.get(itemId) || {
        itemId,
        at: event.at,
        command: "command",
        output: "",
        status: parsedType === "item.started" ? "in_progress" : "completed",
        exitCode: null,
        pending: parsedType === "item.started",
      };

      if (event.at < existing.at) existing.at = event.at;
      if (typeof item?.command === "string" && item.command.trim()) existing.command = item.command;
      if (typeof item?.aggregated_output === "string") existing.output = item.aggregated_output;
      if (typeof item?.status === "string" && item.status.trim()) existing.status = item.status;
      if (typeof item?.exit_code === "number") existing.exitCode = item.exit_code;
      existing.pending = parsedType === "item.started" || existing.status === "in_progress";

      commandByItemId.set(itemId, existing);
      continue;
    }

    if (itemType === "file_change" && (parsedType === "item.started" || parsedType === "item.completed")) {
      const existing = fileChangeByItemId.get(itemId) || {
        itemId,
        at: event.at,
        status: parsedType === "item.started" ? "in_progress" : "completed",
        pending: parsedType === "item.started",
        changes: [] as RunMessageFileChange[],
        errorMessage: undefined,
        path: undefined,
        durationMs: undefined,
      };

      if (event.at < existing.at) existing.at = event.at;
      if (typeof item?.status === "string" && item.status.trim()) existing.status = item.status;
      if (typeof item?.error_message === "string") existing.errorMessage = item.error_message;
      if (typeof item?.path === "string") existing.path = item.path;
      if (typeof item?.duration_ms === "number") existing.durationMs = item.duration_ms;
      const changes = parseRunFileChanges(item || {});
      if (changes.length) existing.changes = changes;
      existing.pending = parsedType === "item.started" || existing.status === "in_progress";

      fileChangeByItemId.set(itemId, existing);
      continue;
    }

    if (itemType === "mcp_tool_call" && (parsedType === "item.started" || parsedType === "item.completed")) {
      const existing = mcpToolByItemId.get(itemId) || {
        itemId,
        at: event.at,
        status: parsedType === "item.started" ? "in_progress" : "completed",
        pending: parsedType === "item.started",
        server: typeof item?.server === "string" ? item.server : "mcp",
        tool: typeof item?.tool === "string" ? item.tool : "tool",
        command: formatMcpToolCommand(item?.server, item?.tool, item?.arguments),
        output: "",
        errorMessage: undefined,
      };

      if (event.at < existing.at) existing.at = event.at;
      if (typeof item?.status === "string" && item.status.trim()) existing.status = item.status;
      if (typeof item?.server === "string" && item.server.trim()) existing.server = item.server;
      if (typeof item?.tool === "string" && item.tool.trim()) existing.tool = item.tool;
      existing.command = formatMcpToolCommand(existing.server, existing.tool, item?.arguments);
      const output = readToolOutputText(item?.result);
      if (output.trim()) existing.output = output;
      const errorMessage = readToolOutputText(item?.error);
      if (errorMessage.trim()) existing.errorMessage = errorMessage;
      existing.pending = parsedType === "item.started" || existing.status === "in_progress";

      mcpToolByItemId.set(itemId, existing);
      continue;
    }

    if (itemType === "web_search" && (parsedType === "item.started" || parsedType === "item.completed")) {
      const existing = webSearchByItemId.get(itemId) || {
        itemId,
        at: event.at,
        status: parsedType === "item.started" ? "in_progress" : "completed",
        pending: parsedType === "item.started",
        query: typeof item?.query === "string" ? item.query : "",
        command: formatWebSearchCommand(item || {}),
        output: "",
      };

      if (event.at < existing.at) existing.at = event.at;
      if (typeof item?.status === "string" && item.status.trim()) existing.status = item.status;
      if (typeof item?.query === "string") existing.query = item.query;
      existing.command = formatWebSearchCommand(item || {});
      const output = stringifyToolValue(item?.action);
      if (output.trim()) existing.output = output;
      existing.pending = parsedType === "item.started" || existing.status === "in_progress";

      webSearchByItemId.set(itemId, existing);
      continue;
    }

    if (itemType === "error") {
      const message = typeof item?.message === "string" ? item.message : raw;
      if (isMissingLocalImageReadErrorText(message)) continue;
      entries.push({
        key: `${run.id}_${itemId}_error`,
        role: "error",
        title: "Error",
        text: message,
        pending: false,
        at: event.at,
        meta: { runId: run.id },
      });
    }
  }

  const commandEntries = [...commandByItemId.values()].map((command) => ({
    key: `${run.id}_${command.itemId}_command`,
    role: "tool" as const,
    title: "Tool",
    text: `$ ${truncatePreview(command.command)}`,
    pending: command.pending,
    at: command.at,
    meta: {
      type: "commandexecution" as const,
      runId: run.id,
      status: command.status || (command.pending ? "in_progress" : "completed"),
      command: command.command,
      output: command.output,
      exitCode: command.exitCode,
    },
  }));

  const fileEntries = [...fileChangeByItemId.values()].map((change) => {
    const primaryPath = change.changes[0]?.path || change.path || "file change";
    const label = change.changes.length > 1 ? `${primaryPath} +${change.changes.length - 1} more` : primaryPath;
    const status = change.status || (change.pending ? "in_progress" : "completed");
    const summary = `${status}: ${label}`;
    return {
      key: `${run.id}_${change.itemId}_file_change`,
      role: "tool" as const,
      title: "Tool",
      text: summary,
      pending: change.pending,
      at: change.at,
      meta: {
        type: "filechange" as const,
        runId: run.id,
        status,
        fileChanges: change.changes,
        errorMessage: change.errorMessage,
        path: change.path,
        durationMs: change.durationMs,
      },
    };
  });

  const mcpEntries = [...mcpToolByItemId.values()].map((call) => ({
    key: `${run.id}_${call.itemId}_mcp_tool`,
    role: "tool" as const,
    title: "Tool",
    text: `MCP ${call.server}.${call.tool}`,
    pending: call.pending,
    at: call.at,
    meta: {
      type: "mcptoolcall" as const,
      runId: run.id,
      status: call.status || (call.pending ? "in_progress" : "completed"),
      command: call.command,
      output: call.output,
      server: call.server,
      tool: call.tool,
      errorMessage: call.errorMessage,
    },
  }));

  const webSearchEntries = [...webSearchByItemId.values()].map((search) => ({
    key: `${run.id}_${search.itemId}_web_search`,
    role: "tool" as const,
    title: "Tool",
    text: search.query ? `Web search: ${search.query}` : "Web search",
    pending: search.pending,
    at: search.at,
    meta: {
      type: "websearch" as const,
      runId: run.id,
      status: search.status || (search.pending ? "in_progress" : "completed"),
      command: search.command,
      output: search.output,
      query: search.query,
    },
  }));

  entries.push(...commandEntries, ...fileEntries, ...mcpEntries, ...webSearchEntries);

  if (run.usage) {
    entries.push({
      key: `${run.id}_usage`,
      role: "system",
      title: "Usage",
      text: `Tokens: in ${run.usage.inputTokens ?? 0}, out ${run.usage.outputTokens ?? 0}, cached ${run.usage.cachedInputTokens ?? 0}`,
      pending: false,
      at: run.updatedAt,
      meta: { runId: run.id },
    });
  }

  return entries.sort((a, b) => a.at - b.at);
}

function isMissingLocalImageReadErrorText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.startsWith("codex could not read the local image at ")
    && normalized.includes("no such file or directory")
    && normalized.includes("os error 2");
}

function buildTranscriptMessageEntries(transcript: SessionTranscriptResponse): RunMessageEntry[] {
  return transcript.entries.filter((entry) => !isMissingLocalImageReadErrorText(entry.text)).map((entry) => ({
    key: `history_${entry.key}`,
    role: entry.role,
    title: entry.role === "user" ? "You" : "Assistant",
    text: entry.text,
    pending: false,
    at: entry.at,
  }));
}

function getLocalSessionRuns(sessionId: string): RunRecord[] {
  return runManager.getRuns(false)
    .filter((run) => run.archivedAt === null && runSessionId(run) === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function buildSessionMessageEntries(runs: RunRecord[]): RunMessageEntry[] {
  return runs
    .flatMap((run) => buildRunMessageEntries(run))
    .sort((a, b) => a.at - b.at);
}

function loadPaginatedRunMessages(runId: string, beforeCursor: string | null): { entries: RunMessageEntry[]; nextCursor: string | null } | null {
  const localSessionRuns = getLocalSessionRuns(runId);
  const localRun = localSessionRuns.length === 0 ? runManager.getRun(runId) : null;
  const entries = localSessionRuns.length > 0
    ? buildSessionMessageEntries(localSessionRuns)
    : localRun
      ? buildRunMessageEntries(localRun)
      : (() => {
          const transcript = loadCodexSessionTranscript(runId);
          return transcript ? buildTranscriptMessageEntries(transcript) : null;
        })();

  if (!entries) return null;

  const { start, end: safeEnd } = resolveCountedPageWindow(
    entries,
    beforeCursor,
    RUN_MESSAGE_PAGE_SIZE,
    (entry) => entry.role !== "tool",
  );
  return {
    entries: entries.slice(start, safeEnd),
    nextCursor: start > 0 ? encodeCursor(start) : null,
  };
}

function resolveCountedPageWindow<T>(
  items: T[],
  beforeCursor: string | null,
  limit: number,
  countsTowardLimit: (item: T) => boolean,
): { start: number; end: number } {
  const end = decodeCursor(beforeCursor) ?? items.length;
  const safeEnd = Math.min(Math.max(end, 0), items.length);
  let start = safeEnd;
  let counted = 0;

  while (start > 0) {
    const item = items[start - 1];
    if (countsTowardLimit(item)) {
      if (counted >= limit) break;
      counted += 1;
    }
    start -= 1;
  }

  return { start, end: safeEnd };
}

function messageKindForRole(role: ChatMessage["role"]): ChatMessage["kind"] {
  if (role === "tool") return "tool";
  if (role === "plan") return "plan";
  if (role === "system") return "system";
  if (role === "error") return "error";
  return "message";
}

function timelineEntryToChatMessage(sessionId: string, entry: RunMessageEntry, sequence: number): ChatMessage {
  return {
    id: entry.key,
    clientMessageId: null,
    sessionId,
    runId: entry.meta?.runId || null,
    role: entry.role,
    kind: messageKindForRole(entry.role),
    title: entry.title,
    text: entry.text,
    createdAt: entry.at,
    sequence,
    deliveryStatus: entry.pending ? "streaming" : "sent",
    attachments: normalizeAttachmentRefs(entry.attachments),
    meta: entry.meta ? { ...entry.meta } : undefined,
  };
}

function transcriptEntryToChatMessage(sessionId: string, entry: SessionTranscriptEntry, sequence: number): ChatMessage {
  return {
    id: `history_${entry.key}`,
    clientMessageId: null,
    sessionId,
    runId: null,
    role: entry.role,
    kind: "message",
    title: entry.role === "user" ? "You" : "Assistant",
    text: entry.text,
    createdAt: entry.at,
    sequence,
    deliveryStatus: "sent",
    attachments: [],
  };
}

const HISTORY_MESSAGE_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

function isHistorySessionMessage(message: ChatMessage): boolean {
  return message.id.startsWith("history_");
}

function isTranscriptRenderableMessage(message: ChatMessage): boolean {
  return message.kind === "message" && (message.role === "user" || message.role === "assistant");
}

function historyDuplicateKey(message: ChatMessage): string {
  return `${message.role}\u0000${message.kind}\u0000${message.text.trim()}`;
}

function compareSessionMessages(left: ChatMessage, right: ChatMessage): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  if (isHistorySessionMessage(left) !== isHistorySessionMessage(right)) {
    return isHistorySessionMessage(left) ? 1 : -1;
  }
  return left.id.localeCompare(right.id);
}

function isLocalOutgoingUserMessage(message: ChatMessage): boolean {
  return message.role === "user" && message.kind === "message" && message.id.startsWith("msg_");
}

function isProjectedRunUserMessage(message: ChatMessage): boolean {
  return message.role === "user" && message.kind === "message" && message.id.startsWith("run_") && message.id.endsWith("_user");
}

function fileChangePath(message: ChatMessage): string {
  const firstChange = Array.isArray(message.meta?.fileChanges) ? message.meta.fileChanges[0] : null;
  if (firstChange && typeof firstChange.path === "string" && firstChange.path.trim()) {
    return firstChange.path.trim();
  }
  return typeof message.meta?.path === "string" ? message.meta.path.trim() : "";
}

function isDuplicateFileChangeMessage(left: ChatMessage, right: ChatMessage): boolean {
  if (left.role !== "tool" || right.role !== "tool" || left.kind !== "tool" || right.kind !== "tool") return false;
  if (left.meta?.type !== "filechange" || right.meta?.type !== "filechange") return false;
  if ((left.meta?.runId || null) !== (right.meta?.runId || null)) return false;
  if ((left.meta?.status || null) !== (right.meta?.status || null)) return false;
  if (left.text.trim() !== right.text.trim()) return false;
  if (fileChangePath(left) !== fileChangePath(right)) return false;
  return Math.abs(left.createdAt - right.createdAt) <= HISTORY_MESSAGE_DUPLICATE_WINDOW_MS;
}

function normalizeSessionMessages(messages: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const order: string[] = [];
  for (const message of messages) {
    if (message.role === "user" && looksLikeEnvelopeMessage(message.text)) continue;
    if (!byId.has(message.id)) order.push(message.id);
    byId.set(message.id, message);
  }

  const dedupedById = order.map((id) => byId.get(id)).filter((message): message is ChatMessage => Boolean(message));
  const localMatches = new Map<string, ChatMessage[]>();
  for (const message of dedupedById) {
    if (isHistorySessionMessage(message) || !isTranscriptRenderableMessage(message)) continue;
    const key = historyDuplicateKey(message);
    const bucket = localMatches.get(key) || [];
    bucket.push(message);
    localMatches.set(key, bucket);
  }

  const dropHistoryIds = new Set<string>();
  for (const message of dedupedById) {
    if (!isHistorySessionMessage(message) || !isTranscriptRenderableMessage(message)) continue;
    const bucket = localMatches.get(historyDuplicateKey(message));
    if (!bucket?.length) continue;
    const matchIndex = bucket.findIndex(
      (candidate) => Math.abs(candidate.createdAt - message.createdAt) <= HISTORY_MESSAGE_DUPLICATE_WINDOW_MS,
    );
    if (matchIndex === -1) continue;
    dropHistoryIds.add(message.id);
    bucket.splice(matchIndex, 1);
  }

  const localUserMatches = new Map<string, ChatMessage[]>();
  for (const message of dedupedById) {
    if (!isLocalOutgoingUserMessage(message)) continue;
    const key = historyDuplicateKey(message);
    const bucket = localUserMatches.get(key) || [];
    bucket.push(message);
    localUserMatches.set(key, bucket);
  }

  const dropProjectedPromptIds = new Set<string>();
  for (const message of dedupedById) {
    if (!isProjectedRunUserMessage(message)) continue;
    const bucket = localUserMatches.get(historyDuplicateKey(message));
    if (!bucket?.length) continue;
    const matchIndex = bucket.findIndex(
      (candidate) => Math.abs(candidate.createdAt - message.createdAt) <= HISTORY_MESSAGE_DUPLICATE_WINDOW_MS,
    );
    if (matchIndex === -1) continue;
    dropProjectedPromptIds.add(message.id);
    bucket.splice(matchIndex, 1);
  }

  const sorted = dedupedById
    .filter((message) => !dropHistoryIds.has(message.id) && !dropProjectedPromptIds.has(message.id))
    .sort(compareSessionMessages);

  const normalized: ChatMessage[] = [];
  for (const message of sorted) {
    const previous = normalized[normalized.length - 1];
    if (previous && isDuplicateFileChangeMessage(previous, message)) {
      normalized[normalized.length - 1] = message;
      continue;
    }
    normalized.push(message);
  }

  return normalized;
}

function transcriptToChatMessages(sessionId: string, transcript: SessionTranscriptResponse): ChatMessage[] {
  return transcript.entries
    .filter((entry) => !isMissingLocalImageReadErrorText(entry.text))
    .map((entry, index) => transcriptEntryToChatMessage(sessionId, entry, index + 1));
}

function buildHistorySessionListItem(entry: SessionHistoryEntry): SessionListItem {
  return {
    id: entry.id,
    title: normalizeRunListName(entry.summary, entry.id),
    status: "completed",
    updatedAt: Date.parse(entry.timestamp) || 0,
    runner: "codex",
    sourceTag: normalizeRunSourceTag(entry.source, true),
    sourceRaw: entry.source,
    workspace: entry.cwd,
    latestRunId: null,
    lastMessagePreview: entry.summary,
    messageCount: 0,
    historyOnly: true,
  };
}

function markScheduledSessionListItems(items: SessionListItem[]): SessionListItem[] {
  const scheduledSessionIds = agentScheduleManager.getScheduledSessionIds();
  const scheduledRunIds = agentScheduleManager.getScheduledRunIds();
  if (scheduledSessionIds.size === 0 && scheduledRunIds.size === 0) return items;

  return items.map((item) => {
    const scheduled =
      scheduledSessionIds.has(item.id) ||
      (item.latestRunId ? scheduledRunIds.has(item.latestRunId) : false);
    return scheduled ? { ...item, scheduled: true } : item;
  });
}

function readSessionListItems(includeHistory: boolean): SessionListItem[] {
  messageStore.reconcileWithRuns(runManager.getRuns(false));
  const localItems = markScheduledSessionListItems(messageStore.listLocalSessions());
  if (!includeHistory) return localItems;

  const localIds = new Set(localItems.map((item) => item.id));
  const historyItems = loadCodexSessionHistory(0, { includeExec: true })
    .filter((entry) => !localIds.has(entry.id))
    .map((entry) => buildHistorySessionListItem(entry));

  return markScheduledSessionListItems([...localItems, ...historyItems]).sort((a, b) => b.updatedAt - a.updatedAt);
}

function messageLogPath(sessionId: string): string {
  return path.join(MESSAGE_LOG_DIR, `${encodeURIComponent(sessionId)}.jsonl`);
}

function clearMessageErrorMeta(meta: ChatMessage["meta"] | undefined): ChatMessage["meta"] | undefined {
  if (!meta) return undefined;
  const { errorMessage, ...rest } = meta;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function readMessageLog(sessionId: string): ChatMessage[] {
  const filePath = messageLogPath(sessionId);
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const ordered: ChatMessage[] = [];
  const indexById = new Map<string, number>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const row = safeJsonParse<ChatMessage>(line, null as unknown as ChatMessage);
    if (!row || typeof row.id !== "string" || typeof row.sessionId !== "string") continue;
    const normalized: ChatMessage = {
      ...row,
      clientMessageId: typeof row.clientMessageId === "string" ? row.clientMessageId : null,
      runId: typeof row.runId === "string" ? row.runId : null,
      title: typeof row.title === "string" ? row.title : undefined,
      attachments: normalizeAttachmentRefs(row.attachments),
      meta: isRecord(row.meta) ? { ...row.meta } : undefined,
    };

    const existingIndex = indexById.get(normalized.id);
    if (existingIndex === undefined) {
      indexById.set(normalized.id, ordered.length);
      ordered.push(normalized);
    } else {
      ordered[existingIndex] = normalized;
    }
  }

  return ordered.sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt);
}

function previewText(text: string): string {
  return truncatePreview(text.replace(/\s+/g, " ").trim(), 140);
}

class MessageStore {
  private sessions = new Map<string, SessionState>();

  private writeQueue = Promise.resolve();

  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(private readonly emitEvent: (event: SseEvent) => void) {}

  loadOrBackfill(runs: RunRecord[]): void {
    fs.mkdirSync(MESSAGE_LOG_DIR, { recursive: true });
    const meta = this.loadMeta();
    if (meta?.schemaVersion === MESSAGE_STORE_SCHEMA_VERSION && fs.existsSync(SESSION_INDEX_PATH)) {
      this.loadFromDisk();
      this.reconcileWithRuns(runs.filter((run) => run.archivedAt === null));
      return;
    }

    this.backfillFromRuns(runs.filter((run) => run.archivedAt === null));
    this.persistMetaSync();
  }

  listLocalSessions(): SessionListItem[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...session.item }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  reconcileWithRuns(runs: RunRecord[]): void {
    const activeRuns = runs.filter((run) => run.archivedAt === null);
    const runById = new Map(activeRuns.map((run) => [run.id, run]));

    for (const [sessionId, state] of [...this.sessions.entries()]) {
      const latestRunId = state.item.latestRunId;
      if (!latestRunId) continue;

      const run = runById.get(latestRunId);
      if (!run) continue;

      const canonicalSessionId = runSessionId(run);
      if (!canonicalSessionId || canonicalSessionId === sessionId) continue;

      this.renameSession(sessionId, canonicalSessionId, latestRunId);
    }

    const runsBySession = new Map<string, RunRecord[]>();
    for (const run of activeRuns) {
      const sessionId = runSessionId(run);
      const existing = runsBySession.get(sessionId) || [];
      existing.push(run);
      runsBySession.set(sessionId, existing);
    }

    for (const [sessionId, sessionRuns] of runsBySession.entries()) {
      this.reconcileProjectedRunMessages(sessionId, sessionRuns);
    }
  }

  private reconcileProjectedRunMessages(sessionId: string, runs: RunRecord[]): void {
    if (runs.length === 0) return;

    const orderedDesc = [...runs].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    const orderedAsc = [...runs].sort((a, b) => a.createdAt - b.createdAt);
    const latestRun = orderedDesc[0];
    const firstPrompt = orderedAsc.find((run) => run.config.prompt.trim())?.config.prompt.trim() || "";
    const titleFallback = normalizeRunListName(firstPrompt || latestRun?.summary || "Session", latestRun?.summary || "Session");

    const state = this.ensureSession(sessionId, {
      title: titleFallback,
      workspace: latestRun?.config.workspace || "",
      status: latestRun?.status || "completed",
      runner: normalizeRunRunner(latestRun?.config.runner),
      sourceTag: "in-app",
      sourceRaw: "in-app",
    });

    const projectedMessages = buildSessionMessageEntries(runs)
      .map((entry, index) => timelineEntryToChatMessage(sessionId, entry, index + 1));
    const normalizedMessages = normalizeSessionMessages([...state.messages, ...projectedMessages]).map((message, index) => ({
      ...message,
      sessionId,
      sequence: index + 1,
    }));

    const previousSerialized = state.messages.map((message) => JSON.stringify(message)).join("\n");
    const nextSerialized = normalizedMessages.map((message) => JSON.stringify(message)).join("\n");
    const messagesChanged = previousSerialized !== nextSerialized;
    const nextUpdatedAt = Math.max(
      state.item.updatedAt,
      latestRun ? (latestRun.updatedAt || latestRun.createdAt) : 0,
      normalizedMessages[normalizedMessages.length - 1]?.createdAt || 0,
    );
    const nextPreview = previewText(normalizedMessages[normalizedMessages.length - 1]?.text || state.item.lastMessagePreview || "");
    const metadataChanged =
      state.item.status !== (latestRun?.status || state.item.status)
      || state.item.workspace !== (latestRun?.config.workspace || state.item.workspace)
      || state.item.latestRunId !== (latestRun?.id || state.item.latestRunId)
      || state.item.messageCount !== normalizedMessages.length
      || state.item.lastMessagePreview !== nextPreview
      || state.item.updatedAt !== nextUpdatedAt
      || (!state.item.title.trim() && titleFallback !== state.item.title);

    if (!messagesChanged && !metadataChanged) return;

    state.messages = normalizedMessages;
    state.messageIds = new Map(normalizedMessages.map((message, index) => [message.id, index]));
    state.nextSequence = normalizedMessages.length + 1;
    state.item.status = latestRun?.status || state.item.status;
    state.item.workspace = latestRun?.config.workspace || state.item.workspace;
    state.item.latestRunId = latestRun?.id || state.item.latestRunId;
    state.item.updatedAt = nextUpdatedAt;
    state.item.messageCount = normalizedMessages.length;
    state.item.lastMessagePreview = nextPreview;
    if (!state.item.title.trim()) state.item.title = titleFallback;
    this.syncSessionSource(state);

    if (messagesChanged) {
      this.enqueueWrite(async () => {
        await fs.promises.mkdir(MESSAGE_LOG_DIR, { recursive: true });
        const fileContent = normalizedMessages.map((message) => JSON.stringify(message)).join("\n");
        await fs.promises.writeFile(messageLogPath(sessionId), `${fileContent}${fileContent ? "\n" : ""}`);
      });
    }

    this.scheduleSnapshot();
    this.emitSessionUpsert(state.item);
  }

  hasLocalSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getLocalSession(sessionId: string): SessionListItem | null {
    const state = this.sessions.get(sessionId);
    return state ? { ...state.item } : null;
  }

  getMessagesPage(sessionId: string, beforeCursor: string | null, limit = SESSION_MESSAGE_PAGE_SIZE): SessionMessagesResponse | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;

    const normalizedMessages = normalizeSessionMessages(state.messages).map((message, index) => ({
      ...message,
      sequence: index + 1,
    }));
    const normalizedChanged = normalizedMessages.length !== state.messages.length
      || normalizedMessages.some((message, index) => {
        const current = state.messages[index];
        return !current || current.id !== message.id || current.sequence !== message.sequence;
      });
    if (normalizedChanged) {
      state.messages = normalizedMessages;
      state.messageIds = new Map(normalizedMessages.map((message, index) => [message.id, index]));
      state.nextSequence = normalizedMessages.reduce((max, message) => Math.max(max, message.sequence), 0) + 1;
      state.item.messageCount = normalizedMessages.length;
      state.item.lastMessagePreview = previewText(normalizedMessages[normalizedMessages.length - 1]?.text || "");
      this.syncSessionSource(state);
      this.scheduleSnapshot();
    }

    const { start, end: safeEnd } = resolveCountedPageWindow(
      state.messages,
      beforeCursor,
      limit,
      (message) => message.kind !== "tool" && message.role !== "tool",
    );
    return {
      sessionId,
      messages: state.messages.slice(start, safeEnd).map((message) => ({
        ...message,
        attachments: normalizeAttachmentRefs(message.attachments),
        meta: message.meta ? { ...message.meta } : undefined,
      })),
      nextCursor: start > 0 ? encodeCursor(start) : null,
      latestRunId: state.item.latestRunId,
    };
  }

  acceptOutgoingMessage(sessionId: string, input: SendMessageInput): ChatMessage {
    const transcript = loadCodexSessionTranscript(sessionId);
    if (transcript) {
      this.hydrateHistorySession(sessionId, transcript, input.workspace);
    }

    const titleFallback = normalizeRunListName(input.text, "Session");
    const state = this.ensureSession(sessionId, {
      title: titleFallback,
      workspace: input.workspace,
      status: "queued",
      runner: input.runner,
      sourceTag: "in-app",
      sourceRaw: "in-app",
    });

    const createdAt = Date.now();
    const message: ChatMessage = {
      id: `msg_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
      clientMessageId: input.clientMessageId,
      sessionId,
      runId: null,
      role: "user",
      kind: "message",
      title: "You",
      text: input.text,
      createdAt,
      sequence: state.nextSequence,
      deliveryStatus: "pending",
      attachments: normalizeAttachmentRefs(input.attachments),
    };

    this.writeMessage(message);
    return message;
  }

  bindMessageToRun(sessionId: string, messageId: string, runId: string): void {
    this.updateStoredMessage(sessionId, messageId, (current) => ({
      ...current,
      runId,
      meta: {
        ...(clearMessageErrorMeta(current.meta) || {}),
        runId,
      },
    }));
  }

  markMessagePending(sessionId: string, messageId: string): void {
    this.updateStoredMessage(sessionId, messageId, (current) => ({
      ...current,
      deliveryStatus: "pending",
      meta: clearMessageErrorMeta(current.meta),
    }));
  }

  markMessageSent(sessionId: string, messageId: string): void {
    this.updateStoredMessage(sessionId, messageId, (current) => ({
      ...current,
      deliveryStatus: "sent",
      meta: clearMessageErrorMeta(current.meta),
    }));
  }

  markMessageFailed(sessionId: string, messageId: string, errorMessage: string): void {
    const next = this.updateStoredMessage(sessionId, messageId, (current) => ({
      ...current,
      deliveryStatus: "failed",
      meta: {
        ...(current.meta || {}),
        errorMessage,
      },
    }));
    if (!next) return;
    this.emitEvent({
      kind: "message.failed",
      at: Date.now(),
      sessionId,
      runId: next.runId || undefined,
      payload: { message: next as unknown as Record<string, unknown> },
    });
  }

  updateSessionFromRun(run: RunRecord, sessionIdOverride?: string | null): void {
    const sessionId = sessionIdOverride || runSessionId(run);
    const titleFallback = normalizeRunListName(run.config.prompt || run.summary || "Session", "Session");
    const state = this.ensureSession(sessionId, {
      title: titleFallback,
      workspace: run.config.workspace,
      status: run.status,
      runner: normalizeRunRunner(run.config.runner),
      sourceTag: "in-app",
      sourceRaw: "in-app",
    });

    this.markSessionInApp(state);
    state.item.status = run.status;
    state.item.runner = normalizeRunRunner(run.config.runner);
    state.item.updatedAt = run.updatedAt || run.createdAt;
    state.item.workspace = run.config.workspace;
    state.item.latestRunId = run.id;
    if (!state.item.title.trim()) {
      state.item.title = titleFallback;
    }
    this.scheduleSnapshot();
    this.emitSessionUpsert(state.item);
  }

  upsertGeneratedMessage(sessionId: string, message: Omit<ChatMessage, "sessionId" | "sequence"> & { sequence?: number }): ChatMessage {
    const state = this.ensureSession(sessionId, {
      title: "Session",
      workspace: "",
      status: "running",
      runner: "codex",
      sourceTag: "in-app",
      sourceRaw: "in-app",
    });

    this.markSessionInApp(state);
    const next: ChatMessage = {
      ...message,
      sessionId,
      attachments: normalizeAttachmentRefs(message.attachments),
      sequence: typeof message.sequence === "number" ? message.sequence : state.nextSequence,
    };

    this.writeMessage(next);
    return next;
  }

  renameSession(previousSessionId: string, nextSessionId: string, latestRunId: string | null): void {
    if (!previousSessionId || previousSessionId === nextSessionId) return;
    const current = this.sessions.get(previousSessionId);
    if (!current) return;

    const existingNext = this.sessions.get(nextSessionId);
    const mergedMessages = existingNext
      ? [...existingNext.messages, ...current.messages]
      : [...current.messages];
    mergedMessages.sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt);

    const deduped: ChatMessage[] = [];
    const seen = new Map<string, number>();
    for (const message of mergedMessages) {
      const normalized = { ...message, sessionId: nextSessionId };
      const existingIndex = seen.get(normalized.id);
      if (existingIndex === undefined) {
        seen.set(normalized.id, deduped.length);
        deduped.push(normalized);
      } else {
        deduped[existingIndex] = normalized;
      }
    }

    const nextState: SessionState = {
      item: {
        ...(existingNext?.item || current.item),
        id: nextSessionId,
        updatedAt: Math.max(existingNext?.item.updatedAt || 0, current.item.updatedAt),
        latestRunId: latestRunId || existingNext?.item.latestRunId || current.item.latestRunId,
      },
      messages: deduped,
      messageIds: new Map(deduped.map((message, index) => [message.id, index])),
      nextSequence: deduped.reduce((max, message) => Math.max(max, message.sequence), 0) + 1,
    };

    nextState.item.messageCount = deduped.length;
    nextState.item.lastMessagePreview = previewText(deduped[deduped.length - 1]?.text || "");
    this.syncSessionSource(nextState);

    this.sessions.delete(previousSessionId);
    this.sessions.set(nextSessionId, nextState);
    this.enqueueWrite(async () => {
      await fs.promises.mkdir(MESSAGE_LOG_DIR, { recursive: true });
      const fileContent = deduped.map((message) => JSON.stringify(message)).join("\n");
      await fs.promises.writeFile(messageLogPath(nextSessionId), `${fileContent}${fileContent ? "\n" : ""}`);
      if (fs.existsSync(messageLogPath(previousSessionId))) {
        await fs.promises.rm(messageLogPath(previousSessionId), { force: true });
      }
    });
    this.scheduleSnapshot();
    this.emitSessionUpsert(nextState.item, previousSessionId);
  }

  removeSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    this.enqueueWrite(async () => {
      if (fs.existsSync(messageLogPath(sessionId))) {
        await fs.promises.rm(messageLogPath(sessionId), { force: true });
      }
    });
    this.scheduleSnapshot();
  }

  flushSync(): void {
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    writeJsonAtomicSync(SESSION_INDEX_PATH, this.listLocalSessions());
    this.persistMetaSync();
  }

  private loadMeta(): MessageStoreMeta | null {
    if (!fs.existsSync(MESSAGE_STORE_META_PATH)) return null;
    return safeJsonParse<MessageStoreMeta | null>(fs.readFileSync(MESSAGE_STORE_META_PATH, "utf8"), null);
  }

  private persistMetaSync(): void {
    writeJsonAtomicSync(MESSAGE_STORE_META_PATH, {
      schemaVersion: MESSAGE_STORE_SCHEMA_VERSION,
      backfilledAt: Date.now(),
    } satisfies MessageStoreMeta);
  }

  private loadFromDisk(): void {
    const rows = safeJsonParse<SessionListItem[]>(fs.readFileSync(SESSION_INDEX_PATH, "utf8"), []);
    this.sessions.clear();
    for (const item of rows) {
      const messages = normalizeSessionMessages(readMessageLog(item.id));
      const state: SessionState = {
        item: {
          ...item,
          runner: normalizeRunRunner(item.runner),
          lastMessagePreview: item.lastMessagePreview || previewText(messages[messages.length - 1]?.text || ""),
          messageCount: messages.length,
        },
        messages,
        messageIds: new Map(messages.map((message, index) => [message.id, index])),
        nextSequence: messages.reduce((max, message) => Math.max(max, message.sequence), 0) + 1,
      };
      this.syncSessionSource(state);
      this.sessions.set(item.id, state);
    }
  }

  private backfillFromRuns(runs: RunRecord[]): void {
    this.sessions.clear();
    fs.mkdirSync(MESSAGE_LOG_DIR, { recursive: true });

    const grouped = new Map<string, RunRecord[]>();
    for (const run of runs) {
      const key = runSessionId(run);
      const existing = grouped.get(key) || [];
      existing.push(run);
      grouped.set(key, existing);
    }

    for (const [sessionId, sessionRuns] of grouped.entries()) {
      const messages = buildSessionMessageEntries(sessionRuns)
        .map((entry, index) => timelineEntryToChatMessage(sessionId, entry, index + 1));
      const orderedDesc = [...sessionRuns].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
      const orderedAsc = [...sessionRuns].sort((a, b) => a.createdAt - b.createdAt);
      const latestRun = orderedDesc[0];
      const firstPrompt = orderedAsc.find((run) => run.config.prompt.trim())?.config.prompt.trim() || "";

      const item: SessionListItem = {
        id: sessionId,
        title: normalizeRunListName(firstPrompt || latestRun?.summary || "Session", latestRun?.summary || "Session"),
        status: latestRun?.status || "completed",
        updatedAt: latestRun ? (latestRun.updatedAt || latestRun.createdAt) : 0,
        runner: normalizeRunRunner(latestRun?.config.runner),
        sourceTag: "in-app",
        sourceRaw: "in-app",
        workspace: latestRun?.config.workspace || "",
        latestRunId: latestRun?.id || null,
        lastMessagePreview: previewText(messages[messages.length - 1]?.text || firstPrompt || latestRun?.summary || ""),
        messageCount: messages.length,
        historyOnly: false,
      };

      const state: SessionState = {
        item,
        messages,
        messageIds: new Map(messages.map((message, index) => [message.id, index])),
        nextSequence: messages.reduce((max, message) => Math.max(max, message.sequence), 0) + 1,
      };
      this.sessions.set(sessionId, state);
      const fileContent = messages.map((message) => JSON.stringify(message)).join("\n");
      fs.writeFileSync(messageLogPath(sessionId), `${fileContent}${fileContent ? "\n" : ""}`);
    }

    writeJsonAtomicSync(SESSION_INDEX_PATH, this.listLocalSessions());
  }

  private ensureSession(
    sessionId: string,
    seed: Pick<SessionListItem, "title" | "workspace" | "status" | "runner" | "sourceTag" | "sourceRaw">,
  ): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const state: SessionState = {
      item: {
        id: sessionId,
        title: seed.title,
        status: seed.status,
        runner: seed.runner,
        updatedAt: Date.now(),
        sourceTag: seed.sourceTag,
        sourceRaw: seed.sourceRaw,
        workspace: seed.workspace,
        latestRunId: null,
        lastMessagePreview: "",
        messageCount: 0,
        historyOnly: false,
      },
      messages: [],
      messageIds: new Map(),
      nextSequence: 1,
    };
    this.sessions.set(sessionId, state);
    this.scheduleSnapshot();
    this.emitSessionUpsert(state.item);
    return state;
  }

  private markSessionInApp(state: SessionState): void {
    if (state.item.sourceTag === "in-app" && state.item.sourceRaw === "in-app" && !state.item.historyOnly) {
      return;
    }

    state.item.sourceTag = "in-app";
    state.item.sourceRaw = "in-app";
    state.item.historyOnly = false;
  }

  private syncSessionSource(state: SessionState): void {
    const hasLocalEvidence =
      Boolean(state.item.latestRunId) || state.messages.some((message) => !message.id.startsWith("history_"));
    if (hasLocalEvidence) {
      this.markSessionInApp(state);
      return;
    }

    state.item.sourceTag = normalizeRunSourceTag(state.item.sourceRaw, state.item.historyOnly);
  }

  private writeMessage(message: ChatMessage, options?: { emitMessage?: boolean }): void {
    const state = this.ensureSession(message.sessionId, {
      title: "Session",
      workspace: "",
      status: "running",
      runner: "codex",
      sourceTag: "in-app",
      sourceRaw: "in-app",
    });
    this.markSessionInApp(state);
    const existingIndex = state.messageIds.get(message.id);
    if (existingIndex === undefined) {
      state.messageIds.set(message.id, state.messages.length);
      state.messages.push(message);
      state.nextSequence = Math.max(state.nextSequence, message.sequence + 1);
    } else {
      state.messages[existingIndex] = message;
      state.nextSequence = Math.max(state.nextSequence, message.sequence + 1);
    }

    state.messages.sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt);
    state.messageIds = new Map(state.messages.map((row, index) => [row.id, index]));
    state.item.updatedAt = Math.max(state.item.updatedAt, message.createdAt);
    state.item.messageCount = state.messages.length;
    state.item.lastMessagePreview = previewText(message.text);
    if (!state.item.title.trim() && message.role === "user") {
      state.item.title = normalizeRunListName(message.text, "Session");
    }

    this.enqueueWrite(async () => {
      await fs.promises.mkdir(MESSAGE_LOG_DIR, { recursive: true });
      await fs.promises.appendFile(messageLogPath(message.sessionId), `${JSON.stringify(message)}\n`);
    });
    this.scheduleSnapshot();
    if (options?.emitMessage !== false) {
      this.emitEvent({
        kind: "message.upsert",
        at: Date.now(),
        sessionId: message.sessionId,
        runId: message.runId || undefined,
        payload: { message: message as unknown as Record<string, unknown> },
      });
    }
    this.emitSessionUpsert(state.item);
  }

  private updateStoredMessage(
    sessionId: string,
    messageId: string,
    transform: (current: ChatMessage) => ChatMessage,
  ): ChatMessage | null {
    const state = this.sessions.get(sessionId);
    const index = state?.messageIds.get(messageId);
    if (state === undefined || index === undefined) return null;
    const next = transform(state.messages[index]);
    this.writeMessage(next);
    return next;
  }

  private hydrateHistorySession(sessionId: string, transcript: SessionTranscriptResponse, workspaceFallback: string): void {
    const historyItem = buildHistorySessionListItem(transcript.session);
    const historyMessages = transcriptToChatMessages(sessionId, transcript);
    const existing = this.sessions.get(sessionId);
    const existingHasLocalMessages = existing?.messages.some((message) => !message.id.startsWith("history_")) ?? false;

    const mergedMessages = existing
      ? [
          ...historyMessages,
          ...existing.messages.filter((message) => !message.id.startsWith("history_")),
        ]
      : historyMessages;

    const normalizedMessages = normalizeSessionMessages(mergedMessages).map((message, index) => ({
      ...message,
      sessionId,
      sequence: index + 1,
    }));
    const hasLocalEvidence =
      existingHasLocalMessages ||
      Boolean(existing?.item.latestRunId) ||
      existing?.item.sourceTag === "in-app" ||
      existing?.item.sourceRaw === "in-app" ||
      normalizedMessages.some((message) => !message.id.startsWith("history_"));

    const nextItem: SessionListItem = {
      id: sessionId,
      title: existing?.item.title?.trim() || historyItem.title,
      status: existing?.item.status || "completed",
      runner: normalizeRunRunner(existing?.item.runner || historyItem.runner),
      updatedAt: Math.max(
        existing?.item.updatedAt || 0,
        historyItem.updatedAt,
        normalizedMessages[normalizedMessages.length - 1]?.createdAt || 0,
      ),
      sourceTag: hasLocalEvidence ? "in-app" : historyItem.sourceTag,
      sourceRaw: hasLocalEvidence ? "in-app" : historyItem.sourceRaw,
      workspace: existing?.item.workspace || historyItem.workspace || workspaceFallback,
      latestRunId: existing?.item.latestRunId || null,
      lastMessagePreview: previewText(normalizedMessages[normalizedMessages.length - 1]?.text || historyItem.lastMessagePreview),
      messageCount: normalizedMessages.length,
      historyOnly: !hasLocalEvidence,
    };

    const nextState: SessionState = {
      item: nextItem,
      messages: normalizedMessages,
      messageIds: new Map(normalizedMessages.map((message, index) => [message.id, index])),
      nextSequence: normalizedMessages.length + 1,
    };

    this.sessions.set(sessionId, nextState);
    this.enqueueWrite(async () => {
      await fs.promises.mkdir(MESSAGE_LOG_DIR, { recursive: true });
      const fileContent = normalizedMessages.map((message) => JSON.stringify(message)).join("\n");
      await fs.promises.writeFile(messageLogPath(sessionId), `${fileContent}${fileContent ? "\n" : ""}`);
    });
    this.scheduleSnapshot();
    this.emitSessionUpsert(nextItem);
  }

  private emitSessionUpsert(item: SessionListItem, previousSessionId?: string): void {
    this.emitEvent({
      kind: "session.upsert",
      at: Date.now(),
      sessionId: item.id,
      runId: item.latestRunId || undefined,
      payload: {
        session: item as unknown as Record<string, unknown>,
        previousSessionId,
      },
    });
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
    }

    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.enqueueWrite(async () => {
        await writeJsonAtomic(SESSION_INDEX_PATH, this.listLocalSessions());
      });
    }, SESSION_INDEX_PERSIST_DEBOUNCE_MS);
  }

  private enqueueWrite(task: () => Promise<void>): void {
    this.writeQueue = this.writeQueue
      .then(task)
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[luma-assistant/message-store] write failed", error);
      });
  }
}

class OutboxProcessor {
  private items: MessageOutboxItem[] = [];

  private persistQueue = Promise.resolve();

  private timer: NodeJS.Timeout | null = null;

  private readonly busySessionIds = new Set<string>();

  private readonly busySessionIdsByRunId = new Map<string, Set<string>>();

  constructor(
    private readonly runManager: RunManager,
    private readonly messageStore: MessageStore,
    private readonly emitEvent: (event: SseEvent) => void,
    private readonly onRunStarted: (item: MessageOutboxItem, run: RunRecord) => void,
  ) {
    this.load();
  }

  enqueue(item: Omit<MessageOutboxItem, "id" | "attempts" | "status" | "nextAttemptAt" | "lastError" | "latestRunId" | "createdAt" | "updatedAt">): void {
    const now = Date.now();
    this.items.push({
      ...item,
      id: `outbox_${now}_${Math.random().toString(36).slice(2, 8)}`,
      attempts: 0,
      status: "pending",
      nextAttemptAt: now,
      lastError: null,
      latestRunId: null,
      createdAt: now,
      updatedAt: now,
    });
    this.persistSoon();
    this.emitOutboxUpdated();
    this.scheduleProcessing(0);
  }

  remapSession(previousSessionId: string, nextSessionId: string, runId?: string | null): void {
    if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) return;
    for (const item of this.items) {
      if (item.sessionId !== previousSessionId) continue;
      item.sessionId = nextSessionId;
      item.updatedAt = Date.now();
    }

    if (this.busySessionIds.has(previousSessionId)) {
      this.busySessionIds.add(nextSessionId);
    }

    if (runId) {
      const aliases = this.busySessionIdsByRunId.get(runId) || new Set<string>();
      aliases.add(previousSessionId);
      aliases.add(nextSessionId);
      this.busySessionIdsByRunId.set(runId, aliases);
    }

    this.persistSoon();
  }

  handleRunFinished(runId: string): void {
    const aliases = this.busySessionIdsByRunId.get(runId);
    if (aliases) {
      for (const alias of aliases) this.busySessionIds.delete(alias);
      this.busySessionIdsByRunId.delete(runId);
    }
    this.scheduleProcessing(0);
  }

  removeSession(sessionId: string): void {
    const next = this.items.filter((item) => item.sessionId !== sessionId);
    if (next.length === this.items.length) return;
    this.items = next;
    this.busySessionIds.delete(sessionId);
    this.persistSoon();
    this.emitOutboxUpdated();
  }

  retryFailedMessage(messageId: string): MessageOutboxItem | null {
    const item = this.items.find((row) => row.messageId === messageId && row.status === "failed");
    if (!item) return null;

    item.attempts = 0;
    item.status = "pending";
    item.nextAttemptAt = Date.now();
    item.lastError = null;
    item.updatedAt = Date.now();
    this.messageStore.markMessagePending(item.sessionId, item.messageId);
    this.persistSoon();
    this.emitOutboxUpdated();
    this.scheduleProcessing(0);
    return { ...item, attachments: normalizeAttachmentRefs(item.attachments), agents: normalizeSelectedAgentRefs(item.agents) };
  }

  flushSync(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    writeJsonAtomicSync(MESSAGE_OUTBOX_PATH, { items: this.items });
  }

  private load(): void {
    if (!fs.existsSync(MESSAGE_OUTBOX_PATH)) return;
    const payload = safeJsonParse<{ items: MessageOutboxItem[] }>(fs.readFileSync(MESSAGE_OUTBOX_PATH, "utf8"), { items: [] });
    this.items = (payload.items || []).map((item) => ({
      ...item,
      runner: normalizeRunRunner(item.runner),
      reasoningEffort: normalizeReasoningEffort(item.reasoningEffort),
      attachments: normalizeAttachmentRefs(item.attachments),
      skills: normalizeSelectedSkillRefs(item.skills),
      agents: normalizeSelectedAgentRefs(item.agents),
    }));
    if (this.items.some((item) => item.status === "pending" || item.status === "processing")) {
      this.scheduleProcessing(0);
    }
  }

  private emitOutboxUpdated(): void {
    this.emitEvent({
      kind: "outbox.updated",
      at: Date.now(),
      payload: {
        items: this.items.map((item) => ({
          id: item.id,
          sessionId: item.sessionId,
          status: item.status,
          attempts: item.attempts,
          nextAttemptAt: item.nextAttemptAt,
          latestRunId: item.latestRunId,
          messageId: item.messageId,
          lastError: item.lastError,
        })) as unknown as Record<string, unknown>,
      },
    });
  }

  private persistSoon(): void {
    this.persistQueue = this.persistQueue
      .then(() => writeJsonAtomic(MESSAGE_OUTBOX_PATH, { items: this.items }))
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[luma-assistant/outbox] persist failed", error);
      });
  }

  private scheduleProcessing(delayMs: number): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.processReadyItems();
    }, Math.max(0, delayMs));
  }

  private async processReadyItems(): Promise<void> {
    const now = Date.now();
    const ready = this.items
      .filter((item) => item.status === "pending" && (item.nextAttemptAt ?? 0) <= now)
      .sort((a, b) => a.createdAt - b.createdAt);

    if (ready.length === 0) {
      const nextAt = this.items
        .filter((item) => item.status === "pending" && typeof item.nextAttemptAt === "number")
        .map((item) => item.nextAttemptAt as number)
        .sort((a, b) => a - b)[0];
      if (typeof nextAt === "number") this.scheduleProcessing(Math.max(0, nextAt - now));
      return;
    }

    for (const item of ready) {
      if (this.busySessionIds.has(item.sessionId) || this.runManager.isSessionActive(item.sessionId)) {
        continue;
      }

      item.status = "processing";
      item.updatedAt = Date.now();
      this.persistSoon();
      this.emitOutboxUpdated();

      try {
        const run = this.runManager.startRun({
          runner: item.runner,
          workspace: item.workspace,
          prompt: item.text,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
          sandbox: item.sandbox,
          approvalPolicy: item.approvalPolicy,
          planMode: item.planMode,
          sessionId: item.provisionalSession ? undefined : item.sessionId,
          attachments: item.attachments,
          skills: item.skills,
          agents: item.agents,
        });

        item.latestRunId = run.id;
        this.messageStore.updateSessionFromRun(run, item.sessionId);
        this.messageStore.bindMessageToRun(item.sessionId, item.messageId, run.id);
        this.messageStore.markMessageSent(item.sessionId, item.messageId);
        this.busySessionIds.add(item.sessionId);
        this.busySessionIdsByRunId.set(run.id, new Set([item.sessionId]));
        this.onRunStarted(item, run);
        this.items = this.items.filter((row) => row.id !== item.id);
        this.persistSoon();
        this.emitOutboxUpdated();
      } catch (error) {
        item.attempts += 1;
        item.lastError = error instanceof Error ? error.message : "Failed to start run";
        item.updatedAt = Date.now();

        const retryDelay = MESSAGE_OUTBOX_RETRY_DELAYS_MS[item.attempts - 1];
        if (typeof retryDelay === "number") {
          item.status = "pending";
          item.nextAttemptAt = Date.now() + retryDelay;
        } else {
          item.status = "failed";
          item.nextAttemptAt = null;
          this.messageStore.markMessageFailed(item.sessionId, item.messageId, item.lastError);
        }

        this.persistSoon();
        this.emitOutboxUpdated();
      }
    }

    const nextPending = this.items
      .filter((item) => item.status === "pending" && typeof item.nextAttemptAt === "number")
      .map((item) => item.nextAttemptAt as number)
      .sort((a, b) => a - b)[0];
    if (typeof nextPending === "number") {
      this.scheduleProcessing(Math.max(0, nextPending - Date.now()));
    }
  }
}

class MessageProjector {
  private sessionIdByRunId = new Map<string, string>();

  constructor(
    private readonly messageStore: MessageStore,
    private readonly outboxBridge: {
      remapSession: (previousSessionId: string, nextSessionId: string, runId?: string | null) => void;
      handleRunFinished: (runId: string) => void;
    },
  ) {}

  registerRun(runId: string, sessionId: string): void {
    this.sessionIdByRunId.set(runId, sessionId);
  }

  onLifecycle(event: RunLifecycleEvent): void {
    if (event.kind === "updated" && event.previous) {
      const meaningfulChange = event.previous.status !== event.run.status
        || event.previous.sessionId !== event.run.sessionId
        || event.previous.threadId !== event.run.threadId
        || event.previous.summary !== event.run.summary
        || event.previous.lastError !== event.run.lastError
        || JSON.stringify(event.previous.usage) !== JSON.stringify(event.run.usage)
        || event.previous.changedFiles.join("\n") !== event.run.changedFiles.join("\n");
      if (!meaningfulChange) return;
    }

    const resolvedSessionId = this.sessionIdByRunId.get(event.run.id) || runSessionId(event.run);
    this.messageStore.updateSessionFromRun(event.run, resolvedSessionId);
    if (event.kind === "completed" || event.kind === "failed" || event.kind === "stopped") {
      this.outboxBridge.handleRunFinished(event.run.id);
    }

    if (event.kind === "failed" && event.run.lastError) {
      const messageId = `${event.run.id}_failed`;
      this.messageStore.upsertGeneratedMessage(resolvedSessionId, {
        id: messageId,
        clientMessageId: null,
        runId: event.run.id,
        role: "error",
        kind: "error",
        title: "Error",
        text: event.run.lastError,
        createdAt: event.run.updatedAt,
        deliveryStatus: "failed",
        attachments: [],
        meta: { runId: event.run.id, errorMessage: event.run.lastError },
      });
    }
  }

  onParsed(event: RunParsedEvent): void {
    const type = typeof event.parsed.type === "string" ? event.parsed.type : "";
    const currentSessionId = this.sessionIdByRunId.get(event.runId) || runSessionId(event.run);

    if (type === "thread.started" && typeof event.parsed.thread_id === "string") {
      const actualSessionId = event.parsed.thread_id;
      if (currentSessionId !== actualSessionId) {
        this.messageStore.renameSession(currentSessionId, actualSessionId, event.run.id);
        this.outboxBridge.remapSession(currentSessionId, actualSessionId, event.run.id);
        this.sessionIdByRunId.set(event.runId, actualSessionId);
      }
    }

    const sessionId = this.sessionIdByRunId.get(event.runId) || runSessionId(event.run);
    const item = isRecord(event.parsed.item) ? event.parsed.item : null;
    const itemId = item && typeof item.id === "string" ? item.id : null;
    const itemType = item && typeof item.type === "string" ? item.type : "";

    if (type === "turn.completed" && event.run.usage) {
      this.messageStore.upsertGeneratedMessage(sessionId, {
        id: `${event.run.id}_usage`,
        clientMessageId: null,
        runId: event.run.id,
        role: "system",
        kind: "system",
        title: "Usage",
        text: `Tokens: in ${event.run.usage.inputTokens ?? 0}, out ${event.run.usage.outputTokens ?? 0}, cached ${event.run.usage.cachedInputTokens ?? 0}`,
        createdAt: event.run.updatedAt,
        deliveryStatus: "sent",
        attachments: [],
        meta: { runId: event.run.id },
      });
    }

    if (!type.startsWith("item.") || !itemId) return;

    if (itemType === "agent_message" && type === "item.completed") {
      const text = typeof item?.text === "string" ? item.text : readTextField(item?.content);
      if (!text.trim()) return;
      this.messageStore.upsertGeneratedMessage(sessionId, {
        id: `${event.run.id}_${itemId}_assistant`,
        clientMessageId: null,
        runId: event.run.id,
        role: "assistant",
        kind: "message",
        title: "Assistant",
        text,
        createdAt: event.run.updatedAt,
        deliveryStatus: "sent",
        attachments: [],
        meta: { runId: event.run.id },
      });
      return;
    }

    if (isPlanLike(itemType) && (type === "item.started" || type === "item.updated" || type === "item.completed")) {
      const pending = type !== "item.completed";
      const text = resolvePlanText(item || {});
      this.messageStore.upsertGeneratedMessage(sessionId, {
        id: `${event.run.id}_${itemId}_plan`,
        clientMessageId: null,
        runId: event.run.id,
        role: "plan",
        kind: "plan",
        title: itemType === "reasoning" ? "Reasoning" : "Plan",
        text: text || (pending ? "Planning" : "Plan updated"),
        createdAt: event.run.updatedAt,
        deliveryStatus: pending ? "streaming" : "sent",
        attachments: [],
        meta: { runId: event.run.id },
      });
      return;
    }

    if (itemType === "command_execution" && (type === "item.started" || type === "item.completed")) {
      const command = typeof item?.command === "string" && item.command.trim() ? item.command : "command";
      const status = typeof item?.status === "string" ? item.status : (type === "item.started" ? "in_progress" : "completed");
      const output = typeof item?.aggregated_output === "string" ? item.aggregated_output : "";
      this.messageStore.upsertGeneratedMessage(sessionId, {
        id: `${event.run.id}_${itemId}_command`,
        clientMessageId: null,
        runId: event.run.id,
        role: "tool",
        kind: "tool",
        title: "Tool",
        text: `$ ${truncatePreview(command)}`,
        createdAt: event.run.updatedAt,
        deliveryStatus: type === "item.started" || status === "in_progress" ? "streaming" : "sent",
        attachments: [],
        meta: {
          type: "commandexecution",
          runId: event.run.id,
          status,
          command,
          output,
          exitCode: typeof item?.exit_code === "number" ? item.exit_code : null,
        },
      });
      return;
    }

    if (itemType === "mcp_tool_call" && (type === "item.started" || type === "item.completed")) {
      const status = typeof item?.status === "string" ? item.status : (type === "item.started" ? "in_progress" : "completed");
      const server = typeof item?.server === "string" && item.server.trim() ? item.server : "mcp";
      const tool = typeof item?.tool === "string" && item.tool.trim() ? item.tool : "tool";
      const output = readToolOutputText(item?.result);
      const errorMessage = readToolOutputText(item?.error);
      this.messageStore.upsertGeneratedMessage(sessionId, {
        id: `${event.run.id}_${itemId}_mcp_tool`,
        clientMessageId: null,
        runId: event.run.id,
        role: "tool",
        kind: "tool",
        title: "Tool",
        text: `MCP ${server}.${tool}`,
        createdAt: event.run.updatedAt,
        deliveryStatus: type === "item.started" || status === "in_progress" ? "streaming" : "sent",
        attachments: [],
        meta: {
          type: "mcptoolcall",
          runId: event.run.id,
          status,
          command: formatMcpToolCommand(server, tool, item?.arguments),
          output,
          server,
          tool,
          errorMessage: errorMessage || undefined,
        },
      });
      return;
    }

    if (itemType === "web_search" && (type === "item.started" || type === "item.completed")) {
      const status = typeof item?.status === "string" ? item.status : (type === "item.started" ? "in_progress" : "completed");
      const query = typeof item?.query === "string" ? item.query : "";
      this.messageStore.upsertGeneratedMessage(sessionId, {
        id: `${event.run.id}_${itemId}_web_search`,
        clientMessageId: null,
        runId: event.run.id,
        role: "tool",
        kind: "tool",
        title: "Tool",
        text: query ? `Web search: ${query}` : "Web search",
        createdAt: event.run.updatedAt,
        deliveryStatus: type === "item.started" || status === "in_progress" ? "streaming" : "sent",
        attachments: [],
        meta: {
          type: "websearch",
          runId: event.run.id,
          status,
          command: formatWebSearchCommand(item || {}),
          output: stringifyToolValue(item?.action),
          query,
        },
      });
      return;
    }

    if (itemType === "file_change" && (type === "item.started" || type === "item.completed")) {
      const changes = parseRunFileChanges(item || {});
      const primaryPath = changes[0]?.path || (typeof item?.path === "string" ? item.path : "file change");
      const status = typeof item?.status === "string" ? item.status : (type === "item.started" ? "in_progress" : "completed");
      const label = changes.length > 1 ? `${primaryPath} +${changes.length - 1} more` : primaryPath;
      this.messageStore.upsertGeneratedMessage(sessionId, {
        id: `${event.run.id}_${itemId}_file_change`,
        clientMessageId: null,
        runId: event.run.id,
        role: "tool",
        kind: "tool",
        title: "Tool",
        text: `${status}: ${label}`,
        createdAt: event.run.updatedAt,
        deliveryStatus: type === "item.started" || status === "in_progress" ? "streaming" : "sent",
        attachments: [],
        meta: {
          type: "filechange",
          runId: event.run.id,
          status,
          fileChanges: changes,
          errorMessage: typeof item?.error_message === "string" ? item.error_message : undefined,
          path: typeof item?.path === "string" ? item.path : undefined,
          durationMs: typeof item?.duration_ms === "number" ? item.duration_ms : undefined,
        },
      });
      return;
    }

    if (itemType === "error") {
      const message = typeof item?.message === "string" ? item.message : "Unknown error";
      this.messageStore.upsertGeneratedMessage(sessionId, {
        id: `${event.run.id}_${itemId}_error`,
        clientMessageId: null,
        runId: event.run.id,
        role: "error",
        kind: "error",
        title: "Error",
        text: message,
        createdAt: event.run.updatedAt,
        deliveryStatus: "failed",
        attachments: [],
        meta: { runId: event.run.id, errorMessage: message },
      });
    }
  }
}

const { defaultWorkspace, options: configWorkspaceOptions } = resolveConfigWorkspaces();
let uiState = loadPersistedUiState(defaultWorkspace);

const app = express();
app.use(express.json({ limit: "5mb" }));
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

const taskManagerStore = new TaskManagerStore();

function extractTaskManagerSession(req: express.Request): TaskManagerSession | null {
  const token = extractAuthToken(req);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, TASK_MANAGER_JWT_SECRET);
    if (!isRecord(decoded) || decoded.scope !== "taskmanager") return null;
    const userId = typeof decoded.sub === "string" ? decoded.sub : "";
    const role = decoded.role === "admin" || decoded.role === "user" ? decoded.role : null;
    const username = typeof decoded.username === "string" ? decoded.username : "";
    if (!userId || !role || !username) return null;
    return { userId, role, username };
  } catch {
    return null;
  }
}

function requireTaskManagerAuth(req: TaskManagerRequest, res: express.Response, next: express.NextFunction): void {
  const session = extractTaskManagerSession(req);
  if (!session || !taskManagerStore.getSessionUser(session)) {
    res.status(401).json(apiErr("Unauthorized"));
    return;
  }
  req.taskUser = session;
  next();
}

function requireTaskManagerAdmin(req: TaskManagerRequest, res: express.Response, next: express.NextFunction): void {
  if (req.taskUser?.role !== "admin") {
    res.status(403).json(apiErr("Admin access is required."));
    return;
  }
  next();
}

function taskSession(req: TaskManagerRequest): TaskManagerSession {
  if (!req.taskUser) throw new Error("Unauthorized");
  return req.taskUser;
}

app.post("/api/taskmanager/auth/login", (req, res) => {
  const parsed = taskManagerLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid login payload."));
    return;
  }
  const result = taskManagerStore.authenticate(parsed.data.username, parsed.data.password);
  if (!result) {
    res.status(401).json(apiErr("Invalid username or password."));
    return;
  }
  res.json(apiOk(result));
});

app.get("/api/taskmanager/bootstrap", requireTaskManagerAuth, (req: TaskManagerRequest, res) => {
  try {
    res.json(apiOk(taskManagerStore.bootstrap(taskSession(req))));
  } catch (error) {
    res.status(401).json(apiErr(error instanceof Error ? error.message : "Unauthorized"));
  }
});

app.get("/api/taskmanager/reports/today", requireTaskManagerAuth, (req: TaskManagerRequest, res) => {
  try {
    const timeZone =
      typeof req.query.timezone === "string"
        ? req.query.timezone
        : typeof req.query.timeZone === "string"
          ? req.query.timeZone
          : undefined;
    const onlyMine = req.query.onlyMine === "1" || req.query.onlyMine === "true";
    const assigneeId = typeof req.query.assigneeId === "string" && req.query.assigneeId.trim() ? req.query.assigneeId.trim() : undefined;
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim() ? req.query.projectId.trim() : undefined;
    const result = taskManagerStore.todayReport(taskSession(req), { timeZone, onlyMine, assigneeId, projectId });

    if (req.query.format === "json") {
      res.json(apiOk(result));
      return;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(result.report);
  } catch (error) {
    res.status(400).json(apiErr(error instanceof Error ? error.message : "Unable to build today report."));
  }
});

app.patch("/api/taskmanager/profile", requireTaskManagerAuth, (req: TaskManagerRequest, res) => {
  const parsed = updateTaskManagerProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid profile payload."));
    return;
  }
  try {
    res.json(apiOk({ user: taskManagerStore.updateProfile(taskSession(req), parsed.data) }));
  } catch (error) {
    res.status(400).json(apiErr(error instanceof Error ? error.message : "Unable to update profile."));
  }
});

app.post("/api/taskmanager/users", requireTaskManagerAuth, requireTaskManagerAdmin, (req, res) => {
  const parsed = createTaskManagerUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid user payload."));
    return;
  }
  try {
    res.json(apiOk({ user: taskManagerStore.createUser(parsed.data) }));
  } catch (error) {
    res.status(400).json(apiErr(error instanceof Error ? error.message : "Unable to create user."));
  }
});

app.patch("/api/taskmanager/users/:id", requireTaskManagerAuth, requireTaskManagerAdmin, (req, res) => {
  const parsed = updateTaskManagerUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid user payload."));
    return;
  }
  try {
    res.json(apiOk({ user: taskManagerStore.updateUser(req.params.id, parsed.data) }));
  } catch (error) {
    res.status(404).json(apiErr(error instanceof Error ? error.message : "Unable to update user."));
  }
});

app.post("/api/taskmanager/projects", requireTaskManagerAuth, (req: TaskManagerRequest, res) => {
  const parsed = createTaskManagerProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid project payload."));
    return;
  }
  res.json(apiOk({ project: taskManagerStore.createProject(parsed.data, taskSession(req).userId) }));
});

app.patch("/api/taskmanager/projects/:id", requireTaskManagerAuth, (req, res) => {
  const parsed = updateTaskManagerProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid project payload."));
    return;
  }
  try {
    res.json(apiOk({ project: taskManagerStore.updateProject(req.params.id, parsed.data, taskSession(req)) }));
  } catch (error) {
    res.status(404).json(apiErr(error instanceof Error ? error.message : "Unable to update project."));
  }
});

app.delete("/api/taskmanager/projects/:id", requireTaskManagerAuth, (req, res) => {
  try {
    res.json(apiOk(taskManagerStore.deleteProject(req.params.id)));
  } catch (error) {
    res.status(404).json(apiErr(error instanceof Error ? error.message : "Unable to delete project."));
  }
});

app.post("/api/taskmanager/labels", requireTaskManagerAuth, (req, res) => {
  const parsed = createTaskManagerLabelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid label payload."));
    return;
  }
  res.json(apiOk({ label: taskManagerStore.createLabel(parsed.data) }));
});

app.post("/api/taskmanager/tasks", requireTaskManagerAuth, (req: TaskManagerRequest, res) => {
  const parsed = createTaskManagerTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid task payload."));
    return;
  }
  res.json(apiOk({ task: taskManagerStore.createTask(parsed.data, taskSession(req).userId) }));
});

app.patch("/api/taskmanager/tasks/:id", requireTaskManagerAuth, (req: TaskManagerRequest, res) => {
  const parsed = updateTaskManagerTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid task payload."));
    return;
  }
  try {
    res.json(apiOk({ task: taskManagerStore.updateTask(req.params.id, parsed.data, taskSession(req)) }));
  } catch (error) {
    res.status(404).json(apiErr(error instanceof Error ? error.message : "Unable to update task."));
  }
});

app.delete("/api/taskmanager/tasks/:id", requireTaskManagerAuth, (req: TaskManagerRequest, res) => {
  try {
    res.json(apiOk(taskManagerStore.deleteTask(req.params.id, taskSession(req))));
  } catch (error) {
    res.status(404).json(apiErr(error instanceof Error ? error.message : "Unable to delete task."));
  }
});

app.post("/api/taskmanager/tasks/:id/comments", requireTaskManagerAuth, (req: TaskManagerRequest, res) => {
  const parsed = createTaskManagerCommentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid comment payload."));
    return;
  }
  try {
    res.json(apiOk({ comment: taskManagerStore.createComment(req.params.id, parsed.data.body, taskSession(req)) }));
  } catch (error) {
    res.status(404).json(apiErr(error instanceof Error ? error.message : "Unable to create comment."));
  }
});

app.post("/api/auth/login", (req, res) => {
  if (!AUTH_ENABLED) {
    res.status(503).json(apiErr("Password auth is not configured on server."));
    return;
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) {
    res.status(400).json(apiErr("Password is required."));
    return;
  }

  if (password !== AUTH_PASSWORD) {
    res.status(401).json(apiErr("Invalid password."));
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresIn = Math.max(60, AUTH_TOKEN_TTL_SECONDS);
  const token = jwt.sign(
    {
      sub: "luma-assistant-user",
      iat: nowSeconds,
    },
    JWT_SECRET,
    { expiresIn },
  );
  res.json(
    apiOk({
      token,
      expiresAt: (nowSeconds + expiresIn) * 1000,
      expiresInSeconds: expiresIn,
    }),
  );
});

app.use(requireAuth);

const runManager = new RunManager(CODEX_PATH);
const persisted = loadPersistedRuns();
runManager.loadPersisted(persisted.runs, persisted.approvals);
const sseClients = new Set<express.Response>();
function broadcastSse(event: SseEvent): void {
  const data = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(data);
}

const messageStore = new MessageStore((event) => broadcastSse(event));
messageStore.loadOrBackfill(runManager.getRuns(false));

let outboxProcessor: OutboxProcessor | null = null;
const messageProjector = new MessageProjector(messageStore, {
  remapSession(previousSessionId: string, nextSessionId: string, runId?: string | null): void {
    outboxProcessor?.remapSession(previousSessionId, nextSessionId, runId);
  },
  handleRunFinished(runId: string): void {
    outboxProcessor?.handleRunFinished(runId);
  },
});

outboxProcessor = new OutboxProcessor(
  runManager,
  messageStore,
  (event) => broadcastSse(event),
  (item, run) => {
    messageProjector.registerRun(run.id, item.sessionId);
  },
);

const terminalManager = new TerminalManager(() => uiState.activeWorkspace);
let latestSkillSyncResult = syncRepoSkills();
const agentScheduleManager = new AgentScheduleManager(runManager, (schedule, prompt, execution) => {
  const sessionId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const message = messageStore.acceptOutgoingMessage(sessionId, {
    clientMessageId: execution.id,
    sessionId,
    text: prompt,
    runner: schedule.runConfig.runner,
    workspace: schedule.runConfig.workspace,
    model: schedule.runConfig.model,
    sandbox: schedule.runConfig.sandbox,
    approvalPolicy: schedule.runConfig.approvalPolicy,
    reasoningEffort: schedule.runConfig.reasoningEffort,
    planMode: false,
    attachments: [],
    skills: schedule.runConfig.skills,
    agents: [],
  });

  try {
    const run = runManager.startRun({
      runner: schedule.runConfig.runner,
      workspace: schedule.runConfig.workspace,
      prompt,
      model: schedule.runConfig.model,
      reasoningEffort: schedule.runConfig.reasoningEffort,
      sandbox: schedule.runConfig.sandbox,
      approvalPolicy: schedule.runConfig.approvalPolicy,
      planMode: false,
      attachments: [],
      skills: schedule.runConfig.skills,
      agents: [],
    });
    messageProjector.registerRun(run.id, sessionId);
    messageStore.updateSessionFromRun(run, sessionId);
    messageStore.bindMessageToRun(sessionId, message.id, run.id);
    messageStore.markMessageSent(sessionId, message.id);
    return { run, sessionId };
  } catch (error) {
    messageStore.markMessageFailed(sessionId, message.id, error instanceof Error ? error.message : "Failed to start scheduled run");
    throw error;
  }
});
agentScheduleManager.load();

runManager.on("sse", (event: SseEvent) => {
  broadcastSse(event);
});
runManager.on("run.lifecycle", (event: RunLifecycleEvent) => {
  messageProjector.onLifecycle(event);
  agentScheduleManager.onRunLifecycle(event);
});
runManager.on("run.parsed", (event: RunParsedEvent) => {
  messageProjector.onParsed(event);
});
terminalManager.on("sse", (event: SseEvent) => {
  broadcastSse(event);
});

setInterval(() => {
  const evt: SseEvent = { kind: "heartbeat", at: Date.now() };
  broadcastSse(evt);
}, 10000);

function apiOk<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function apiErr(message: string): ApiResponse<never> {
  return { ok: false, error: { message } };
}

function extractAuthToken(req: express.Request): string | null {
  const auth = req.header("authorization") || req.header("Authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }

  const queryToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (queryToken) return queryToken;

  return null;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!AUTH_ENABLED) {
    next();
    return;
  }

  if (req.path === "/api/auth/login") {
    next();
    return;
  }

  const token = extractAuthToken(req);
  if (!token) {
    res.status(401).json(apiErr("Unauthorized"));
    return;
  }

  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json(apiErr("Unauthorized"));
  }
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
      runner: DEFAULT_RUNNER,
      model: DEFAULT_MODEL,
      codexModel: DEFAULT_CODEX_MODEL,
      claudeModel: DEFAULT_CLAUDE_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      sandbox: DEFAULT_SANDBOX as "read-only" | "workspace-write" | "danger-full-access",
    },
    activeWorkspace: uiState.activeWorkspace,
    workspaces: getWorkspaces(),
    runs: runManager.getRuns(false),
    approvals: runManager.getApprovals(),
  };
  res.json(apiOk(payload));
});

app.get("/api/bootstrap-lite", (_req, res) => {
  const payload: AppBootstrapLite = {
    defaults: {
      runner: DEFAULT_RUNNER,
      model: DEFAULT_MODEL,
      codexModel: DEFAULT_CODEX_MODEL,
      claudeModel: DEFAULT_CLAUDE_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      sandbox: DEFAULT_SANDBOX as "read-only" | "workspace-write" | "danger-full-access",
    },
    activeWorkspace: uiState.activeWorkspace,
    workspaces: getWorkspaces(),
    approvals: runManager.getApprovals(),
  };
  res.json(apiOk(payload));
});

app.get("/api/skills", (req, res) => {
  latestSkillSyncResult = syncRepoSkills();
  const requestedWorkspace = typeof req.query.workspace === "string" && req.query.workspace.trim()
    ? req.query.workspace.trim()
    : uiState.activeWorkspace;
  const workspace = path.resolve(requestedWorkspace);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    res.status(400).json(apiErr("Workspace does not exist"));
    return;
  }

  const payload: SkillListResponse = {
    skills: discoverSkills(workspace),
  };
  res.json(apiOk(payload));
});

app.get("/api/agents", (_req, res) => {
  latestSkillSyncResult = syncRepoSkills();
  const payload: AgentListResponse = {
    agents: publicAgents(),
    skillSync: latestSkillSyncResult,
  };
  res.json(apiOk(payload));
});

app.post("/api/agents/reload", (_req, res) => {
  latestSkillSyncResult = syncRepoSkills();
  const schedules = agentScheduleManager.list();
  const payload: AgentScheduleListResponse = {
    agents: publicAgents(),
    schedules: schedules.schedules,
    upcoming: schedules.upcoming,
    executions: schedules.executions,
    skillSync: latestSkillSyncResult,
  };
  res.json(apiOk(payload));
});

app.get("/api/agent-schedules", (_req, res) => {
  const schedules = agentScheduleManager.list();
  const payload: AgentScheduleListResponse = {
    agents: publicAgents(),
    schedules: schedules.schedules,
    upcoming: schedules.upcoming,
    executions: schedules.executions,
    skillSync: latestSkillSyncResult,
  };
  res.json(apiOk(payload));
});

app.post("/api/agent-schedules", (req, res) => {
  const parsed = createAgentScheduleSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid schedule payload"));
    return;
  }

  const workspace = path.resolve(parsed.data.workspace || uiState.activeWorkspace);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    res.status(400).json(apiErr("Workspace does not exist"));
    return;
  }

  let selectedSkills: SelectedSkillRef[] = [];
  try {
    selectedSkills = resolveSelectedSkills(workspace, parsed.data.skills).map((skill) => ({
      id: skill.item.id,
      path: skill.item.path,
    }));
  } catch (error) {
    if (error instanceof SkillResolutionError) {
      res.status(400).json(apiErr(error.message));
      return;
    }
    res.status(500).json(apiErr(error instanceof Error ? error.message : "Failed to resolve selected skills"));
    return;
  }

  try {
    const schedule = agentScheduleManager.create({
      agentId: parsed.data.agentId,
      hour: parsed.data.hour,
      minute: parsed.data.minute,
      runner: parsed.data.runner,
      workspace,
      model: parsed.data.model,
      reasoningEffort: parsed.data.reasoningEffort,
      sandbox: parsed.data.sandbox,
      approvalPolicy: parsed.data.approvalPolicy,
      skills: selectedSkills,
    });
    res.json(apiOk({ schedule }));
  } catch (error) {
    res.status(400).json(apiErr(error instanceof Error ? error.message : "Failed to create schedule"));
  }
});

app.patch("/api/agent-schedules/:id", (req, res) => {
  const parsed = updateAgentScheduleSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid schedule payload"));
    return;
  }

  const schedule = agentScheduleManager.updateStatus(req.params.id, parsed.data.status);
  if (!schedule) {
    res.status(404).json(apiErr("Schedule not found"));
    return;
  }
  res.json(apiOk({ schedule }));
});

app.delete("/api/agent-schedules/:id", (req, res) => {
  const deleted = agentScheduleManager.delete(req.params.id);
  if (!deleted) {
    res.status(404).json(apiErr("Schedule not found"));
    return;
  }
  res.json(apiOk({ deleted: true }));
});

app.post("/api/agent-schedules/:id/run-now", (req, res) => {
  const execution = agentScheduleManager.runNow(req.params.id);
  if (!execution) {
    res.status(404).json(apiErr("Schedule not found"));
    return;
  }
  res.json(apiOk({ execution }));
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

app.get("/api/sessions/list", (req, res) => {
  const limit = clampListLimit(req.query.limit, SESSION_LIST_PAGE_DEFAULT, SESSION_LIST_PAGE_MAX);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const includeHistory = req.query.includeHistory === "1" || req.query.includeHistory === "true";
  const startedAt = Date.now();
  const payload = sliceRunListItems(readSessionListItems(includeHistory), limit, cursor);
  const response: SessionListResponse = {
    items: payload.items,
    nextCursor: payload.nextCursor,
    approvals: runManager.getApprovals(),
  };
  if (process.env.MESSAGE_PERF_LOG === "1") {
    // eslint-disable-next-line no-console
    console.log(`[luma-assistant/message-perf] sessions.list durationMs=${Date.now() - startedAt} payloadBytes=${Buffer.byteLength(JSON.stringify(response))}`);
  }
  res.json(apiOk(response));
});

app.get("/api/runs/list", (req, res) => {
  const limit = clampListLimit(req.query.limit);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const includeHistory = req.query.includeHistory === "1" || req.query.includeHistory === "true";
  const payload = sliceRunListItems(readRunListItems(includeHistory), limit, cursor);
  res.json(apiOk({ ...payload, approvals: runManager.getApprovals() }));
});

app.post("/api/attachments", express.raw({ limit: ATTACHMENT_MAX_BYTES, type: () => true }), (req, res) => {
  const workspaceRaw = typeof req.query.workspace === "string" && req.query.workspace.trim()
    ? req.query.workspace
    : uiState.activeWorkspace;
  const workspace = path.resolve(workspaceRaw);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    res.status(400).json(apiErr("Workspace does not exist"));
    return;
  }

  const rawNameHeader = req.header("x-attachment-name") || "";
  let decodedName = rawNameHeader;
  try {
    decodedName = decodeURIComponent(rawNameHeader);
  } catch {
    decodedName = rawNameHeader;
  }

  const displayName = path.basename(decodedName || "").trim() || "attachment";
  const mimeType = normalizeMimeType(req.header("x-attachment-content-type") || req.header("content-type") || undefined);
  const kind = classifyAttachment(displayName, mimeType);
  if (!kind) {
    res.status(400).json(apiErr("Unsupported attachment type. Use an image or a text/code file."));
    return;
  }

  const body = Buffer.isBuffer(req.body) ? req.body : null;
  if (!body || body.byteLength === 0) {
    res.status(400).json(apiErr("Attachment body is required"));
    return;
  }

  const attachmentId = `attachment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const relativePath = createStoredAttachmentRelativePath(workspace, attachmentId, displayName);
  const absolutePath = resolveStoredAttachmentPath(workspace, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, body);

  const attachment: AttachmentRef = {
    id: attachmentId,
    name: displayName,
    mimeType,
    size: body.byteLength,
    kind,
    relativePath,
    uploadedAt: Date.now(),
  };

  res.json(apiOk({ attachment }));
});

app.post("/api/attachments/content", (req, res) => {
  const parsed = attachmentRefSchema.safeParse(req.body?.attachment);
  if (!parsed.success || parsed.data.kind !== "image") {
    res.status(400).json(apiErr("A valid image attachment is required."));
    return;
  }

  const attachment = parsed.data;
  const storage = attachment.storage || "workspace";
  try {
    const absolutePath = storage === "luma"
      ? resolveStoredSessionImagePath(attachment.relativePath)
      : resolveStoredAttachmentPath(path.resolve(String(req.body?.workspace || uiState.activeWorkspace)), attachment.relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      res.status(404).json(apiErr("Image attachment not found."));
      return;
    }
    const buffer = fs.readFileSync(absolutePath);
    const mimeType = storage === "luma"
      ? validateImageGuardrails(buffer).mimeType
      : imageMimeFromBuffer(buffer);
    if (!mimeType) {
      res.status(400).json(apiErr("Unsupported image type. Use PNG, JPEG, WebP, or GIF."));
      return;
    }
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(buffer.byteLength));
    res.setHeader("Cache-Control", "private, max-age=300");
    if (req.body?.download === true) {
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizeAttachmentName(attachment.name)}"`);
    }
    res.end(buffer);
  } catch (error) {
    res.status(400).json(apiErr(error instanceof Error ? error.message : "Unable to read image attachment."));
  }
});

app.post("/api/session-images", (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64.trim() : "";
  const requestedName = typeof body.name === "string" ? body.name.trim() : "image";
  const caption = typeof body.caption === "string" ? body.caption.trim().slice(0, 4000) : "";
  const alt = typeof body.alt === "string" ? body.alt.trim().slice(0, 500) : "";
  if (!sessionId) {
    res.status(400).json(apiErr("sessionId is required."));
    return;
  }
  const localSession = messageStore.getLocalSession(sessionId);
  if (!localSession) {
    res.status(404).json(apiErr("Session not found."));
    return;
  }
  if (!dataBase64) {
    res.status(400).json(apiErr("dataBase64 is required."));
    return;
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, "base64");
  } catch {
    res.status(400).json(apiErr("Invalid base64 image data."));
    return;
  }

  try {
    const metadata = validateImageGuardrails(buffer);
    const extension = metadata.mimeType === "image/jpeg" ? ".jpg" : `.${metadata.mimeType.split("/")[1] || "png"}`;
    const displayName = sanitizeAttachmentName(requestedName || `image${extension}`);
    const nameWithExtension = path.extname(displayName) ? displayName : `${displayName}${extension}`;
    const attachmentId = `image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const relativePath = createStoredSessionImageRelativePath(attachmentId, nameWithExtension);
    const absolutePath = resolveStoredSessionImagePath(relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, buffer);

    const attachment: AttachmentRef = {
      id: attachmentId,
      name: nameWithExtension,
      mimeType: metadata.mimeType,
      size: buffer.byteLength,
      kind: "image",
      relativePath,
      uploadedAt: Date.now(),
      storage: "luma",
      width: metadata.width,
      height: metadata.height,
      alt: alt || caption || nameWithExtension,
    };
    const createdAt = Date.now();
    const message = messageStore.upsertGeneratedMessage(sessionId, {
      id: `image_msg_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
      clientMessageId: null,
      runId: null,
      role: "assistant",
      kind: "message",
      title: "Assistant",
      text: caption || `Image: ${nameWithExtension}`,
      createdAt,
      deliveryStatus: "sent",
      attachments: [attachment],
    });
    res.json(apiOk({ sessionId, attachment, message }));
  } catch (error) {
    res.status(400).json(apiErr(error instanceof Error ? error.message : "Unable to publish image."));
  }
});

app.post("/api/messages/send", (req, res) => {
  const parsed = sendMessageSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json(apiErr(parsed.error.issues[0]?.message || "Invalid message payload"));
    return;
  }

  const workspace = path.resolve(parsed.data.workspace || uiState.activeWorkspace);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    res.status(400).json(apiErr("Workspace does not exist"));
    return;
  }

  let selectedSkills: SelectedSkillRef[] = [];
  let selectedAgents: SelectedAgentRef[] = [];
  try {
    selectedSkills = resolveSelectedSkills(workspace, parsed.data.skills).map((skill) => ({
      id: skill.item.id,
      path: skill.item.path,
    }));
    selectedAgents = resolveSelectedAgents(parsed.data.agents).map((agent) => ({
      id: agent.item.id,
      path: agent.item.path,
    }));
  } catch (error) {
    if (error instanceof SkillResolutionError) {
      res.status(400).json(apiErr(error.message));
      return;
    }
    if (error instanceof AgentResolutionError) {
      res.status(400).json(apiErr(error.message));
      return;
    }
    res.status(500).json(apiErr(error instanceof Error ? error.message : "Failed to resolve selected context"));
    return;
  }

  const startedAt = Date.now();
  const sessionId = parsed.data.sessionId?.trim() || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const provisionalSession = !parsed.data.sessionId?.trim();
  const acceptedMessage = messageStore.acceptOutgoingMessage(sessionId, {
    ...parsed.data,
    workspace,
    runner: parsed.data.runner,
    skills: selectedSkills,
    agents: selectedAgents,
  });

  outboxProcessor?.enqueue({
    sessionId,
    provisionalSession,
    messageId: acceptedMessage.id,
    clientMessageId: parsed.data.clientMessageId,
    text: parsed.data.text,
    attachments: normalizeAttachmentRefs(parsed.data.attachments),
    workspace,
    runner: parsed.data.runner,
    model: parsed.data.model,
    reasoningEffort: parsed.data.reasoningEffort,
    sandbox: parsed.data.sandbox,
    approvalPolicy: parsed.data.approvalPolicy,
    planMode: parsed.data.planMode,
    skills: selectedSkills,
    agents: selectedAgents,
  });

  const response: SendMessageAccepted = {
    sessionId,
    message: acceptedMessage,
    queueStatus: "accepted",
    latestRunId: messageStore.getLocalSession(sessionId)?.latestRunId || null,
  };

  broadcastSse({
    kind: "message.ack",
    at: Date.now(),
    sessionId,
    payload: {
      message: acceptedMessage as unknown as Record<string, unknown>,
      queueStatus: response.queueStatus,
      latestRunId: response.latestRunId,
    },
  });

  if (process.env.MESSAGE_PERF_LOG === "1") {
    // eslint-disable-next-line no-console
    console.log(`[luma-assistant/message-perf] messages.send ackMs=${Date.now() - startedAt}`);
  }

  res.json(apiOk(response));
});

app.post("/api/messages/:messageId/retry", (req, res) => {
  const retried = outboxProcessor?.retryFailedMessage(req.params.messageId);
  if (!retried) {
    res.status(404).json(apiErr("Failed message not found or is not retryable"));
    return;
  }

  res.json(apiOk({ messageId: retried.messageId, sessionId: retried.sessionId, queued: true }));
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
      runner: parsed.data.runner,
      workspace,
      prompt: parsed.data.prompt,
      model: parsed.data.model,
      reasoningEffort: parsed.data.reasoningEffort,
      sandbox: parsed.data.sandbox,
      approvalPolicy: parsed.data.approvalPolicy,
      planMode: parsed.data.planMode,
      sessionId: parsed.data.sessionId,
      attachments: parsed.data.attachments,
      skills: parsed.data.skills,
      agents: parsed.data.agents,
    });

    res.json(apiOk({ run }));
  } catch (error) {
    res.status(error instanceof SkillResolutionError || error instanceof AgentResolutionError ? 400 : 409).json(apiErr(error instanceof Error ? error.message : "Failed to start run"));
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
    res.status(error instanceof SkillResolutionError || error instanceof AgentResolutionError ? 400 : 409).json(apiErr(error instanceof Error ? error.message : "Failed to rerun"));
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

  if (approval.kind === "claude_permission") {
    res.json(apiOk({ run: baseRun, approval }));
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
    res.status(error instanceof SkillResolutionError || error instanceof AgentResolutionError ? 400 : 409).json(apiErr(error instanceof Error ? error.message : "Failed to run escalation"));
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

app.get("/api/runs/:runId/messages", (req, res) => {
  const before = typeof req.query.before === "string" ? req.query.before : null;
  const payload = loadPaginatedRunMessages(req.params.runId, before);
  if (!payload) {
    res.status(404).json(apiErr("Run messages not found"));
    return;
  }
  res.json(apiOk({ runId: req.params.runId, ...payload }));
});

app.get("/api/sessions/:sessionId/token-usage", (req, res) => {
  const payload: SessionTokenUsageResponse = {
    usage: runManager.getSessionTokenUsage(req.params.sessionId),
  };
  res.json(apiOk(payload));
});

app.get("/api/sessions/:sessionId/messages", (req, res) => {
  const limit = clampListLimit(req.query.limit, SESSION_MESSAGE_PAGE_SIZE, SESSION_MESSAGE_PAGE_SIZE);
  const before = typeof req.query.before === "string" ? req.query.before : null;
  const startedAt = Date.now();
  const payload = messageStore.getMessagesPage(req.params.sessionId, before, limit);
  if (payload) {
    if (process.env.MESSAGE_PERF_LOG === "1") {
      // eslint-disable-next-line no-console
      console.log(`[luma-assistant/message-perf] sessions.messages durationMs=${Date.now() - startedAt} payloadBytes=${Buffer.byteLength(JSON.stringify(payload))}`);
    }
    res.json(apiOk(payload));
    return;
  }

  const transcript = loadCodexSessionTranscript(req.params.sessionId);
  if (!transcript) {
    res.status(404).json(apiErr("Session messages not found"));
    return;
  }

  const historyMessages = transcriptToChatMessages(req.params.sessionId, transcript);
  const { start, end: safeEnd } = resolveCountedPageWindow(
    historyMessages,
    before,
    limit,
    (message) => message.kind !== "tool" && message.role !== "tool",
  );
  const response: SessionMessagesResponse = {
    sessionId: req.params.sessionId,
    messages: historyMessages.slice(start, safeEnd),
    nextCursor: start > 0 ? encodeCursor(start) : null,
    latestRunId: null,
  };
  if (process.env.MESSAGE_PERF_LOG === "1") {
    // eslint-disable-next-line no-console
    console.log(`[luma-assistant/message-perf] sessions.messages durationMs=${Date.now() - startedAt} payloadBytes=${Buffer.byteLength(JSON.stringify(response))}`);
  }
  res.json(apiOk(response));
});

app.post("/api/sessions/:sessionId/archive", (req, res) => {
  try {
    const result = runManager.archiveSession(req.params.sessionId);
    if (!result) {
      res.status(404).json(apiErr("Session not found"));
      return;
    }
    messageStore.removeSession(req.params.sessionId);
    outboxProcessor?.removeSession(req.params.sessionId);
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
      const localSession = messageStore.getLocalSession(req.params.sessionId);
      if (!localSession || localSession.historyOnly) {
        res.status(404).json(apiErr("Session not found"));
        return;
      }

      messageStore.removeSession(req.params.sessionId);
      outboxProcessor?.removeSession(req.params.sessionId);
      terminalManager.removeSession(req.params.sessionId);
      res.json(apiOk({ sessionId: req.params.sessionId, removedRuns: 0, removedApprovals: 0 }));
      return;
    }
    messageStore.removeSession(req.params.sessionId);
    outboxProcessor?.removeSession(req.params.sessionId);
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
    source: LOCAL_SESSION_SOURCE,
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
    const winner = nextTime > currentTime || (nextTime === currentTime && nextScore > existingScore)
      ? entry
      : existing;
    const summary = choosePreferredSessionSummary([existing, entry]);

    mergedById.set(entry.id, {
      ...winner,
      summary,
    });
  }

  const merged = [...mergedById.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  res.json(apiOk({ entries: merged }));
});

app.get("/api/sessions/:sessionId/history", (req, res) => {
  const transcript = loadCodexSessionTranscript(req.params.sessionId);
  if (!transcript) {
    res.status(404).json(apiErr("Session history not found"));
    return;
  }
  res.json(apiOk(transcript));
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

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (isRecord(error) && error.type === "entity.too.large") {
    res.status(413).json(apiErr(`Attachment exceeds the ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB limit.`));
    return;
  }

  next(error);
});

function flushPersistentStateSync(): void {
  runManager.flushPersistedStateSync();
  messageStore.flushSync();
  outboxProcessor?.flushSync();
  agentScheduleManager.flushSync();
  taskManagerStore.flushSync();
}

process.on("beforeExit", () => {
  flushPersistentStateSync();
});

process.on("SIGINT", () => {
  flushPersistentStateSync();
  process.exit(0);
});

process.on("SIGTERM", () => {
  flushPersistentStateSync();
  process.exit(0);
});

app.listen(API_PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[luma-assistant/server] listening on http://${HOST}:${API_PORT} | auth=${AUTH_ENABLED ? "enabled" : "disabled"}`,
  );
});
