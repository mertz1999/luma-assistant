import { ModelCatalogContext, ModelCatalogRefresh, ModelCatalogNotice, ModelEffortOptions, useModelCatalogState, useModelOptions } from "./lib/model-catalog";
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { VoiceSettings } from "@/components/VoiceSettings";
import { RemoteMacs, RemoteSidebar, RemoteConversation, RemoteConversationHeader, useRemoteWorkspace } from "@/components/RemoteMacs";
import { chatComposerClass, chatEntriesClass, chatHeaderClass, chatMessageAlignment, chatMessageClass, chatTimelineClass, MarkdownMessage, ThinkingDots } from "@/components/ChatPresentation";
import { SessionRows } from "@/components/SessionRows";
import { getSpeechSettings, speechSettingsQueryKey, useApiDictation } from "@/lib/speech";
import Convert from "ansi-to-html";
import {
  AtSign,
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  CircleStop,
  Copy,
  Download,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Laptop,
  Lock,
  Layers,
  ListFilter,
  LogOut,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  Moon,
  Maximize2,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  SquarePen,
  Sun,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type {
  AgentListItem,
  AgentSchedule,
  AgentScheduleExecution,
  ApprovalPolicy,
  AttachmentRef,
  ChatMessage,
  RunRecord,
  ReasoningEffort,
  RunRunner,
  RunSourceTag,
  SandboxMode,
  SelectedAgentRef,
  SendMessageInput,
  SessionListItem,
  SkillListItem,
  SelectedSkillRef,
  CursorModelInfo,
  TerminalSessionSnapshot,
  TokenUsageSummary,
  WorkspaceOption,
  SkillSyncResult,
} from "@luma/shared";
import {
  archiveSession,
  connectEvents,
  createAgentSchedule,
  deleteSession,
  deleteAgentSchedule,
  fetchAttachmentBlob,
  sendMessage,
  getAgentSchedules,
  getAccountStatus,
  getBootstrapLite,
  getCursorModels,
  getMcpStatus,
  getSkills,
  getSessionList,
  getSessionMessages,
  getSessionTokenUsage,
  getSystemStatus,
  getTerminal,
  interruptTerminal,
  loginWithPassword,
  recordCloudActivity,
  revokeCloudSession,
  reloadAgentsAndSkills,
  getRun,
  rerun,
  retryMessage,
  runAgentScheduleNow,
  setApiAuthToken,
  sendTerminalInput,
  setActiveWorkspace,
  startTerminal,
  stopRun,
  stopTerminal,
  updateAgentSchedule,
  uploadAttachment,
} from "@/lib/api";
import { parsePlanningMessage, type PlanningSegment } from "@/lib/planning";
import { createScreenWakeLockController } from "@/lib/screenWakeLock";
import { resolveTextDirection } from "@/lib/textDirection";
import { isDesktopLocal } from "@/lib/desktop";
import { ProjectsContext, useProjects, useProjectState } from "@/lib/projects";
import { moveSessionToProject } from "@/lib/projects-api";
import { ProjectSessionControls, ProjectMemoryDialog } from "@/components/ProjectMemory";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/useUiStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardContent } from "@/components/ui/card";
type StatusFilter = "all" | "running" | "completed" | "failed" | "stopped";
type SessionFilterValue = StatusFilter | "all-history";
type DockTab = "terminal" | "context";
type SidebarMode = "code" | "agents";
type BackendConnectionStatus = "connecting" | "connected" | "disconnected";

type DebugLogEntry = {
  key: string;
  runId: string;
  at: number;
  text: string;
};

type TimelineEntry = {
  key: string;
  messageId: string;
  clientMessageId: string | null;
  sessionId: string;
  role: ChatMessage["role"];
  kind: ChatMessage["kind"];
  title?: string;
  text: string;
  pending: boolean;
  at: number;
  sequence: number;
  deliveryStatus: ChatMessage["deliveryStatus"];
  attachments?: AttachmentRef[];
  meta?: ChatMessage["meta"];
};

type TimelineRenderBlock =
  | {
      kind: "entry";
      key: string;
      entry: TimelineEntry;
    }
  | {
      kind: "tool-group";
      key: string;
      entries: TimelineEntry[];
    };

type SessionCard = {
  projectId: string | null;
  id: string;
  sessionId: string;
  latestRunId: string | null;
  messageCount: number;
  lastMessagePreview: string;
  summary: string;
  status: SessionListItem["status"];
  updatedAt: number;
  runner: RunRunner;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sourceTag: RunSourceTag;
  sourceRaw: string;
  workspace: string;
  historyOnly: boolean;
  scheduled: boolean;
};

type PlanSessionState = "idle" | "armed" | "active";

const sandboxOptions: SandboxMode[] = isDesktopLocal ? ["read-only", "workspace-write"] : ["read-only", "workspace-write", "danger-full-access"];
const runnerOptions: RunRunner[] = ["codex", "claude", "cursor"];
function normalizeRunRunnerValue(input: unknown): RunRunner {
  if (input === "claude" || input === "cursor") return input;
  return "codex";
}

function defaultModelForRunner(
  runner: RunRunner,
  defaults: { codex: string; claude: string; cursor: string },
): string {
  if (runner === "claude") return defaults.claude;
  if (runner === "cursor") return defaults.cursor;
  return defaults.codex;
}

function runnerLabel(runner: RunRunner): string {
  if (runner === "claude") return "Claude Code";
  if (runner === "cursor") return "Cursor";
  return "Codex";
}

function cursorModelIdIncludesEffort(model: string): boolean {
  const base = model.replace(/\[[^\]]*\]\s*$/, "").trim().toLowerCase();
  return /(?:^|-)(?:none|minimal|low|medium|high|xhigh|extra-high|max)(?:-fast)?$/.test(base);
}

function cursorModelSupportsEffort(model: string, cursorModels: CursorModelInfo[]): boolean {
  const base = model.replace(/\[[^\]]*\]\s*$/, "").trim().toLowerCase();
  if (cursorModelIdIncludesEffort(base)) return false;
  const known = cursorModels.find((item) => item.id.toLowerCase() === base);
  if (known) return Boolean(known.supportsEffort);
  if (/^(auto|composer)/i.test(base)) return false;
  return true;
}

function reasoningEffortLabel(effort: ReasoningEffort): string {
  if (effort === "xhigh") return "extra high";
  if (effort === "max") return "max";
  return effort;
}
function isReasoningEffort(input: unknown): input is ReasoningEffort {
  return input === "low" || input === "medium" || input === "high" || input === "xhigh" || input === "max" || input === "ultra";
}
function compactSelectWidth(label: string): string {
  return `${Math.max(label.length + 2, 6)}ch`;
}
const draftSessionKey = "__draft__";
const runListPageSize = 60;
const sidebarListPageSize = 15;
const messagePageSize = 30;
const queueStorageKey = "luma_assistant_queue_v1";
const legacyQueueStorageKey = "agentic_cli_queue_v1";
const terminalHistoryStorageKey = "luma_assistant_terminal_history_v1";
const legacyTerminalHistoryStorageKey = "agentic_cli_terminal_history_v1";
const terminalHistoryLimit = 80;
const authSessionStorageKey = "luma_assistant_auth_session_v1";
const legacyAuthSessionStorageKey = "agentic_cli_auth_session_v1";
const authSessionMaxAgeMs = 48 * 60 * 60 * 1_000;
const cloudActivityIntervalMs = 60_000;
const planInstructionPath = "plan.md";
const attachmentMaxFiles = 10;
// Account for the chat stack gap and bottom padding so "visually at bottom"
// still counts as bottom without making the auto-follow area too large.
const timelineAutoScrollThresholdPx = 64;
const eventStreamHeartbeatStaleMs = 30000;
const eventStreamWatchdogIntervalMs = 10000;

type StoredAuthSession = {
  token: string;
  expiresAt: number;
  idleTimeoutMs?: number;
};

function getLocalStorageWithLegacy(primaryKey: string, legacyKey: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(primaryKey) || window.localStorage.getItem(legacyKey);
}

function removeLocalStorageWithLegacy(primaryKey: string, legacyKey: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(primaryKey);
  window.localStorage.removeItem(legacyKey);
}

type SlashCommandKey = "/mcp" | "/account" | "/status" | "/help" | "/speech" | "/plan";

type SlashCommandSuggestion = {
  key: SlashCommandKey;
  title: string;
  description: string;
};

type QueuedMessage = {
  deliveryError?: string;
  projectId?: string | null;
  id: string;
  sessionKey: string;
  prompt: string;
  attachments: AttachmentRef[];
  createdAt: number;
  workspace: string;
  runner: RunRunner;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  planMode: boolean;
  askMode: boolean;
  skills: SelectedSkillRef[];
  agents: SelectedAgentRef[];
};

type SpeechRecognitionAlternativeLike = {
  transcript?: string;
};

type SpeechRecognitionResultLike = ArrayLike<SpeechRecognitionAlternativeLike> & {
  isFinal?: boolean;
};

type SpeechRecognitionEventLike = Event & {
  resultIndex?: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

const slashCommandSuggestions: SlashCommandSuggestion[] = [
  { key: "/plan", title: "Planning workflow", description: "Enable the protected planning flow for your next message." },
  { key: "/status", title: "System status", description: "Show both account and MCP status." },
  { key: "/account", title: "Account status", description: "Show Codex account/login status." },
  { key: "/mcp", title: "MCP status", description: "Show configured MCP servers and auth status." },
  { key: "/speech", title: "Speech support", description: "Check Web Speech API availability in this browser." },
  { key: "/help", title: "Slash help", description: "List available slash commands." },
];

function normalizeSlashCommand(raw: string): SlashCommandKey | null {
  const lower = raw.toLowerCase();
  if (lower === "/plan") return "/plan";
  if (lower === "/status") return "/status";
  if (lower === "/account" || lower === "/account-status") return "/account";
  if (lower === "/mcp" || lower === "/mcp-status") return "/mcp";
  if (lower === "/speech" || lower === "/voice" || lower === "/mic" || lower === "/speech-status") return "/speech";
  if (lower === "/help" || lower === "/?") return "/help";
  return null;
}

function parseSlashCommand(rawPrompt: string): SlashCommandKey | null {
  const trimmed = rawPrompt.trim();
  if (!trimmed.startsWith("/")) return null;
  const commandToken = trimmed.split(/\s+/)[0];
  return normalizeSlashCommand(commandToken);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").trim();
}

function splitColumns(line: string): string[] {
  return line.trim().split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
}

function parseCliTables(raw: string): Array<{ headers: string[]; rows: string[][] }> {
  const blocks = raw
    .split(/\n\s*\n/)
    .map((block) => block.split(/\r?\n/).map((line) => line.trimRight()).filter(Boolean))
    .filter((lines) => lines.length >= 2);

  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  for (const lines of blocks) {
    const headers = splitColumns(lines[0]);
    if (!headers.length) continue;

    const rows = lines
      .slice(1)
      .map((line) => splitColumns(line))
      .filter((row) => row.length > 0);

    if (!rows.length) continue;
    tables.push({ headers, rows });
  }
  return tables;
}

function toMarkdownTable(headers: string[], rows: string[][]): string {
  const normalizedRows = rows.map((row) =>
    headers.map((_, index) => escapeMarkdownCell(row[index] || "-")),
  );
  const headerRow = `| ${headers.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = normalizedRows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [headerRow, divider, body].join("\n");
}

function formatTokenStatus(tokenStatus: { remainingTokens: number | null; note: string | null }): string {
  if (typeof tokenStatus.remainingTokens === "number") {
    return `Remaining tokens: **${tokenStatus.remainingTokens.toLocaleString()}**`;
  }
  return tokenStatus.note
    ? `Remaining tokens: unavailable\nNote: ${tokenStatus.note}`
    : "Remaining tokens: unavailable";
}

function formatStatusBlock(title: string, status: { ok: boolean; exitCode: number; stdout: string; stderr: string; command: string }, preferTable = false): string {
  const rawContent = status.stdout || status.stderr || "No output returned.";
  const statusLine = status.ok ? "ok" : `failed (exit ${status.exitCode})`;
  const tables = preferTable ? parseCliTables(rawContent) : [];

  if (!tables.length) {
    return `### ${title}\nStatus: ${statusLine}\nCommand: \`${status.command}\`\n\n\`\`\`text\n${rawContent}\n\`\`\``;
  }

  const renderedTables = tables
    .map((table, index) => {
      const sectionTitle = tables.length > 1
        ? `#### ${index === 0 ? "Local MCP servers" : "Remote MCP servers"}`
        : "#### MCP servers";
      return `${sectionTitle}\n${toMarkdownTable(table.headers, table.rows)}`;
    })
    .join("\n\n");

  return `### ${title}\nStatus: ${statusLine}\nCommand: \`${status.command}\`\n\n${renderedTables}`;
}

function buildSlashHelpText(): string {
  return [
    "Available slash commands:",
    ...slashCommandSuggestions.map((item) => `- \`${item.key}\` - ${item.description}`),
  ].join("\n");
}

function buildPlanModeEnabledText(): string {
  return [
    "Plan mode is enabled for the next message.",
    `The next request will ask the selected runner to read and follow \`${planInstructionPath}\`.`,
    "Planning turns stay read-only until final approval is granted.",
  ].join("\n\n");
}

function buildPlanUsageText(): string {
  return [
    "Use `/plan` by itself.",
    "Then send your actual request in the next message to start the planning workflow.",
  ].join("\n\n");
}

type PlanQuestionAnswer = {
  questionTitle: string;
  answer: string;
};

function buildPlanAnswersPrompt(answers: PlanQuestionAnswer[]): string {
  const lines = ["These are answers:"];
  answers.forEach((item, index) => {
    lines.push(`${index + 1}. Question: ${item.questionTitle}`);
    lines.push(`   Answer: ${item.answer}`);
  });
  return lines.join("\n");
}

function buildPlanFeedbackPrompt(feedback: string): string {
  return `Final approval not granted yet. Revise the plan with this feedback:\n${feedback}`;
}

function buildSpeechSupportText(): string {
  if (typeof window === "undefined") {
    return [
      "### Speech Recognition Check",
      "Expression: `window.SpeechRecognition || window.webkitSpeechRecognition`",
      "Supported: **no**",
      "Detected API: `none`",
      "Note: Browser runtime is not available here.",
    ].join("\n");
  }

  const hasSpeechRecognition = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const detectedApi = window.SpeechRecognition
    ? "window.SpeechRecognition"
    : window.webkitSpeechRecognition
      ? "window.webkitSpeechRecognition"
      : "none";

  return [
    "### Speech Recognition Check",
    "Expression: `window.SpeechRecognition || window.webkitSpeechRecognition`",
    `Supported: **${hasSpeechRecognition ? "yes" : "no"}**`,
    `Detected API: \`${detectedApi}\``,
    `Secure context: **${window.isSecureContext ? "yes" : "no"}**`,
    `URL: \`${window.location.origin}\``,
    hasSpeechRecognition
      ? "Result: Voice recording should be available."
      : "Result: This browser/context does not expose Web Speech API.",
  ].join("\n");
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
}

function normalizeTerminalCommand(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\n+$/g, "").trim();
}

function loadTerminalCommandHistory(): Record<string, string[]> {
  if (typeof window === "undefined") return {};

  try {
    const raw = getLocalStorageWithLegacy(terminalHistoryStorageKey, legacyTerminalHistoryStorageKey);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};

    const next: Record<string, string[]> = {};
    for (const [sessionId, commands] of Object.entries(parsed)) {
      if (!Array.isArray(commands) || !sessionId) continue;

      const normalized = commands
        .map((command) => (typeof command === "string" ? normalizeTerminalCommand(command) : ""))
        .filter((command) => Boolean(command))
        .slice(0, terminalHistoryLimit);

      if (normalized.length) next[sessionId] = normalized;
    }
    return next;
  } catch {
    return {};
  }
}

function loadStoredAuthSession(): StoredAuthSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = getLocalStorageWithLegacy(authSessionStorageKey, legacyAuthSessionStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;

    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0;
    if (!token || !expiresAt) return null;

    if (Date.now() >= expiresAt) return null;
    if (expiresAt - Date.now() > authSessionMaxAgeMs) return null;

    const idleTimeoutMs = typeof parsed.idleTimeoutMs === "number" ? parsed.idleTimeoutMs : undefined;
    return { token, expiresAt, idleTimeoutMs };
  } catch {
    return null;
  }
}

function loadQueuedMessages(): Record<string, QueuedMessage[]> {
  if (typeof window === "undefined") return {};

  try {
    const raw = getLocalStorageWithLegacy(queueStorageKey, legacyQueueStorageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};

    const next: Record<string, QueuedMessage[]> = {};
    for (const [sessionKey, queue] of Object.entries(parsed)) {
      if (!Array.isArray(queue)) continue;

      const normalized: QueuedMessage[] = [];
      for (const item of queue) {
        if (!isRecord(item)) continue;

        const id = typeof item.id === "string" ? item.id : "";
        const prompt = typeof item.prompt === "string" ? item.prompt : "";
        const workspace = typeof item.workspace === "string" ? item.workspace : "";
        const runner = normalizeRunRunnerValue(item.runner);
        const model = typeof item.model === "string" ? item.model : "";
        const reasoningEffort: ReasoningEffort = isReasoningEffort(item.reasoningEffort) ? item.reasoningEffort : "high";
        const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
        const planMode = typeof item.planMode === "boolean" ? item.planMode : false;
        const askMode = typeof item.askMode === "boolean" ? item.askMode : false;
        const attachments = readAttachmentRefs(item.attachments);
        const skills = readSelectedSkillRefs(item.skills);
        const agents = readSelectedAgentRefs(item.agents);

        if (!id || !prompt || !workspace || !model || !isSandboxMode(item.sandbox) || !isApprovalPolicy(item.approvalPolicy)) {
          continue;
        }

        normalized.push({
          projectId: typeof item.projectId === "string" ? item.projectId : item.projectId === null ? null : undefined,
          id,
          deliveryError: typeof item.deliveryError === "string" ? item.deliveryError : undefined,
          sessionKey,
          prompt,
          attachments,
          createdAt,
          workspace,
          runner,
          model,
          reasoningEffort,
          sandbox: item.sandbox,
          approvalPolicy: item.approvalPolicy,
          planMode,
          askMode,
          skills,
          agents,
        });
      }

      if (normalized.length) next[sessionKey] = normalized;
    }

    return next;
  } catch {
    return {};
  }
}

function runSessionId(run: RunRecord): string {
  return run.sessionId || run.threadId || run.id;
}

function describeSessionMeta(session: SessionCard): string {
  if (!session.historyOnly) {
    return session.lastMessagePreview || `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`;
  }

  const workspaceName = session.workspace.split(/[\\/]/).filter(Boolean).pop() || session.workspace;
  if (workspaceName) return workspaceName;
  return "External session";
}

function getSessionSourceBadge(session: SessionCard): { label: string; className: string } {
  if (session.sourceTag === "in-app") {
    if (session.runner === "claude") {
      return {
        label: "Claude",
        className: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
      };
    }
    if (session.runner === "cursor") {
      return {
        label: "Cursor",
        className: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200",
      };
    }
    return {
      label: "Codex",
      className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
    };
  }
  if (session.sourceTag === "vscode") {
    return {
      label: "vscode",
      className: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200",
    };
  }
  if (session.sourceTag === "cli") {
    return {
      label: "cli",
      className: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
    };
  }
  if (session.sourceTag === "exec") {
    return {
      label: "exec",
      className: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100",
    };
  }

  return {
    label: "other",
    className: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
  };
}

function buildSessionCards(items: SessionListItem[]): SessionCard[] {
  return items.map((item) => ({
    id: item.id,
    projectId: item.projectId || null,
    sessionId: item.id,
    latestRunId: item.latestRunId,
    messageCount: item.messageCount,
    lastMessagePreview: item.lastMessagePreview,
    summary: item.title,
    status: item.status,
    updatedAt: item.updatedAt,
    runner: normalizeRunRunnerValue(item.runner),
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    sourceTag: item.sourceTag,
    sourceRaw: item.sourceRaw,
    workspace: item.workspace,
    historyOnly: item.historyOnly,
    scheduled: Boolean(item.scheduled),
  }));
}

const sessionReviewStorageKey = "luma_session_reviews_v1";

type SessionReviews = {
  trackingSince: number;
  reviewedRunIds: Record<string, string>;
};

function loadSessionReviews(): SessionReviews {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(sessionReviewStorageKey) || "null");
    if (isRecord(stored) && typeof stored.trackingSince === "number" && isRecord(stored.reviewedRunIds)) {
      return {
        trackingSince: stored.trackingSince,
        reviewedRunIds: Object.fromEntries(
          Object.entries(stored.reviewedRunIds).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
      };
    }
  } catch {
    // The page can still track reviews if browser storage is unavailable.
  }
  return { trackingSince: Date.now(), reviewedRunIds: {} };
}

function needsSessionReview(session: SessionCard, reviews: SessionReviews): boolean {
  return !session.historyOnly
    && session.status === "completed"
    && session.latestRunId !== null
    && session.updatedAt >= reviews.trackingSince
    && reviews.reviewedRunIds[session.id] !== session.latestRunId;
}

function isProvisionalSessionId(sessionId: string): boolean {
  return sessionId.startsWith("local_");
}

function chooseCanonicalSessionItem(current: SessionListItem, candidate: SessionListItem): SessionListItem {
  const currentIsProvisional = isProvisionalSessionId(current.id);
  const candidateIsProvisional = isProvisionalSessionId(candidate.id);
  if (currentIsProvisional !== candidateIsProvisional) {
    return currentIsProvisional ? candidate : current;
  }

  if (current.historyOnly !== candidate.historyOnly) {
    return current.historyOnly ? candidate : current;
  }

  if (current.updatedAt !== candidate.updatedAt) {
    return current.updatedAt >= candidate.updatedAt ? current : candidate;
  }

  return current.messageCount >= candidate.messageCount ? current : candidate;
}

function normalizeSessionItems(items: SessionListItem[]): SessionListItem[] {
  const latestById = new Map<string, SessionListItem>();
  for (const item of items) {
    latestById.set(item.id, item);
  }

  const dedupedByRunId = new Map<string, SessionListItem>();
  const passthrough: SessionListItem[] = [];

  for (const item of latestById.values()) {
    if (!item.latestRunId) {
      passthrough.push(item);
      continue;
    }

    const existing = dedupedByRunId.get(item.latestRunId);
    if (!existing) {
      dedupedByRunId.set(item.latestRunId, item);
      continue;
    }

    dedupedByRunId.set(item.latestRunId, chooseCanonicalSessionItem(existing, item));
  }

  return [...passthrough, ...dedupedByRunId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function findSessionByRunId(sessions: SessionCard[], runId: string | null): SessionCard | null {
  if (!runId) return null;
  return sessions.find((session) => session.latestRunId === runId || session.id === runId) || null;
}

function chatMessageToTimelineEntry(message: ChatMessage): TimelineEntry {
  const normalizedText = message.role === "assistant" || message.role === "plan"
    ? normalizeMessageTextForDisplay(message.text)
    : message.text;
  return {
    key: message.id,
    messageId: message.id,
    clientMessageId: message.clientMessageId,
    sessionId: message.sessionId,
    role: message.role,
    kind: message.kind,
    title: message.title,
    text: normalizedText,
    pending: message.deliveryStatus === "pending" || message.deliveryStatus === "streaming",
    at: message.createdAt,
    sequence: message.sequence,
    deliveryStatus: message.deliveryStatus,
    attachments: readAttachmentRefs(message.attachments),
    meta: message.meta ? { ...message.meta } : undefined,
  };
}

function isPlaceholderPlanMessage(message: ChatMessage): boolean {
  if (message.role !== "plan") return false;
  const text = message.text.replace(/\s+/g, " ").trim();
  return !text || text === "Plan updated" || text === "Planning";
}

function timelineEntriesFromMessages(messages: ChatMessage[]): TimelineEntry[] {
  return messages
    .filter((message) => !isPlaceholderPlanMessage(message))
    .map((message) => chatMessageToTimelineEntry(message));
}

function sameTimelineMessage(left: TimelineEntry, right: TimelineEntry): boolean {
  if (left.messageId && right.messageId && left.messageId === right.messageId) return true;
  return Boolean(left.clientMessageId && right.clientMessageId && left.clientMessageId === right.clientMessageId);
}

function normalizeTimelineEntryText(entry: TimelineEntry): string {
  return entry.text.replace(/\s+/g, " ").trim();
}

function isLocalStoredUserEntry(entry: TimelineEntry): boolean {
  return entry.role === "user" && entry.kind === "message" && Boolean(entry.messageId?.startsWith("msg_"));
}

function isProjectedRunPromptEntry(entry: TimelineEntry): boolean {
  return entry.role === "user" && entry.kind === "message" && Boolean(entry.messageId?.startsWith("run_") && entry.messageId.endsWith("_user"));
}

function fileChangePathFromEntry(entry: TimelineEntry): string {
  const changes = Array.isArray(entry.meta?.fileChanges) ? entry.meta.fileChanges : [];
  const firstChange = changes[0];
  if (firstChange && typeof firstChange.path === "string" && firstChange.path.trim()) {
    return firstChange.path.trim();
  }
  return typeof entry.meta?.path === "string" ? entry.meta.path.trim() : "";
}

function isDuplicatePromptEntry(left: TimelineEntry, right: TimelineEntry): boolean {
  if (left.sessionId !== right.sessionId || left.role !== "user" || right.role !== "user" || left.kind !== "message" || right.kind !== "message") {
    return false;
  }
  if (normalizeTimelineEntryText(left) !== normalizeTimelineEntryText(right)) return false;
  if (Math.abs(left.at - right.at) > 2 * 60 * 1000) return false;
  return (
    (isLocalStoredUserEntry(left) && isProjectedRunPromptEntry(right))
    || (isLocalStoredUserEntry(right) && isProjectedRunPromptEntry(left))
  );
}

function isDuplicateFileChangeEntry(left: TimelineEntry, right: TimelineEntry): boolean {
  if (left.sessionId !== right.sessionId || left.role !== "tool" || right.role !== "tool" || left.kind !== "tool" || right.kind !== "tool") {
    return false;
  }
  if (left.meta?.type !== "filechange" || right.meta?.type !== "filechange") return false;
  if ((left.meta?.runId || null) !== (right.meta?.runId || null)) return false;
  if ((left.meta?.status || null) !== (right.meta?.status || null)) return false;
  if (normalizeTimelineEntryText(left) !== normalizeTimelineEntryText(right)) return false;
  if (fileChangePathFromEntry(left) !== fileChangePathFromEntry(right)) return false;
  return Math.abs(left.at - right.at) <= 2 * 60 * 1000;
}

function sameSemanticTimelineMessage(left: TimelineEntry, right: TimelineEntry): boolean {
  return sameTimelineMessage(left, right) || isDuplicatePromptEntry(left, right) || isDuplicateFileChangeEntry(left, right);
}

function mergeSemanticTimelineEntry(existing: TimelineEntry, next: TimelineEntry): TimelineEntry {
  if (sameTimelineMessage(existing, next)) return next;
  if (isDuplicatePromptEntry(existing, next)) {
    const local = isLocalStoredUserEntry(existing) ? existing : next;
    const projected = local === existing ? next : existing;
    return {
      ...local,
      pending: local.pending && projected.pending,
      deliveryStatus: local.deliveryStatus === "pending" ? projected.deliveryStatus : local.deliveryStatus,
      meta: { ...(projected.meta || {}), ...(local.meta || {}) },
      at: Math.min(existing.at, next.at),
      sequence: Math.min(existing.sequence, next.sequence),
    };
  }
  return next;
}

function mergeTimelineEntries(older: TimelineEntry[], newer: TimelineEntry[]): TimelineEntry[] {
  const merged: TimelineEntry[] = [];
  const seenMessageIds = new Set<string>();
  const seenClientIds = new Set<string>();

  for (const entry of [...older, ...newer]) {
    if (entry.messageId && seenMessageIds.has(entry.messageId)) continue;
    if (entry.clientMessageId && seenClientIds.has(entry.clientMessageId)) continue;
    if (entry.messageId) seenMessageIds.add(entry.messageId);
    if (entry.clientMessageId) seenClientIds.add(entry.clientMessageId);
    merged.push(entry);
  }

  return merged.sort((a, b) => a.sequence - b.sequence || a.at - b.at);
}

function upsertTimelineEntry(entries: TimelineEntry[], nextEntry: TimelineEntry): TimelineEntry[] {
  const next = [...entries];
  const index = next.findIndex((entry) => sameSemanticTimelineMessage(entry, nextEntry));
  if (index >= 0) {
    next[index] = mergeSemanticTimelineEntry(next[index], nextEntry);
  } else {
    next.push(nextEntry);
  }
  return next.sort((a, b) => a.sequence - b.sequence || a.at - b.at);
}

function removeTimelineEntryByClientMessageId(entries: TimelineEntry[], clientMessageId: string): TimelineEntry[] {
  return entries.filter((entry) => entry.clientMessageId !== clientMessageId);
}

function buildOptimisticUserEntry(
  sessionId: string,
  clientMessageId: string,
  text: string,
  attachments: AttachmentRef[],
): TimelineEntry {
  const now = Date.now();
  return {
    key: `optimistic_${clientMessageId}`,
    messageId: `optimistic_${clientMessageId}`,
    clientMessageId,
    sessionId,
    role: "user",
    kind: "message",
    title: "You",
    text,
    pending: true,
    at: now,
    sequence: now,
    deliveryStatus: "pending",
    attachments: readAttachmentRefs(attachments),
  };
}

function buildLocalTimelineEntry(
  sessionId: string,
  key: string,
  role: TimelineEntry["role"],
  title: string,
  text: string,
  at: number,
): TimelineEntry {
  let kind: TimelineEntry["kind"] = "message";
  if (role === "tool") kind = "tool";
  else if (role === "plan") kind = "plan";
  else if (role === "system") kind = "system";
  else if (role === "error") kind = "error";

  return {
    key,
    messageId: key,
    clientMessageId: null,
    sessionId,
    role,
    kind,
    title,
    text,
    pending: false,
    at,
    sequence: at,
    deliveryStatus: "sent",
    attachments: [],
  };
}

function buildTimelineRenderBlocks(entries: TimelineEntry[]): TimelineRenderBlock[] {
  const blocks: TimelineRenderBlock[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.role !== "tool") {
      blocks.push({ kind: "entry", key: entry.key, entry });
      continue;
    }

    const group = [entry];
    while (entries[index + 1]?.role === "tool") {
      group.push(entries[index + 1]);
      index += 1;
    }

    if (group.length === 1) {
      blocks.push({ kind: "entry", key: entry.key, entry });
      continue;
    }

    blocks.push({
      kind: "tool-group",
      key: `tool_group_${group[0]?.key || index}`,
      entries: group,
    });
  }

  return blocks;
}

function toolEntryTypeLabel(entry: TimelineEntry): string {
  const type = String(entry.meta?.type || "").toLowerCase();
  if (type === "commandexecution") return "command";
  if (type === "filechange") return "file change";
  if (type === "mcptoolcall") return "MCP tool";
  if (type === "websearch") return "web search";
  return "tool update";
}

function toolEntryDescription(entry: TimelineEntry): string {
  // Only use explicit tool descriptions (Claude Bash `description`, etc.).
  // Do not infer from command text — that made Codex rows show raw /bin/bash -lc payloads.
  return String(entry.meta?.description || "").trim();
}

function toolEntryDisplayName(entry: TimelineEntry): string {
  const description = toolEntryDescription(entry);
  if (description) return description;
  return summarizeToolEntriesInline([entry]);
}

function countChangedFiles(entries: TimelineEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    const changes = Array.isArray(entry.meta?.fileChanges) ? entry.meta.fileChanges : [];
    if (changes.length > 0) {
      count += changes.length;
    } else if (String(entry.meta?.type || "").toLowerCase() === "filechange") {
      count += 1;
    }
  }
  return count;
}

function summarizeToolEntriesInline(entries: TimelineEntry[]): string {
  const total = entries.length;
  const running = entries.some((entry) => entry.pending);
  const typeCounts = entries.reduce<Record<string, number>>((acc, entry) => {
    const type = String(entry.meta?.type || "").toLowerCase() || "tool";
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  const action = running ? "Running" : "Ran";
  const onlyType = Object.keys(typeCounts).length === 1 ? Object.keys(typeCounts)[0] : "";
  const count = onlyType ? typeCounts[onlyType] || total : total;

  if (total === 1) {
    const only = entries[0];
    const description = only ? toolEntryDescription(only) : "";
    if (description) return description;
  }

  if (onlyType === "commandexecution") return `${action} ${count} command${count === 1 ? "" : "s"}`;
  if (onlyType === "mcptoolcall") return `${action} ${count} MCP tool${count === 1 ? "" : "s"}`;
  if (onlyType === "websearch") return `${running ? "Searching" : "Searched"} ${count === 1 ? "the web" : `${count} times`}`;
  if (onlyType === "filechange") {
    const fileCount = countChangedFiles(entries);
    return `${running ? "Editing" : "Edited"} ${fileCount} file${fileCount === 1 ? "" : "s"}`;
  }

  return `${action} ${total} tool${total === 1 ? "" : "s"}`;
}

function toolEntryDetailTitle(entry: TimelineEntry): string {
  const type = String(entry.meta?.type || "").toLowerCase();
  if (type === "commandexecution") return "Command output";
  if (type === "mcptoolcall") return "MCP tool output";
  if (type === "websearch") return "Web search output";
  if (type === "filechange") return "File changes";
  return "Tool output";
}

function toolEntryCommandText(entry: TimelineEntry): string {
  const type = String(entry.meta?.type || "").toLowerCase();
  if (type === "filechange") return "File changes";
  return String(entry.meta?.command || entry.text || toolEntryTypeLabel(entry)).trim();
}

function toolEntryOutputText(entry: TimelineEntry): string {
  const type = String(entry.meta?.type || "").toLowerCase();
  if (type === "filechange") {
    const changes = Array.isArray(entry.meta?.fileChanges) ? entry.meta.fileChanges : [];
    if (changes.length > 0) {
      return changes
        .map((change) => `${change.kind} ${change.path} +${change.added} -${change.removed}`)
        .join("\n");
    }
    return String(entry.meta?.path || entry.text || "File change");
  }

  return String(entry.meta?.output || entry.meta?.errorMessage || entry.text || "").trim();
}

function summarizeToolGroup(entries: TimelineEntry[]): { summary: string; detail: string; preview: string } {
  const typeCounts = new Map<string, number>();
  let runningCount = 0;

  for (const entry of entries) {
    if (entry.pending) runningCount += 1;
    const label = toolEntryTypeLabel(entry);
    typeCounts.set(label, (typeCounts.get(label) || 0) + 1);
  }

  const detailParts = [...typeCounts.entries()].map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`);
  if (runningCount > 0) detailParts.push(`${runningCount} running`);

  const firstEntry = entries[0];
  const previewSource = firstEntry
    && String(toolEntryDescription(firstEntry) || firstEntry.meta?.command || firstEntry.text || "").trim();

  return {
    summary: summarizeToolEntriesInline(entries),
    detail: detailParts.join(" | "),
    preview: previewSource ? truncatePreview(previewSource, 120) : "",
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function readAttachmentRef(input: unknown): AttachmentRef | null {
  if (!isRecord(input)) return null;
  return typeof input.id === "string"
    && typeof input.name === "string"
    && typeof input.mimeType === "string"
    && typeof input.size === "number"
    && (input.kind === "image" || input.kind === "text" || input.kind === "file")
    && typeof input.relativePath === "string"
    && typeof input.uploadedAt === "number"
    ? {
        id: input.id,
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        kind: input.kind,
        relativePath: input.relativePath,
        uploadedAt: input.uploadedAt,
        storage: input.storage === "luma" ? "luma" : input.storage === "workspace" ? "workspace" : undefined,
        width: typeof input.width === "number" && input.width > 0 ? input.width : undefined,
        height: typeof input.height === "number" && input.height > 0 ? input.height : undefined,
        alt: typeof input.alt === "string" ? input.alt : undefined,
      }
    : null;
}

function readAttachmentRefs(input: unknown): AttachmentRef[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => readAttachmentRef(value))
    .filter((value): value is AttachmentRef => value !== null)
    .slice(0, attachmentMaxFiles);
}

function readSelectedSkillRef(input: unknown): SelectedSkillRef | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const skillPath = typeof input.path === "string" ? input.path.trim() : "";
  return id && skillPath ? { id, path: skillPath } : null;
}

function readSelectedSkillRefs(input: unknown): SelectedSkillRef[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const refs: SelectedSkillRef[] = [];
  for (const value of input) {
    const ref = readSelectedSkillRef(value);
    if (!ref) continue;
    const key = `${ref.id}\n${ref.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= 20) break;
  }
  return refs;
}

function readSelectedAgentRef(input: unknown): SelectedAgentRef | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const agentPath = typeof input.path === "string" ? input.path.trim() : "";
  return id && agentPath ? { id, path: agentPath } : null;
}

function readSelectedAgentRefs(input: unknown): SelectedAgentRef[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const refs: SelectedAgentRef[] = [];
  for (const value of input) {
    const ref = readSelectedAgentRef(value);
    if (!ref) continue;
    const key = `${ref.id}\n${ref.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= 10) break;
  }
  return refs;
}

function selectedSkillRef(skill: SkillListItem): SelectedSkillRef {
  return { id: skill.id, path: skill.path };
}

function selectedAgentRef(agent: AgentListItem): SelectedAgentRef {
  return { id: agent.id, path: agent.path };
}

function skillDisplayName(ref: SelectedSkillRef, catalog: SkillListItem[]): string {
  const match = catalog.find((skill) => skill.id === ref.id || skill.path === ref.path);
  if (match) return match.name;
  return ref.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || ref.path.split(/[\\/]/).pop() || "Skill";
}

function formatSkillSummary(refs: SelectedSkillRef[], catalog: SkillListItem[]): string {
  if (refs.length === 0) return "";
  const names = refs.slice(0, 2).map((ref) => skillDisplayName(ref, catalog));
  const suffix = refs.length > names.length ? ` +${refs.length - names.length}` : "";
  return `Skills: ${names.join(", ")}${suffix}`;
}

function agentDisplayName(ref: SelectedAgentRef, catalog: AgentListItem[]): string {
  const match = catalog.find((agent) => agent.id === ref.id || agent.path === ref.path);
  if (match) return match.name;
  return ref.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || ref.path.split(/[\\/]/).pop() || "Agent";
}

function formatAgentSummary(refs: SelectedAgentRef[], catalog: AgentListItem[]): string {
  if (refs.length === 0) return "";
  const names = refs.slice(0, 2).map((ref) => agentDisplayName(ref, catalog));
  const suffix = refs.length > names.length ? ` +${refs.length - names.length}` : "";
  return `Agents: ${names.join(", ")}${suffix}`;
}

function isSystemSkill(skill: SkillListItem): boolean {
  return skill.path.split(/[\\/]/).includes(".system");
}

function skillIdentityKey(skill: SkillListItem): string {
  const parts = skill.path.split(/[\\/]/).filter(Boolean);
  const runtimeIndex = parts.findIndex((part) => part === ".codex" || part === ".claude");
  const skillsIndex = runtimeIndex >= 0 ? parts.indexOf("skills", runtimeIndex) : -1;
  if (skillsIndex >= 0 && skillsIndex < parts.length - 1) {
    const relative = parts.slice(skillsIndex + 1, -1).join("/");
    if (relative) return relative.toLowerCase();
  }

  return skill.name.trim().toLowerCase();
}

function skillCanonicalRank(skill: SkillListItem): number {
  if (skill.scope === "repo") return skill.source.includes("codex") ? 0 : 1;
  if (skill.source === "codex") return 2;
  if (skill.source === "claude") return 3;
  if (skill.source === "cursor") return 4;
  return 5;
}

function chooseCanonicalSkill(current: SkillListItem, candidate: SkillListItem): SkillListItem {
  const currentRank = skillCanonicalRank(current);
  const candidateRank = skillCanonicalRank(candidate);
  if (currentRank !== candidateRank) return candidateRank < currentRank ? candidate : current;
  return candidate.path.localeCompare(current.path) < 0 ? candidate : current;
}

function dedupeSkillCatalog(skills: SkillListItem[]): SkillListItem[] {
  const byIdentity = new Map<string, SkillListItem>();
  for (const skill of skills) {
    const key = skillIdentityKey(skill);
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing ? chooseCanonicalSkill(existing, skill) : skill);
  }

  return [...byIdentity.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

type SkillQueryToken = {
  start: number;
  end: number;
  query: string;
};

function findSkillQueryToken(value: string): SkillQueryToken | null {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== "@") continue;
    if (value[index + 1] === "@") continue;
    if (index > 0 && !/\s/.test(value[index - 1])) continue;
    const token = value.slice(index + 1);
    if (/\s/.test(token)) return null;
    if (token.startsWith("@")) return null;
    return { start: index, end: value.length, query: token };
  }
  return null;
}

function findAgentQueryToken(value: string): SkillQueryToken | null {
  for (let index = value.length - 2; index >= 0; index -= 1) {
    if (value[index] !== "@" || value[index + 1] !== "@") continue;
    if (index > 0 && !/\s/.test(value[index - 1])) continue;
    const token = value.slice(index + 2);
    if (/\s/.test(token)) return null;
    return { start: index, end: value.length, query: token };
  }
  return null;
}

function removeSkillQueryToken(value: string, token: SkillQueryToken | null): string {
  if (!token) return value;
  const before = value.slice(0, token.start).replace(/[ \t]+$/g, "");
  const after = value.slice(token.end).replace(/^[ \t]+/g, "");
  if (!before) return after;
  if (!after) return before;
  return `${before} ${after}`;
}

function readChatMessage(input: unknown): ChatMessage | null {
  if (!isRecord(input)) return null;
  return typeof input.id === "string"
    && typeof input.sessionId === "string"
    && typeof input.role === "string"
    && typeof input.kind === "string"
    && typeof input.text === "string"
    && typeof input.createdAt === "number"
    && typeof input.sequence === "number"
    && typeof input.deliveryStatus === "string"
    ? {
        ...input,
        clientMessageId: typeof input.clientMessageId === "string" ? input.clientMessageId : null,
        runId: typeof input.runId === "string" ? input.runId : null,
        title: typeof input.title === "string" ? input.title : undefined,
        attachments: readAttachmentRefs(input.attachments),
        meta: isRecord(input.meta) ? { ...input.meta } : undefined,
      } as ChatMessage
    : null;
}

function readSessionListItem(input: unknown): SessionListItem | null {
  if (!isRecord(input)) return null;
  return typeof input.id === "string"
    && typeof input.title === "string"
    && typeof input.status === "string"
    && typeof input.updatedAt === "number"
    && typeof input.sourceTag === "string"
    && typeof input.sourceRaw === "string"
    && typeof input.workspace === "string"
    && typeof input.lastMessagePreview === "string"
    && typeof input.messageCount === "number"
    && typeof input.historyOnly === "boolean"
    ? {
        id: input.id,
        title: input.title,
        status: input.status as SessionListItem["status"],
        updatedAt: input.updatedAt,
        runner: normalizeRunRunnerValue(input.runner),
        model: typeof input.model === "string" ? input.model : undefined,
        reasoningEffort: isReasoningEffort(input.reasoningEffort) ? input.reasoningEffort : undefined,
        sourceTag: input.sourceTag as RunSourceTag,
        sourceRaw: input.sourceRaw,
        workspace: input.workspace,
        latestRunId: typeof input.latestRunId === "string" ? input.latestRunId : null,
        lastMessagePreview: input.lastMessagePreview,
        messageCount: input.messageCount,
        historyOnly: input.historyOnly,
        scheduled: typeof input.scheduled === "boolean" ? input.scheduled : undefined,
        projectId: typeof input.projectId === "string" ? input.projectId : null,
      }
    : null;
}

function toJson(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function normalizeMessageTextForDisplay(input: string): string {
  if (!input.includes("\n")) return input;
  if (input.includes("```")) return input;

  const lines = input.split(/\r?\n/);
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  if (nonEmpty.length < 6) return input;

  const looksLikeStructuredMarkdown = nonEmpty.some((line) =>
    line.startsWith("- ")
    || line.startsWith("* ")
    || line.startsWith("> ")
    || /^\d+\.\s/.test(line),
  );
  if (looksLikeStructuredMarkdown) return input;

  const veryShortLineCount = nonEmpty.filter((line) => line.length <= 4).length;
  const punctuationOnlyCount = nonEmpty.filter((line) => /^[,.;:()[\]{}-]+$/.test(line)).length;
  const compactRatio = (veryShortLineCount + punctuationOnlyCount) / nonEmpty.length;
  if (compactRatio < 0.35) return input;

  return nonEmpty.join(" ").replace(/\s+/g, " ").trim();
}

function isTerminalSessionStatus(value: unknown): value is "running" | "stopped" {
  return value === "running" || value === "stopped";
}

function isTerminalSnapshot(value: unknown): value is TerminalSessionSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.sessionId === "string"
    && isTerminalSessionStatus(value.status)
    && typeof value.workspace === "string"
    && typeof value.shell === "string"
    && (typeof value.pid === "number" || value.pid === null)
    && typeof value.createdAt === "number"
    && typeof value.updatedAt === "number"
    && typeof value.output === "string";
}

function readTerminalSnapshot(payload: unknown): TerminalSessionSnapshot | null {
  if (!isRecord(payload)) return null;
  const candidate = payload.terminal;
  if (!isTerminalSnapshot(candidate)) return null;
  return candidate;
}

function truncatePreview(input: string, max = 120): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function workspaceLabel(workspace: string): string {
  if (!workspace.trim()) return "workspace";
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || workspace;
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatAttachmentSummary(attachments: AttachmentRef[]): string {
  if (attachments.length === 0) return "";
  if (attachments.length === 1) return attachments[0]?.name || "1 attachment";
  return `${attachments.length} attachments`;
}

function formatRecordingDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isScrolledToBottom(node: HTMLDivElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= timelineAutoScrollThresholdPx;
}

function appendTranscriptToPrompt(currentPrompt: string, transcript: string): string {
  const next = transcript.trim();
  if (!next) return currentPrompt;
  if (!currentPrompt.trim()) return next;
  const suffix = /[\s\n]$/.test(currentPrompt) ? "" : " ";
  return `${currentPrompt}${suffix}${next}`;
}

function toSpeechErrorMessage(error?: string): string {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Microphone permission was denied.";
  }
  if (error === "audio-capture") {
    return "No microphone was found for voice input.";
  }
  if (error === "network") {
    return "Voice input failed because of a network issue.";
  }
  if (error === "aborted") {
    return "Voice input was stopped.";
  }
  return error ? `Voice input error: ${error}` : "Voice input failed.";
}

function isPlanLike(itemType: string): boolean {
  const normalized = itemType.toLowerCase();
  return normalized === "plan" || normalized === "reasoning" || normalized.includes("todo");
}

function readPlanStepText(step: Record<string, unknown>): string {
  if (typeof step.step === "string" && step.step.trim()) return step.step.trim();
  if (typeof step.text === "string" && step.text.trim()) return step.text.trim();
  if (typeof step.content === "string" && step.content.trim()) return step.content.trim();
  if (typeof step.title === "string" && step.title.trim()) return step.title.trim();
  if (typeof step.description === "string" && step.description.trim()) return step.description.trim();
  return "";
}

function formatPlanSteps(steps: unknown[]): string {
  const lines = steps
    .map((step) => {
      if (typeof step === "string" && step.trim()) return `- [pending] ${step.trim()}`;
      if (!isRecord(step)) return "";
      const text = readPlanStepText(step);
      if (!text) return "";
      const status = typeof step.status === "string" && step.status.trim() ? step.status.trim() : "pending";
      return `- [${status}] ${text}`;
    })
    .filter(Boolean);
  return lines.length ? `Plan steps:\n${lines.join("\n")}` : "";
}

function resolvePlanText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
  if (typeof item.explanation === "string" && item.explanation.trim()) return item.explanation.trim();
  if (typeof item.summary === "string" && item.summary.trim()) return item.summary.trim();

  for (const key of ["plan", "items", "todos", "steps", "entries"] as const) {
    const value = item[key];
    if (!Array.isArray(value)) continue;
    const formatted = formatPlanSteps(value);
    if (formatted) return formatted;
  }

  return readTextField(item.content).trim();
}

function collectSessionDebugLogs(runs: RunRecord[]): DebugLogEntry[] {
  const entries: DebugLogEntry[] = [];

  for (const run of [...runs].sort((a, b) => a.createdAt - b.createdAt)) {
    for (const event of [...run.events].sort((a, b) => a.at - b.at)) {
      const raw = (event.text || "").trim();
      if (!raw || event.source !== "stderr") continue;

      entries.push({
        key: `${run.id}_${event.id}_stderr`,
        runId: run.id,
        at: event.at,
        text: raw,
      });
    }
  }

  return entries;
}

type StructuredMessageProps = {
  entryKey: string;
  text: string;
  interactive: boolean;
  resolved: boolean;
  onAnswerPlanQuestions: (answers: PlanQuestionAnswer[]) => Promise<void>;
  onApprovePlanImplementation: () => Promise<void>;
  onSubmitPlanFeedback: (feedback: string) => Promise<void>;
};

type PlanningQuestionSegment = Extract<PlanningSegment, { type: "question" }>;

function StructuredMessage(props: StructuredMessageProps): JSX.Element {
  const segments = useMemo(() => parsePlanningMessage(props.text), [props.text]);
  const questionSegments = useMemo(
    () => segments.filter((segment): segment is PlanningQuestionSegment => segment.type === "question"),
    [segments],
  );
  let renderedQuestionnaire = false;

  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        const key = `${props.entryKey}_${segment.type}_${index}`;

        if (segment.type === "markdown" || segment.type === "proposed_plan") {
          return <MarkdownMessage key={key} text={segment.type === "markdown" ? segment.text : segment.text} />;
        }

        if (segment.type === "question") {
          if (!props.interactive) {
            return <MarkdownMessage key={key} text={segment.raw} />;
          }
          if (renderedQuestionnaire) return null;
          renderedQuestionnaire = true;
          return (
            <QuestionnaireCard
              key={key}
              questions={questionSegments}
              disabled={props.resolved}
              onSubmit={props.onAnswerPlanQuestions}
            />
          );
        }

        if (!props.interactive) {
          return <MarkdownMessage key={key} text={segment.text || "Do you want to implement this plan now?"} />;
        }

        return (
          <FinalApprovalCard
            key={key}
            text={segment.text}
            disabled={props.resolved}
            onApprove={props.onApprovePlanImplementation}
            onSubmitFeedback={props.onSubmitPlanFeedback}
          />
        );
      })}
    </div>
  );
}

function QuestionnaireCard({
  questions,
  disabled,
  onSubmit,
}: {
  questions: PlanningQuestionSegment[];
  disabled: boolean;
  onSubmit: (answers: PlanQuestionAnswer[]) => Promise<void>;
}): JSX.Element {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [customAnswers, setCustomAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const isDisabled = disabled || submitted;
  const currentQuestion = questions[currentIndex];
  const currentAnswer = selectedAnswers[currentIndex] || "";
  const currentCustomAnswer = customAnswers[currentIndex] || "";
  const totalQuestions = questions.length;
  const isLastQuestion = currentIndex === totalQuestions - 1;

  function updateAnswerAt(index: number, value: string): void {
    setSelectedAnswers((prev) => prev.map((item, itemIndex) => (itemIndex === index ? value : item)));
  }

  function updateCustomAnswerAt(index: number, value: string): void {
    setCustomAnswers((prev) => prev.map((item, itemIndex) => (itemIndex === index ? value : item)));
    updateAnswerAt(index, value);
  }

  async function submitAnswers(): Promise<void> {
    if (isDisabled || submitting) return;
    const answers = questions.map((question, index) => ({
      questionTitle: question.title,
      answer: selectedAnswers[index]?.trim() || "",
    }));
    if (answers.some((item) => !item.answer)) return;
    setSubmitting(true);
    try {
      await onSubmit(answers);
      setSubmitted(true);
    } catch {
      // parent already surfaces submission errors
    } finally {
      setSubmitting(false);
    }
  }

  function onSelectOption(answer: string): void {
    if (isDisabled || submitting) return;
    updateAnswerAt(currentIndex, answer);
  }

  function onNextQuestion(): void {
    if (isDisabled || submitting || !currentAnswer.trim() || isLastQuestion) return;
    setCurrentIndex((value) => Math.min(value + 1, totalQuestions - 1));
  }

  return (
    <section className="rounded-2xl border border-brand/25 bg-brand-soft/35 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
            {totalQuestions > 1 ? `Question ${currentIndex + 1} of ${totalQuestions}` : "Question"}
          </p>
          <h3 className="text-sm font-semibold">{currentQuestion?.title || "Question"}</h3>
        </div>
        <Badge>{isDisabled ? "Answered" : submitting ? "Sending" : `${totalQuestions} total`}</Badge>
      </div>

      {currentQuestion?.description ? (
        <div className="mb-3 text-sm leading-relaxed">
          <MarkdownMessage text={currentQuestion.description} />
        </div>
      ) : null}

      <div className="space-y-2">
        {currentQuestion?.options.map((option) => (
          <button
            key={option}
            type="button"
            className={cn(
              "w-full rounded-xl border bg-surface-1 px-3 py-2 text-left text-sm transition hover:border-brand/50 hover:bg-brand-soft/30 disabled:cursor-not-allowed disabled:opacity-70",
              currentAnswer === option ? "border-brand bg-brand-soft/30" : "border-card-border",
            )}
            onClick={() => onSelectOption(option)}
            disabled={isDisabled || submitting}
          >
            {option}
          </button>
        ))}

        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border border-dashed bg-surface-1 px-3 py-2",
            currentCustomAnswer.trim() && currentAnswer === currentCustomAnswer ? "border-brand bg-brand-soft/25" : "border-card-border",
          )}
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground/60">Custom</span>
          <input
            className="h-9 w-full rounded-lg border border-card-border bg-surface-1 px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            value={currentCustomAnswer}
            onChange={(event) => updateCustomAnswerAt(currentIndex, event.target.value)}
            placeholder="Add your own answer"
            disabled={isDisabled || submitting}
          />
        </div>

        {totalQuestions > 1 ? (
          <div className="rounded-xl border border-card-border bg-surface-1/70 px-3 py-2 text-xs text-foreground/70">
            {selectedAnswers.filter((answer) => answer.trim()).length} of {totalQuestions} answered
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        {!isLastQuestion ? (
          <Button type="button" onClick={onNextQuestion} disabled={isDisabled || submitting || !currentAnswer.trim()}>
            Next question
          </Button>
        ) : (
          <Button type="button" onClick={() => void submitAnswers()} disabled={isDisabled || submitting || !currentAnswer.trim()}>
            {submitting ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {totalQuestions > 1 ? "Send all answers" : "Send answer"}
          </Button>
        )}
      </div>
    </section>
  );
}

function FinalApprovalCard({
  text,
  disabled,
  onApprove,
  onSubmitFeedback,
}: {
  text: string;
  disabled: boolean;
  onApprove: () => Promise<void>;
  onSubmitFeedback: (feedback: string) => Promise<void>;
}): JSX.Element {
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState<"approve" | "feedback" | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const isDisabled = disabled || submitted;

  async function submitApprove(): Promise<void> {
    if (isDisabled || submitting) return;
    setSubmitting("approve");
    try {
      await onApprove();
      setSubmitted(true);
    } catch {
      // parent already surfaces submission errors
    } finally {
      setSubmitting(null);
    }
  }

  async function submitFeedback(): Promise<void> {
    if (isDisabled || submitting || !feedback.trim()) return;
    setSubmitting("feedback");
    try {
      await onSubmitFeedback(feedback.trim());
      setFeedback("");
      setSubmitted(true);
    } catch {
      // parent already surfaces submission errors
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section className="rounded-2xl border border-amber-300/70 bg-amber-50/80 p-3 dark:border-[#8b6a24]/45 dark:bg-[#20190e]/95 dark:shadow-[0_10px_28px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,226,168,0.06)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground/70 dark:text-amber-100/65">Final approval</p>
          <h3 className="text-sm font-semibold dark:text-amber-50">Do you want to implement this plan?</h3>
        </div>
        <Badge className="dark:border-[#8b6a24]/40 dark:bg-[#312614] dark:text-amber-100/90">
          {isDisabled ? "Submitted" : "Required"}
        </Badge>
      </div>

      <div className="mb-3 text-sm leading-relaxed dark:text-stone-200">
        <MarkdownMessage text={text.trim() || "Do you want to implement this plan now?"} />
      </div>

      <div className="space-y-2">
        <Button type="button" onClick={() => void submitApprove()} disabled={isDisabled || submitting !== null} className="w-full justify-center">
          {submitting === "approve" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Yes, implement
        </Button>

        <div className="flex items-center gap-2 rounded-xl border border-dashed border-amber-300/80 bg-surface-1 px-3 py-2 dark:border-[#8b6a24]/40 dark:bg-[#17130e]">
          <input
            className="composer-input h-9 w-full rounded-lg border border-card-border bg-surface-1 px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-[#5f4d25]/35 dark:bg-[#100d09] dark:text-stone-100 dark:placeholder:text-stone-400 dark:focus:border-[#c59c39] dark:focus:ring-[#c59c39]/20"
            value={feedback}
            dir={feedback.trim() ? resolveTextDirection(feedback) : "auto"}
            lang={feedback.trim() && resolveTextDirection(feedback) === "rtl" ? "fa" : undefined}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Add plan changes before approval"
            disabled={isDisabled || submitting !== null}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="dark:border-[#5f4d25]/35 dark:bg-[#241d12] dark:text-amber-50 dark:hover:border-[#8b6a24]/45 dark:hover:bg-[#2c2316]"
            onClick={() => void submitFeedback()}
            disabled={isDisabled || submitting !== null || !feedback.trim()}
          >
            {submitting === "feedback" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "Send"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ToolEntry({
  entry,
  ansi,
}: {
  entry: TimelineEntry;
  ansi: Convert;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const type = (entry.meta?.type || "").toLowerCase();
  const status = entry.meta?.status || null;
  const statusLabel = status ? String(status).replace(/[-_]/g, " ") : null;
  const command = toolEntryCommandText(entry);
  const output = type === "filechange"
    ? toolEntryOutputText(entry) || "No file changes captured."
    : toolEntryOutputText(entry) || entry.text || "No output captured.";
  const title = toolEntryDetailTitle(entry);
  const exitCode = entry.meta?.exitCode;

  if (type === "commandexecution" || type === "mcptoolcall" || type === "websearch") {
    return (
      <div className="w-full">
        <button
          type="button"
          className="group inline-flex max-w-full items-center gap-1 text-left text-sm leading-6 text-foreground/55 transition hover:text-foreground/85"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="truncate">{toolEntryDisplayName(entry)}</span>
          <span className={cn("text-foreground/35 transition group-hover:text-foreground/70", expanded && "rotate-90")}>›</span>
        </button>
        {expanded ? (
          <InlineToolDetails
            title={title}
            command={command}
            output={output}
            status={status || undefined}
            statusLabel={statusLabel || undefined}
            exitCode={exitCode}
            at={entry.at}
            ansi={ansi}
          />
        ) : null}
      </div>
    );
  }

  if (type === "filechange") {
    return (
      <div className="w-full">
        <button
          type="button"
          className="group inline-flex max-w-full items-center gap-1 text-left text-sm leading-6 text-foreground/55 transition hover:text-foreground/85"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="truncate">{toolEntryDisplayName(entry)}</span>
          <span className={cn("text-foreground/35 transition group-hover:text-foreground/70", expanded && "rotate-90")}>›</span>
        </button>
        {expanded ? (
          <InlineToolDetails
            title={title}
            command={command}
            output={output}
            status={status || undefined}
            statusLabel={statusLabel || undefined}
            exitCode={exitCode}
            at={entry.at}
            ansi={ansi}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="w-full">
      <button
        type="button"
        className="group inline-flex max-w-full items-center gap-1 text-left text-sm leading-6 text-foreground/55 transition hover:text-foreground/85"
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="truncate">{toolEntryDisplayName(entry)}</span>
        <span className={cn("text-foreground/35 transition group-hover:text-foreground/70", expanded && "rotate-90")}>›</span>
      </button>
      {expanded ? (
        <InlineToolDetails
          title={title}
          command={command}
          output={output}
          status={status || undefined}
          statusLabel={statusLabel || undefined}
          exitCode={exitCode}
          at={entry.at}
          ansi={ansi}
        />
      ) : null}
    </div>
  );
}

function InlineToolDetails({
  title,
  command,
  output,
  status,
  statusLabel,
  exitCode,
  at,
  ansi,
}: {
  title: string;
  command: string;
  output: string;
  status?: string;
  statusLabel?: string;
  exitCode?: number | null;
  at: number;
  ansi: Convert;
}): JSX.Element {
  return (
    <div className="mt-1.5 w-full max-w-4xl rounded-md border border-card-border bg-surface-1/70 p-2 text-xs text-foreground/75">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="font-medium text-foreground/80">{title}</span>
        <span className="text-foreground/35">·</span>
        <span>{new Date(at).toLocaleTimeString()}</span>
        {status || statusLabel ? (
          <>
            <span className="text-foreground/35">·</span>
            <span>{statusLabel || status}</span>
          </>
        ) : null}
        {exitCode !== null && exitCode !== undefined ? (
          <>
            <span className="text-foreground/35">·</span>
            <span>exit {exitCode}</span>
          </>
        ) : null}
      </div>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">{command}</pre>
      <div
        className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80"
        dangerouslySetInnerHTML={{ __html: ansi.toHtml(output) }}
      />
    </div>
  );
}

function ToolEntryGroup({
  entries,
  ansi,
}: {
  entries: TimelineEntry[];
  ansi: Convert;
}): JSX.Element {
  const hasNamedEntries = entries.some((entry) => Boolean(toolEntryDescription(entry)));
  const [loaded, setLoaded] = useState(hasNamedEntries && entries.length > 1);
  const groupSummary = useMemo(() => summarizeToolGroup(entries), [entries]);

  return (
    <article className="w-full animate-fade-up">
      <button
        type="button"
        className="group inline-flex max-w-full items-center gap-1 text-left text-sm leading-6 text-foreground/55 transition hover:text-foreground/85"
        onClick={() => setLoaded((current) => !current)}
        title={groupSummary.detail || groupSummary.preview || groupSummary.summary}
      >
        <span className="truncate">{groupSummary.summary}</span>
        <span className={cn("text-foreground/35 transition group-hover:text-foreground/70", loaded && "rotate-90")}>›</span>
      </button>

      {loaded ? (
        <div className="mt-1 flex flex-col items-start gap-0.5 pl-4">
          {entries.map((entry) => (
            <ToolEntry key={entry.key} entry={entry} ansi={ansi} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function App(): JSX.Element {
  const {
    selectedRunId,
    setSelectedRunId,
    rightPanelTab,
    setRightPanelTab,
    rightDockOpen,
    setRightDockOpen,
    leftSidebarOpen,
    setLeftSidebarOpen,
    mobileThreadsOpen,
    setMobileThreadsOpen,
    mobileContextOpen,
    setMobileContextOpen,
    theme,
    setTheme,
    toggleTheme,
  } = useUiStore();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [activeWorkspace, setWorkspace] = useState("");
  const [runItems, setRunItems] = useState<SessionListItem[]>([]);
  const [runListNextCursor, setRunListNextCursor] = useState<string | null>(null);
  const [loadingMoreRunItems, setLoadingMoreRunItems] = useState(false);
  const [messagesByRunId, setMessagesByRunId] = useState<Record<string, TimelineEntry[]>>({});
  const [messageNextCursorByRunId, setMessageNextCursorByRunId] = useState<Record<string, string | null>>({});
  const [loadingMessagesByRunId, setLoadingMessagesByRunId] = useState<Record<string, boolean>>({});
  const [selectedRunRecord, setSelectedRunRecord] = useState<RunRecord | null>(null);
  const [tokenUsageBySession, setTokenUsageBySession] = useState<Record<string, TokenUsageSummary | null>>({});
  const [tokenUsageLoadingSessionId, setTokenUsageLoadingSessionId] = useState<string | null>(null);
  const [tokenUsageError, setTokenUsageError] = useState<string | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [loadingRunList, setLoadingRunList] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("code");
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  const [prompt, setPromptState] = useState("");
  const promptRef = useRef("");
  const composerSendLock = useRef(false);
  const setPrompt = useCallback((value: string | ((current: string) => string)) => {
    const next = typeof value === "function" ? value(promptRef.current) : value;
    promptRef.current = next;
    setPromptState(next);
  }, []);
  const [skillCatalog, setSkillCatalog] = useState<SkillListItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(null);
  const [newSessionUseCustomModel, setNewSessionUseCustomModel] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<SkillListItem[]>([]);
  const [showSystemSkills, setShowSystemSkills] = useState(false);
  const [highlightedSkillIndex, setHighlightedSkillIndex] = useState(0);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [selectedPromptAgents, setSelectedPromptAgents] = useState<AgentListItem[]>([]);
  const [highlightedAgentIndex, setHighlightedAgentIndex] = useState(0);
  const [agentSchedules, setAgentSchedules] = useState<AgentSchedule[]>([]);
  const [upcomingAgentSchedules, setUpcomingAgentSchedules] = useState<AgentSchedule[]>([]);
  const [agentExecutions, setAgentExecutions] = useState<AgentScheduleExecution[]>([]);
  const [skillSyncResult, setSkillSyncResult] = useState<SkillSyncResult | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentScheduleTime, setAgentScheduleTime] = useState("09:00");
  const [agentScheduleModel, setAgentScheduleModel] = useState("gpt-5.4");
  const [agentScheduleEffort, setAgentScheduleEffort] = useState<ReasoningEffort>("high");
  const [agentActionId, setAgentActionId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRef[]>([]);
  const [pendingAttachmentWorkspace, setPendingAttachmentWorkspace] = useState<string | null>(null);
  const [uploadingAttachmentNames, setUploadingAttachmentNames] = useState<string[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [runner, setRunnerState] = useState<RunRunner>("codex");
  const [model, setModel] = useState("gpt-5.6-sol");
  const [defaultCodexModel, setDefaultCodexModel] = useState("gpt-5.6-sol");
  const [defaultClaudeModel, setDefaultClaudeModel] = useState("sonnet");
  const [defaultCursorModel, setDefaultCursorModel] = useState("composer-2.5");
  const [claudeEffortFlagSupported, setClaudeEffortFlagSupported] = useState(true);
  const [claudeAvailable, setClaudeAvailable] = useState(!isDesktopLocal);
  const [cursorAvailable, setCursorAvailable] = useState(false);
  const unavailableRunners: RunRunner[] = isDesktopLocal
    ? runnerOptions.filter(option => (option === "claude" && !claudeAvailable) || (option === "cursor" && !cursorAvailable))
    : [];
  const [cursorModels, setCursorModels] = useState<CursorModelInfo[]>([]);
  const [askMode, setAskMode] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [sandbox, setSandbox] = useState<SandboxMode>(isDesktopLocal ? "workspace-write" : "danger-full-access");
  const approvalPolicy: ApprovalPolicy = "never";
  const [planFlowBySession, setPlanFlowBySession] = useState<Record<string, PlanSessionState>>({});

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionReviews, setSessionReviews] = useState(loadSessionReviews);
  const [isDraftSession, setIsDraftSession] = useState(false);
  const [slashEntriesBySession, setSlashEntriesBySession] = useState<Record<string, TimelineEntry[]>>({});
  const [queuedBySession, setQueuedBySession] = useState<Record<string, QueuedMessage[]>>(() => loadQueuedMessages());
  const [terminalHistoryBySession, setTerminalHistoryBySession] = useState<Record<string, string[]>>(() => loadTerminalCommandHistory());
  const [processingQueueItemId, setProcessingQueueItemId] = useState<string | null>(null);
  const processingQueueRef = useRef<string | null>(null);
  const sessionAliasesRef = useRef(new Map<string, string>());
  const [sessionAction, setSessionAction] = useState<"archive" | "delete" | null>(null);
  const [terminalsBySession, setTerminalsBySession] = useState<Record<string, TerminalSessionSnapshot>>({});
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalAction, setTerminalAction] = useState<"starting" | "stopping" | "sending" | null>(null);
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  const [remoteMacsOpen, setRemoteMacsOpen] = useState(false);
  const [remoteWorkspaceOpen, setRemoteWorkspaceOpen] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceRecordingStartedAt, setVoiceRecordingStartedAt] = useState<number | null>(null);
  const [voiceRecordingSeconds, setVoiceRecordingSeconds] = useState(0);
  const [authReady, setAuthReady] = useState(false);
  const [authSession, setAuthSession] = useState<StoredAuthSession | null>(null);
  const authSessionRef = useRef<StoredAuthSession | null>(null);
  const authToken = authSession?.token;
  const authExpiresAt = authSession?.expiresAt ?? 0;
  const idleTimeoutMs = authSession?.idleTimeoutMs;
  const updateAuthSession = useCallback((session: StoredAuthSession | null, persist = true) => {
    const stored = persist && session && !isDesktopLocal ? loadStoredAuthSession() : null;
    const next = stored && stored.token === session?.token && stored.expiresAt > session.expiresAt ? stored : session;
    authSessionRef.current = next;
    setApiAuthToken(next?.token ?? null);
    setAuthSession(next);
    if (isDesktopLocal || !persist) return;
    try {
      if (next) {
        window.localStorage.setItem(authSessionStorageKey, JSON.stringify(next));
        window.localStorage.removeItem(legacyAuthSessionStorageKey);
      } else {
        removeLocalStorageWithLegacy(authSessionStorageKey, legacyAuthSessionStorageKey);
      }
    } catch {
      // Users can still sign in when this browser disables persistent storage.
    }
  }, []);
  const [authPasswordInput, setAuthPasswordInput] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [backendConnectionStatus, setBackendConnectionStatus] = useState<BackendConnectionStatus>("connecting");

  const ansi = useMemo(() => new Convert({ newline: true, escapeXML: true }), []);
  const composerFileInputRef = useRef<HTMLInputElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineBottomRef = useRef<HTMLDivElement>(null);
  const terminalOutputRef = useRef<HTMLDivElement>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const timelineShouldAutoScrollRef = useRef(true);
  const suppressTimelineScrollTrackingRef = useRef(false);
  const timelineScrollTrackingTimeoutRef = useRef<number | null>(null);
  const pendingTimelineExpansionRef = useRef<{ sessionKey: string; scrollHeight: number; scrollTop: number } | null>(null);
  const selectedRunRefreshTimeoutRef = useRef<number | null>(null);
  const selectedRunIdRef = useRef<string | null>(selectedRunId);
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const showAllHistoryRef = useRef(showAllHistory);
  const activeWorkspaceRef = useRef(activeWorkspace);
  const isDraftSessionRef = useRef(isDraftSession);
  const modelControlsTouchedRef = useRef(false);
  const lastEventAtRef = useRef<number>(Date.now());
  const autoRefreshInFlightRef = useRef(false);
  const messagesByRunIdRef = useRef(messagesByRunId);
  const previousTimelineStateRef = useRef<{ sessionKey: string; length: number }>({
    sessionKey: draftSessionKey,
    length: 0,
  });
  const appDefaultsRequestRef = useRef<Promise<string> | null>(null);
  const appDefaultsLoadedRef = useRef(false);
  const isAuthenticated = isDesktopLocal || Boolean(authToken && authExpiresAt > Date.now());
  const remoteWorkspace = useRemoteWorkspace(isAuthenticated && !isDesktopLocal && remoteWorkspaceOpen);
  const speechSettings = useQuery({
    queryKey: speechSettingsQueryKey,
    queryFn: getSpeechSettings,
    enabled: authReady && isAuthenticated,
    retry: false,
  });
  const apiDictationEnabled = speechSettings.data?.configured === true;
  const appendDictation = useCallback((text: string) => setPrompt((current) => appendTranscriptToPrompt(current, text)), [setPrompt]);
  const dictation = useApiDictation(
    authReady && isAuthenticated && apiDictationEnabled ? selectedSessionId || `draft:${draftProjectId ?? ""}` : null,
    appendDictation,
  );
  const recording = dictation.phase === "recording" || voiceListening;
  const recordingStartedAt = dictation.startedAt ?? voiceRecordingStartedAt;
  const needsVoiceProvider = !apiDictationEnabled && (Boolean(window.lumaDesktop) || !voiceSupported);

  const projectState = useProjectState(authReady && isAuthenticated);
  const modelCatalogState = useModelCatalogState(authReady && isAuthenticated);
  const { modelOptionsForRunner, reasoningEffortOptionsForRunner, modelSupportsEffort, modelLabel, effortForModel } = useModelOptions(modelCatalogState);
  const isUploadingAttachments = uploadingAttachmentNames.length > 0;

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    messagesByRunIdRef.current = messagesByRunId;
  }, [messagesByRunId]);

  useEffect(() => {
    showAllHistoryRef.current = showAllHistory;
  }, [showAllHistory]);

  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace;
  }, [activeWorkspace]);

  useEffect(() => {
    isDraftSessionRef.current = isDraftSession;
  }, [isDraftSession]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    return () => {
      if (timelineScrollTrackingTimeoutRef.current !== null) {
        window.clearTimeout(timelineScrollTrackingTimeoutRef.current);
      }
      if (selectedRunRefreshTimeoutRef.current !== null) {
        window.clearTimeout(selectedRunRefreshTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isDesktopLocal) {
      let cancelled = false;
      void window.lumaDesktop!.localAuth().then(session => {
        if (cancelled) return;
        updateAuthSession(session);
        setAuthReady(true);
      }).catch(() => { if (!cancelled) setAuthReady(true); });
      return () => { cancelled = true; };
    }
    updateAuthSession(loadStoredAuthSession());
    setAuthReady(true);

    const syncAuth = (event: StorageEvent) => {
      if (event.key !== authSessionStorageKey && event.key !== null) return;
      updateAuthSession(loadStoredAuthSession(), false);
    };
    window.addEventListener("storage", syncAuth);
    return () => window.removeEventListener("storage", syncAuth);
  }, [updateAuthSession]);

  useEffect(() => {
    if (isDesktopLocal || !authReady || !authToken) return;

    const expire = () => {
      if (authSessionRef.current?.token !== authToken) return;
      updateAuthSession(null);
      setAuthError("Session expired. Please enter your password again.");
    };
    const checkExpiry = () => {
      if (authSessionRef.current && Date.now() >= authSessionRef.current.expiresAt) expire();
    };
    const timer = window.setTimeout(checkExpiry, Math.max(0, authExpiresAt - Date.now()));
    window.addEventListener("focus", checkExpiry);
    window.addEventListener("pageshow", checkExpiry);
    document.addEventListener("visibilitychange", checkExpiry);
    window.addEventListener("luma:unauthorized", expire);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", checkExpiry);
      window.removeEventListener("pageshow", checkExpiry);
      document.removeEventListener("visibilitychange", checkExpiry);
      window.removeEventListener("luma:unauthorized", expire);
    };
  }, [authReady, authToken, authExpiresAt, updateAuthSession]);

  useEffect(() => {
    if (isDesktopLocal || !authToken || !idleTimeoutMs) return;
    const controller = new AbortController();
    let lastAttemptAt = 0;
    let recording = false;

    const onActivity = (event: Event) => {
      const now = Date.now();
      const session = authSessionRef.current;
      if (!event.isTrusted || document.visibilityState !== "visible" || !session || session.token !== authToken) return;
      if (now >= session.expiresAt || recording || now - lastAttemptAt < cloudActivityIntervalMs) return;

      lastAttemptAt = now;
      recording = true;
      void recordCloudActivity(controller.signal).then(({ expiresAt }) => {
        const current = authSessionRef.current;
        if (!controller.signal.aborted && current?.token === authToken && expiresAt > current.expiresAt) {
          updateAuthSession({ ...current, expiresAt });
        }
      }).catch(() => {
        // Keep the current expiry if offline. A later interaction may retry.
      }).finally(() => { recording = false; });
    };

    const inputEvents = ["pointerdown", "keydown", "wheel"] as const;
    const options = { capture: true, passive: true };
    for (const name of inputEvents) window.addEventListener(name, onActivity, options);
    return () => {
      controller.abort();
      for (const name of inputEvents) window.removeEventListener(name, onActivity, options);
    };
  }, [authToken, idleTimeoutMs, updateAuthSession]);

  useEffect(() => {
    if (!activeWorkspace || pendingAttachments.length === 0) return;
    if (pendingAttachmentWorkspace === null || pendingAttachmentWorkspace === activeWorkspace) return;

    setPendingAttachments([]);
    setPendingAttachmentWorkspace(activeWorkspace);
    setAttachmentError("Attachments were cleared after changing workspace.");
    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
  }, [activeWorkspace, pendingAttachmentWorkspace, pendingAttachments.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) {
      setVoiceSupported(false);
      return;
    }

    setVoiceSupported(true);
    const recognition = new SpeechRecognitionImpl();
    recognition.lang = window.navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setVoiceListening(true);
      setVoiceError(null);
      const now = Date.now();
      setVoiceRecordingStartedAt(now);
      setVoiceRecordingSeconds(0);
    };

    recognition.onend = () => {
      setVoiceListening(false);
      setVoiceRecordingStartedAt(null);
      setVoiceRecordingSeconds(0);
    };

    recognition.onerror = (event) => {
      setVoiceError(toSpeechErrorMessage(event.error));
      setVoiceListening(false);
      setVoiceRecordingStartedAt(null);
      setVoiceRecordingSeconds(0);
    };

    recognition.onresult = (event) => {
      const start = typeof event.resultIndex === "number" ? event.resultIndex : 0;
      let finalized = "";

      for (let index = start; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const transcript = (result[0]?.transcript || "").trim();
        if (!transcript) continue;
        if (result.isFinal) {
          finalized += `${transcript} `;
        }
      }

      const finalizedText = finalized.trim();
      if (finalizedText) {
        setPrompt((current) => appendTranscriptToPrompt(current, finalizedText));
      }
    };

    speechRecognitionRef.current = recognition;

    return () => {
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.stop();
      } catch {
        // ignore stop errors during teardown
      }
      if (speechRecognitionRef.current === recognition) {
        speechRecognitionRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!recording || recordingStartedAt === null) {
      setVoiceRecordingSeconds(0);
      return;
    }

    const tick = () => {
      setVoiceRecordingSeconds(Math.floor((Date.now() - recordingStartedAt) / 1000));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [recording, recordingStartedAt]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      if (Object.keys(queuedBySession).length === 0) {
        removeLocalStorageWithLegacy(queueStorageKey, legacyQueueStorageKey);
        return;
      }
      window.localStorage.setItem(queueStorageKey, JSON.stringify(queuedBySession));
      window.localStorage.removeItem(legacyQueueStorageKey);
    } catch {
      // ignore localStorage write errors
    }
  }, [queuedBySession]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      if (Object.keys(terminalHistoryBySession).length === 0) {
        removeLocalStorageWithLegacy(terminalHistoryStorageKey, legacyTerminalHistoryStorageKey);
        return;
      }
      window.localStorage.setItem(terminalHistoryStorageKey, JSON.stringify(terminalHistoryBySession));
      window.localStorage.removeItem(legacyTerminalHistoryStorageKey);
    } catch {
      // ignore localStorage write errors
    }
  }, [terminalHistoryBySession]);

  useEffect(() => {
    if (!authReady) return;
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    void loadSessionList();
  }, [authReady, isAuthenticated, showAllHistory]);

  useEffect(() => {
    if (!authReady || typeof window === "undefined" || window.lumaDesktop) return;
    const controller = createScreenWakeLockController();
    controller.setEnabled(isAuthenticated);
    return () => {
      controller.dispose();
    };
  }, [authReady, isAuthenticated]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) {
      setBackendConnectionStatus("disconnected");
      return;
    }
    setBackendConnectionStatus("connecting");
    let es: EventSource | null = null;
    let hasOpenedOnce = false;
    let shouldRefreshSelectedSession = false;

    const refreshSelectedSessionState = (options?: { forceMessages?: boolean }) => {
      const currentSelectedSessionId = selectedSessionIdRef.current;
      if (currentSelectedSessionId) {
        // On a healthy live stream, skip reload when the timeline is already warm.
        // After mobile screen-off / stale SSE, force a message reload — upserts were missed.
        const existing = messagesByRunIdRef.current[currentSelectedSessionId];
        const shouldReloadMessages = Boolean(options?.forceMessages) || !existing || existing.length === 0;
        if (shouldReloadMessages) {
          void loadRunMessagesPage(currentSelectedSessionId, { reset: true });
        }
      }
      const currentSelectedRunId = selectedRunIdRef.current;
      if (currentSelectedRunId) {
        void loadSelectedRunRecord(currentSelectedRunId);
      }
    };

    const refreshRealtimeState = (options?: { forceMessages?: boolean }) => {
      void refreshRunList(selectedSessionIdRef.current);
      refreshSelectedSessionState(options);
    };

    const openEventStream = () => {
      es?.close();
      es = connectEvents((event) => {
        lastEventAtRef.current = Date.now();
        if (event.kind === "heartbeat") return;
        if (event.kind === "project.updated" || event.kind === "memory.updated") {
          projectState.invalidate();
          if (event.kind === "project.updated" && typeof event.payload?.sessionId === "string") {
            const { sessionId, projectId } = event.payload;
            updateSessionProject(sessionId, typeof projectId === "string" ? projectId : null);
          }
          return;
        }

        if (event.kind === "terminal.started" || event.kind === "terminal.stopped") {
          const terminal = readTerminalSnapshot(event.payload);
          if (!terminal) return;
          setTerminalsBySession((prev) => ({ ...prev, [terminal.sessionId]: terminal }));
          return;
        }

        if (event.kind === "terminal.output") {
          const sessionId = typeof event.sessionId === "string"
            ? event.sessionId
            : typeof event.payload?.sessionId === "string"
              ? event.payload.sessionId
              : "";
          if (!sessionId) return;
          const chunk = typeof event.payload?.text === "string" ? event.payload.text : "";
          if (!chunk) return;

          setTerminalsBySession((prev) => {
            const existing = prev[sessionId];
            if (!existing) return prev;
            const merged = `${existing.output}${chunk}`;
            const output = merged.length > 220000 ? merged.slice(merged.length - 220000) : merged;
            return {
              ...prev,
              [sessionId]: {
                ...existing,
                output,
                status: "running",
                updatedAt: event.at || Date.now(),
              },
            };
          });
          return;
        }

        if (event.kind === "session.upsert") {
          const session = readSessionListItem(event.payload?.session);
          if (!session) return;
          const previousSessionId = typeof event.payload?.previousSessionId === "string" ? event.payload.previousSessionId : null;
          applySessionUpsert(session, previousSessionId);
          return;
        }

        if (event.kind === "message.upsert" || event.kind === "message.ack" || event.kind === "message.failed") {
          const message = readChatMessage(event.payload?.message);
          if (!message) return;
          applyIncomingMessage(message);
          if (message.runId && message.runId === selectedRunIdRef.current) {
            void loadSelectedRunRecord(message.runId);
          }
          return;
        }

        if (
          (event.kind === "run.started"
            || event.kind === "run.completed"
            || event.kind === "run.failed"
            || event.kind === "run.stopped")
          && event.runId
          && event.runId === selectedRunIdRef.current
        ) {
          void loadSelectedRunRecord(event.runId);
          return;
        }

      });

      es.onopen = () => {
        lastEventAtRef.current = Date.now();
        setBackendConnectionStatus("connected");
        if (!hasOpenedOnce) {
          hasOpenedOnce = true;
          shouldRefreshSelectedSession = false;
          return;
        }
        if (!shouldRefreshSelectedSession) return;
        shouldRefreshSelectedSession = false;
        // Reconnected after a drop (common when mobile screen turns off): reload chat.
        refreshRealtimeState({ forceMessages: true });
      };

      es.onerror = () => {
        setBackendConnectionStatus("disconnected");
        if (!hasOpenedOnce) return;
        shouldRefreshSelectedSession = true;
      };
    };

    const ensureFreshRealtimeState = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine) return;

      const isStale = Date.now() - lastEventAtRef.current > eventStreamHeartbeatStaleMs;
      const streamDead = !es || es.readyState === EventSource.CLOSED || isStale;
      const forceMessages = streamDead || shouldRefreshSelectedSession;

      refreshRealtimeState({ forceMessages });

      if (streamDead) {
        shouldRefreshSelectedSession = true;
        setBackendConnectionStatus("connecting");
        openEventStream();
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      ensureFreshRealtimeState();
    };

    const handlePageShow = () => {
      ensureFreshRealtimeState();
    };

    openEventStream();

    const watchdog = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (Date.now() - lastEventAtRef.current <= eventStreamHeartbeatStaleMs) return;
      shouldRefreshSelectedSession = true;
      setBackendConnectionStatus("connecting");
      openEventStream();
      refreshRealtimeState({ forceMessages: true });
    }, eventStreamWatchdogIntervalMs);

    window.addEventListener("focus", ensureFreshRealtimeState);
    window.addEventListener("online", ensureFreshRealtimeState);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(watchdog);
      window.removeEventListener("focus", ensureFreshRealtimeState);
      window.removeEventListener("online", ensureFreshRealtimeState);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      es?.close();
    };
  }, [authReady, isAuthenticated, authToken]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;

    // Poll only when SSE looks stale. Healthy event streams already push
    // session.upsert / message / run events into local state.
    const timer = window.setInterval(() => {
      if (autoRefreshInFlightRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine) return;
      if (Date.now() - lastEventAtRef.current <= eventStreamHeartbeatStaleMs) return;

      autoRefreshInFlightRef.current = true;
      void (async () => {
        try {
          await refreshRunList(selectedSessionIdRef.current);
          const selectedSessionId = selectedSessionIdRef.current;
          if (selectedSessionId) {
            await loadRunMessagesPage(selectedSessionId, { reset: true });
          }
          const selectedRunId = selectedRunIdRef.current;
          if (selectedRunId) await loadSelectedRunRecord(selectedRunId);
        } catch {
          // Keep polling quiet; SSE/focus refresh paths surface recoverable state later.
        } finally {
          autoRefreshInFlightRef.current = false;
        }
      })();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [authReady, isAuthenticated]);

  useEffect(() => {
    if (!authReady || !isAuthenticated || sidebarMode !== "agents") return;
    void ensureAppDefaults().then(() => refreshAgentSchedules());
    const timer = window.setInterval(() => {
      void refreshAgentSchedules();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [authReady, isAuthenticated, sidebarMode]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    if (!skillPickerOpen && !agentPickerOpen) return;
    void (async () => {
      await ensureAppDefaults();
      if (skillPickerOpen) await refreshSkillCatalog();
      if (agentPickerOpen) await refreshAgentSchedules();
    })();
  }, [authReady, isAuthenticated, skillPickerOpen, agentPickerOpen]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    if (!newSessionDialogOpen && !mobileContextOpen) return;
    void ensureAppDefaults();
  }, [authReady, isAuthenticated, newSessionDialogOpen, mobileContextOpen]);

  useEffect(() => {
    const options = modelOptionsForRunner(runner, cursorModels);
    setAgentScheduleModel((current) => (
      options.includes(current)
        ? current
        : defaultModelForRunner(runner, {
          codex: defaultCodexModel,
          claude: defaultClaudeModel,
          cursor: defaultCursorModel,
        })
    ));
    setAgentScheduleEffort((current) => (
      reasoningEffortOptionsForRunner(runner, model).includes(current) ? current : "high"
    ));
  }, [runner]);

  const allSessions = useMemo(() => buildSessionCards(runItems), [runItems]);
  useEffect(() => {
    try {
      window.localStorage.setItem(sessionReviewStorageKey, JSON.stringify(sessionReviews));
    } catch {
      // Keep reviews in memory if browser storage is unavailable.
    }
  }, [sessionReviews]);
  const filteredSessions = useMemo(() => {
    const visibleSessions = showAllHistory
      ? allSessions
      : allSessions.filter((session) => !session.scheduled);
    if (statusFilter === "all") return visibleSessions;
    return visibleSessions.filter((session) => session.status === statusFilter);
  }, [allSessions, showAllHistory, statusFilter]);

  const selectedSession = useMemo(
    () => allSessions.find((session) => session.id === selectedSessionId) || null,
    [allSessions, selectedSessionId],
  );
  const currentProjectId = selectedSessionId ? selectedSession?.projectId ?? null : draftProjectId;
  useEffect(() => {
    if (currentProjectId) setExpandedProjects((current) => ({ ...current, [currentProjectId]: true }));
  }, [currentProjectId]);
  const selectedTerminal = useMemo(
    () => (selectedSessionId ? terminalsBySession[selectedSessionId] || null : null),
    [selectedSessionId, terminalsBySession],
  );
  const selectedTerminalHistory = useMemo(
    () => (selectedSessionId ? terminalHistoryBySession[selectedSessionId] || [] : []),
    [selectedSessionId, terminalHistoryBySession],
  );

  const sessionTimelineKey = selectedSessionId || draftSessionKey;
  const planSessionState = planFlowBySession[sessionTimelineKey] || "idle";
  const timeline = useMemo(() => {
    const base = messagesByRunId[sessionTimelineKey] || [];
    const slashEntries = slashEntriesBySession[sessionTimelineKey] || [];
    return [...base, ...slashEntries].sort((a, b) => a.at - b.at);
  }, [messagesByRunId, sessionTimelineKey, slashEntriesBySession]);
  const debugLogs = useMemo(
    () => collectSessionDebugLogs(selectedRunRecord ? [selectedRunRecord] : []),
    [selectedRunRecord],
  );
  const visibleTimeline = timeline;
  const hiddenTimelineCount = selectedSessionId && messageNextCursorByRunId[selectedSessionId] ? messagePageSize : 0;
  const slashSuggestions = useMemo(() => {
    const trimmed = prompt.trimStart();
    if (!trimmed.startsWith("/")) return [] as SlashCommandSuggestion[];
    const token = trimmed.split(/\s+/)[0].toLowerCase();
    return slashCommandSuggestions.filter((item) => item.key.startsWith(token) || item.key.includes(token));
  }, [prompt]);
  const agentQueryToken = useMemo(() => findAgentQueryToken(prompt), [prompt]);
  const skillQueryToken = useMemo(() => findSkillQueryToken(prompt), [prompt]);
  const visibleSkillCatalog = useMemo(() => dedupeSkillCatalog(skillCatalog), [skillCatalog]);
  const selectedSkillKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const selected of selectedSkills) {
      const match = skillCatalog.find((skill) => skill.id === selected.id || skill.path === selected.path);
      keys.add(match ? skillIdentityKey(match) : selected.id);
    }
    return keys;
  }, [selectedSkills, skillCatalog]);
  const selectedPromptAgentIds = useMemo(() => new Set(selectedPromptAgents.map((agent) => agent.id)), [selectedPromptAgents]);
  const filteredSkills = useMemo(() => {
    const query = (skillQueryToken?.query || "").toLowerCase();
    return visibleSkillCatalog
      .filter((skill) => showSystemSkills || !isSystemSkill(skill))
      .filter((skill) => !selectedSkillKeys.has(skillIdentityKey(skill)))
      .filter((skill) => {
        if (!query) return true;
        return skill.name.toLowerCase().includes(query)
          || skill.description.toLowerCase().includes(query)
          || skill.path.toLowerCase().includes(query)
          || skill.source.toLowerCase().includes(query);
      })
      .slice(0, 30);
  }, [visibleSkillCatalog, selectedSkillKeys, showSystemSkills, skillQueryToken]);
  const filteredPromptAgents = useMemo(() => {
    const query = (agentQueryToken?.query || "").toLowerCase();
    return agents
      .filter((agent) => !selectedPromptAgentIds.has(agent.id))
      .filter((agent) => {
        if (!query) return true;
        return agent.name.toLowerCase().includes(query)
          || agent.description.toLowerCase().includes(query)
          || agent.slug.toLowerCase().includes(query)
          || agent.path.toLowerCase().includes(query);
      })
      .slice(0, 30);
  }, [agents, selectedPromptAgentIds, agentQueryToken]);
  const busySessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of allSessions) {
      if (!item.historyOnly && (item.status === "queued" || item.status === "running")) ids.add(item.sessionId);
    }
    return ids;
  }, [allSessions]);
  const queuedMessagesForActiveSession = queuedBySession[sessionTimelineKey] || [];

  const mobileHeaderTitle = selectedSession
    ? truncatePreview(selectedSession.summary || `Session ${selectedSession.id}`, 34)
    : "Luma Assistant";

  const hasPendingTimelineEntry = timeline.some((entry) => entry.pending);

  useEffect(() => {
    if (agentQueryToken) {
      setSkillPickerOpen(false);
      setAgentPickerOpen(true);
      setHighlightedAgentIndex(0);
      return;
    }
    if (!skillQueryToken) {
      setSkillPickerOpen(false);
      setAgentPickerOpen(false);
      setHighlightedSkillIndex(0);
      setHighlightedAgentIndex(0);
      return;
    }
    setAgentPickerOpen(false);
    setSkillPickerOpen(true);
    setHighlightedSkillIndex(0);
  }, [agentQueryToken?.start, agentQueryToken?.query, skillQueryToken?.start, skillQueryToken?.query]);

  useEffect(() => {
    if (filteredSkills.length > 0 && highlightedSkillIndex >= filteredSkills.length) {
      setHighlightedSkillIndex(Math.max(0, filteredSkills.length - 1));
    }
  }, [filteredSkills.length, highlightedSkillIndex]);

  useEffect(() => {
    if (filteredPromptAgents.length > 0 && highlightedAgentIndex >= filteredPromptAgents.length) {
      setHighlightedAgentIndex(Math.max(0, filteredPromptAgents.length - 1));
    }
  }, [filteredPromptAgents.length, highlightedAgentIndex]);

  useEffect(() => {
    const previous = previousTimelineStateRef.current;
    const sessionChanged = previous.sessionKey !== sessionTimelineKey;
    const hasNewTimelineItems = timeline.length > previous.length;

    previousTimelineStateRef.current = {
      sessionKey: sessionTimelineKey,
      length: timeline.length,
    };

    if (!sessionChanged && !hasNewTimelineItems) return;
    if (!sessionChanged && !timelineShouldAutoScrollRef.current) return;

    scrollTimelineToBottom(sessionChanged ? "auto" : "smooth");
  }, [timeline.length, sessionTimelineKey]);

  useEffect(() => {
    const pending = pendingTimelineExpansionRef.current;
    if (!pending || pending.sessionKey !== sessionTimelineKey) return;
    const node = timelineScrollRef.current;
    if (!node) return;

    suppressTimelineScrollTracking(100);
    node.scrollTop = pending.scrollTop + (node.scrollHeight - pending.scrollHeight);
    timelineShouldAutoScrollRef.current = false;
    pendingTimelineExpansionRef.current = null;
  }, [visibleTimeline.length, sessionTimelineKey]);

  useEffect(() => {
    if (!selectedSessionId) {
      if (isDraftSession) {
        setSelectedRunId(null);
        return;
      }
      setSelectedRunId(null);
      return;
    }

    const selected = allSessions.find((session) => session.id === selectedSessionId);
    if (selected) {
      if (selectedRunId !== selected.latestRunId) {
        setSelectedRunId(selected.latestRunId);
      }
      return;
    }

    if (messagesByRunId[selectedSessionId]?.length) {
      return;
    }

    setSelectedSessionId(null);
    setSelectedRunId(null);
  }, [allSessions, isDraftSession, messagesByRunId, selectedRunId, selectedSessionId, setSelectedRunId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setTerminalInput("");
      return;
    }
    setTerminalInput("");
    void loadTerminal(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (isDraftSession || !selectedSessionId || !selectedSession) {
      setSelectedRunRecord(null);
      return;
    }
    void loadRunMessagesPage(selectedSessionId, { reset: true });
  }, [isDraftSession, selectedSessionId, selectedSession?.id]);

  useEffect(() => {
    if (isDraftSession || !selectedSessionId || !selectedSession || selectedSession.historyOnly || !selectedSession.latestRunId) {
      setSelectedRunRecord(null);
      return;
    }
    void loadSelectedRunRecord(selectedSession.latestRunId);
  }, [isDraftSession, selectedSessionId, selectedSession?.historyOnly, selectedSession?.latestRunId]);

  useEffect(() => {
    const node = terminalOutputRef.current;
    if (!node || !selectedSessionId || !selectedTerminal) return;
    node.scrollTop = node.scrollHeight;
  }, [selectedSessionId, selectedTerminal?.output]);

  useEffect(() => {
    if (!authReady || !isAuthenticated || loadingRunList || submitting || processingQueueRef.current) return;

    for (const [sessionKey, [head]] of Object.entries(queuedBySession)) {
      if (!head || head.deliveryError || sessionKey === draftSessionKey || busySessionIds.has(sessionKey)) continue;
      processingQueueRef.current = head.id;
      setProcessingQueueItemId(head.id);
      void runQueuedMessage(head);
      return;
    }
  }, [authReady, isAuthenticated, loadingRunList, queuedBySession, busySessionIds, submitting]);

  async function onAuthenticate(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (!authPasswordInput.trim() || authSubmitting) return;

    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const payload = await loginWithPassword(authPasswordInput);
      updateAuthSession({
        token: payload.token,
        expiresAt: Math.min(payload.expiresAt, Date.now() + authSessionMaxAgeMs),
        idleTimeoutMs: payload.idleTimeoutMs,
      });
      setAuthPasswordInput("");
      setLoading(true);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
      updateAuthSession(null);
    } finally {
      setAuthSubmitting(false);
    }
  }

  function onSignOut(): void {
    if (authSessionRef.current?.idleTimeoutMs) void revokeCloudSession().catch(() => {});
    updateAuthSession(null);
    setAuthPasswordInput("");
    setRemoteMacsOpen(false);
    setRemoteWorkspaceOpen(false);
    setAuthError(null);
    setBackendConnectionStatus("disconnected");
  }

  function applyAgentScheduleState(payload: {
    agents: AgentListItem[];
    schedules: AgentSchedule[];
    upcoming: AgentSchedule[];
    executions: AgentScheduleExecution[];
    skillSync: SkillSyncResult;
  }): void {
    setAgents(payload.agents);
    setAgentSchedules(payload.schedules);
    setUpcomingAgentSchedules(payload.upcoming);
    setAgentExecutions(payload.executions);
    setSkillSyncResult(payload.skillSync);
    setAgentsError(null);
    setSelectedAgentId((current) => {
      if (current && payload.agents.some((agent) => agent.id === current)) return current;
      return payload.agents[0]?.id || "";
    });
  }

  async function loadSessionList(): Promise<void> {
    setLoading(true);
    setLoadingRunList(true);
    try {
      const includeHistory = showAllHistoryRef.current;
      const listPayload = await getSessionList(runListPageSize, null, includeHistory);
      if (includeHistory !== showAllHistoryRef.current) return;
      const normalizedItems = normalizeSessionItems(listPayload.items);
      setRunItems(normalizedItems);
      setRunListNextCursor(listPayload.nextCursor);
      const sessions = buildSessionCards(normalizedItems);
      if (isDraftSessionRef.current) return;
      if (selectedSessionIdRef.current) {
        const current = sessions.find((session) => session.id === selectedSessionIdRef.current);
        if (current) {
          setSelectedRunId(current.latestRunId);
          return;
        }
      }
      if (selectedRunIdRef.current) {
        const current = findSessionByRunId(sessions, selectedRunIdRef.current);
        if (current) {
          setSelectedSessionId(current.id);
          setSelectedRunId(current.latestRunId);
          return;
        }
      }
      setSelectedSessionId(null);
      setSelectedRunId(null);
    } finally {
      setLoadingRunList(false);
      setLoading(false);
    }
  }

  async function ensureAppDefaults(): Promise<string> {
    if (appDefaultsLoadedRef.current) return activeWorkspaceRef.current;
    if (appDefaultsRequestRef.current) return appDefaultsRequestRef.current;
    const request = (async () => {
      const payload = await getBootstrapLite();
      setWorkspaces(payload.workspaces);
      setWorkspace(payload.activeWorkspace);
      activeWorkspaceRef.current = payload.activeWorkspace;
      setDefaultCodexModel(payload.defaults.codexModel);
      setDefaultClaudeModel(payload.defaults.claudeModel);
      setDefaultCursorModel(payload.defaults.cursorModel || "composer-2.5");
      setClaudeEffortFlagSupported(payload.defaults.claudeEffortFlagSupported);
      setClaudeAvailable(payload.defaults.claudeAvailable ?? !isDesktopLocal);
      setCursorAvailable(Boolean(payload.defaults.cursorAvailable));
      setCursorModels(Array.isArray(payload.defaults.cursorModels) ? payload.defaults.cursorModels : []);
      if (!modelControlsTouchedRef.current) {
        setRunnerState(payload.defaults.runner);
        setModel(payload.defaults.model);
        setReasoningEffort(payload.defaults.reasoningEffort);
        setAgentScheduleModel(payload.defaults.model || "gpt-5.4");
        setAgentScheduleEffort(payload.defaults.reasoningEffort);
        setSandbox(payload.defaults.sandbox);
      }
      appDefaultsLoadedRef.current = true;
      return payload.activeWorkspace;
    })();
    appDefaultsRequestRef.current = request;
    try { return await request; } finally { appDefaultsRequestRef.current = null; }
  }

  async function refreshSkillCatalog(workspace = activeWorkspace): Promise<void> {
    const resolvedWorkspace = workspace || await ensureAppDefaults();
    if (!resolvedWorkspace) return;
    setSkillsLoading(true);
    try {
      const payload = await getSkills(resolvedWorkspace);
      setSkillCatalog(payload.skills);
      setSkillsError(null);
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : "Failed to load skills");
    } finally {
      setSkillsLoading(false);
    }
  }

  async function refreshAgentSchedules(): Promise<void> {
    setAgentsLoading(true);
    try {
      const payload = await getAgentSchedules();
      applyAgentScheduleState(payload);
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : "Failed to load agents");
    } finally {
      setAgentsLoading(false);
    }
  }

  async function onReloadAgentsAndSkills(): Promise<void> {
    setAgentsLoading(true);
    setSkillsLoading(true);
    try {
      const [agentPayload, skillsPayload] = await Promise.all([
        reloadAgentsAndSkills(),
        getSkills(activeWorkspace),
      ]);
      applyAgentScheduleState(agentPayload);
      setSkillCatalog(skillsPayload.skills);
      setSkillsError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reload agents and skills";
      setAgentsError(message);
      setSkillsError(message);
    } finally {
      setAgentsLoading(false);
      setSkillsLoading(false);
    }
  }

  async function refreshRunList(preferredSessionId?: string | null): Promise<void> {
    const includeHistory = showAllHistoryRef.current;
    const payload = await getSessionList(runListPageSize, null, includeHistory);
    if (includeHistory !== showAllHistoryRef.current) return;
    const normalizedItems = normalizeSessionItems(payload.items);
    setRunItems(normalizedItems);
    setRunListNextCursor(payload.nextCursor);

    if (isDraftSessionRef.current) return;

    const sessions = buildSessionCards(normalizedItems);
    const deepLinkSessionId = (() => {
      try {
        return new URLSearchParams(window.location.search).get("session")?.trim() || null;
      } catch {
        return null;
      }
    })();
    const preferredId = deepLinkSessionId || preferredSessionId;
    const preferred = preferredId
      ? sessions.find((session) => session.id === preferredId)
      : null;
    if (preferred && (deepLinkSessionId || !selectedSessionIdRef.current)) {
      setSelectedSessionId(preferred.id);
      setSelectedRunId(preferred.latestRunId);
      setIsDraftSession(false);
      if (deepLinkSessionId && preferred.id === deepLinkSessionId) {
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("session");
          window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        } catch {
          // ignore history cleanup failures
        }
      }
      return;
    }

    if (selectedSessionIdRef.current) {
      const current = sessions.find((session) => session.id === selectedSessionIdRef.current);
      if (current) {
        setSelectedRunId(current.latestRunId);
      }
      return;
    }

    if (selectedRunIdRef.current) {
      const current = findSessionByRunId(sessions, selectedRunIdRef.current);
      if (current) {
        setSelectedSessionId(current.id);
        setSelectedRunId(current.latestRunId);
        return;
      }
    }

    setSelectedSessionId(null);
    setSelectedRunId(null);
  }

  async function loadMoreRunItemsPage(): Promise<void> {
    if (!runListNextCursor || loadingMoreRunItems) return;
    setLoadingMoreRunItems(true);
    try {
      const includeHistory = showAllHistoryRef.current;
      const payload = await getSessionList(runListPageSize, runListNextCursor, includeHistory);
      if (includeHistory !== showAllHistoryRef.current) return;
      setRunItems((prev) => {
        const next = new Map(prev.map((item) => [item.id, item]));
        for (const item of payload.items) next.set(item.id, item);
        return normalizeSessionItems([...next.values()]);
      });
      setRunListNextCursor(payload.nextCursor);
    } finally {
      setLoadingMoreRunItems(false);
    }
  }

  async function loadRunMessagesPage(sessionId: string, options?: { reset?: boolean; before?: string | null }): Promise<void> {
    const before = options?.reset ? null : (options?.before ?? messageNextCursorByRunId[sessionId] ?? null);
    if (!options?.reset && !before) return;

    setLoadingMessagesByRunId((prev) => ({ ...prev, [sessionId]: true }));
    try {
      const payload = await getSessionMessages(sessionId, before);
      setMessagesByRunId((prev) => ({
        ...prev,
        [sessionId]: options?.reset
          ? timelineEntriesFromMessages(payload.messages)
          : mergeTimelineEntries(
            timelineEntriesFromMessages(payload.messages),
            prev[sessionId] || [],
          ),
      }));
      setMessageNextCursorByRunId((prev) => ({ ...prev, [sessionId]: payload.nextCursor }));
      if (selectedSessionIdRef.current === sessionId && payload.latestRunId !== undefined) {
        setSelectedRunId(payload.latestRunId);
      }
    } finally {
      setLoadingMessagesByRunId((prev) => ({ ...prev, [sessionId]: false }));
    }
  }

  async function reloadSelectedChat(): Promise<void> {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) return;
    await loadRunMessagesPage(sessionId, { reset: true });
    const runId = selectedRunIdRef.current;
    if (runId) {
      await loadSelectedRunRecord(runId);
    } else {
      setSelectedRunRecord(null);
    }
  }

  async function loadTokenUsageForSession(sessionId: string): Promise<void> {
    setTokenUsageLoadingSessionId(sessionId);
    setTokenUsageError(null);
    try {
      const payload = await getSessionTokenUsage(sessionId);
      setTokenUsageBySession((prev) => ({ ...prev, [sessionId]: payload.usage }));
    } catch (error) {
      setTokenUsageError(error instanceof Error ? error.message : "Failed to load token usage");
    } finally {
      setTokenUsageLoadingSessionId((current) => (current === sessionId ? null : current));
    }
  }

  async function loadSelectedRunRecord(runId: string): Promise<void> {
    try {
      const payload = await getRun(runId);
      setSelectedRunRecord(payload.run);
    } catch {
      setSelectedRunRecord(null);
    }
  }

  function scheduleSelectedRunRefresh(sessionKey: string, runId: string | null): void {
    if (selectedRunRefreshTimeoutRef.current !== null) {
      window.clearTimeout(selectedRunRefreshTimeoutRef.current);
    }

    selectedRunRefreshTimeoutRef.current = window.setTimeout(() => {
      selectedRunRefreshTimeoutRef.current = null;
      void loadRunMessagesPage(sessionKey, { reset: true });
      if (runId) {
        void loadSelectedRunRecord(runId);
      } else {
        setSelectedRunRecord(null);
      }
    }, 150);
  }

  async function loadTerminal(sessionId: string): Promise<void> {
    try {
      const payload = await getTerminal(sessionId);
      setTerminalsBySession((prev) => {
        if (!payload.terminal) {
          if (!(sessionId in prev)) return prev;
          const next = { ...prev };
          delete next[sessionId];
          return next;
        }
        return { ...prev, [sessionId]: payload.terminal };
      });
    } catch {
      // ignore terminal fetch errors in background
    }
  }

  function moveSessionCollections(previousSessionId: string, nextSessionId: string): void {
    setMessagesByRunId((prev) => {
      if (!(previousSessionId in prev) || previousSessionId === nextSessionId) return prev;
      const next = { ...prev, [nextSessionId]: mergeTimelineEntries(prev[previousSessionId] || [], prev[nextSessionId] || []) };
      delete next[previousSessionId];
      return next;
    });
    setMessageNextCursorByRunId((prev) => {
      if (!(previousSessionId in prev) || previousSessionId === nextSessionId) return prev;
      const next = { ...prev, [nextSessionId]: prev[nextSessionId] ?? prev[previousSessionId] ?? null };
      delete next[previousSessionId];
      return next;
    });
    setLoadingMessagesByRunId((prev) => {
      if (!(previousSessionId in prev) || previousSessionId === nextSessionId) return prev;
      const next = { ...prev, [nextSessionId]: prev[nextSessionId] ?? prev[previousSessionId] ?? false };
      delete next[previousSessionId];
      return next;
    });
    setSlashEntriesBySession((prev) => {
      if (!(previousSessionId in prev) || previousSessionId === nextSessionId) return prev;
      const next = {
        ...prev,
        [nextSessionId]: mergeTimelineEntries(prev[previousSessionId] || [], prev[nextSessionId] || []),
      };
      delete next[previousSessionId];
      return next;
    });
    setQueuedBySession((prev) => {
      if (!(previousSessionId in prev) || previousSessionId === nextSessionId) return prev;
      const next = {
        ...prev,
        [nextSessionId]: [...(prev[nextSessionId] || []), ...prev[previousSessionId].map((item) => ({ ...item, sessionKey: nextSessionId }))]
          .sort((left, right) => left.createdAt - right.createdAt),
      };
      delete next[previousSessionId];
      return next;
    });
    setPlanFlowBySession((prev) => {
      if (!(previousSessionId in prev) || previousSessionId === nextSessionId) return prev;
      const next = { ...prev, [nextSessionId]: prev[nextSessionId] || prev[previousSessionId] };
      delete next[previousSessionId];
      return next;
    });
  }

  function applySessionUpsert(session: SessionListItem, previousSessionId: string | null): void {
    if (previousSessionId && previousSessionId !== session.id) {
      sessionAliasesRef.current.set(previousSessionId, session.id);
      moveSessionCollections(previousSessionId, session.id);
      if (selectedSessionIdRef.current === previousSessionId) {
        setSelectedSessionId(session.id);
      }
    }

    setRunItems((prev) => {
      const next = new Map(prev.map((item) => [item.id, item]));
      if (previousSessionId && previousSessionId !== session.id) {
        next.delete(previousSessionId);
      }
      next.set(session.id, session);
      return normalizeSessionItems([...next.values()]);
    });

    if (selectedSessionIdRef.current === session.id) {
      setSelectedRunId(session.latestRunId);
    }
  }

  function updateSessionProject(sessionId: string, projectId: string | null): void {
    setRunItems((items) => items.map((item) => (
      item.id === sessionId && item.projectId !== projectId ? { ...item, projectId } : item
    )));
  }

  function resolveSessionAlias(sessionId: string): string {
    let current = sessionId;
    const visited = new Set<string>();
    while (sessionAliasesRef.current.has(current) && !visited.has(current)) {
      visited.add(current);
      current = sessionAliasesRef.current.get(current)!;
    }
    return current;
  }

  function applyIncomingMessage(message: ChatMessage, fromSendResponse = false): void {
    if (isPlaceholderPlanMessage(message)) return;
    const sessionId = resolveSessionAlias(message.sessionId);
    if (message.role === "user" && message.clientMessageId) removeQueuedMessage(sessionId, message.clientMessageId);
    const nextEntry = chatMessageToTimelineEntry({ ...message, sessionId });
    setMessagesByRunId((prev) => {
      const existing = prev[sessionId] || [];
      // An SSE upsert can arrive while the send response is still in flight.
      if (fromSendResponse && existing.some((entry) => entry.messageId === message.id)) return prev;
      return { ...prev, [sessionId]: upsertTimelineEntry(existing, nextEntry) };
    });
  }

  function resolvePlanState(sessionKey: string): PlanSessionState {
    return planFlowBySession[sessionKey] || "idle";
  }

  function shouldUsePlanMode(sessionKey: string): boolean {
    const state = resolvePlanState(sessionKey);
    return state === "armed" || state === "active";
  }

  function moveDraftTimelineEntries(nextSessionKey: string): void {
    if (nextSessionKey === draftSessionKey) return;
    setSlashEntriesBySession((prev) => {
      const draftEntries = prev[draftSessionKey];
      if (!draftEntries?.length) return prev;
      const nextEntries = [...(prev[nextSessionKey] || []), ...draftEntries].slice(-200);
      const next = { ...prev, [nextSessionKey]: nextEntries };
      delete next[draftSessionKey];
      return next;
    });
  }

  function setPlanState(sessionKey: string, nextState: PlanSessionState): void {
    setPlanFlowBySession((prev) => {
      const next = { ...prev };
      if (nextState === "idle") {
        delete next[sessionKey];
      } else {
        next[sessionKey] = nextState;
      }
      return next;
    });
  }

  function chooseEffort(next: ReasoningEffort): void {
    modelControlsTouchedRef.current = true;
    setReasoningEffort(next);
  }

  function chooseScheduleModel(next: string): void {
    modelControlsTouchedRef.current = true;
    setAgentScheduleModel(next);
  }

  function chooseScheduleEffort(next: ReasoningEffort): void {
    modelControlsTouchedRef.current = true;
    setAgentScheduleEffort(next);
  }

  function chooseSandbox(next: SandboxMode): void {
    modelControlsTouchedRef.current = true;
    setSandbox(next);
  }

  function chooseModel(next: string): void {
    modelControlsTouchedRef.current = true;
    setModel(next);
    setReasoningEffort(current => effortForModel(runner, next, current));
  }

  function setRunner(nextRunner: RunRunner): void {
    if (unavailableRunners.includes(nextRunner)) return;
    modelControlsTouchedRef.current = true;
    setRunnerState(nextRunner);
    if (nextRunner !== "cursor") setAskMode(false);
    const nextModel = modelOptionsForRunner(nextRunner, cursorModels).includes(model) ? model : defaultModelForRunner(nextRunner, {
      codex: defaultCodexModel, claude: defaultClaudeModel, cursor: defaultCursorModel,
    });
    setModel(nextModel);
    setReasoningEffort(current => effortForModel(nextRunner, nextModel, current));
  }

  function applyRunConfigToControls(nextRunner: RunRunner, nextModel?: string, nextReasoningEffort?: ReasoningEffort): void {
    modelControlsTouchedRef.current = true;
    setRunnerState(nextRunner);
    if (nextRunner !== "cursor") setAskMode(false);
    if (nextModel?.trim()) {
      setModel(nextModel);
    } else {
      setModel(defaultModelForRunner(nextRunner, {
        codex: defaultCodexModel,
        claude: defaultClaudeModel,
        cursor: defaultCursorModel,
      }));
    }
    setReasoningEffort((current) => {
      const nextEffort = nextReasoningEffort && reasoningEffortOptionsForRunner(nextRunner).includes(nextReasoningEffort)
        ? nextReasoningEffort
        : current;
      return reasoningEffortOptionsForRunner(nextRunner).includes(nextEffort) ? nextEffort : "high";
    });
  }

  useEffect(() => {
    setNewSessionUseCustomModel(!modelOptionsForRunner(runner, cursorModels).includes(model));
  }, [model, runner, cursorModels, modelOptionsForRunner]);

  useEffect(() => {
    if (newSessionDialogOpen || isDraftSession || !selectedRunRecord) return;
    if (selectedSession?.latestRunId && selectedRunRecord.id !== selectedSession.latestRunId) return;
    if (selectedSessionIdRef.current !== runSessionId(selectedRunRecord)) return;
    applyRunConfigToControls(selectedRunRecord.config.runner, selectedRunRecord.config.model, selectedRunRecord.config.reasoningEffort);
  }, [newSessionDialogOpen, isDraftSession, selectedRunRecord?.id, selectedSession?.latestRunId]);

  function buildQueuedMessage(
    sessionKey: string,
    promptValue: string,
    overrides?: {
      attachments?: AttachmentRef[];
      planMode?: boolean;
      askMode?: boolean;
      sandbox?: SandboxMode;
      approvalPolicy?: ApprovalPolicy;
      skills?: SelectedSkillRef[];
      agents?: SelectedAgentRef[];
    },
  ): QueuedMessage {
    const planMode = overrides?.planMode ?? shouldUsePlanMode(sessionKey);
    const nextAskMode = Boolean(overrides?.askMode ?? (sessionKey === draftSessionKey ? askMode : false)) && !planMode;
    const existingSession = allSessions.find((session) => session.id === sessionKey);
    const requestRunner = sessionKey === draftSessionKey ? runner : (existingSession?.runner || runner);
    const requestModel =
      requestRunner === runner
        ? model
        : existingSession?.runner === requestRunner && existingSession.model
          ? existingSession.model
          : selectedRunRecord?.config.runner === requestRunner && selectedRunRecord.config.model
            ? selectedRunRecord.config.model
            : defaultModelForRunner(requestRunner, {
              codex: defaultCodexModel,
              claude: defaultClaudeModel,
              cursor: defaultCursorModel,
            });
    const requestReasoningEffort =
      requestRunner === runner && reasoningEffortOptionsForRunner(requestRunner).includes(reasoningEffort)
        ? reasoningEffort
        : existingSession?.runner === requestRunner && existingSession.reasoningEffort
          ? existingSession.reasoningEffort
          : selectedRunRecord?.config.runner === requestRunner
            ? selectedRunRecord.config.reasoningEffort
            : "high";
    return {
      projectId: sessionKey === draftSessionKey ? draftProjectId : existingSession?.projectId,
      id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionKey,
      prompt: promptValue,
      attachments: readAttachmentRefs(overrides?.attachments),
      createdAt: Date.now(),
      workspace: (isDesktopLocal ? allSessions.find(session => session.id === sessionKey)?.workspace : undefined) || activeWorkspaceRef.current || activeWorkspace,
      runner: requestRunner,
      model: requestModel,
      reasoningEffort: requestReasoningEffort,
      sandbox: overrides?.sandbox ?? (planMode || nextAskMode ? "read-only" : sandbox),
      approvalPolicy: overrides?.approvalPolicy ?? (planMode || nextAskMode ? "never" : approvalPolicy),
      planMode,
      askMode: nextAskMode,
      skills: readSelectedSkillRefs(overrides?.skills ?? selectedSkills.map(selectedSkillRef)),
      agents: readSelectedAgentRefs(overrides?.agents ?? selectedPromptAgents.map(selectedAgentRef)),
    };
  }

  function enqueueMessage(request: QueuedMessage): void {
    const sessionKey = request.sessionKey;
    const queued: QueuedMessage = {
      ...request,
      attachments: readAttachmentRefs(request.attachments),
      skills: readSelectedSkillRefs(request.skills),
      agents: readSelectedAgentRefs(request.agents),
      id: request.id || `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: request.createdAt || Date.now(),
    };

    setQueuedBySession((prev) => ({
      ...prev,
      [sessionKey]: [...(prev[sessionKey] || []), queued],
    }));
  }

  function removeQueuedMessage(sessionKey: string, messageId: string): void {
    sessionKey = resolveSessionAlias(sessionKey);
    setQueuedBySession((prev) => {
      const current = prev[sessionKey] || [];
      const next = current.filter((item) => item.id !== messageId);
      if (next.length === current.length) return prev;
      const copy = { ...prev };
      if (next.length) {
        copy[sessionKey] = next;
      } else {
        delete copy[sessionKey];
      }
      return copy;
    });
  }

  function setQueuedDeliveryError(sessionKey: string, messageId: string, deliveryError?: string): void {
    const sessionId = resolveSessionAlias(sessionKey);
    setQueuedBySession((prev) => {
      const queue = prev[sessionId];
      if (!queue?.some((item) => item.id === messageId)) return prev;
      return {
        ...prev,
        [sessionId]: queue.map((item) => item.id === messageId ? { ...item, deliveryError } : item),
      };
    });
  }

  async function startCodexRun(request: QueuedMessage, focusSession: boolean, showOptimistic = true): Promise<void> {
    if (showOptimistic) {
      const optimisticEntry = buildOptimisticUserEntry(request.sessionKey, request.id, request.prompt, request.attachments);
      setMessagesByRunId((prev) => ({
        ...prev,
        [request.sessionKey]: upsertTimelineEntry(prev[request.sessionKey] || [], optimisticEntry),
      }));
    }

    const input: SendMessageInput = {
      projectId: request.projectId,
      clientMessageId: request.id,
      text: request.prompt,
      attachments: request.attachments,
      workspace: request.workspace,
      runner: request.runner,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      sandbox: request.sandbox,
      approvalPolicy: request.approvalPolicy,
      planMode: request.planMode,
      askMode: request.askMode,
      skills: request.skills,
      agents: request.agents,
      sessionId: request.sessionKey === draftSessionKey ? undefined : resolveSessionAlias(request.sessionKey),
    };

    try {
      const payload = await sendMessage(input);
      const nextSessionKey = resolveSessionAlias(payload.sessionId);

      if (request.sessionKey === draftSessionKey) {
        moveDraftTimelineEntries(nextSessionKey);
        moveSessionCollections(draftSessionKey, nextSessionKey);
        setPlanState(draftSessionKey, "idle");
      }

      if (focusSession && (!selectedSessionIdRef.current || resolveSessionAlias(request.sessionKey) === selectedSessionIdRef.current)) {
        setIsDraftSession(false);
      }

      if (request.planMode) {
        setPlanState(nextSessionKey, "active");
      }

      applyIncomingMessage(payload.message, true);

      if (focusSession && (!selectedSessionIdRef.current || selectedSessionIdRef.current === nextSessionKey)) {
        setSelectedSessionId(nextSessionKey);
        setSelectedRunId(payload.latestRunId);
        setRightPanelTab("terminal");
        setMobileThreadsOpen(false);
      }
    } catch (error) {
      if (showOptimistic) setMessagesByRunId((prev) => {
        const current = prev[request.sessionKey] || [];
        return {
          ...prev,
          [request.sessionKey]: removeTimelineEntryByClientMessageId(current, request.id),
        };
      });
      throw error;
    }
  }

  async function runQueuedMessage(queued: QueuedMessage): Promise<void> {
    setSubmitting(true);
    try {
      await startCodexRun(queued, false, false);
      removeQueuedMessage(queued.sessionKey, queued.id);
    } catch (error) {
      setQueuedDeliveryError(queued.sessionKey, queued.id, error instanceof Error ? error.message : "Unable to send message.");
    } finally {
      processingQueueRef.current = null;
      setProcessingQueueItemId(null);
      setSubmitting(false);
    }
  }

  async function submitSessionMessage(
    promptValue: string,
    options?: {
      sessionKey?: string;
      attachments?: AttachmentRef[];
      planMode?: boolean;
      askMode?: boolean;
      sandbox?: SandboxMode;
      approvalPolicy?: ApprovalPolicy;
      skills?: SelectedSkillRef[];
      agents?: SelectedAgentRef[];
      focusSession?: boolean;
      onBeforeSubmit?: () => void;
      onError?: (message: string) => void;
      onSubmitted?: () => void;
    },
  ): Promise<void> {
    scrollTimelineToBottom("auto");
    const sessionKey = options?.sessionKey || selectedSessionId || draftSessionKey;
    const request = buildQueuedMessage(sessionKey, promptValue, {
      attachments: options?.attachments,
      planMode: options?.planMode,
      askMode: options?.askMode,
      sandbox: options?.sandbox,
      approvalPolicy: options?.approvalPolicy,
      skills: options?.skills,
      agents: options?.agents,
    });
    const focusSession = options?.focusSession ?? (selectedSessionId === sessionKey || sessionKey === draftSessionKey);

    options?.onBeforeSubmit?.();
    setSubmitting(true);
    try {
      await startCodexRun(request, focusSession);
      options?.onSubmitted?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start run";
      options?.onError?.(message);
      throw error;
    } finally {
      setSubmitting(false);
    }
  }

  function clearComposerAttachments(): void {
    setPendingAttachments([]);
    setPendingAttachmentWorkspace(null);
    setAttachmentError(null);
    setUploadingAttachmentNames([]);
    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
  }

  function updatePrompt(value: string): void {
    setPrompt(value);
    if (findAgentQueryToken(value)) {
      setAgentPickerOpen(true);
      setSkillPickerOpen(false);
    } else if (findSkillQueryToken(value)) {
      setSkillPickerOpen(true);
      setAgentPickerOpen(false);
    }
  }

  function selectSkill(skill: SkillListItem): void {
    setSelectedSkills((current) => {
      if (current.some((item) => item.id === skill.id)) return current;
      return [...current, skill].slice(0, 20);
    });
    setPrompt((current) => removeSkillQueryToken(current, findSkillQueryToken(current)));
    setSkillPickerOpen(false);
    setHighlightedSkillIndex(0);
  }

  function selectPromptAgent(agent: AgentListItem): void {
    setSelectedPromptAgents((current) => {
      if (current.some((item) => item.id === agent.id)) return current;
      return [...current, agent].slice(0, 10);
    });
    setPrompt((current) => removeSkillQueryToken(current, findAgentQueryToken(current)));
    setAgentPickerOpen(false);
    setHighlightedAgentIndex(0);
  }

  function removeSelectedSkill(skillId: string): void {
    setSelectedSkills((current) => current.filter((skill) => skill.id !== skillId));
  }

  function removeSelectedPromptAgent(agentId: string): void {
    setSelectedPromptAgents((current) => current.filter((agent) => agent.id !== agentId));
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const activePicker = agentPickerOpen ? "agent" : skillPickerOpen ? "skill" : null;
    if (!activePicker) return;

    if (event.key === "Escape") {
      event.preventDefault();
      setSkillPickerOpen(false);
      setAgentPickerOpen(false);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (activePicker === "agent") {
        setHighlightedAgentIndex((current) => Math.min(current + 1, Math.max(0, filteredPromptAgents.length - 1)));
      } else {
        setHighlightedSkillIndex((current) => Math.min(current + 1, Math.max(0, filteredSkills.length - 1)));
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (activePicker === "agent") {
        setHighlightedAgentIndex((current) => Math.max(0, current - 1));
      } else {
        setHighlightedSkillIndex((current) => Math.max(0, current - 1));
      }
      return;
    }

    if (event.key === "Enter" && activePicker === "agent" && filteredPromptAgents.length > 0) {
      event.preventDefault();
      selectPromptAgent(filteredPromptAgents[highlightedAgentIndex] || filteredPromptAgents[0]);
      return;
    }

    if (event.key === "Enter" && activePicker === "skill" && filteredSkills.length > 0) {
      event.preventDefault();
      selectSkill(filteredSkills[highlightedSkillIndex] || filteredSkills[0]);
    }
  }

  function removePendingAttachment(attachmentId: string): void {
    if (pendingAttachments.length === 1 && pendingAttachments[0]?.id === attachmentId) {
      setPendingAttachmentWorkspace(null);
    }
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setAttachmentError(null);
    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
  }

  async function uploadPendingFiles(files: FileList | null): Promise<void> {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) return;

    const workspace = await ensureAppDefaults();
    if (!workspace) {
      setAttachmentError("Select a workspace before adding attachments.");
      return;
    }

    const remainingCapacity = Math.max(0, attachmentMaxFiles - pendingAttachments.length);
    if (remainingCapacity === 0) {
      setAttachmentError(`You can attach up to ${attachmentMaxFiles} files per message.`);
      if (composerFileInputRef.current) {
        composerFileInputRef.current.value = "";
      }
      return;
    }

    const acceptedFiles = selectedFiles.slice(0, remainingCapacity);
    const skippedCount = selectedFiles.length - acceptedFiles.length;
    setUploadingAttachmentNames((current) => [...current, ...acceptedFiles.map((file) => file.name)]);

    const uploaded: AttachmentRef[] = [];
    const failures: string[] = [];
    for (const file of acceptedFiles) {
      try {
        const payload = await uploadAttachment(file, workspace);
        uploaded.push(payload.attachment);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed";
        failures.push(`${file.name}: ${message}`);
      }
    }

    if (uploaded.length > 0) {
      setPendingAttachments((current) => [...current, ...uploaded].slice(0, attachmentMaxFiles));
      setPendingAttachmentWorkspace(workspace);
    }

    if (failures.length > 0) {
      setAttachmentError(failures[0] || "One or more attachments failed to upload.");
    } else if (skippedCount > 0) {
      setAttachmentError(`Only ${attachmentMaxFiles} attachments are allowed per message.`);
    } else {
      setAttachmentError(null);
    }

    setUploadingAttachmentNames((current) => {
      const next = [...current];
      for (const file of acceptedFiles) {
        const index = next.indexOf(file.name);
        if (index >= 0) next.splice(index, 1);
      }
      return next;
    });

    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
  }

  function pushSlashEntries(sessionKey: string, entries: TimelineEntry[]): void {
    setSlashEntriesBySession((prev) => {
      const current = prev[sessionKey] || [];
      const nextEntries = [...current, ...entries].slice(-200);
      return { ...prev, [sessionKey]: nextEntries };
    });
  }

  function suppressTimelineScrollTracking(durationMs = 250): void {
    suppressTimelineScrollTrackingRef.current = true;
    if (timelineScrollTrackingTimeoutRef.current !== null) {
      window.clearTimeout(timelineScrollTrackingTimeoutRef.current);
    }
    timelineScrollTrackingTimeoutRef.current = window.setTimeout(() => {
      suppressTimelineScrollTrackingRef.current = false;
      timelineScrollTrackingTimeoutRef.current = null;
      const node = timelineScrollRef.current;
      if (node) {
        timelineShouldAutoScrollRef.current = isScrolledToBottom(node);
      }
    }, durationMs);
  }

  function scrollTimelineToBottom(behavior: ScrollBehavior = "smooth"): void {
    timelineShouldAutoScrollRef.current = true;
    suppressTimelineScrollTracking(behavior === "smooth" ? 300 : 100);
    timelineBottomRef.current?.scrollIntoView({ behavior, block: "end" });
  }

  async function runSlashCommand(command: SlashCommandKey, sessionKey: string, rawInput?: string): Promise<void> {
    scrollTimelineToBottom("auto");
    const now = Date.now();
    const messageId = `${now}_${Math.random().toString(36).slice(2, 7)}`;
    const input = (rawInput ?? prompt).trim();
    pushSlashEntries(sessionKey, [
      buildLocalTimelineEntry(sessionKey, `slash_${messageId}_user`, "user", "You", input, now),
    ]);

    if (command === "/plan") {
      const activeState = resolvePlanState(sessionKey);
      if (input !== "/plan") {
        pushSlashEntries(sessionKey, [
          buildLocalTimelineEntry(sessionKey, `slash_${messageId}_plan_usage`, "error", "System", buildPlanUsageText(), now + 1),
        ]);
        return;
      }

      if (activeState === "active") {
        pushSlashEntries(sessionKey, [
          buildLocalTimelineEntry(
            sessionKey,
            `slash_${messageId}_plan_active`,
            "assistant",
            "System",
            "This session is already in the planning workflow. Continue with the next planning message or final approval step.",
            now + 1,
          ),
        ]);
        return;
      }

      setPlanState(sessionKey, "armed");
      pushSlashEntries(sessionKey, [
        buildLocalTimelineEntry(sessionKey, `slash_${messageId}_plan_enabled`, "assistant", "System", buildPlanModeEnabledText(), now + 1),
      ]);
      return;
    }

    if (command === "/help") {
      pushSlashEntries(sessionKey, [
        buildLocalTimelineEntry(sessionKey, `slash_${messageId}_help`, "assistant", "System", buildSlashHelpText(), now + 1),
      ]);
      return;
    }

    if (command === "/account") {
      const payload = await getAccountStatus();
      pushSlashEntries(sessionKey, [
        buildLocalTimelineEntry(
          sessionKey,
          `slash_${messageId}_account`,
          "assistant",
          "System",
          [
            "### Token quota",
            formatTokenStatus(payload.tokenStatus),
            "",
            formatStatusBlock("Codex Account", payload.account, false),
          ].join("\n"),
          Date.now(),
        ),
      ]);
      return;
    }

    if (command === "/speech") {
      pushSlashEntries(sessionKey, [
        buildLocalTimelineEntry(
          sessionKey, `slash_${messageId}_speech`, "assistant", "System",
          speechSettings.data?.configured
            ? `Voice provider: **${speechSettings.data.model}**. Use Record to insert a transcript into your draft.`
            : window.lumaDesktop ? "Set up a transcription provider in Voice settings to record on desktop." : buildSpeechSupportText(),
          Date.now(),
        ),
      ]);
      return;
    }

    if (command === "/mcp") {
      const payload = await getMcpStatus();
      pushSlashEntries(sessionKey, [
        buildLocalTimelineEntry(
          sessionKey,
          `slash_${messageId}_mcp`,
          "assistant",
          "System",
          formatStatusBlock("Codex MCP", payload.mcp, true),
          Date.now(),
        ),
      ]);
      return;
    }

    const payload = await getSystemStatus();
    pushSlashEntries(sessionKey, [
      buildLocalTimelineEntry(
        sessionKey,
        `slash_${messageId}_status`,
        "assistant",
        "System",
        [
          "### Token quota",
          formatTokenStatus(payload.tokenStatus),
          "",
          formatStatusBlock("Codex Account", payload.account, false),
          formatStatusBlock("Codex MCP", payload.mcp, true),
        ].join("\n\n"),
        Date.now(),
      ),
    ]);
  }

  async function onSelectSlashCommand(command: SlashCommandKey): Promise<void> {
    const sessionKey = selectedSessionId || draftSessionKey;
    if (submitting) return;

    setSubmitting(true);
    try {
      await runSlashCommand(command, sessionKey, command);
      setPrompt("");
    } finally {
      setSubmitting(false);
    }
  }

  async function onStartRun(): Promise<void> {
    const originalPrompt = promptRef.current;
    if (!originalPrompt.trim() || composerSendLock.current || dictation.phase !== "idle") return;
    if (!selectedSessionId && submitting) return;
    composerSendLock.current = true;
    try {
      if (!appDefaultsLoadedRef.current) await ensureAppDefaults();
      await sendComposerPrompt(originalPrompt);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to send message.");
    } finally {
      composerSendLock.current = false;
    }
  }

  async function sendComposerPrompt(originalPrompt: string): Promise<void> {
    if (isUploadingAttachments) {
      setAttachmentError("Wait for attachments to finish uploading before sending.");
      return;
    }
    if (pendingAttachments.length > 0 && pendingAttachmentWorkspace && pendingAttachmentWorkspace !== activeWorkspace) {
      setAttachmentError("Attachments belong to a different workspace. Reattach them after switching workspaces.");
      return;
    }
    if (voiceListening) {
      try {
        speechRecognitionRef.current?.stop();
      } catch {
        // ignore stop errors while submitting
      }
    }

    const trimmedPrompt = originalPrompt.trim();
    const slashCommand = parseSlashCommand(originalPrompt);
    const sessionKey = selectedSessionId || draftSessionKey;
    const selectedSkillRefs = selectedSkills.map(selectedSkillRef);
    const selectedAgentRefs = selectedPromptAgents.map(selectedAgentRef);

    if (trimmedPrompt.startsWith("/") && !slashCommand) {
      const now = Date.now();
      const messageId = `${now}_${Math.random().toString(36).slice(2, 7)}`;
      pushSlashEntries(sessionKey, [
        buildLocalTimelineEntry(sessionKey, `slash_${messageId}_user`, "user", "You", trimmedPrompt, now),
        buildLocalTimelineEntry(
          sessionKey,
          `slash_${messageId}_error`,
          "error",
          "System",
          `Unknown slash command. Try \`/help\`.\n\n${buildSlashHelpText()}`,
          now + 1,
        ),
      ]);
      setPrompt((current) => current === originalPrompt ? "" : current);
      return;
    }

    if (slashCommand) {
      setSubmitting(true);
      try {
        await runSlashCommand(slashCommand, sessionKey);
        setPrompt((current) => current === originalPrompt ? "" : current);
      } finally {
        setSubmitting(false);
      }
      return;
    }

    try {
      if (sessionKey !== draftSessionKey) {
        enqueueMessage(buildQueuedMessage(sessionKey, trimmedPrompt, {
          attachments: pendingAttachments,
          skills: selectedSkillRefs,
          agents: selectedAgentRefs,
        }));
        setPrompt((current) => current === originalPrompt ? "" : current);
        clearComposerAttachments();
        setSelectedSkills([]);
        setSelectedPromptAgents([]);
        setSkillPickerOpen(false);
        setAgentPickerOpen(false);
        return;
      }

      await submitSessionMessage(trimmedPrompt, {
        sessionKey,
        attachments: pendingAttachments,
        skills: selectedSkillRefs,
        agents: selectedAgentRefs,
        onError: (message) => window.alert(message),
      });
      setPrompt((current) => current === originalPrompt ? "" : current);
      clearComposerAttachments();
      setSelectedSkills([]);
      setSelectedPromptAgents([]);
      setSkillPickerOpen(false);
      setAgentPickerOpen(false);
    } catch {
      // handled above
    } finally {
      if (voiceListening) {
        setVoiceRecordingStartedAt(null);
        setVoiceRecordingSeconds(0);
      }
    }
  }

  async function onStopRun(): Promise<void> {
    if (!selectedRunId) return;
    setStopping(true);
    try {
      await stopRun(selectedRunId);
      await refreshRunList(selectedSessionId);
      void loadSelectedRunRecord(selectedRunId);
    } finally {
      setStopping(false);
    }
  }


  async function onChangeWorkspace(nextWorkspace: string): Promise<void> {
    await setActiveWorkspace(nextWorkspace);
    setWorkspace(nextWorkspace);
    setSelectedSkills([]);
    setSelectedPromptAgents([]);
    setSkillPickerOpen(false);
    setAgentPickerOpen(false);
    await refreshSkillCatalog(nextWorkspace);
  }

  async function onCreateAgentSchedule(): Promise<void> {
    if (!selectedAgentId) return;
    const workspace = await ensureAppDefaults();
    if (!workspace) return;
    const match = agentScheduleTime.match(/^(\d{2}):(\d{2})$/);
    if (!match) {
      setAgentsError("Use HH:mm for Tehran time.");
      return;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      setAgentsError("Use a valid Tehran time from 00:00 to 23:59.");
      return;
    }

    setAgentActionId("create");
    try {
      await createAgentSchedule({
        projectId: currentProjectId,
        agentId: selectedAgentId,
        hour,
        minute,
        workspace,
        runner,
        model: agentScheduleModel.trim() || model,
        reasoningEffort: agentScheduleEffort,
        sandbox,
        approvalPolicy,
        skills: selectedSkills.map(selectedSkillRef),
      });
      await refreshAgentSchedules();
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : "Failed to create schedule");
    } finally {
      setAgentActionId(null);
    }
  }

  async function onToggleAgentSchedule(schedule: AgentSchedule): Promise<void> {
    setAgentActionId(schedule.id);
    try {
      await updateAgentSchedule(schedule.id, { status: schedule.status === "active" ? "paused" : "active" });
      await refreshAgentSchedules();
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : "Failed to update schedule");
    } finally {
      setAgentActionId(null);
    }
  }

  async function onUpdateAgentScheduleConfig(
    schedule: AgentSchedule,
    patch: { model?: string; reasoningEffort?: ReasoningEffort },
  ): Promise<void> {
    setAgentActionId(schedule.id);
    try {
      await updateAgentSchedule(schedule.id, patch);
      await refreshAgentSchedules();
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : "Failed to update schedule");
    } finally {
      setAgentActionId(null);
    }
  }

  async function onDeleteAgentSchedule(schedule: AgentSchedule): Promise<void> {
    setAgentActionId(schedule.id);
    try {
      await deleteAgentSchedule(schedule.id);
      await refreshAgentSchedules();
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : "Failed to delete schedule");
    } finally {
      setAgentActionId(null);
    }
  }

  async function onRunAgentScheduleNow(schedule: AgentSchedule): Promise<void> {
    setAgentActionId(schedule.id);
    try {
      const payload = await runAgentScheduleNow(schedule.id);
      await refreshAgentSchedules();
      await refreshRunList(payload.execution.sessionId);
      if (payload.execution.sessionId) {
        setIsDraftSession(false);
        setSelectedSessionId(payload.execution.sessionId);
        setSelectedRunId(payload.execution.runId);
        void loadRunMessagesPage(payload.execution.sessionId, { reset: true });
        if (payload.execution.runId) void loadSelectedRunRecord(payload.execution.runId);
      }
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : "Failed to start agent");
    } finally {
      setAgentActionId(null);
    }
  }

  function onSelectAgentExecution(execution: AgentScheduleExecution): void {
    if (!execution.sessionId) return;
    setIsDraftSession(false);
    setSelectedSessionId(execution.sessionId);
    setSelectedRunId(execution.runId);
    void loadRunMessagesPage(execution.sessionId, { reset: true });
    if (execution.runId) void loadSelectedRunRecord(execution.runId);
    setMobileContextOpen(false);
  }

  function onSelectSession(sessionId: string): void {
    setIsDraftSession(false);
    setSelectedSkills([]);
    setSelectedPromptAgents([]);
    setSkillPickerOpen(false);
    setAgentPickerOpen(false);
    const target = allSessions.find((item) => item.id === sessionId);
    if (target) {
      const runId = target.latestRunId;
      if (runId && needsSessionReview(target, sessionReviews)) {
        setSessionReviews((current) => ({
          ...current,
          reviewedRunIds: { ...current.reviewedRunIds, [target.id]: runId },
        }));
      }
      if (target.projectId) {
        const projectId = target.projectId;
        setExpandedProjects((current) => ({ ...current, [projectId]: true }));
      }
      setSelectedSessionId(target.id);
      setSelectedRunId(target.latestRunId);
      applyRunConfigToControls(target.runner, target.model, target.reasoningEffort);
    }
    setMobileThreadsOpen(false);
  }

  function createDraftSession(nextRunner: RunRunner): void {
    modelControlsTouchedRef.current = true;
    if (nextRunner !== runner) setRunner(nextRunner);
    setIsDraftSession(true);
    setDraftProjectId(newSessionProjectId);
    if (newSessionProjectId) {
      const projectId = newSessionProjectId;
      setExpandedProjects((current) => ({ ...current, [projectId]: true }));
    }
    setSelectedSessionId(null);
    setSelectedRunId(null);
    setSelectedRunRecord(null);
    setPrompt("");
    setSelectedSkills([]);
    setSelectedPromptAgents([]);
    setSkillPickerOpen(false);
    setAgentPickerOpen(false);
    clearComposerAttachments();
    setPlanState(draftSessionKey, "idle");
    setSlashEntriesBySession((prev) => {
      if (!(draftSessionKey in prev)) return prev;
      const next = { ...prev };
      delete next[draftSessionKey];
      return next;
    });
    setMobileThreadsOpen(false);
    setNewSessionDialogOpen(false);
  }

  async function onNewSession(projectId = currentProjectId): Promise<void> {
    try {
      await ensureAppDefaults();
      setNewSessionProjectId(projectId);
      setMobileThreadsOpen(false);
      setNewSessionDialogOpen(true);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not load session defaults.");
    }
  }

  function startVoiceInput(): void {
    if (!voiceSupported || !speechRecognitionRef.current) {
      setVoiceError("Voice input is not supported in this browser.");
      return;
    }

    setVoiceError(null);
    try {
      speechRecognitionRef.current.start();
    } catch (error) {
      if (error instanceof Error && error.name === "InvalidStateError") {
        return;
      }
      setVoiceError("Unable to start voice input.");
    }
  }

  function stopVoiceInput(): void {
    if (!speechRecognitionRef.current) return;
    try {
      speechRecognitionRef.current.stop();
    } catch {
      // ignore stop errors
    }
  }

  function openVoiceSettings(): void {
    setMobileThreadsOpen(false);
    setVoiceSettingsOpen(true);
  }

  function onToggleVoiceRecording(): void {
    if (apiDictationEnabled) {
      if (dictation.phase === "recording") dictation.stop();
      else if (dictation.phase === "idle") void dictation.start();
      return;
    }
    if (needsVoiceProvider) {
      openVoiceSettings();
      return;
    }
    if (voiceListening) {
      stopVoiceInput();
      return;
    }
    startVoiceInput();
  }

  function onSendButtonClick(): void {
    void onStartRun();
  }

  async function onAnswerPlanQuestions(answers: PlanQuestionAnswer[]): Promise<void> {
    await submitSessionMessage(buildPlanAnswersPrompt(answers), {
      sessionKey: sessionTimelineKey,
      planMode: true,
      onError: (message) => window.alert(message),
    });
  }

  async function onSubmitPlanFeedback(feedback: string): Promise<void> {
    await submitSessionMessage(buildPlanFeedbackPrompt(feedback), {
      sessionKey: sessionTimelineKey,
      planMode: true,
      onError: (message) => window.alert(message),
    });
  }

  async function onApprovePlanImplementation(): Promise<void> {
    const previousState = resolvePlanState(sessionTimelineKey);
    setPlanState(sessionTimelineKey, "idle");
    try {
      await submitSessionMessage("Final approval granted. Implement the approved plan now.", {
        sessionKey: sessionTimelineKey,
        planMode: false,
        sandbox,
        approvalPolicy,
        onError: (message) => window.alert(message),
      });
    } catch (error) {
      setPlanState(sessionTimelineKey, previousState);
      throw error;
    }
  }

  function onDisablePlanMode(): void {
    setPlanState(sessionTimelineKey, "idle");
  }

  async function onRetryTimelineMessage(entry: TimelineEntry): Promise<void> {
    if (entry.role !== "user" || entry.deliveryStatus !== "failed") return;
    try {
      await retryMessage(entry.messageId);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to retry message");
    }
  }

  async function onStartTerminal(): Promise<void> {
    if (!selectedSessionId) return;
    setTerminalAction("starting");
    try {
      const workspace = selectedSession?.workspace || activeWorkspace;
      const payload = await startTerminal(selectedSessionId, workspace);
      setTerminalsBySession((prev) => ({ ...prev, [selectedSessionId]: payload.terminal }));
      setRightPanelTab("terminal");
      window.setTimeout(() => terminalOutputRef.current?.focus(), 0);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to start terminal");
    } finally {
      setTerminalAction(null);
    }
  }

  async function onStopTerminal(): Promise<void> {
    if (!selectedSessionId) return;
    setTerminalAction("stopping");
    try {
      const payload = await stopTerminal(selectedSessionId);
      setTerminalsBySession((prev) => ({ ...prev, [selectedSessionId]: payload.terminal }));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to stop terminal");
    } finally {
      setTerminalAction(null);
    }
  }

  function saveTerminalCommandHistory(sessionId: string, command: string): void {
    const normalized = normalizeTerminalCommand(command);
    if (!normalized) return;

    setTerminalHistoryBySession((prev) => {
      const current = prev[sessionId] || [];
      const withoutDup = current.filter((item) => item !== normalized);
      const next = [normalized, ...withoutDup].slice(0, terminalHistoryLimit);
      return { ...prev, [sessionId]: next };
    });
  }

  async function onSubmitTerminalInput(rawInput?: string): Promise<void> {
    if (!selectedSessionId) return;
    const base = typeof rawInput === "string" ? rawInput : terminalInput;
    if (!base) return;

    setTerminalAction("sending");
    try {
      await sendTerminalInput(selectedSessionId, base);
      saveTerminalCommandHistory(selectedSessionId, base);
      setTerminalInput("");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to send terminal input");
    } finally {
      setTerminalAction(null);
    }
  }

  async function onInterruptTerminal(): Promise<void> {
    if (!selectedSessionId) return;
    setTerminalAction("sending");
    try {
      const payload = await interruptTerminal(selectedSessionId);
      setTerminalsBySession((prev) => ({ ...prev, [selectedSessionId]: payload.terminal }));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to interrupt terminal");
    } finally {
      setTerminalAction(null);
    }
  }

  async function onArchiveSession(): Promise<void> {
    if (!selectedSessionId || sessionAction || !selectedSession || selectedSession.historyOnly) return;
    const ok = window.confirm("Archive this session? It will be hidden from Chats.");
    if (!ok) return;

    setSessionAction("archive");
    try {
      await archiveSession(selectedSessionId);
      setTerminalsBySession((prev) => {
        if (!(selectedSessionId in prev)) return prev;
        const next = { ...prev };
        delete next[selectedSessionId];
        return next;
      });
      await refreshRunList();
      setMobileContextOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to archive session");
    } finally {
      setSessionAction(null);
    }
  }

  async function onDeleteSession(): Promise<void> {
    if (!selectedSessionId || sessionAction || !selectedSession || selectedSession.historyOnly) return;
    const ok = window.confirm("Delete this session and all its messages? This cannot be undone.");
    if (!ok) return;

    setSessionAction("delete");
    try {
      await deleteSession(selectedSessionId);
      setTerminalsBySession((prev) => {
        if (!(selectedSessionId in prev)) return prev;
        const next = { ...prev };
        delete next[selectedSessionId];
        return next;
      });
      await refreshRunList();
      setMobileContextOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to delete session");
    } finally {
      setSessionAction(null);
    }
  }

  function onTimelineScroll(): void {
    const node = timelineScrollRef.current;
    if (!node) return;
    if (suppressTimelineScrollTrackingRef.current) return;
    timelineShouldAutoScrollRef.current = isScrolledToBottom(node);
  }

  function onLoadOlderTimelineMessages(): void {
    if (!selectedSessionId) return;
    if (loadingMessagesByRunId[selectedSessionId]) return;
    const nextCursor = messageNextCursorByRunId[selectedSessionId];
    if (!nextCursor) return;

    const node = timelineScrollRef.current;
    if (node) {
      timelineShouldAutoScrollRef.current = false;
      pendingTimelineExpansionRef.current = {
        sessionKey: selectedSessionId,
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }

    void loadRunMessagesPage(selectedSessionId, { before: nextCursor });
  }

  const agentsSidebarPanel = (
    <AgentsPanel
      agents={agents}
      schedules={agentSchedules}
      upcoming={upcomingAgentSchedules}
      executions={agentExecutions}
      skillSyncResult={skillSyncResult}
      loading={agentsLoading}
      error={agentsError}
      selectedAgentId={selectedAgentId}
      setSelectedAgentId={setSelectedAgentId}
      scheduleTime={agentScheduleTime}
      setScheduleTime={setAgentScheduleTime}
      scheduleModel={agentScheduleModel}
      setScheduleModel={chooseScheduleModel}
      scheduleEffort={agentScheduleEffort}
      setScheduleEffort={chooseScheduleEffort}
      scheduleRunner={runner}
      cursorModels={cursorModels}
      selectedSkills={selectedSkills}
      skillCatalog={skillCatalog}
      actionId={agentActionId}
      onReload={onReloadAgentsAndSkills}
      onCreateSchedule={onCreateAgentSchedule}
      onToggleSchedule={onToggleAgentSchedule}
      onUpdateScheduleConfig={onUpdateAgentScheduleConfig}
      onDeleteSchedule={onDeleteAgentSchedule}
      onRunNow={onRunAgentScheduleNow}
      onSelectExecution={onSelectAgentExecution}
      compact
    />
  );

  if (!authReady) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-[color:var(--bg)] text-[color:var(--text)]">
        <div className="flex items-center gap-2 rounded-md border border-card-border bg-surface-1 px-4 py-3 text-sm">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span>Preparing secure session...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-[color:var(--bg)] px-4 text-[color:var(--text)]">
        <div className="w-full max-w-md rounded-lg border border-card-border bg-surface-1">
          <div className="border-b border-card-border px-4 py-3">
            <h1 className="flex items-center gap-2 text-base font-semibold">
              <Lock className="h-5 w-5" />
              Sign in
            </h1>
            <p className="mt-1 text-sm text-foreground/70">
              Enter password to access this panel. Auth session is saved in browser for 24 hours.
            </p>
          </div>
          <div className="p-4">
            <form className="space-y-3" onSubmit={(event) => void onAuthenticate(event)}>
              <input
                className="h-10 w-full rounded-md border border-card-border bg-control px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 md:text-sm"
                type="password"
                autoComplete="current-password"
                value={authPasswordInput}
                onChange={(event) => setAuthPasswordInput(event.target.value)}
                placeholder="Password"
                disabled={authSubmitting}
              />
              {authError ? <p className="text-xs text-rose-700">{authError}</p> : null}
              <Button type="submit" className="w-full" disabled={!authPasswordInput.trim() || authSubmitting}>
                {authSubmitting ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Continue
              </Button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const showContextDock = rightDockOpen && !remoteWorkspaceOpen;
  const desktopGridColumns = leftSidebarOpen
    ? showContextDock
      ? "lg:grid-cols-[382px_minmax(0,1fr)_410px]"
      : "lg:grid-cols-[382px_minmax(0,1fr)]"
    : showContextDock
      ? "lg:grid-cols-[minmax(0,1fr)_410px]"
      : "lg:grid-cols-1";

  const remoteTitle = remoteWorkspace.selected?.title || remoteWorkspace.device?.name || "Remote Macs";
  const remoteSidebar = remoteWorkspaceOpen ? (
    <RemoteSidebar
      workspace={remoteWorkspace}
      onCloud={() => setRemoteWorkspaceOpen(false)}
      onManage={() => { setMobileThreadsOpen(false); setRemoteMacsOpen(true); }}
      onSelect={id => {
        remoteWorkspace.selectSession(id);
        setMobileThreadsOpen(false);
      }}
    />
  ) : null;

  return (
    <ProjectsContext.Provider value={{ ...projectState,
      selectedSessionId, selectedRunId, currentProjectId,
      setDraftProject: setDraftProjectId,
      startProjectDraft: projectId => {
        setDraftProjectId(projectId);
        setIsDraftSession(true); setSelectedSessionId(null); setSelectedRunId(null); setSelectedRunRecord(null);
      },
      setPanel: panel => { setMobileThreadsOpen(false); projectState.setPanel(panel); },
      onMoveSession: async projectId => {
        if (!selectedSessionId) return;
        await moveSessionToProject(selectedSessionId, projectId);
        updateSessionProject(selectedSessionId, projectId);
        projectState.invalidate();
      },
    }}>
    <ModelCatalogContext.Provider value={modelCatalogState}>
    <div className="h-[100dvh] w-full overflow-hidden bg-background text-[color:var(--text)]">
      <header className="fixed inset-x-0 top-0 z-20 bg-surface-1/95 px-2 py-1 shadow-[0_14px_30px_-24px_rgba(0,0,0,0.9)] lg:hidden">
        <div className="mx-auto flex min-h-10 max-w-7xl items-center justify-between gap-1">
          <Button size="sm" variant="ghost" onClick={() => setMobileThreadsOpen(true)}>
            <PanelLeft className="mr-1.5 h-4 w-4" /> Chats
          </Button>
          <div className="flex min-w-0 flex-1 flex-col items-center">
            <div className="max-w-full truncate text-center text-sm font-semibold leading-4" title={remoteWorkspaceOpen ? remoteTitle : mobileHeaderTitle} dir="auto">
              {remoteWorkspaceOpen ? remoteTitle : mobileHeaderTitle}
            </div>
            {remoteWorkspaceOpen ? remoteWorkspace.selected && remoteWorkspace.device ? (
              <span className="max-w-full truncate text-[11px] text-foreground/60">
                {remoteWorkspace.device.name}
              </span>
            ) : null : <ProjectSessionControls key={selectedSessionId ?? "draft"} />}
          </div>
          {!remoteWorkspaceOpen ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="sm"
              variant="ghost"
              className="px-2"
              onClick={() => void reloadSelectedChat()}
              disabled={!selectedSessionId || Boolean(selectedSessionId && loadingMessagesByRunId[selectedSessionId])}
              aria-label="Reload chat"
              title="Reload chat"
            >
              <RefreshCw className={cn("h-4 w-4", selectedSessionId && loadingMessagesByRunId[selectedSessionId] && "animate-spin")} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMobileContextOpen(true)}>
              <PanelRight className="mr-1.5 h-4 w-4" /> Tools
            </Button>
          </div>
          ) : null}
        </div>
      </header>

      <div
        className={cn(
          "grid h-full min-h-0 grid-cols-1 pt-12 lg:gap-2 lg:p-2 lg:pt-2",
          desktopGridColumns,
        )}
      >
        {leftSidebarOpen ? (
        <aside className="hidden min-h-0 flex-col overflow-hidden rounded-lg bg-surface-1 shadow-[10px_0_26px_-26px_rgba(0,0,0,0.9)] lg:flex">
          {remoteSidebar ?? <SessionsPanel
            sessions={filteredSessions}
            sessionReviews={sessionReviews}
            expandedProjects={expandedProjects}
            setExpandedProjects={setExpandedProjects}
            selectedSessionId={selectedSessionId}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            showAllHistory={showAllHistory}
            loadingRunList={loadingRunList}
            hasMoreRuns={Boolean(runListNextCursor)}
            loadingMoreRuns={loadingMoreRunItems}
            onToggleShowAllHistory={setShowAllHistory}
            onSelectSession={onSelectSession}
            onLoadMoreRuns={loadMoreRunItemsPage}
            onNewSession={onNewSession}
            mode={sidebarMode}
            setMode={setSidebarMode}
            agentsPanel={agentsSidebarPanel}
            backendConnectionStatus={backendConnectionStatus}
            theme={theme}
            setTheme={setTheme}
            onSignOut={onSignOut}
            onOpenRemoteMacs={isDesktopLocal ? undefined : () => setRemoteWorkspaceOpen(true)}
            onOpenVoiceSettings={openVoiceSettings}
            onCloseSidebar={() => setLeftSidebarOpen(false)}
          />}
        </aside>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background lg:rounded-lg">
          {remoteWorkspaceOpen ? (
            remoteWorkspace.device && remoteWorkspace.selected && !remoteWorkspace.devices.isError && !remoteWorkspace.sessions.isError ? (
              <RemoteConversation
                key={`${remoteWorkspace.device.id}:${remoteWorkspace.selected.id}`}
                device={remoteWorkspace.device}
                session={remoteWorkspace.selected}
                leftSidebarOpen={leftSidebarOpen}
                onOpenSidebar={() => setLeftSidebarOpen(true)}
              />
            ) : (
              <>
                <RemoteConversationHeader title={remoteTitle} leftSidebarOpen={leftSidebarOpen} onOpenSidebar={() => setLeftSidebarOpen(true)} />
                <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
                  <p role="status" className="text-sm text-foreground/70">
                    {remoteWorkspace.devices.isError ? "Could not load paired Macs."
                      : remoteWorkspace.devices.isPending ? "Checking paired Macs…"
                      : !remoteWorkspace.device ? "Pair a Mac from Chats to see its sessions."
                      : !remoteWorkspace.device.online ? `${remoteWorkspace.device.name} is offline.`
                      : remoteWorkspace.sessions.isError ? "Could not load sessions from this Mac."
                      : "Choose a Mac session from Chats."}
                  </p>
                </div>
              </>
            )
          ) : <CenterPanel
            loading={loading || Boolean(selectedSessionId && loadingMessagesByRunId[selectedSessionId] && timeline.length === 0)}
            loadingOlderMessages={Boolean(selectedSessionId && loadingMessagesByRunId[selectedSessionId] && timeline.length > 0)}
            selectedSession={selectedSession}
            activeWorkspace={activeWorkspace}
            runner={runner}
            setRunner={setRunner}
            unavailableRunners={unavailableRunners}
            model={model}
            setModel={chooseModel}
            reasoningEffort={reasoningEffort}
            setReasoningEffort={chooseEffort}
            claudeEffortFlagSupported={claudeEffortFlagSupported}
            cursorModels={cursorModels}
            askMode={askMode}
            setAskMode={setAskMode}
            rightPanelTab={rightPanelTab}
            rightDockOpen={rightDockOpen}
            onOpenRightPanel={(tab) => {
              setRightPanelTab(tab);
              setRightDockOpen(true);
            }}
            leftSidebarOpen={leftSidebarOpen}
            onOpenLeftSidebar={() => setLeftSidebarOpen(true)}
            reloadingChat={Boolean(selectedSessionId && loadingMessagesByRunId[selectedSessionId])}
            onReloadChat={() => void reloadSelectedChat()}
            timeline={visibleTimeline}
            hiddenTimelineCount={hiddenTimelineCount}
            prompt={prompt}
            setPrompt={updatePrompt}
            skillCatalog={skillCatalog}
            filteredSkills={filteredSkills}
            selectedSkills={selectedSkills}
            agentCatalog={agents}
            filteredAgents={filteredPromptAgents}
            selectedAgents={selectedPromptAgents}
            showSystemSkills={showSystemSkills}
            skillsLoading={skillsLoading}
            skillsError={skillsError}
            skillPickerOpen={skillPickerOpen}
            agentPickerOpen={agentPickerOpen}
            highlightedSkillIndex={highlightedSkillIndex}
            highlightedAgentIndex={highlightedAgentIndex}
            onRefreshSkills={refreshSkillCatalog}
            onToggleShowSystemSkills={() => setShowSystemSkills((current) => !current)}
            onSelectSkill={selectSkill}
            onRemoveSelectedSkill={removeSelectedSkill}
            onSelectAgent={selectPromptAgent}
            onRemoveSelectedAgent={removeSelectedPromptAgent}
            onComposerKeyDown={onComposerKeyDown}
            pendingAttachments={pendingAttachments}
            attachmentError={attachmentError}
            uploadingAttachmentNames={uploadingAttachmentNames}
            isUploadingAttachments={isUploadingAttachments}
            composerFileInputRef={composerFileInputRef}
            submitting={submitting}
            stopping={stopping}
            onStopRun={onStopRun}
            onNewSession={() => void onNewSession()}
            hasPendingIndicator={Boolean(selectedSession && selectedSession.status === "running" && !hasPendingTimelineEntry)}
            ansi={ansi}
            timelineScrollRef={timelineScrollRef}
            timelineBottomRef={timelineBottomRef}
            onTimelineScroll={onTimelineScroll}
            onLoadOlderTimelineMessages={onLoadOlderTimelineMessages}
            slashSuggestions={slashSuggestions}
            onSelectSlashCommand={onSelectSlashCommand}
            queueItems={queuedMessagesForActiveSession}
            processingQueueItemId={processingQueueItemId}
            onRetryQueueItem={(id) => setQueuedDeliveryError(sessionTimelineKey, id)}
            onRemoveQueueItem={(messageId) => removeQueuedMessage(sessionTimelineKey, messageId)}
            onRetryMessage={onRetryTimelineMessage}
            onSelectAttachments={uploadPendingFiles}
            onRemovePendingAttachment={removePendingAttachment}
            voiceListening={recording}
            voiceError={apiDictationEnabled ? dictation.error : voiceError}
            voiceRecordingSeconds={voiceRecordingSeconds}
            voiceNeedsSetup={needsVoiceProvider}
            voiceSettingsLoading={speechSettings.isLoading}
            voicePhase={dictation.phase}
            onCancelDictation={dictation.cancel}
            onToggleVoiceRecording={onToggleVoiceRecording}
            onSendButtonClick={onSendButtonClick}
            planSessionState={planSessionState}
            onDisablePlanMode={onDisablePlanMode}
            onAnswerPlanQuestions={onAnswerPlanQuestions}
            onApprovePlanImplementation={onApprovePlanImplementation}
            onSubmitPlanFeedback={onSubmitPlanFeedback}
          />}
        </main>

        {showContextDock ? (
        <aside className="hidden min-h-0 flex-col overflow-hidden rounded-lg bg-surface-1 shadow-[-10px_0_26px_-26px_rgba(0,0,0,0.9)] lg:flex">
          <ClaudeRightPanel
            rightPanelTab={rightPanelTab}
            setRightPanelTab={setRightPanelTab}
            onClose={() => setRightDockOpen(false)}
            workspaces={workspaces}
            activeWorkspace={activeWorkspace}
            onChangeWorkspace={onChangeWorkspace}
            runner={runner}
            setRunner={setRunner}
            unavailableRunners={unavailableRunners}
            model={model}
            setModel={chooseModel}
            reasoningEffort={reasoningEffort}
            setReasoningEffort={chooseEffort}
            cursorModels={cursorModels}
            sandbox={sandbox}
            setSandbox={chooseSandbox}
            theme={theme}
            toggleTheme={toggleTheme}
            ansi={ansi}
            debugLogs={debugLogs}
            selectedSessionId={selectedSessionId}
            selectedSession={selectedSession}
            selectedSessionTokenUsage={selectedSessionId ? tokenUsageBySession[selectedSessionId] : undefined}
            tokenUsageLoading={Boolean(selectedSessionId && tokenUsageLoadingSessionId === selectedSessionId)}
            tokenUsageError={tokenUsageError}
            onLoadTokenUsage={loadTokenUsageForSession}
            selectedTerminal={selectedTerminal}
            terminalHistory={selectedTerminalHistory}
            terminalInput={terminalInput}
            setTerminalInput={setTerminalInput}
            terminalAction={terminalAction}
            terminalOutputRef={terminalOutputRef}
            onStartTerminal={onStartTerminal}
            onStopTerminal={onStopTerminal}
            onInterruptTerminal={onInterruptTerminal}
            onSubmitTerminalInput={onSubmitTerminalInput}
            sessionAction={sessionAction}
            onArchiveSession={onArchiveSession}
            onDeleteSession={onDeleteSession}
          />
        </aside>
        ) : null}
      </div>

      <ProjectMemoryDialog />
      {!isDesktopLocal ? <RemoteMacs open={remoteMacsOpen} setOpen={setRemoteMacsOpen} workspace={remoteWorkspace} /> : null}
      <VoiceSettings open={voiceSettingsOpen} setOpen={setVoiceSettingsOpen} settings={speechSettings.data} loading={speechSettings.isLoading} />
      <Dialog.Root open={newSessionDialogOpen} onOpenChange={setNewSessionDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-24px)] w-[min(460px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-card-border bg-surface-1 p-4 shadow-xl outline-none">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <Dialog.Title className="text-base font-semibold">Create new session</Dialog.Title>
                <Dialog.Description className="mt-1 text-xs text-foreground/65">
                  Choose a project, runner, model, and thinking effort.
                </Dialog.Description>
              </div>
              <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setNewSessionDialogOpen(false)} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <Button
                type="button"
                variant={runner === "codex" ? "primary" : "ghost"}
                className="h-16 justify-start gap-3 rounded-md border border-card-border px-3 text-left"
                onClick={() => setRunner("codex")}
              >
                <FileCode2 className="h-5 w-5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">Codex</span>
                  <span className="block truncate text-xs opacity-70">{runner === "codex" ? model : defaultCodexModel}</span>
                </span>
              </Button>
              <Button
                type="button"
                variant={runner === "claude" ? "primary" : "ghost"}
                disabled={unavailableRunners.includes("claude")}
                title={unavailableRunners.includes("claude") ? "Install Claude Code on this Mac and reopen Luma" : undefined}
                className="h-16 justify-start gap-3 rounded-md border border-card-border px-3 text-left"
                onClick={() => setRunner("claude")}
              >
                <Bot className="h-5 w-5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">Claude Code</span>
                  <span className="block truncate text-xs opacity-70">{runner === "claude" ? model : defaultClaudeModel}</span>
                </span>
              </Button>
              <Button
                type="button"
                variant={runner === "cursor" ? "primary" : "ghost"}
                className="h-16 justify-start gap-3 rounded-md border border-card-border px-3 text-left"
                onClick={() => setRunner("cursor")}
                disabled={unavailableRunners.includes("cursor") || (!isDesktopLocal && !cursorAvailable && cursorModels.length === 0)}
                title={unavailableRunners.includes("cursor") ? "Install Cursor Agent on this Mac and reopen Luma" : "Cursor Agent CLI"}
              >
                <Sparkles className="h-5 w-5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">Cursor</span>
                  <span className="block truncate text-xs opacity-70">{runner === "cursor" ? model : defaultCursorModel}</span>
                </span>
              </Button>
            </div>

            <div className="mt-4 space-y-3">
              {projectState.projects.length > 0 ? (
                <label className="block space-y-1 text-xs font-semibold text-foreground/75">
                  <span>Project</span>
                  <select
                    className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                    value={newSessionProjectId || ""}
                    onChange={(event) => setNewSessionProjectId(event.target.value || null)}
                  >
                    <option value="">No project</option>
                    {projectState.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </label>
              ) : null}
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="block text-xs font-semibold text-foreground/75">Model</label>
                  <ModelCatalogRefresh runner={runner} />
                  {runner === "cursor" ? (
                    <button
                      type="button"
                      className="text-[11px] text-brand hover:underline"
                      onClick={() => {
                        void (async () => {
                          try {
                            const payload = await getCursorModels();
                            setCursorAvailable(payload.available);
                            setCursorModels(payload.models);
                            setDefaultCursorModel(payload.defaultModel || defaultCursorModel);
                          } catch {
                            // ignore refresh errors in dialog
                          }
                        })();
                      }}
                    >
                      Refresh models
                    </button>
                  ) : null}
                </div>
                <select
                  className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  value={newSessionUseCustomModel ? "__custom__" : model}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === "__custom__") {
                      setNewSessionUseCustomModel(true);
                      return;
                    }
                    setNewSessionUseCustomModel(false);
                    chooseModel(next);
                  }}
                >
                  {modelOptionsForRunner(runner, cursorModels).map((modelOption) => (
                    <option key={modelOption} value={modelOption}>
                      {modelLabel(runner, modelOption)}
                    </option>
                  ))}
                  <option value="__custom__">Custom model...</option>
                </select>
                {newSessionUseCustomModel ? (
                  <input
                    className="mt-2 h-9 w-full rounded-md border border-card-border bg-control px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 md:text-sm"
                    value={model}
                    onChange={(event) => chooseModel(event.target.value)}
                    placeholder={
                      runner === "claude"
                        ? "Enter Claude model id"
                        : runner === "cursor"
                          ? "Enter Cursor model id"
                          : "Enter Codex model id"
                    }
                  />
                ) : null}
              </div>

              <div>
                <ModelCatalogNotice runner={runner} />
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="block text-xs font-semibold text-foreground/75">Thinking effort</label>
                  {runner === "claude" && !claudeEffortFlagSupported ? (
                    <span className="text-[11px] text-amber-600 dark:text-amber-300" title="Claude effort flag support was not detected; Luma uses CLAUDE_CODE_EFFORT_LEVEL. Check model discovery for CLI errors.">
                      env fallback
                    </span>
                  ) : null}
                  {runner === "cursor" && !cursorModelSupportsEffort(model, cursorModels) ? (
                    <span className="text-[11px] text-foreground/55" title="This Cursor model has no effort control.">
                      not supported
                    </span>
                  ) : null}
                </div>
                <select
                  className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:opacity-50"
                  value={reasoningEffort}
                  disabled={runner === "cursor" ? !cursorModelSupportsEffort(model, cursorModels) : !modelSupportsEffort(runner, model)}
                  onChange={(event) => chooseEffort(event.target.value as ReasoningEffort)}
                >
                  <ModelEffortOptions runner={runner} model={model} value={reasoningEffort} />
                </select>
              </div>

              <Button type="button" className="w-full" onClick={() => createDraftSession(runner)} disabled={!model.trim()}>
                Create session
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={mobileThreadsOpen} onOpenChange={setMobileThreadsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-30 bg-black/55" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-40 w-[min(360px,95vw)] border-r border-card-border bg-surface-1 outline-none">
            <Dialog.Title className="sr-only">Chats Drawer</Dialog.Title>
            <Dialog.Description className="sr-only">Session list and chat selection panel for mobile.</Dialog.Description>
            <div className="flex h-full min-h-0 flex-col overflow-hidden animate-slide-in">
              {remoteSidebar ?? <SessionsPanel
                sessions={filteredSessions}
                sessionReviews={sessionReviews}
                expandedProjects={expandedProjects}
                setExpandedProjects={setExpandedProjects}
                selectedSessionId={selectedSessionId}
                statusFilter={statusFilter}
                setStatusFilter={setStatusFilter}
                showAllHistory={showAllHistory}
                loadingRunList={loadingRunList}
                hasMoreRuns={Boolean(runListNextCursor)}
                loadingMoreRuns={loadingMoreRunItems}
                onToggleShowAllHistory={setShowAllHistory}
                onSelectSession={onSelectSession}
                onLoadMoreRuns={loadMoreRunItemsPage}
                onNewSession={onNewSession}
                mode={sidebarMode}
                setMode={setSidebarMode}
                agentsPanel={agentsSidebarPanel}
                backendConnectionStatus={backendConnectionStatus}
                theme={theme}
                setTheme={setTheme}
                onSignOut={onSignOut}
                onOpenRemoteMacs={isDesktopLocal ? undefined : () => setRemoteWorkspaceOpen(true)}
                onOpenVoiceSettings={openVoiceSettings}
                onCloseSidebar={() => setMobileThreadsOpen(false)}
              />}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={mobileContextOpen} onOpenChange={setMobileContextOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-30 bg-black/55" />
          <Dialog.Content className="fixed inset-y-0 right-0 z-40 w-[min(410px,95vw)] border-l border-card-border bg-surface-1 outline-none">
            <Dialog.Title className="sr-only">Context Drawer</Dialog.Title>
            <Dialog.Description className="sr-only">Context and tools panel for mobile.</Dialog.Description>
            <div className="flex h-full min-h-0 flex-col overflow-hidden animate-slide-in">
              <ClaudeRightPanel
                rightPanelTab={rightPanelTab}
                setRightPanelTab={setRightPanelTab}
                onClose={() => setMobileContextOpen(false)}
                workspaces={workspaces}
                activeWorkspace={activeWorkspace}
                onChangeWorkspace={onChangeWorkspace}
                runner={runner}
                setRunner={setRunner}
                unavailableRunners={unavailableRunners}
                model={model}
                setModel={chooseModel}
                reasoningEffort={reasoningEffort}
                setReasoningEffort={chooseEffort}
                cursorModels={cursorModels}
                sandbox={sandbox}
                setSandbox={chooseSandbox}
                theme={theme}
                toggleTheme={toggleTheme}
                ansi={ansi}
                debugLogs={debugLogs}
                selectedSessionId={selectedSessionId}
                selectedSession={selectedSession}
                selectedSessionTokenUsage={selectedSessionId ? tokenUsageBySession[selectedSessionId] : undefined}
                tokenUsageLoading={Boolean(selectedSessionId && tokenUsageLoadingSessionId === selectedSessionId)}
                tokenUsageError={tokenUsageError}
                onLoadTokenUsage={loadTokenUsageForSession}
                selectedTerminal={selectedTerminal}
                terminalHistory={selectedTerminalHistory}
                terminalInput={terminalInput}
                setTerminalInput={setTerminalInput}
                terminalAction={terminalAction}
                terminalOutputRef={terminalOutputRef}
                onStartTerminal={onStartTerminal}
                onStopTerminal={onStopTerminal}
                onInterruptTerminal={onInterruptTerminal}
                onSubmitTerminalInput={onSubmitTerminalInput}
                sessionAction={sessionAction}
                onArchiveSession={onArchiveSession}
                onDeleteSession={onDeleteSession}
                mobile
              />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
    </ModelCatalogContext.Provider>
    </ProjectsContext.Provider>
  );
}

const sessionActionClass = "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-foreground/75 hover:bg-control-hover hover:text-foreground focus-visible:outline focus-visible:outline-brand";

const sessionFilters: { value: SessionFilterValue; label: string }[] = [
  { value: "all", label: "All sessions" },
  { value: "all-history", label: "All history" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "stopped", label: "Stopped" },
];

function SidebarSessionRows({
  sessions,
  sessionReviews,
  selectedSessionId,
  onSelectSession,
}: Pick<SessionsPanelProps, "sessions" | "sessionReviews" | "selectedSessionId" | "onSelectSession">): JSX.Element | null {
  return (
    <SessionRows
      sessions={sessions.map(session => ({
        id: session.id,
        title: session.summary,
        status: session.status,
        running: session.status === "running" && !session.historyOnly,
        needsReview: needsSessionReview(session, sessionReviews),
      }))}
      selectedSessionId={selectedSessionId}
      onSelectSession={onSelectSession}
    />
  );
}

type SessionsPanelProps = {
  sessions: SessionCard[];
  sessionReviews: SessionReviews;
  expandedProjects: Record<string, boolean>;
  setExpandedProjects: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  selectedSessionId: string | null;
  statusFilter: StatusFilter;
  setStatusFilter: (next: StatusFilter) => void;
  showAllHistory: boolean;
  loadingRunList: boolean;
  hasMoreRuns: boolean;
  loadingMoreRuns: boolean;
  onToggleShowAllHistory: (next: boolean) => void;
  onSelectSession: (sessionId: string) => void;
  onLoadMoreRuns: () => Promise<void>;
  onNewSession: (projectId?: string) => void;
  mode: SidebarMode;
  setMode: (mode: SidebarMode) => void;
  agentsPanel: ReactNode;
  backendConnectionStatus: BackendConnectionStatus;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  onSignOut: () => void;
  onOpenRemoteMacs?: () => void;
  onCloseSidebar: () => void;
  onOpenVoiceSettings: () => void;
};

function SessionsPanel({
  sessions,
  sessionReviews,
  expandedProjects,
  setExpandedProjects,
  selectedSessionId,
  statusFilter,
  setStatusFilter,
  showAllHistory,
  loadingRunList,
  hasMoreRuns,
  loadingMoreRuns,
  onToggleShowAllHistory,
  onSelectSession,
  onLoadMoreRuns,
  onNewSession,
  mode,
  setMode,
  agentsPanel,
  backendConnectionStatus,
  theme,
  setTheme,
  onSignOut,
  onOpenRemoteMacs,
  onCloseSidebar,
  onOpenVoiceSettings,
}: SessionsPanelProps): JSX.Element {
  const sessionFilterValue: SessionFilterValue = showAllHistory ? "all-history" : statusFilter;
  const environmentLabel = deploymentLabel();
  const { projects, loading: projectsLoading, error: projectsError, setPanel } = useProjects();
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const sessionsByProject = useMemo(() => {
    const groups = new Map<string | null, SessionCard[]>();
    for (const session of sessions) {
      const group = groups.get(session.projectId);
      if (group) group.push(session);
      else groups.set(session.projectId, [session]);
    }
    return groups;
  }, [sessions]);
  const recents = sessionsByProject.get(null) ?? [];
  const filterLabel = sessionFilters.find((filter) => filter.value === sessionFilterValue)?.label;

  useEffect(() => {
    if (!accountMenuOpen) return;

    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (accountMenuRef.current?.contains(target)) return;
      setAccountMenuOpen(false);
    }

    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") setAccountMenuOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountMenuOpen]);

  function onSessionFilterChange(next: SessionFilterValue): void {
    if (next === "all-history") {
      setStatusFilter("all");
      onToggleShowAllHistory(true);
      return;
    }

    setStatusFilter(next);
    if (showAllHistory) onToggleShowAllHistory(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {mode === "code" ? (
        <div role="group" aria-label="Session actions" className="flex shrink-0 items-center gap-1 border-b border-card-border px-3 py-2">
          <button type="button" className={sessionActionClass} onClick={() => onNewSession()} aria-label="New session" title="New session">
            <SquarePen className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" className={sessionActionClass} onClick={() => setPanel({ tab: "create", projectId: null })} aria-label="New project" title="New project">
            <FolderPlus className="h-4 w-4" aria-hidden="true" />
          </button>
          <label
            className={cn(sessionActionClass, "relative focus-within:ring-2 focus-within:ring-brand", sessionFilterValue !== "all" && "bg-brand-soft text-brand")}
            title={`Filter sessions · ${filterLabel}`}
          >
            {loadingRunList ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ListFilter className="h-4 w-4" aria-hidden="true" />}
            <select
              aria-label="Filter sessions"
              title={`Filter sessions · ${filterLabel}`}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              value={sessionFilterValue}
              onChange={(event) => onSessionFilterChange(event.target.value as SessionFilterValue)}
              disabled={loadingRunList}
            >
              {sessionFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
            </select>
          </label>
        </div>
      ) : null}

      {mode === "agents" ? (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto px-3 py-3">
          {agentsPanel}
        </div>
      ) : (
        <nav aria-label="Sessions and projects" className="scrollbar-thin min-h-0 flex-1 space-y-5 overflow-auto px-3 py-3">
          {projects.length > 0 || projectsLoading || projectsError ? (
            <section aria-label="Projects">
              <h2 className="mb-1.5 px-2 text-xs font-semibold text-foreground/55">Projects</h2>
              {projectsLoading ? <p className="px-2 py-1 text-xs text-foreground/55">Loading projects…</p> : null}
              {projectsError ? <p role="alert" className="px-2 py-1 text-xs text-danger-fg">Projects could not load.</p> : null}
              <ul className="space-y-1">
                {projects.map((project) => {
                  const expanded = Boolean(expandedProjects[project.id]);
                  const projectSessions = sessionsByProject.get(project.id) ?? [];
                  const Icon = expanded ? FolderOpen : Folder;
                  return (
                    <li key={project.id}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setExpandedProjects((current) => ({ ...current, [project.id]: !current[project.id] }))}
                          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-foreground/85 hover:bg-control-hover focus-visible:outline focus-visible:outline-brand"
                        >
                          <Icon className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate" title={project.name} dir="auto">{project.name}</span>
                          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-foreground/45 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-foreground/65 hover:bg-brand-soft hover:text-brand focus-visible:outline focus-visible:outline-brand"
                          aria-label={`New session in ${project.name}`}
                          title={`New session in ${project.name}`}
                          onClick={() => onNewSession(project.id)}
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                      {expanded ? (
                        <div className="ml-4 border-l border-card-border pl-2">
                          <SidebarSessionRows sessions={projectSessions} sessionReviews={sessionReviews} selectedSessionId={selectedSessionId} onSelectSession={onSelectSession} />
                          {projectSessions.length === 0 ? (
                            <p className="px-2 py-1.5 text-xs text-foreground/60">
                              {hasMoreRuns && project.sessionCount > 0 ? "Load more to see earlier sessions." : "No sessions to show"}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section aria-label="Recents">
            <button
              type="button"
              aria-expanded={recentsOpen}
              onClick={() => setRecentsOpen((open) => !open)}
              className="mb-1 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-foreground/65 hover:bg-control-hover focus-visible:outline focus-visible:outline-brand"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", recentsOpen && "rotate-90")} aria-hidden="true" />
              Recents
            </button>
            {recentsOpen ? (
              <SidebarSessionRows sessions={recents} sessionReviews={sessionReviews} selectedSessionId={selectedSessionId} onSelectSession={onSelectSession} />
            ) : null}
          </section>

          {!loadingRunList && sessions.length === 0 && !hasMoreRuns ? (
            <p className="px-2 text-xs text-foreground/60">
              {sessionFilterValue === "all" ? "No sessions yet" : "No sessions match this filter"}
            </p>
          ) : null}

          {hasMoreRuns ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void onLoadMoreRuns()} disabled={loadingMoreRuns || loadingRunList} className="w-full">
              {loadingMoreRuns ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Load more sessions
            </Button>
          ) : null}
        </nav>
      )}

      <div className="relative z-10 p-3 shadow-[0_-14px_28px_-28px_rgba(0,0,0,0.9)]">
        {onOpenRemoteMacs ? (
          <button type="button"
            className="mb-1 flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground/80 hover:bg-control-hover focus-visible:outline focus-visible:outline-brand"
            onClick={onOpenRemoteMacs}>
            <Laptop className="h-4 w-4 text-foreground/65" aria-hidden="true" />Remote Macs
          </button>
        ) : null}
        <div ref={accountMenuRef} className="relative">
          {accountMenuOpen ? (
            <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-md border border-card-border bg-surface-1 p-1 text-sm shadow-[0_16px_42px_-20px_rgba(0,0,0,0.95)]">
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-foreground/80 transition hover:bg-control-hover"
                onClick={() => {
                  setMode(mode === "code" ? "agents" : "code");
                  setAccountMenuOpen(false);
                }}
              >
                {mode === "code" ? <Bot className="h-4 w-4 text-foreground/55" /> : <MessageSquare className="h-4 w-4 text-foreground/55" />}
                <span>{mode === "code" ? "Agents" : "Sessions"}</span>
              </button>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-foreground/80 transition hover:bg-control-hover"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onCloseSidebar();
                }}
              >
                <PanelLeft className="h-4 w-4 text-foreground/55" />
                <span>Close sidebar</span>
              </button>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-foreground/80 transition hover:bg-control-hover"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onSignOut();
                }}
              >
                <LogOut className="h-4 w-4 text-foreground/55" />
                <span>Sign out</span>
              </button>

              <div className="my-1 border-t border-card-border" />

              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
                <Settings className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                Settings
              </div>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-foreground/80 transition hover:bg-control-hover"
                onClick={() => { setAccountMenuOpen(false); onOpenVoiceSettings(); }}
              >
                <Mic className="h-4 w-4 text-foreground/55" />
                <span>Voice settings</span>
              </button>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-foreground/80 transition hover:bg-control-hover"
                onClick={() => {
                  setTheme("light");
                  setAccountMenuOpen(false);
                }}
              >
                <Sun className="h-4 w-4 text-foreground/55" />
                <span className="flex-1">Light mode</span>
                {theme === "light" ? <Check className="h-4 w-4 text-brand" /> : null}
              </button>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-foreground/80 transition hover:bg-control-hover"
                onClick={() => {
                  setTheme("dark");
                  setAccountMenuOpen(false);
                }}
              >
                <Moon className="h-4 w-4 text-foreground/55" />
                <span className="flex-1">Dark mode</span>
                {theme === "dark" ? <Check className="h-4 w-4 text-brand" /> : null}
              </button>
            </div>
          ) : null}

          <button
            type="button"
            className="flex h-9 w-full items-center justify-between gap-3 rounded-md px-1.5 text-left text-xs text-foreground/60 transition hover:bg-control-hover hover:text-foreground"
            onClick={() => setAccountMenuOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn("h-2.5 w-2.5 shrink-0 rounded-full", backendConnectionClass(backendConnectionStatus))}
                title={`Backend ${backendConnectionStatus}`}
                aria-label={`Backend ${backendConnectionStatus}`}
              />
              <span className="truncate font-medium text-foreground/75">Luma Assistant</span>
            </span>
            <span className="shrink-0">{environmentLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

type AttachmentChipProps = {
  attachment: AttachmentRef;
  className?: string;
  onRemove?: () => void;
};

function AttachmentChip({ attachment, className, onRemove }: AttachmentChipProps): JSX.Element {
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[11px]", className)}>
      <span className="font-medium">{attachment.name}</span>
      <span className="opacity-70">{attachment.kind === "image" ? "image" : "file"} · {formatAttachmentSize(attachment.size)}</span>
      {onRemove ? (
        <button
          type="button"
          className="rounded-full p-0.5 transition hover:bg-black/5 dark:hover:bg-control-hover/70"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          title="Remove attachment"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

type ImageAttachmentPreviewProps = {
  attachment: AttachmentRef;
  workspace: string;
};

function ImageAttachmentPreview({ attachment, workspace }: ImageAttachmentPreviewProps): JSX.Element {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    setObjectUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setError(null);
    setLoading(false);
    setLightboxOpen(false);
  }, [attachment.id, attachment.relativePath, workspace]);

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  const description = [
    attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : null,
    formatAttachmentSize(attachment.size),
  ].filter(Boolean).join(" | ");

  async function loadImage(): Promise<void> {
    if (loading || objectUrl) return;
    setLoading(true);
    setError(null);
    try {
      const blob = await fetchAttachmentBlob(attachment, workspace);
      const nextUrl = URL.createObjectURL(blob);
      setObjectUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return nextUrl;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load image.");
    } finally {
      setLoading(false);
    }
  }

  if (!objectUrl) {
    return (
      <figure className="mt-2 max-w-full rounded-md border border-card-border bg-surface-1 px-3 py-2">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-control text-foreground/65">
            <ImageIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground/85">{attachment.name}</div>
            <div className="mt-0.5 text-xs text-foreground/55">{description || "Image attachment"}</div>
            {error ? <div className="mt-1 text-xs text-rose-300">{error}</div> : null}
          </div>
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-card-border px-2 text-xs font-medium transition hover:bg-control-hover disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void loadImage()}
            disabled={loading}
          >
            {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
            {loading ? "Loading" : "Load image"}
          </button>
        </div>
      </figure>
    );
  }

  return (
    <>
      <figure className="mt-2 max-w-full overflow-hidden rounded-md border border-card-border bg-surface-1">
        <button
          type="button"
          className="group block w-full bg-black/10 text-left"
          onClick={() => setLightboxOpen(true)}
          aria-label={`Open ${attachment.name}`}
        >
          <img
            src={objectUrl}
            alt={attachment.alt || attachment.name}
            className="max-h-[460px] w-full object-contain transition group-hover:brightness-110 max-sm:max-h-[320px]"
          />
        </button>
        <figcaption className="flex items-center justify-between gap-3 border-t border-card-border px-3 py-2 text-xs text-foreground/70">
          <span className="min-w-0">
            <span className="block truncate font-medium text-foreground/85">{attachment.name}</span>
            <span>{description}</span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-foreground/55">
            <Maximize2 className="h-3.5 w-3.5" />
            Open
          </span>
        </figcaption>
      </figure>

      {lightboxOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true">
          <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-md border border-card-border bg-surface-1 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-card-border px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{attachment.name}</div>
                <div className="text-xs text-foreground/60">{description}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-card-border px-2 text-xs font-medium transition hover:bg-control-hover"
                  href={objectUrl}
                  download={attachment.name}
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </a>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-card-border transition hover:bg-control-hover"
                  onClick={() => setLightboxOpen(false)}
                  aria-label="Close image preview"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-black p-3">
              <img src={objectUrl} alt={attachment.alt || attachment.name} className="mx-auto max-h-[calc(100vh-130px)] max-w-full object-contain" />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

type CenterPanelProps = {
  loading: boolean;
  loadingOlderMessages: boolean;
  selectedSession: SessionCard | null;
  activeWorkspace: string;
  runner: RunRunner;
  setRunner: (value: RunRunner) => void;
  unavailableRunners: RunRunner[];
  model: string;
  setModel: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  claudeEffortFlagSupported: boolean;
  cursorModels: CursorModelInfo[];
  askMode: boolean;
  setAskMode: (value: boolean) => void;
  rightPanelTab: DockTab;
  rightDockOpen: boolean;
  onOpenRightPanel: (tab: DockTab) => void;
  leftSidebarOpen: boolean;
  onOpenLeftSidebar: () => void;
  reloadingChat: boolean;
  onReloadChat: () => void;
  timeline: TimelineEntry[];
  hiddenTimelineCount: number;
  prompt: string;
  setPrompt: (value: string) => void;
  skillCatalog: SkillListItem[];
  filteredSkills: SkillListItem[];
  selectedSkills: SkillListItem[];
  agentCatalog: AgentListItem[];
  filteredAgents: AgentListItem[];
  selectedAgents: AgentListItem[];
  showSystemSkills: boolean;
  skillsLoading: boolean;
  skillsError: string | null;
  skillPickerOpen: boolean;
  agentPickerOpen: boolean;
  highlightedSkillIndex: number;
  highlightedAgentIndex: number;
  onRefreshSkills: () => Promise<void>;
  onToggleShowSystemSkills: () => void;
  onSelectSkill: (skill: SkillListItem) => void;
  onRemoveSelectedSkill: (skillId: string) => void;
  onSelectAgent: (agent: AgentListItem) => void;
  onRemoveSelectedAgent: (agentId: string) => void;
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  pendingAttachments: AttachmentRef[];
  attachmentError: string | null;
  uploadingAttachmentNames: string[];
  isUploadingAttachments: boolean;
  composerFileInputRef: React.RefObject<HTMLInputElement>;
  submitting: boolean;
  stopping: boolean;
  onStopRun: () => Promise<void>;
  onNewSession: () => void;
  hasPendingIndicator: boolean;
  ansi: Convert;
  timelineScrollRef: React.RefObject<HTMLDivElement>;
  timelineBottomRef: React.RefObject<HTMLDivElement>;
  onTimelineScroll: () => void;
  onLoadOlderTimelineMessages: () => void;
  slashSuggestions: SlashCommandSuggestion[];
  onSelectSlashCommand: (command: SlashCommandKey) => Promise<void>;
  queueItems: QueuedMessage[];
  processingQueueItemId: string | null;
  onRemoveQueueItem: (messageId: string) => void;
  onRetryQueueItem: (messageId: string) => void;
  onRetryMessage: (entry: TimelineEntry) => Promise<void>;
  onSelectAttachments: (files: FileList | null) => Promise<void>;
  onRemovePendingAttachment: (attachmentId: string) => void;
  voiceNeedsSetup: boolean;
  voiceSettingsLoading: boolean;
  voicePhase: "idle" | "starting" | "recording" | "transcribing";
  onCancelDictation: () => void;
  voiceListening: boolean;
  voiceError: string | null;
  voiceRecordingSeconds: number;
  onToggleVoiceRecording: () => void;
  onSendButtonClick: () => void;
  planSessionState: PlanSessionState;
  onDisablePlanMode: () => void;
  onAnswerPlanQuestions: (answers: PlanQuestionAnswer[]) => Promise<void>;
  onApprovePlanImplementation: () => Promise<void>;
  onSubmitPlanFeedback: (feedback: string) => Promise<void>;
};

function CenterPanel(props: CenterPanelProps): JSX.Element {
  const { modelOptionsForRunner, reasoningEffortOptionsForRunner, modelSupportsEffort, modelLabel, effortForModel } = useModelOptions();
  const sourceBadge = props.selectedSession ? getSessionSourceBadge(props.selectedSession) : null;
  const [copiedEntryKey, setCopiedEntryKey] = useState<string | null>(null);
  const [attachmentDropActive, setAttachmentDropActive] = useState(false);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const attachmentDragDepthRef = useRef(0);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineBlocks = useMemo(() => buildTimelineRenderBlocks(props.timeline), [props.timeline]);
  const timelineActionsRef = useRef({
    onTimelineScroll: props.onTimelineScroll,
    onLoadOlderTimelineMessages: props.onLoadOlderTimelineMessages,
    onRetryMessage: props.onRetryMessage,
    onAnswerPlanQuestions: props.onAnswerPlanQuestions,
    onApprovePlanImplementation: props.onApprovePlanImplementation,
    onSubmitPlanFeedback: props.onSubmitPlanFeedback,
  });
  timelineActionsRef.current = {
    onTimelineScroll: props.onTimelineScroll,
    onLoadOlderTimelineMessages: props.onLoadOlderTimelineMessages,
    onRetryMessage: props.onRetryMessage,
    onAnswerPlanQuestions: props.onAnswerPlanQuestions,
    onApprovePlanImplementation: props.onApprovePlanImplementation,
    onSubmitPlanFeedback: props.onSubmitPlanFeedback,
  };
  const selectedSessionBusy = Boolean(props.selectedSession && !props.selectedSession.historyOnly && (props.selectedSession.status === "queued" || props.selectedSession.status === "running"));
  const attachmentDropDisabled = props.submitting || props.isUploadingAttachments;
  const composerModelOptions = modelOptionsForRunner(props.runner, props.cursorModels);
  const composerModelSelectOptions = composerModelOptions.includes(props.model)
    ? composerModelOptions
    : [props.model, ...composerModelOptions];
  const composerEffortSupported = props.runner === "cursor" ? cursorModelSupportsEffort(props.model, props.cursorModels) : modelSupportsEffort(props.runner, props.model);
  const composerRunnerLabel = runnerLabel(props.runner);
  const composerDirection = useMemo(
    () => (props.prompt.trim() ? resolveTextDirection(props.prompt) : "auto"),
    [props.prompt],
  );
  const laterUserMessageAts = useMemo(
    () => props.timeline.filter((entry) => entry.role === "user").map((entry) => entry.at),
    [props.timeline],
  );

  const timelineFeed = useMemo(() => (
    <div
      ref={props.timelineScrollRef}
      onScroll={() => timelineActionsRef.current.onTimelineScroll()}
      className={chatTimelineClass}
    >
      <div className={chatEntriesClass}>
        {props.loading ? <p className="text-sm text-foreground/70">Loading...</p> : null}

        {props.hiddenTimelineCount > 0 ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => timelineActionsRef.current.onLoadOlderTimelineMessages()}
              disabled={props.loadingOlderMessages}
            >
              {props.loadingOlderMessages ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Load older messages
            </Button>
          </div>
        ) : null}

        {timelineBlocks.map((block) => {
          if (block.kind === "tool-group") {
            return <ToolEntryGroup key={block.key} entries={block.entries} ansi={props.ansi} />;
          }

          const entry = block.entry;
          const hasLaterUserMessage = laterUserMessageAts.some((at) => at > entry.at);
          const showUserDeliveryState = entry.role === "user"
            && (entry.deliveryStatus === "pending" || entry.deliveryStatus === "failed");
          const canRetryUserMessage = entry.role === "user" && entry.deliveryStatus === "failed";
          const canCopyMessage = (entry.role === "assistant" || entry.role === "plan" || entry.role === "user")
            && Boolean(entry.text.trim());
          return (
            <div key={entry.key} className={chatMessageAlignment(entry.role)}>
              <article className={chatMessageClass(entry.role, entry.deliveryStatus === "failed")}>
                {entry.role !== "system" && entry.role !== "assistant" && entry.role !== "user" && entry.title ? (
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-foreground/70">{entry.title}</div>
                ) : null}

                {entry.attachments && entry.attachments.length > 0 ? (
                  <div className="mb-2 flex flex-col gap-2">
                    {entry.attachments.map((attachment) => (
                      attachment.kind === "image" ? (
                        <ImageAttachmentPreview
                          key={`${entry.key}_${attachment.id}`}
                          attachment={attachment}
                          workspace={props.selectedSession?.workspace || props.activeWorkspace}
                        />
                      ) : (
                        <AttachmentChip
                          key={`${entry.key}_${attachment.id}`}
                          attachment={attachment}
                          className={entry.role === "user"
                            ? "border-card-border bg-surface-2 text-foreground"
                            : "border-card-border bg-surface-1/80 text-foreground"}
                        />
                      )
                    ))}
                  </div>
                ) : null}

                {entry.role === "tool" ? (
                  <ToolEntry entry={entry} ansi={props.ansi} />
                ) : entry.role === "assistant" || entry.role === "plan" ? (
                  <div className="break-words text-[15px] leading-7">
                    <StructuredMessage
                      entryKey={entry.key}
                      text={entry.text}
                      interactive={entry.role === "assistant" && !entry.pending}
                      resolved={hasLaterUserMessage}
                      onAnswerPlanQuestions={(answers) => timelineActionsRef.current.onAnswerPlanQuestions(answers)}
                      onApprovePlanImplementation={() => timelineActionsRef.current.onApprovePlanImplementation()}
                      onSubmitPlanFeedback={(feedback) => timelineActionsRef.current.onSubmitPlanFeedback(feedback)}
                    />
                    {entry.pending ? (
                      <div className="mt-1">
                        <ThinkingDots label={entry.title || "Thinking"} />
                      </div>
                    ) : null}
                  </div>
                ) : entry.role === "error" ? (
                  <div
                    className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs"
                    dangerouslySetInnerHTML={{ __html: props.ansi.toHtml(entry.text) }}
                  />
                ) : (
                  (() => {
                    const direction = resolveTextDirection(entry.text);
                    return (
                      <div
                        className={cn(
                          "rich-text break-words text-sm leading-relaxed",
                          entry.role === "user" && "whitespace-pre-wrap",
                        )}
                        dir={direction}
                        lang={direction === "rtl" ? "fa" : undefined}
                      >
                        {entry.text}
                      </div>
                    );
                  })()
                )}

                {showUserDeliveryState ? (
                  <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-foreground/70">
                    <span>{entry.deliveryStatus === "failed" ? "Failed to send" : "Sending..."}</span>
                    {canRetryUserMessage ? (
                      <button
                        type="button"
                        className="rounded-md border border-card-border px-2 py-0.5 font-semibold transition hover:bg-control-hover disabled:cursor-not-allowed disabled:opacity-70"
                        onClick={() => void timelineActionsRef.current.onRetryMessage(entry)}
                        disabled={props.submitting}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
              {canCopyMessage ? (
                <div className={cn("mt-1 flex items-center gap-1", entry.role === "user" ? "justify-end" : "justify-start")}>
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground/40 transition hover:bg-control-hover hover:text-foreground/75"
                    onClick={() => void copyMessage(entry)}
                    aria-label={copiedEntryKey === entry.key ? "Message copied" : "Copy message"}
                    title={copiedEntryKey === entry.key ? "Copied" : "Copy message"}
                  >
                    {copiedEntryKey === entry.key ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}

        {props.hasPendingIndicator ? (
          <article className="mr-auto max-w-5xl animate-fade-up px-0 py-1.5">
            <div className="inline-flex items-center gap-2 rounded-md bg-surface-1/45 px-2.5 py-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-foreground/45">Reasoning</span>
              <ThinkingDots label="Thinking" />
            </div>
          </article>
        ) : null}

        <div ref={props.timelineBottomRef} />
      </div>
    </div>
  ), [
    copiedEntryKey,
    laterUserMessageAts,
    props.activeWorkspace,
    props.ansi,
    props.hasPendingIndicator,
    props.hiddenTimelineCount,
    props.loading,
    props.loadingOlderMessages,
    props.selectedSession,
    props.submitting,
    props.timelineBottomRef,
    props.timelineScrollRef,
    timelineBlocks,
  ]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const node = composerTextareaRef.current;
    if (!node) return;

    const styles = window.getComputedStyle(node);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
    const borderTop = Number.parseFloat(styles.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(styles.borderBottomWidth) || 0;
    const minHeight = 44;
    const maxHeight = Math.ceil((lineHeight * 5) + paddingTop + paddingBottom + borderTop + borderBottom);

    node.style.height = "auto";
    const nextHeight = Math.min(Math.max(node.scrollHeight, minHeight), maxHeight);
    node.style.height = `${nextHeight}px`;
    node.style.overflowY = node.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [props.prompt]);

  async function copyMessage(entry: TimelineEntry): Promise<void> {
    if (!entry.text.trim()) return;
    await navigator.clipboard.writeText(entry.text);
    setCopiedEntryKey(entry.key);
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
    }
    copyResetTimeoutRef.current = window.setTimeout(() => {
      setCopiedEntryKey((current) => (current === entry.key ? null : current));
      copyResetTimeoutRef.current = null;
    }, 1600);
  }

  function dragEventHasFiles(event: ReactDragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function resetAttachmentDropState(): void {
    attachmentDragDepthRef.current = 0;
    setAttachmentDropActive(false);
  }

  function onAttachmentDragEnter(event: ReactDragEvent<HTMLElement>): void {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    attachmentDragDepthRef.current += 1;
    if (!attachmentDropDisabled) setAttachmentDropActive(true);
  }

  function onAttachmentDragOver(event: ReactDragEvent<HTMLElement>): void {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = attachmentDropDisabled ? "none" : "copy";
  }

  function onAttachmentDragLeave(event: ReactDragEvent<HTMLElement>): void {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
    if (attachmentDragDepthRef.current === 0) setAttachmentDropActive(false);
  }

  function onAttachmentDrop(event: ReactDragEvent<HTMLElement>): void {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    resetAttachmentDropState();
    if (attachmentDropDisabled) return;
    void props.onSelectAttachments(event.dataTransfer.files);
  }

  return (
    <>
      <div className={chatHeaderClass}>
        <div className="flex min-w-0 items-center gap-2">
          {!props.leftSidebarOpen ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0"
              onClick={props.onOpenLeftSidebar}
              aria-label="Open left sidebar"
              title="Open sidebar"
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <FileCode2 className="h-4 w-4 shrink-0 text-foreground/70" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold" title={props.selectedSession?.summary} dir="auto">
                {props.selectedSession?.summary || "New session"}
              </h1>
            </div>
            <div className="flex min-w-0 items-center gap-2 text-[11px] text-foreground/55">
              <ProjectSessionControls key={props.selectedSession?.id ?? "draft"} />
              {props.selectedSession ? <span className="truncate" title={props.selectedSession.id}>{props.selectedSession.status}</span> : null}
              {sourceBadge ? <span className="shrink-0">{sourceBadge.label}</span> : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={props.onReloadChat}
            disabled={!props.selectedSession || props.reloadingChat}
            aria-label="Reload chat"
            title="Reload chat"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", props.reloadingChat && "animate-spin")} />
          </Button>
          <Button type="button" variant={props.rightDockOpen && props.rightPanelTab === "terminal" ? "primary" : "ghost"} size="sm" className="h-7 w-7 p-0" onClick={() => props.onOpenRightPanel("terminal")} aria-label="Open terminal" title="Terminal">
            <Terminal className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant={props.rightDockOpen && props.rightPanelTab === "context" ? "primary" : "ghost"} size="sm" className="h-7 w-7 p-0" onClick={() => props.onOpenRightPanel("context")} aria-label="Open context" title="Context">
            <Layers className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onNewSession}>
            New
          </Button>
        </div>
      </div>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-0 p-0">
        {timelineFeed}

        <form
          className={cn(
            chatComposerClass,
            attachmentDropActive && "border-brand bg-brand-soft/25",
          )}
          onDragEnter={onAttachmentDragEnter}
          onDragOver={onAttachmentDragOver}
          onDragLeave={onAttachmentDragLeave}
          onDragEnd={resetAttachmentDropState}
          onDrop={onAttachmentDrop}
          onSubmit={(event) => {
            event.preventDefault();
            props.onSendButtonClick();
          }}
        >
          {attachmentDropActive ? (
            <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-md border-2 border-dashed border-brand bg-surface-1/95 text-sm font-semibold text-brand">
              Drop files to attach
            </div>
          ) : null}

          <input
            ref={props.composerFileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void props.onSelectAttachments(event.target.files)}
          />

          <div className="mx-auto w-full max-w-5xl">
          <div className="mb-2 flex min-h-9 flex-wrap items-center justify-start gap-2 rounded-md bg-surface-2 px-3 py-1.5 text-xs text-foreground/70">
            <select
              className="h-6 appearance-none rounded-md border-0 bg-control px-2 text-xs text-foreground outline-none hover:bg-control-hover focus:ring-2 focus:ring-brand/20"
              style={{ width: compactSelectWidth(composerRunnerLabel) }}
              value={props.runner}
              onChange={(event) => props.setRunner(event.target.value as RunRunner)}
              aria-label="Runner"
              title="Runner"
            >
              {runnerOptions.map((runnerOption) => (
                <option key={runnerOption} value={runnerOption} disabled={props.unavailableRunners.includes(runnerOption)}>
                  {runnerLabel(runnerOption)}
                </option>
              ))}
            </select>
            <select
              className="h-6 appearance-none rounded-md border-0 bg-control px-2 text-xs text-foreground outline-none hover:bg-control-hover focus:ring-2 focus:ring-brand/20"
              style={{ width: compactSelectWidth(modelLabel(props.runner, props.model)), maxWidth: "min(60vw, 22rem)" }}
              value={props.model}
              onChange={(event) => props.setModel(event.target.value)}
              aria-label="Model"
              title={modelLabel(props.runner, props.model)}
            >
              {composerModelSelectOptions.map((modelOption) => (
                <option key={modelOption} value={modelOption}>
                  {modelLabel(props.runner, modelOption)}
                </option>
              ))}
            </select>
            <select
              className="h-6 appearance-none rounded-md border-0 bg-control px-2 text-xs text-foreground outline-none hover:bg-control-hover focus:ring-2 focus:ring-brand/20 disabled:opacity-50"
              style={{ width: compactSelectWidth(reasoningEffortLabel(props.reasoningEffort)) }}
              value={props.reasoningEffort}
              disabled={!composerEffortSupported}
              onChange={(event) => props.setReasoningEffort(event.target.value as ReasoningEffort)}
              aria-label="Thinking effort"
              title={composerEffortSupported ? "Thinking effort" : "This model has no effort control"}
            >
              <ModelEffortOptions runner={props.runner} model={props.model} value={props.reasoningEffort} />
            </select>
            <ModelCatalogRefresh runner={props.runner} compact />
            {props.runner === "claude" && !props.claudeEffortFlagSupported ? (
              <span className="rounded-md bg-amber-500/12 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300" title="Claude effort flag support was not detected; Luma uses CLAUDE_CODE_EFFORT_LEVEL. Check model discovery for CLI errors.">
                env fallback
              </span>
            ) : null}
            {props.runner === "cursor" ? (
              <button
                type="button"
                className={cn(
                  "h-6 rounded-md px-2 text-[11px] font-medium outline-none transition focus:ring-2 focus:ring-brand/20",
                  props.askMode
                    ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                    : "bg-control text-foreground/70 hover:bg-control-hover",
                )}
                onClick={() => props.setAskMode(!props.askMode)}
                title="Cursor ask mode: read-only Q&A without edits"
              >
                Ask
              </button>
            ) : null}
          </div>

          <ModelCatalogNotice runner={props.runner} />
          {props.askMode && props.runner === "cursor" && props.planSessionState === "idle" ? (
            <div className="mb-2 flex items-start justify-between gap-3 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-foreground/80">
              <span className="min-w-0">Ask mode is on. Cursor will answer in read-only mode without editing files.</span>
              <button
                type="button"
                className="shrink-0 rounded-full p-1 text-foreground/60 transition hover:bg-black/5 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30 dark:hover:bg-control-hover/70"
                onClick={() => props.setAskMode(false)}
                aria-label="Disable ask mode"
                title="Disable ask mode"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          {props.planSessionState !== "idle" ? (
            <div className="mb-2 flex items-start justify-between gap-3 rounded-md border border-brand/30 bg-brand-soft/40 px-3 py-2 text-sm text-foreground/80">
              <span className="min-w-0">
                {props.planSessionState === "armed"
                  ? "Plan mode is enabled. Your next message will start the planning workflow."
                  : "Planning workflow is active. Messages stay read-only until final approval."}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-full p-1 text-foreground/60 transition hover:bg-black/5 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30 dark:hover:bg-control-hover/70"
                onClick={props.onDisablePlanMode}
                aria-label="Disable plan mode"
                title="Disable plan mode"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          {props.selectedSkills.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {props.selectedSkills.map((skill) => (
                <div
                  key={skill.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-card-border bg-surface-2/80 px-2 py-1 text-xs text-foreground"
                  title={skill.path}
                >
                  <AtSign className="h-3.5 w-3.5 text-foreground/60" />
                  <span className="max-w-[220px] truncate">{skill.name}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-foreground/65 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-control-hover/70"
                    onClick={() => props.onRemoveSelectedSkill(skill.id)}
                    aria-label={`Remove ${skill.name}`}
                    title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {props.selectedAgents.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {props.selectedAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-card-border bg-surface-2/80 px-2 py-1 text-xs text-foreground"
                  title={agent.path}
                >
                  <Bot className="h-3.5 w-3.5 text-foreground/60" />
                  <span className="max-w-[220px] truncate">{agent.name}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-foreground/65 transition hover:bg-black/5 hover:text-foreground dark:hover:bg-control-hover/70"
                    onClick={() => props.onRemoveSelectedAgent(agent.id)}
                    aria-label={`Remove ${agent.name}`}
                    title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {props.pendingAttachments.length > 0 || props.isUploadingAttachments || props.attachmentError ? (
            <div className="mb-2 rounded-md border border-card-border bg-surface-1 px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground/80">
                <span>Attachments</span>
                <span>
                  {props.pendingAttachments.length}/{attachmentMaxFiles}
                  {props.isUploadingAttachments ? ` · Uploading ${props.uploadingAttachmentNames.length}` : ""}
                </span>
              </div>

              {props.pendingAttachments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {props.pendingAttachments.map((attachment) => (
                    <AttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      className="border-card-border bg-surface-2/60 text-foreground"
                      onRemove={() => props.onRemovePendingAttachment(attachment.id)}
                    />
                  ))}
                </div>
              ) : null}

              {props.isUploadingAttachments ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {props.uploadingAttachmentNames.map((name, index) => (
                    <div
                      key={`${name}_${index}`}
                      className="inline-flex items-center gap-2 rounded-full border border-dashed border-card-border px-2 py-1 text-[11px] text-foreground/70"
                    >
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                      <span>{name}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {props.attachmentError ? <p className="mt-2 text-xs text-rose-700">{props.attachmentError}</p> : null}
            </div>
          ) : null}

          {props.queueItems.length > 0 ? (
            <div className="mb-2 rounded-md border border-card-border bg-surface-1 p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-foreground/80">Queued messages ({props.queueItems.length})</div>
                {selectedSessionBusy && !props.queueItems[0]?.deliveryError ? (
                  <div className="text-[11px] text-foreground/60">Will send after current run finishes</div>
                ) : null}
              </div>
              <div className="space-y-1">
                {props.queueItems.slice(0, 5).map((item) => {
                  const isProcessing = item.id === props.processingQueueItemId;
                  return (
                  <div key={item.id} className="flex items-center gap-2 rounded-md bg-surface-2/60 px-2 py-1">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 truncate text-xs text-foreground/80" title={item.prompt}>
                          {truncatePreview(item.prompt, 140)}
                        </div>
                        {isProcessing ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand-dark">
                            <LoaderCircle className="h-3 w-3 animate-spin" />
                            Sending now
                          </span>
                        ) : null}
                      </div>
                      {item.deliveryError ? <div role="alert" className="text-[11px] text-danger-fg">{item.deliveryError}</div> : null}
                      {item.attachments.length > 0 ? (
                        <div className="text-[11px] text-foreground/60">{formatAttachmentSummary(item.attachments)}</div>
                      ) : null}
                      {item.skills.length > 0 ? (
                        <div className="text-[11px] text-foreground/60">{formatSkillSummary(item.skills, props.skillCatalog)}</div>
                      ) : null}
                      {item.agents.length > 0 ? (
                        <div className="text-[11px] text-foreground/60">{formatAgentSummary(item.agents, props.agentCatalog)}</div>
                      ) : null}
                    </div>
                    {item.deliveryError ? (
                      <button type="button" className="rounded px-2 py-1 text-xs text-brand hover:bg-control-hover" onClick={() => props.onRetryQueueItem(item.id)}>
                        Retry
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="rounded p-1 text-foreground/70 transition hover:bg-black/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-control-hover/70"
                      onClick={() => props.onRemoveQueueItem(item.id)}
                      disabled={isProcessing}
                      aria-label="Remove queued message"
                      title={isProcessing ? "This message is already sending" : "Remove"}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          ) : null}

	          <div className="relative flex items-end gap-2">
            <Dialog.Root open={props.agentPickerOpen} modal={false}>
              <Dialog.Content
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                className="absolute bottom-full left-0 right-12 z-20 mb-2 max-h-[360px] overflow-hidden rounded-md border border-card-border bg-surface-1 p-2 shadow-xl outline-none max-sm:right-0 max-sm:max-h-[300px] max-sm:p-1.5"
              >
                <Dialog.Title className="flex items-center justify-between gap-2 px-1 pb-2 text-xs font-semibold text-foreground/80">
                  <span className="inline-flex items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5" />
                    Agents
                  </span>
                  <Badge className="shrink-0 bg-surface-2 text-[10px] text-foreground/70">@@</Badge>
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  Select a repo agent to attach it to the next message.
                </Dialog.Description>

                {props.filteredAgents.length > 0 ? (
                  <div className="max-h-[292px] space-y-1 overflow-auto pr-1 max-sm:max-h-[240px] max-sm:space-y-0.5">
                    {props.filteredAgents.map((agent, index) => (
                      <button
                        key={agent.id}
                        type="button"
                        className={cn(
                          "w-full rounded-md border px-2 py-2 text-left transition max-sm:py-1.5",
                          index === props.highlightedAgentIndex
                            ? "border-brand/45 bg-brand-soft/50"
                            : "border-transparent hover:border-card-border hover:bg-surface-2",
                        )}
                        onClick={() => props.onSelectAgent(agent)}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-foreground">{agent.name}</span>
                          <Badge className="shrink-0 bg-surface-2 text-[10px] text-foreground/70">{agent.slug}</Badge>
                        </div>
                        {agent.description ? (
                          <div className="mt-0.5 max-h-8 overflow-hidden text-[11px] leading-snug text-foreground/65 max-sm:hidden">{agent.description}</div>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-card-border px-2 py-3 text-center text-xs text-foreground/60">
                    {props.agentCatalog.length === 0 ? "No agents found." : "No matching agents."}
                  </div>
                )}
              </Dialog.Content>
            </Dialog.Root>

            <Dialog.Root open={props.skillPickerOpen} modal={false}>
              <Dialog.Content
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                className="absolute bottom-full left-0 right-12 z-20 mb-2 max-h-[360px] overflow-hidden rounded-md border border-card-border bg-surface-1 p-2 shadow-xl outline-none max-sm:right-0 max-sm:max-h-[300px] max-sm:p-1.5"
              >
                <Dialog.Title className="flex items-center justify-between gap-2 px-1 pb-2 text-xs font-semibold text-foreground/80">
                  <span className="inline-flex items-center gap-1.5">
                    <AtSign className="h-3.5 w-3.5" />
                    Skills
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={props.showSystemSkills}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px] font-medium transition",
                        props.showSystemSkills
                          ? "bg-brand-soft text-brand-dark dark:text-brand"
                          : "text-foreground/65 hover:bg-surface-2 hover:text-foreground",
                      )}
                      onClick={props.onToggleShowSystemSkills}
                      title={props.showSystemSkills ? "Hide system skills" : "Show system skills"}
                    >
                      System
                    </button>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-foreground/65 transition hover:bg-surface-2 hover:text-foreground"
                      onClick={() => void props.onRefreshSkills()}
                      disabled={props.skillsLoading}
                    >
                      {props.skillsLoading ? "Loading" : "Reload"}
                    </button>
                  </div>
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  Select a skill to attach it to the next message.
                </Dialog.Description>

                {props.skillsError ? (
                  <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-2 text-xs text-rose-800 dark:border-danger-fg/40 dark:bg-danger-bg/80 dark:text-danger-fg">
                    {props.skillsError}
                  </div>
                ) : props.filteredSkills.length > 0 ? (
                  <div className="max-h-[292px] space-y-1 overflow-auto pr-1 max-sm:max-h-[240px] max-sm:space-y-0.5">
                    {props.filteredSkills.map((skill, index) => (
                      <button
                        key={skill.id}
                        type="button"
                        className={cn(
                          "w-full rounded-md border px-2 py-2 text-left transition max-sm:py-1.5",
                          index === props.highlightedSkillIndex
                            ? "border-brand/45 bg-brand-soft/50"
                            : "border-transparent hover:border-card-border hover:bg-surface-2",
                        )}
                        onClick={() => props.onSelectSkill(skill)}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-foreground">{skill.name}</span>
                          <Badge className="shrink-0 bg-surface-2 text-[10px] text-foreground/70">{skill.source}</Badge>
                        </div>
                        {skill.description ? (
                          <div className="mt-0.5 max-h-8 overflow-hidden text-[11px] leading-snug text-foreground/65 max-sm:hidden">{skill.description}</div>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-card-border px-2 py-3 text-center text-xs text-foreground/60">
                    {props.skillsLoading
                      ? "Loading skills..."
                      : props.skillCatalog.length === 0
                        ? "No skills found."
                        : props.showSystemSkills
                          ? "No matching skills."
                          : "No matching non-system skills."}
                  </div>
                )}
              </Dialog.Content>
            </Dialog.Root>

            {props.slashSuggestions.length > 0 ? (
              <div className="absolute bottom-full left-0 right-12 z-10 mb-2 space-y-1 rounded-md border border-card-border bg-surface-1 p-2 shadow-lg">
                {props.slashSuggestions.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="w-full rounded-md border border-transparent px-2 py-2 text-left transition hover:border-card-border hover:bg-surface-2"
                    onClick={() => void props.onSelectSlashCommand(item.key)}
                    disabled={props.submitting}
                  >
                    <div className="text-xs font-semibold">{item.key}</div>
                    <div className="text-[11px] text-foreground/70">{item.title} - {item.description}</div>
                  </button>
                ))}
              </div>
            ) : null}

            <textarea
              ref={composerTextareaRef}
              rows={1}
              className="composer-input min-h-[44px] w-full resize-none rounded-lg border border-card-border bg-surface-1 px-3 py-2 text-base outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20 md:text-sm"
              placeholder="Type / for commands"
              value={props.prompt}
              dir={composerDirection}
              lang={composerDirection === "rtl" ? "fa" : undefined}
              onChange={(event) => props.setPrompt(event.target.value)}
              onKeyDown={props.onComposerKeyDown}
            />

            <Button
              type="button"
              disabled={!props.prompt.trim() || (!props.selectedSession && props.submitting) || props.isUploadingAttachments || props.voicePhase !== "idle"}
              aria-label={selectedSessionBusy || (props.selectedSession && props.submitting) ? "Queue message" : "Send message"}
              title={selectedSessionBusy || (props.selectedSession && props.submitting) ? "Queue message" : "Send message"}
              onClick={props.onSendButtonClick}
              className="h-[44px] w-[44px] shrink-0 rounded-lg p-0"
            >
              {!props.selectedSession && props.submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-md bg-brand-soft px-2 py-1 font-medium text-brand">Auto</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.submitting || props.isUploadingAttachments}
              aria-label="Add attachment"
              title="Add attachment"
              onClick={() => props.composerFileInputRef.current?.click()}
            >
              <Paperclip className="mr-1.5 h-4 w-4" />
              Attachment
            </Button>
            <span className="hidden rounded-md border border-dashed border-card-border px-2 py-1 text-xs text-foreground/60 sm:inline-flex">
              Drop files here
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void props.onStopRun()}
              disabled={!props.selectedSession || props.selectedSession.status !== "running" || props.stopping}
            >
              {props.stopping ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <CircleStop className="mr-1.5 h-4 w-4" />}
              Stop
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onToggleVoiceRecording}
              disabled={props.voiceSettingsLoading || props.voicePhase === "starting" || props.voicePhase === "transcribing"}
              aria-label={props.voiceListening ? "Stop recording" : props.voiceNeedsSetup ? "Set up dictation" : "Start recording"}
              title={props.voiceListening ? "Stop recording" : props.voiceNeedsSetup ? "Set up dictation" : "Start recording"}
            >
              {props.voicePhase === "starting" || props.voicePhase === "transcribing" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : props.voiceListening ? <MicOff className="mr-1.5 h-4 w-4" /> : <Mic className="mr-1.5 h-4 w-4" />}
              {props.voicePhase === "transcribing" ? "Transcribing…" : props.voicePhase === "starting" ? "Opening microphone…" : props.voiceListening ? `Stop ${formatRecordingDuration(props.voiceRecordingSeconds)}` : props.voiceNeedsSetup ? "Set up dictation" : "Record"}
            </Button>
            {props.voicePhase !== "idle" ? <Button type="button" variant="ghost" size="sm" onClick={props.onCancelDictation}>Cancel dictation</Button> : null}
          </div>
          {props.voiceError ? <p role="alert" className="mt-2 text-xs text-danger-fg">{props.voiceError}</p> : null}
          </div>

        </form>
      </CardContent>
    </>
  );
}

type ClaudeRightPanelProps = {
  rightPanelTab: DockTab;
  setRightPanelTab: (tab: DockTab) => void;
  onClose: () => void;
  workspaces: WorkspaceOption[];
  activeWorkspace: string;
  onChangeWorkspace: (workspace: string) => Promise<void>;
  runner: RunRunner;
  setRunner: (value: RunRunner) => void;
  unavailableRunners: RunRunner[];
  model: string;
  setModel: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  cursorModels: CursorModelInfo[];
  sandbox: SandboxMode;
  setSandbox: (value: SandboxMode) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  ansi: Convert;
  debugLogs: DebugLogEntry[];
  selectedSessionId: string | null;
  selectedSession: SessionCard | null;
  selectedSessionTokenUsage: TokenUsageSummary | null | undefined;
  tokenUsageLoading: boolean;
  tokenUsageError: string | null;
  onLoadTokenUsage: (sessionId: string) => Promise<void>;
  selectedTerminal: TerminalSessionSnapshot | null;
  terminalHistory: string[];
  terminalInput: string;
  setTerminalInput: (value: string) => void;
  terminalAction: "starting" | "stopping" | "sending" | null;
  terminalOutputRef: React.RefObject<HTMLDivElement>;
  onStartTerminal: () => Promise<void>;
  onStopTerminal: () => Promise<void>;
  onInterruptTerminal: () => Promise<void>;
  onSubmitTerminalInput: (rawInput?: string) => Promise<void>;
  sessionAction: "archive" | "delete" | null;
  onArchiveSession: () => Promise<void>;
  onDeleteSession: () => Promise<void>;
  mobile?: boolean;
};

function ClaudeRightPanel(props: ClaudeRightPanelProps): JSX.Element {
  const { modelOptionsForRunner, reasoningEffortOptionsForRunner, modelSupportsEffort, modelLabel, effortForModel } = useModelOptions();
  const activeModelOptions = modelOptionsForRunner(props.runner, props.cursorModels);
  const [useCustomModel, setUseCustomModel] = useState(() => !activeModelOptions.includes(props.model));
  const [terminalHistoryCursor, setTerminalHistoryCursor] = useState<number | null>(null);
  const terminalRunning = props.selectedTerminal?.status === "running";
  const effortSupported = props.runner === "cursor" ? cursorModelSupportsEffort(props.model, props.cursorModels) : modelSupportsEffort(props.runner, props.model);
  const terminalBusy = props.terminalAction === "starting" || props.terminalAction === "stopping";
  const selectedSessionSourceBadge = props.selectedSession ? getSessionSourceBadge(props.selectedSession) : null;
  const activeTabLabel = {
    terminal: "Terminal",
    context: "Context",
  }[props.rightPanelTab];

  useEffect(() => {
    if (!modelOptionsForRunner(props.runner, props.cursorModels).includes(props.model)) {
      setUseCustomModel(true);
    }
  }, [props.model, props.runner, props.cursorModels, modelOptionsForRunner]);

  useEffect(() => {
    if (props.rightPanelTab !== "terminal") return;
    const node = props.terminalOutputRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [props.rightPanelTab, props.selectedTerminal?.output, props.terminalInput]);

  function selectTab(tab: DockTab): void {
    props.setRightPanelTab(tab);
  }

  function focusTerminalPane(): void {
    props.terminalOutputRef.current?.focus();
  }

  function onTerminalKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!terminalRunning || props.terminalAction === "sending") return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void props.onInterruptTerminal();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const command = props.terminalInput;
      setTerminalHistoryCursor(null);
      void props.onSubmitTerminalInput(`${command}\n`);
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      setTerminalHistoryCursor(null);
      props.setTerminalInput(props.terminalInput.slice(0, -1));
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setTerminalHistoryCursor(null);
      props.setTerminalInput("");
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!props.terminalHistory.length) return;
      const nextCursor = terminalHistoryCursor === null
        ? 0
        : Math.min(terminalHistoryCursor + 1, props.terminalHistory.length - 1);
      setTerminalHistoryCursor(nextCursor);
      props.setTerminalInput(props.terminalHistory[nextCursor] || "");
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (terminalHistoryCursor === null) return;
      const nextCursor = terminalHistoryCursor - 1;
      if (nextCursor < 0) {
        setTerminalHistoryCursor(null);
        props.setTerminalInput("");
        return;
      }
      setTerminalHistoryCursor(nextCursor);
      props.setTerminalInput(props.terminalHistory[nextCursor] || "");
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      setTerminalHistoryCursor(null);
      props.setTerminalInput(`${props.terminalInput}  `);
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1) return;

    event.preventDefault();
    setTerminalHistoryCursor(null);
    props.setTerminalInput(`${props.terminalInput}${event.key}`);
  }

  function onTerminalPaste(event: ReactClipboardEvent<HTMLDivElement>): void {
    if (!terminalRunning || props.terminalAction === "sending") return;
    const text = event.clipboardData.getData("text");
    if (!text) return;
    event.preventDefault();
    setTerminalHistoryCursor(null);
    props.setTerminalInput(`${props.terminalInput}${text.replace(/\r\n/g, "\n")}`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <div className="relative z-10 flex h-12 shrink-0 items-center justify-between px-3 shadow-[0_14px_30px_-28px_rgba(0,0,0,0.9)]">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 text-brand" />
          <span className="truncate text-sm font-semibold">{activeTabLabel}</span>
        </div>
        <button type="button" className="rounded-md p-1 text-foreground/55 hover:bg-control-hover hover:text-foreground" onClick={props.onClose} aria-label="Close dock" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      {props.mobile ? (
        <div className="relative z-10 grid shrink-0 grid-cols-2 gap-1 bg-background px-2 py-2 shadow-[0_12px_26px_-26px_rgba(0,0,0,0.9)]">
          {([
            ["terminal", Terminal, ""],
            ["context", Layers, ""],
          ] as const).map(([tab, Icon, count]) => (
            <button
              key={tab}
              type="button"
              className={cn(
                "flex h-8 items-center justify-center gap-1 rounded-md text-xs transition",
                props.rightPanelTab === tab ? "bg-control-hover text-foreground" : "text-foreground/60 hover:bg-control hover:text-foreground",
              )}
              onClick={() => selectTab(tab)}
              title={tab}
            >
              <Icon className="h-3.5 w-3.5" />
              {count ? <span>{count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
        {props.rightPanelTab === "terminal" ? (
          <section className="flex min-h-full flex-col">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">Session terminal</h3>
                <p className="truncate text-[11px] text-foreground/55" title={props.selectedSessionId || ""}>
                  {props.selectedSessionId || "Select a session to open a terminal"}
                </p>
              </div>
              <Badge>{terminalRunning ? "running" : "stopped"}</Badge>
            </div>

            <div className="mb-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void props.onStartTerminal()} disabled={!props.selectedSessionId || terminalRunning || terminalBusy}>
                {props.terminalAction === "starting" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Open
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void props.onStopTerminal()} disabled={!terminalRunning || terminalBusy}>
                {props.terminalAction === "stopping" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Stop
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void props.onInterruptTerminal()} disabled={!terminalRunning || props.terminalAction === "sending"}>
                Ctrl+C
              </Button>
            </div>

            {props.selectedTerminal ? (
              <p className="mb-2 truncate text-[11px] text-foreground/60">
                {props.selectedTerminal.workspace} {props.selectedTerminal.pid ? `| pid ${props.selectedTerminal.pid}` : ""}
              </p>
            ) : null}

            <div
              ref={props.terminalOutputRef}
              className="min-h-[420px] flex-1 cursor-text overflow-auto rounded-md border border-card-border bg-[#1f1f1e] p-3 font-mono text-[11px] leading-5 text-[#e7e5df] outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
              tabIndex={0}
              role="textbox"
              aria-label="Session terminal"
              aria-multiline="true"
              onClick={focusTerminalPane}
              onKeyDown={onTerminalKeyDown}
              onPaste={onTerminalPaste}
            >
              <pre className="min-w-max whitespace-pre-wrap">
                {props.selectedTerminal?.output
                  || (props.selectedTerminal
                    ? (props.selectedTerminal.status === "running" ? "$ terminal ready" : "$ terminal stopped")
                    : "$ terminal not started")}
              </pre>
              {terminalRunning ? (
                <div className="flex min-w-max items-center whitespace-pre-wrap">
                  <span className="text-brand">$ </span>
                  <span>{props.terminalInput}</span>
                  <span className={cn(
                    "ml-0.5 inline-block h-4 w-1.5 bg-[#e7e5df]",
                    props.terminalAction === "sending" ? "opacity-40" : "animate-pulse",
                  )} />
                </div>
              ) : null}
            </div>

          </section>
        ) : null}


        {props.rightPanelTab === "context" ? (
          <section className="space-y-3">
            <div className="rounded-md border border-card-border bg-surface-2 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Workspace</h3>
                <Badge>active</Badge>
              </div>
              <select
                className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                value={props.activeWorkspace}
                onChange={(event) => void props.onChangeWorkspace(event.target.value)}
              >
                {props.workspaces.map((workspace) => (
                  <option key={workspace.path} value={workspace.path}>
                    {workspace.name} - {workspace.path}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-md border border-card-border bg-surface-2 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Session</h3>
                {selectedSessionSourceBadge ? <span className={cn("rounded px-2 py-0.5 text-[10px] font-semibold", selectedSessionSourceBadge.className)}>{selectedSessionSourceBadge.label}</span> : <Badge>none</Badge>}
              </div>
              {props.selectedSession ? (
                <>
                  <p className="mb-2 truncate font-mono text-[11px] text-foreground/65" title={props.selectedSession.sessionId}>{props.selectedSession.sessionId}</p>
                  <p className="mb-2 text-xs text-foreground/70">{describeSessionMeta(props.selectedSession)}</p>
                  <p className="mb-2 text-xs text-foreground/60">runner: {runnerLabel(props.selectedSession.runner)} | source: {props.selectedSession.sourceRaw || props.selectedSession.sourceTag}</p>
                  <div className="mb-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" disabled={props.tokenUsageLoading} onClick={() => void props.onLoadTokenUsage(props.selectedSession!.sessionId)}>
                      {props.tokenUsageLoading ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      Token usage
                    </Button>
                    <Button size="sm" variant="ghost" disabled={props.sessionAction !== null || props.selectedSession.historyOnly} onClick={() => void props.onArchiveSession()}>
                      {props.sessionAction === "archive" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      Archive
                    </Button>
                    <Button size="sm" variant="ghost" className="text-rose-400" disabled={props.sessionAction !== null || props.selectedSession.historyOnly} onClick={() => void props.onDeleteSession()}>
                      {props.sessionAction === "delete" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      Delete
                    </Button>
                  </div>
                  {props.tokenUsageError ? <p className="mb-2 rounded-md border border-danger-fg/40 bg-danger-bg px-3 py-2 text-xs text-danger-fg">{props.tokenUsageError}</p> : null}
                  {props.selectedSessionTokenUsage ? (
                    <div className="rounded-md border border-card-border bg-control px-3 py-2 text-xs text-foreground/75">
                      <div className="mb-1 font-semibold text-foreground">Token usage</div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <span>Input</span><span className="text-right tabular-nums">{props.selectedSessionTokenUsage.inputTokens.toLocaleString()}</span>
                        <span>Output</span><span className="text-right tabular-nums">{props.selectedSessionTokenUsage.outputTokens.toLocaleString()}</span>
                        <span>Cached input</span><span className="text-right tabular-nums">{props.selectedSessionTokenUsage.cachedInputTokens.toLocaleString()}</span>
                        <span>Total</span><span className="text-right tabular-nums">{props.selectedSessionTokenUsage.totalTokens.toLocaleString()}</span>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-foreground/70">Select a session to manage it.</p>
              )}
            </div>

            <div className="rounded-md border border-card-border bg-surface-2 p-3">
              <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Run defaults</h3><ModelCatalogRefresh runner={props.runner} /></div>
              <ModelCatalogNotice runner={props.runner} />
              <div className="space-y-2">
                <select className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none" value={props.runner} onChange={(event) => props.setRunner(event.target.value as RunRunner)}>
                  {runnerOptions.map((runnerOption) => <option key={runnerOption} value={runnerOption} disabled={props.unavailableRunners.includes(runnerOption)}>{runnerLabel(runnerOption)}</option>)}
                </select>
                <select
                  className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none"
                  value={useCustomModel ? "__custom__" : props.model}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === "__custom__") {
                      setUseCustomModel(true);
                      return;
                    }
                    setUseCustomModel(false);
                    props.setModel(next);
                  }}
                >
                  {activeModelOptions.map((modelOption) => <option key={modelOption} value={modelOption}>{modelLabel(props.runner, modelOption)}</option>)}
                  <option value="__custom__">Custom model...</option>
                </select>
                {useCustomModel ? <input className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none" value={props.model} onChange={(event) => props.setModel(event.target.value)} placeholder="Custom model id" /> : null}
                <select className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none disabled:opacity-50" value={props.reasoningEffort} disabled={!effortSupported} onChange={(event) => props.setReasoningEffort(event.target.value as ReasoningEffort)}>
                  <ModelEffortOptions runner={props.runner} model={props.model} value={props.reasoningEffort} />
                </select>
                <select className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none" value={props.sandbox} onChange={(event) => props.setSandbox(event.target.value as SandboxMode)}>
                  {sandboxOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </div>
            </div>

            <div className="rounded-md border border-card-border bg-surface-2 p-3">
              <Button variant="ghost" onClick={props.toggleTheme} className="w-full justify-between">
                <span className="flex items-center gap-2"><Layers className="h-4 w-4" /> {props.theme === "light" ? "Light mode" : "Dark mode"}</span>
                {props.theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              </Button>
            </div>

            {props.debugLogs.length > 0 ? (
              <details className="rounded-md border border-card-border bg-surface-2 p-3">
                <summary className="cursor-pointer text-sm font-semibold">Debug logs ({props.debugLogs.length})</summary>
                <div className="mt-2 space-y-2">
                  {props.debugLogs.map((entry) => (
                    <div key={entry.key} className="rounded-md border border-card-border bg-control px-3 py-2">
                      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-foreground/65">
                        <span className="font-mono">{entry.runId}</span>
                        <span>{new Date(entry.at).toLocaleString()}</span>
                      </div>
                      <div className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground/80" dangerouslySetInnerHTML={{ __html: props.ansi.toHtml(entry.text) }} />
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </section>
        ) : null}

      </div>
    </div>
  );
}

type AgentsPanelProps = {
  agents: AgentListItem[];
  schedules: AgentSchedule[];
  upcoming: AgentSchedule[];
  executions: AgentScheduleExecution[];
  skillSyncResult: SkillSyncResult | null;
  loading: boolean;
  error: string | null;
  selectedAgentId: string;
  setSelectedAgentId: (agentId: string) => void;
  scheduleTime: string;
  setScheduleTime: (time: string) => void;
  scheduleModel: string;
  setScheduleModel: (model: string) => void;
  scheduleEffort: ReasoningEffort;
  setScheduleEffort: (effort: ReasoningEffort) => void;
  scheduleRunner: RunRunner;
  cursorModels: CursorModelInfo[];
  selectedSkills: SkillListItem[];
  skillCatalog: SkillListItem[];
  actionId: string | null;
  onReload: () => Promise<void>;
  onCreateSchedule: () => Promise<void>;
  onToggleSchedule: (schedule: AgentSchedule) => Promise<void>;
  onUpdateScheduleConfig: (
    schedule: AgentSchedule,
    patch: { model?: string; reasoningEffort?: ReasoningEffort },
  ) => Promise<void>;
  onDeleteSchedule: (schedule: AgentSchedule) => Promise<void>;
  onRunNow: (schedule: AgentSchedule) => Promise<void>;
  onSelectExecution: (execution: AgentScheduleExecution) => void;
  compact?: boolean;
};

function formatDateTime(value: number | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function formatTehranSchedule(schedule: AgentSchedule): string {
  const hour = String(schedule.time.hour).padStart(2, "0");
  const minute = String(schedule.time.minute).padStart(2, "0");
  return `${hour}:${minute} ${schedule.time.timezone}`;
}

function executionStatusClass(status: AgentScheduleExecution["status"]): string {
  if (status === "completed") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-300";
  if (status === "running" || status === "queued") return "border-brand/35 bg-brand-soft text-brand";
  if (status === "failed") return "border-rose-500/35 bg-rose-500/10 text-rose-300";
  if (status === "stopped" || status === "skipped") return "border-card-border bg-control text-foreground/65";
  return "border-card-border bg-control text-foreground/65";
}

function deploymentLabel(): "Local" | "Deployed" {
  if (typeof window === "undefined") return "Local";
  if (isDesktopLocal) return "Local";
  const hostname = window.location.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1" || hostname.startsWith("127.")
    ? "Local"
    : "Deployed";
}

function backendConnectionClass(status: BackendConnectionStatus): string {
  if (status === "connected") return "bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.16)]";
  if (status === "connecting") return "bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.14)]";
  return "bg-rose-400 shadow-[0_0_0_3px_rgba(251,113,133,0.14)]";
}

function AgentsPanel(props: AgentsPanelProps): JSX.Element {
  const { modelOptionsForRunner, reasoningEffortOptionsForRunner, modelSupportsEffort, modelLabel, effortForModel } = useModelOptions();
  const selectedAgent = props.agents.find((agent) => agent.id === props.selectedAgentId) || null;
  const selectedSkillRefs = props.selectedSkills.map(selectedSkillRef);
  const syncConflictCount = props.skillSyncResult?.conflicts.length || 0;
  const syncErrorCount = props.skillSyncResult?.errors.length || 0;
  const [visibleExecutionCount, setVisibleExecutionCount] = useState(sidebarListPageSize);
  const visibleExecutions = props.executions.slice(0, visibleExecutionCount);
  const hasHiddenExecutions = visibleExecutionCount < props.executions.length;
  const createModelOptions = modelOptionsForRunner(props.scheduleRunner, props.cursorModels);
  const createModelChoices = createModelOptions.includes(props.scheduleModel)
    ? createModelOptions
    : [props.scheduleModel, ...createModelOptions];

  useEffect(() => {
    setVisibleExecutionCount(sidebarListPageSize);
  }, [props.executions.length]);


  return (
    <div className={cn(props.compact ? "space-y-2" : "space-y-3")}>
      <section className={cn("border border-card-border bg-surface-1 p-3", props.compact ? "rounded-md" : "rounded-2xl")}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Bot className="h-4 w-4" />
            Agent schedule
          </h3>
          <ModelCatalogRefresh runner={props.scheduleRunner} compact />
          <Button size="sm" variant="ghost" onClick={() => void props.onReload()} disabled={props.loading}>
            {props.loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>

        {props.error ? (
          <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-200">
            {props.error}
          </div>
        ) : null}

        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-foreground/75">Agent</label>
            <select
              className="h-10 w-full rounded-xl border border-card-border bg-surface-1 px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
              value={props.selectedAgentId}
              onChange={(event) => props.setSelectedAgentId(event.target.value)}
              disabled={props.agents.length === 0}
            >
              {props.agents.length === 0 ? <option value="">No agents found</option> : null}
              {props.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            {selectedAgent ? (
              <p className="mt-1 line-clamp-3 text-xs text-foreground/65">{selectedAgent.description || selectedAgent.promptPreview}</p>
            ) : (
              <p className="mt-1 text-xs text-foreground/65">No repo agents found.</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-foreground/75">Daily time</label>
            <input
              type="time"
              className="h-10 w-full rounded-xl border border-card-border bg-surface-1 px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
              value={props.scheduleTime}
              onChange={(event) => props.setScheduleTime(event.target.value)}
            />
            <p className="mt-1 text-xs text-foreground/60">Asia/Tehran · runner {runnerLabel(props.scheduleRunner)}</p>
          </div>

          <div className="grid grid-cols-1 gap-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-foreground/75">Model</label>
              <select
                className="h-10 w-full rounded-xl border border-card-border bg-surface-1 px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                value={props.scheduleModel}
                onChange={(event) => { props.setScheduleModel(event.target.value); props.setScheduleEffort(effortForModel(props.scheduleRunner, event.target.value, props.scheduleEffort)); }}
              >
                {createModelChoices.map((modelOption) => (
                  <option key={modelOption} value={modelOption}>
                    {modelLabel(props.scheduleRunner, modelOption)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-foreground/75">Reasoning effort</label>
              <select
                className="h-10 w-full rounded-xl border border-card-border bg-surface-1 px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                value={props.scheduleEffort}
                disabled={!modelSupportsEffort(props.scheduleRunner, props.scheduleModel)}
                onChange={(event) => props.setScheduleEffort(event.target.value as ReasoningEffort)}
              >
                <ModelEffortOptions runner={props.scheduleRunner} model={props.scheduleModel} value={props.scheduleEffort} />
              </select>
            </div>
          </div>

          <div className={cn("border border-card-border bg-surface-2 px-3 py-2 text-xs text-foreground/70", props.compact ? "rounded-md" : "rounded-xl")}>
            {selectedSkillRefs.length > 0 ? formatSkillSummary(selectedSkillRefs, props.skillCatalog) : "No selected skills"}
          </div>

          <Button
            className="w-full justify-center"
            onClick={() => void props.onCreateSchedule()}
            disabled={!props.selectedAgentId || props.actionId === "create" || props.loading}
          >
            {props.actionId === "create" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <CalendarClock className="mr-1.5 h-4 w-4" />}
            Create schedule
          </Button>
        </div>
      </section>

      {props.skillSyncResult ? (
        <section className={cn("border border-card-border bg-surface-1 p-3", props.compact ? "rounded-md" : "rounded-2xl")}>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-sm font-bold">Skill sync</h3>
            <Badge>{syncConflictCount + syncErrorCount > 0 ? "attention" : "ok"}</Badge>
          </div>
          <p className="text-xs text-foreground/70">
            copied {props.skillSyncResult.copied.length}, updated {props.skillSyncResult.updated.length}, conflicts {syncConflictCount}, errors {syncErrorCount}
          </p>
          {props.skillSyncResult.conflicts.slice(0, 3).map((conflict) => (
            <p key={`${conflict.slug}_${conflict.targetPath}`} className="mt-1 break-all text-[11px] text-amber-700 dark:text-amber-200">
              {conflict.slug}: {conflict.reason}
            </p>
          ))}
          {props.skillSyncResult.errors.slice(0, 3).map((error) => (
            <p key={`${error.slug}_${error.sourcePath}`} className="mt-1 break-all text-[11px] text-rose-700 dark:text-rose-200">
              {error.slug}: {error.message}
            </p>
          ))}
        </section>
      ) : null}

      <section className={cn("border border-card-border bg-surface-1 p-3", props.compact ? "rounded-md" : "rounded-2xl")}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold">Schedules</h3>
          <Badge>{props.schedules.length}</Badge>
        </div>
        <div className="space-y-2">
          {props.schedules.length === 0 ? <p className="text-xs text-foreground/70">No schedules yet.</p> : null}
          {props.schedules.map((schedule) => {
            const scheduleRunner = normalizeRunRunnerValue(schedule.runConfig.runner);
            const scheduleModelOptions = modelOptionsForRunner(scheduleRunner, props.cursorModels);
            const scheduleModelChoices = scheduleModelOptions.includes(schedule.runConfig.model)
              ? scheduleModelOptions
              : [schedule.runConfig.model, ...scheduleModelOptions];
            const busy = props.actionId === schedule.id;
            return (
              <div key={schedule.id} className={cn("border border-card-border bg-surface-2 px-3 py-2", props.compact ? "rounded-md" : "rounded-xl")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{schedule.agentName}</p>
                    <p className="text-xs text-foreground/65">
                      {formatTehranSchedule(schedule)} | next {formatDateTime(schedule.nextRunAt)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-foreground/60">
                      {runnerLabel(scheduleRunner)} · {schedule.runConfig.model} · {reasoningEffortLabel(schedule.runConfig.reasoningEffort)}
                    </p>
                    {schedule.runConfig.skills.length > 0 ? (
                      <p className="mt-0.5 text-[11px] text-foreground/60">{formatSkillSummary(schedule.runConfig.skills, props.skillCatalog)}</p>
                    ) : null}
                  </div>
                  <Badge>{schedule.status}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-1.5">
                  <select
                    className="h-9 w-full rounded-lg border border-card-border bg-surface-1 px-2 text-xs outline-none focus:border-brand"
                    value={schedule.runConfig.model}
                    disabled={busy}
                    onChange={(event) => void props.onUpdateScheduleConfig(schedule, { model: event.target.value, reasoningEffort: effortForModel(scheduleRunner, event.target.value, schedule.runConfig.reasoningEffort) })}
                    aria-label={`${schedule.agentName} model`}
                  >
                    {scheduleModelChoices.map((modelOption) => (
                      <option key={modelOption} value={modelOption}>
                        {modelLabel(scheduleRunner, modelOption)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="h-9 w-full rounded-lg border border-card-border bg-surface-1 px-2 text-xs outline-none focus:border-brand"
                    value={schedule.runConfig.reasoningEffort}
                    disabled={busy || !modelSupportsEffort(scheduleRunner, schedule.runConfig.model)}
                    onChange={(event) => void props.onUpdateScheduleConfig(schedule, { reasoningEffort: event.target.value as ReasoningEffort })}
                    aria-label={`${schedule.agentName} reasoning effort`}
                  >
                    <ModelEffortOptions runner={scheduleRunner} model={schedule.runConfig.model} value={schedule.runConfig.reasoningEffort} />
                  </select>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1">
                  <Button size="sm" variant="ghost" className="px-2" onClick={() => void props.onRunNow(schedule)} disabled={busy}>
                    {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  </Button>
                  <Button size="sm" variant="ghost" className="px-2" onClick={() => void props.onToggleSchedule(schedule)} disabled={busy}>
                    {schedule.status === "active" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  </Button>
                  <Button size="sm" variant="ghost" className="px-2 text-rose-700" onClick={() => void props.onDeleteSchedule(schedule)} disabled={busy}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className={cn("border border-card-border bg-surface-1 p-3", props.compact ? "rounded-md" : "rounded-2xl")}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold">Upcoming</h3>
          <Badge>{props.upcoming.length}</Badge>
        </div>
        <div className="space-y-1.5">
          {props.upcoming.length === 0 ? <p className="text-xs text-foreground/70">No active upcoming runs.</p> : null}
          {props.upcoming.slice(0, 8).map((schedule) => (
            <div key={`upcoming_${schedule.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-card-border bg-surface-2 px-2 py-1.5 text-xs">
              <span className="min-w-0 truncate">{schedule.agentName}</span>
              <span className="shrink-0 text-foreground/65">{formatDateTime(schedule.nextRunAt)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={cn("border border-card-border bg-surface-1 p-3", props.compact ? "rounded-md" : "rounded-2xl")}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold">Latest executions</h3>
          <Badge>{props.executions.length}</Badge>
        </div>
        <div className="space-y-2">
          {props.executions.length === 0 ? <p className="text-xs text-foreground/70">No executions recorded.</p> : null}
          {visibleExecutions.map((execution) => (
            <button
              key={execution.id}
              type="button"
              className={cn("w-full border border-card-border bg-surface-2 px-3 py-2 text-left transition hover:border-brand/50 disabled:cursor-default disabled:hover:border-card-border", props.compact ? "rounded-md" : "rounded-xl")}
              disabled={!execution.sessionId}
              onClick={() => props.onSelectExecution(execution)}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-semibold">{execution.agentName}</span>
                <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold", executionStatusClass(execution.status))}>
                  {execution.status}
                </span>
              </div>
              <p className="text-[11px] text-foreground/65">scheduled {formatDateTime(execution.scheduledFor)}</p>
              <p className="text-[11px] text-foreground/65">
                started {formatDateTime(execution.startedAt)} | completed {formatDateTime(execution.completedAt)}
              </p>
              {execution.error ? <p className="mt-1 line-clamp-2 text-[11px] text-rose-700 dark:text-rose-200">{execution.error}</p> : null}
            </button>
          ))}
          {hasHiddenExecutions ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setVisibleExecutionCount((current) => Math.min(current + sidebarListPageSize, props.executions.length))}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export default App;
