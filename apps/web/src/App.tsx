import { isValidElement, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Convert from "ansi-to-html";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AtSign,
  Bot,
  CalendarClock,
  Check,
  ClipboardList,
  CircleStop,
  Copy,
  ExternalLink,
  FileCode2,
  Lock,
  Layers,
  LogOut,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  Moon,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pause,
  Play,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
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
  ApprovalQueueItem,
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
  TerminalSessionSnapshot,
  TokenUsageSummary,
  WorkspaceOption,
  SkillSyncResult,
} from "@luma/shared";
import {
  acceptApproval,
  archiveSession,
  connectEvents,
  createAgentSchedule,
  deleteSession,
  deleteAgentSchedule,
  sendMessage,
  getAgentSchedules,
  getAccountStatus,
  getBootstrapLite,
  getMcpStatus,
  getSkills,
  getSessionList,
  getSessionMessages,
  getSessionTokenUsage,
  getSystemStatus,
  getTerminal,
  interruptTerminal,
  loginWithPassword,
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
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/useUiStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardContent } from "@/components/ui/card";
import { TaskManager } from "@/TaskManager";

type StatusFilter = "all" | "running" | "completed" | "failed" | "stopped";
type SessionFilterValue = StatusFilter | "all-history";
type DockTab = "terminal" | "approvals" | "context";
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
  id: string;
  sessionId: string;
  latestRunId: string | null;
  messageCount: number;
  lastMessagePreview: string;
  summary: string;
  status: SessionListItem["status"];
  updatedAt: number;
  runner: RunRunner;
  sourceTag: RunSourceTag;
  sourceRaw: string;
  workspace: string;
  historyOnly: boolean;
  scheduled: boolean;
};

type PlanSessionState = "idle" | "armed" | "active";

const sandboxOptions: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const approvalPolicies: ApprovalPolicy[] = ["untrusted", "on-failure", "on-request", "never"];
const runnerOptions: RunRunner[] = ["codex", "claude"];
const codexModelOptions = ["gpt-5.3-codex", "gpt-5.4", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"];
const claudeModelOptions = ["sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-opus-4-1"];
const reasoningEffortOptions: ReasoningEffort[] = ["low", "medium", "high"];
const modelOptions = codexModelOptions;
function modelOptionsForRunner(runner: RunRunner): string[] {
  return runner === "claude" ? claudeModelOptions : codexModelOptions;
}
function runnerLabel(runner: RunRunner): string {
  return runner === "claude" ? "Claude Code" : "Codex";
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
const authSessionMaxAgeMs = 24 * 60 * 60 * 1000;
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
  skills: SelectedSkillRef[];
  agents: SelectedAgentRef[];
};

type ProcessingQueueItem = {
  item: QueuedMessage;
  runSessionKey: string | null;
  startedAt: number;
  observedActive: boolean;
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

    return { token, expiresAt };
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
        const runner: RunRunner = item.runner === "claude" ? "claude" : "codex";
        const model = typeof item.model === "string" ? item.model : "";
        const reasoningEffort: ReasoningEffort = item.reasoningEffort === "low" || item.reasoningEffort === "medium" || item.reasoningEffort === "high" ? item.reasoningEffort : "high";
        const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
        const planMode = typeof item.planMode === "boolean" ? item.planMode : false;
        const attachments = readAttachmentRefs(item.attachments);
        const skills = readSelectedSkillRefs(item.skills);
        const agents = readSelectedAgentRefs(item.agents);

        if (!id || !prompt || !workspace || !model || !isSandboxMode(item.sandbox) || !isApprovalPolicy(item.approvalPolicy)) {
          continue;
        }

        normalized.push({
          id,
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
    return session.runner === "claude"
      ? {
          label: "Claude",
          className: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
        }
      : {
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

function statusClass(status: string): string {
  if (status === "running") return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200";
  if (status === "completed") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200";
  if (status === "failed") return "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200";
  if (status === "stopped") return "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200";
}

function buildSessionCards(items: SessionListItem[]): SessionCard[] {
  return items.map((item) => ({
    id: item.id,
    sessionId: item.id,
    latestRunId: item.latestRunId,
    messageCount: item.messageCount,
    lastMessagePreview: item.lastMessagePreview,
    summary: item.title,
    status: item.status,
    updatedAt: item.updatedAt,
    runner: item.runner === "claude" ? "claude" : "codex",
    sourceTag: item.sourceTag,
    sourceRaw: item.sourceRaw,
    workspace: item.workspace,
    historyOnly: item.historyOnly,
    scheduled: Boolean(item.scheduled),
  }));
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
  const previewSource = firstEntry && String(firstEntry.meta?.command || firstEntry.text || "").trim();

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
    && (input.kind === "image" || input.kind === "text")
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
        runner: input.runner === "claude" ? "claude" : "codex",
        sourceTag: input.sourceTag as RunSourceTag,
        sourceRaw: input.sourceRaw,
        workspace: input.workspace,
        latestRunId: typeof input.latestRunId === "string" ? input.latestRunId : null,
        lastMessagePreview: input.lastMessagePreview,
        messageCount: input.messageCount,
        historyOnly: input.historyOnly,
        scheduled: typeof input.scheduled === "boolean" ? input.scheduled : undefined,
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

function flattenMarkdownText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => flattenMarkdownText(child)).join("");
  }
  if (isValidElement(children)) {
    return flattenMarkdownText(children.props.children);
  }
  return "";
}

function MarkdownMessage({ text }: { text: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        h1: ({ children }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 text-base font-bold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 text-sm font-semibold">{children}</h3>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-foreground/30 pl-3 italic text-foreground/80">{children}</blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark dark:text-[#8fc5ff] dark:hover:text-[#bddcff]"
          >
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="claude-table my-2 overflow-x-auto rounded-md">
            <table className="min-w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="px-2 py-1.5 text-left font-semibold text-foreground/80">{children}</th>,
        td: ({ children }) => <td className="px-2 py-1.5 align-top text-foreground/90">{children}</td>,
        code: ({ className, children }) => {
          const raw = flattenMarkdownText(children).replace(/\n$/, "");
          const isBlock = Boolean(className) || raw.includes("\n");
          return (
            <code
              className={cn(
                isBlock
                  ? "block whitespace-pre-wrap break-words bg-transparent font-mono text-[0.95em] leading-relaxed text-foreground"
                  : "rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.92em] text-foreground",
                className,
              )}
            >
              {raw}
            </code>
          );
        },
        pre: ({ children }) => <pre className="my-1.5 overflow-x-auto rounded-md border border-card-border bg-surface-2 px-3 py-2">{children}</pre>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function ThinkingDots({ label = "Thinking" }: { label?: string }): JSX.Element {
  return (
    <div className="inline-flex items-center gap-2 text-sm text-foreground/70">
      <span className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_0_3px_rgba(234,111,55,0.12)]" />
      <span className="font-medium">{label}</span>
      <span className="dot-wave" aria-label={`${label} in progress`} role="status">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
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
            className="h-9 w-full rounded-lg border border-card-border bg-surface-1 px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-[#5f4d25]/35 dark:bg-[#100d09] dark:text-stone-100 dark:placeholder:text-stone-400 dark:focus:border-[#c59c39] dark:focus:ring-[#c59c39]/20"
            value={feedback}
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
          <span className="truncate">{summarizeToolEntriesInline([entry])}</span>
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
          <span className="truncate">{summarizeToolEntriesInline([entry])}</span>
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
        <span className="truncate">{summarizeToolEntriesInline([entry])}</span>
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
  const [loaded, setLoaded] = useState(false);
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
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/taskmanager")) {
    return <TaskManager />;
  }

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
  const [approvals, setApprovals] = useState<ApprovalQueueItem[]>([]);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("code");

  const [prompt, setPrompt] = useState("");
  const [skillCatalog, setSkillCatalog] = useState<SkillListItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
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
  const [agentActionId, setAgentActionId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRef[]>([]);
  const [pendingAttachmentWorkspace, setPendingAttachmentWorkspace] = useState<string | null>(null);
  const [uploadingAttachmentNames, setUploadingAttachmentNames] = useState<string[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [runner, setRunnerState] = useState<RunRunner>("codex");
  const [model, setModel] = useState("gpt-5.3-codex");
  const [defaultCodexModel, setDefaultCodexModel] = useState("gpt-5.3-codex");
  const [defaultClaudeModel, setDefaultClaudeModel] = useState("sonnet");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [sandbox, setSandbox] = useState<SandboxMode>("danger-full-access");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>("on-request");
  const [planFlowBySession, setPlanFlowBySession] = useState<Record<string, PlanSessionState>>({});

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isDraftSession, setIsDraftSession] = useState(false);
  const [slashEntriesBySession, setSlashEntriesBySession] = useState<Record<string, TimelineEntry[]>>({});
  const [queuedBySession, setQueuedBySession] = useState<Record<string, QueuedMessage[]>>(() => loadQueuedMessages());
  const [terminalHistoryBySession, setTerminalHistoryBySession] = useState<Record<string, string[]>>(() => loadTerminalCommandHistory());
  const [processingQueueItem, setProcessingQueueItem] = useState<ProcessingQueueItem | null>(null);
  const [sessionAction, setSessionAction] = useState<"archive" | "delete" | null>(null);
  const [terminalsBySession, setTerminalsBySession] = useState<Record<string, TerminalSessionSnapshot>>({});
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalAction, setTerminalAction] = useState<"starting" | "stopping" | "sending" | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceRecordingStartedAt, setVoiceRecordingStartedAt] = useState<number | null>(null);
  const [voiceRecordingSeconds, setVoiceRecordingSeconds] = useState(0);
  const [authReady, setAuthReady] = useState(false);
  const [authToken, setAuthTokenState] = useState<string | null>(null);
  const [authExpiresAt, setAuthExpiresAt] = useState<number>(0);
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
  const isDraftSessionRef = useRef(isDraftSession);
  const lastEventAtRef = useRef<number>(Date.now());
  const autoRefreshInFlightRef = useRef(false);
  const previousTimelineStateRef = useRef<{ sessionKey: string; length: number }>({
    sessionKey: draftSessionKey,
    length: 0,
  });
  const isAuthenticated = Boolean(authToken && authExpiresAt > Date.now());
  const isUploadingAttachments = uploadingAttachmentNames.length > 0;

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    showAllHistoryRef.current = showAllHistory;
  }, [showAllHistory]);

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
    const session = loadStoredAuthSession();
    if (session) {
      setAuthTokenState(session.token);
      setAuthExpiresAt(session.expiresAt);
      setApiAuthToken(session.token);
    } else {
      setApiAuthToken(null);
    }
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (!authReady || typeof window === "undefined") return;
    if (isAuthenticated && authToken) {
      const session: StoredAuthSession = {
        token: authToken,
        expiresAt: Math.min(authExpiresAt, Date.now() + authSessionMaxAgeMs),
      };
      window.localStorage.setItem(authSessionStorageKey, JSON.stringify(session));
      window.localStorage.removeItem(legacyAuthSessionStorageKey);
      return;
    }
    removeLocalStorageWithLegacy(authSessionStorageKey, legacyAuthSessionStorageKey);
  }, [authReady, isAuthenticated, authToken, authExpiresAt]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    const onUnauthorized = () => {
      setApiAuthToken(null);
      setAuthTokenState(null);
      setAuthExpiresAt(0);
      setAuthError("Session expired. Please enter password again.");
    };
    window.addEventListener("luma:unauthorized", onUnauthorized as EventListener);
    return () => {
      window.removeEventListener("luma:unauthorized", onUnauthorized as EventListener);
    };
  }, [authReady, isAuthenticated]);

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
    if (!voiceListening || voiceRecordingStartedAt === null) {
      setVoiceRecordingSeconds(0);
      return;
    }

    const tick = () => {
      setVoiceRecordingSeconds(Math.floor((Date.now() - voiceRecordingStartedAt) / 1000));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [voiceListening, voiceRecordingStartedAt]);

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
    void loadBootstrapLite();
  }, [authReady, isAuthenticated, showAllHistory]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) {
      setBackendConnectionStatus("disconnected");
      return;
    }
    setBackendConnectionStatus("connecting");
    let es: EventSource | null = null;
    let hasOpenedOnce = false;
    let shouldRefreshSelectedSession = false;

    const refreshSelectedSessionState = () => {
      const currentSelectedSessionId = selectedSessionIdRef.current;
      if (currentSelectedSessionId) {
        void loadRunMessagesPage(currentSelectedSessionId, { reset: true });
      }
      const currentSelectedRunId = selectedRunIdRef.current;
      if (currentSelectedRunId) {
        void loadSelectedRunRecord(currentSelectedRunId);
      }
    };

    const refreshRealtimeState = () => {
      void refreshRunList(selectedSessionIdRef.current);
      refreshSelectedSessionState();
    };

    const openEventStream = () => {
      es?.close();
      es = connectEvents((event) => {
        lastEventAtRef.current = Date.now();
        if (event.kind === "heartbeat") return;

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

        if (event.kind === "run.approvalQueued") {
          void refreshRunList(selectedSessionIdRef.current);
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
        refreshRealtimeState();
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

      refreshRealtimeState();

      const isStale = Date.now() - lastEventAtRef.current > eventStreamHeartbeatStaleMs;
      if (!es || es.readyState === EventSource.CLOSED || isStale) {
        shouldRefreshSelectedSession = true;
        setBackendConnectionStatus("connecting");
        openEventStream();
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      ensureFreshRealtimeState();
    };

    openEventStream();

    const watchdog = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (Date.now() - lastEventAtRef.current <= eventStreamHeartbeatStaleMs) return;
      shouldRefreshSelectedSession = true;
      setBackendConnectionStatus("connecting");
      openEventStream();
      refreshRealtimeState();
    }, eventStreamWatchdogIntervalMs);

    window.addEventListener("focus", ensureFreshRealtimeState);
    window.addEventListener("online", ensureFreshRealtimeState);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(watchdog);
      window.removeEventListener("focus", ensureFreshRealtimeState);
      window.removeEventListener("online", ensureFreshRealtimeState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      es?.close();
    };
  }, [authReady, isAuthenticated]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;

    const timer = window.setInterval(() => {
      if (autoRefreshInFlightRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine) return;

      autoRefreshInFlightRef.current = true;
      void (async () => {
        try {
          await refreshRunList(selectedSessionIdRef.current);
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
    void refreshAgentSchedules();
    const timer = window.setInterval(() => {
      void refreshAgentSchedules();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [authReady, isAuthenticated, sidebarMode]);

  const allSessions = useMemo(() => buildSessionCards(runItems), [runItems]);
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
  const pendingApprovals = useMemo(() => approvals.filter((item) => item.status === "pending"), [approvals]);
  const slashSuggestions = useMemo(() => {
    const trimmed = prompt.trimStart();
    if (!trimmed.startsWith("/")) return [] as SlashCommandSuggestion[];
    const token = trimmed.split(/\s+/)[0].toLowerCase();
    return slashCommandSuggestions.filter((item) => item.key.startsWith(token) || item.key.includes(token));
  }, [prompt]);
  const agentQueryToken = useMemo(() => findAgentQueryToken(prompt), [prompt]);
  const skillQueryToken = useMemo(() => findSkillQueryToken(prompt), [prompt]);
  const selectedSkillIds = useMemo(() => new Set(selectedSkills.map((skill) => skill.id)), [selectedSkills]);
  const selectedPromptAgentIds = useMemo(() => new Set(selectedPromptAgents.map((agent) => agent.id)), [selectedPromptAgents]);
  const filteredSkills = useMemo(() => {
    const query = (skillQueryToken?.query || "").toLowerCase();
    return skillCatalog
      .filter((skill) => showSystemSkills || !isSystemSkill(skill))
      .filter((skill) => !selectedSkillIds.has(skill.id))
      .filter((skill) => {
        if (!query) return true;
        return skill.name.toLowerCase().includes(query)
          || skill.description.toLowerCase().includes(query)
          || skill.path.toLowerCase().includes(query)
          || skill.source.toLowerCase().includes(query);
      })
      .slice(0, 30);
  }, [skillCatalog, selectedSkillIds, showSystemSkills, skillQueryToken]);
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
  const activeProcessingQueueItem = processingQueueItem?.item.sessionKey === sessionTimelineKey ? processingQueueItem.item : null;
  const queuedMessagesForActiveSession = useMemo(() => {
    const queued = queuedBySession[sessionTimelineKey] || [];
    if (!activeProcessingQueueItem) return queued;
    if (queued.some((item) => item.id === activeProcessingQueueItem.id)) return queued;
    return [activeProcessingQueueItem, ...queued];
  }, [activeProcessingQueueItem, queuedBySession, sessionTimelineKey]);

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

    node.scrollTop = pending.scrollTop + (node.scrollHeight - pending.scrollHeight);
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
    if (!selectedSession.historyOnly && selectedSession.latestRunId) {
      void loadSelectedRunRecord(selectedSession.latestRunId);
    } else {
      setSelectedRunRecord(null);
    }
  }, [isDraftSession, selectedSessionId, selectedSession]);

  useEffect(() => {
    if (!processingQueueItem) return;

    const runSessionKey = processingQueueItem.runSessionKey || processingQueueItem.item.sessionKey;
    const session = allSessions.find((item) => item.id === runSessionKey || item.sessionId === runSessionKey);
    if (!session || session.historyOnly) return;

    const isActive = session.status === "queued" || session.status === "running";
    if (isActive && !processingQueueItem.observedActive) {
      setProcessingQueueItem((current) => current && current.item.id === processingQueueItem.item.id
        ? { ...current, observedActive: true }
        : current);
      return;
    }

    const isTerminal = session.status === "completed" || session.status === "failed" || session.status === "stopped";
    const terminalAfterQueueStart = isTerminal && session.updatedAt >= processingQueueItem.startedAt;
    if ((processingQueueItem.observedActive && isTerminal) || terminalAfterQueueStart) {
      setProcessingQueueItem((current) => current?.item.id === processingQueueItem.item.id ? null : current);
    }
  }, [allSessions, processingQueueItem]);

  useEffect(() => {
    const node = terminalOutputRef.current;
    if (!node || !selectedSessionId || !selectedTerminal) return;
    node.scrollTop = node.scrollHeight;
  }, [selectedSessionId, selectedTerminal?.output]);

  useEffect(() => {
    if (submitting || processingQueueItem) return;

    for (const [sessionKey, queued] of Object.entries(queuedBySession)) {
      if (!queued.length) continue;
      if (sessionKey === draftSessionKey) continue;
      if (busySessionIds.has(sessionKey)) continue;

      setProcessingQueueItem({
        item: queued[0],
        runSessionKey: null,
        startedAt: Date.now(),
        observedActive: false,
      });
      void runQueuedMessage(queued[0]);
      return;
    }
  }, [queuedBySession, busySessionIds, submitting, processingQueueItem]);

  async function onAuthenticate(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (!authPasswordInput.trim() || authSubmitting) return;

    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const payload = await loginWithPassword(authPasswordInput);
      setAuthTokenState(payload.token);
      setAuthExpiresAt(payload.expiresAt);
      setApiAuthToken(payload.token);
      setAuthPasswordInput("");
      setLoading(true);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
      setApiAuthToken(null);
      setAuthTokenState(null);
      setAuthExpiresAt(0);
    } finally {
      setAuthSubmitting(false);
    }
  }

  function onSignOut(): void {
    setApiAuthToken(null);
    setAuthTokenState(null);
    setAuthExpiresAt(0);
    setAuthPasswordInput("");
    setAuthError(null);
    setBackendConnectionStatus("disconnected");
    removeLocalStorageWithLegacy(authSessionStorageKey, legacyAuthSessionStorageKey);
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

  async function loadBootstrapLite(): Promise<void> {
    setLoading(true);
    setLoadingRunList(true);
    setSkillsLoading(true);
    setAgentsLoading(true);
    try {
      const [payload, listPayload, skillsPayload, agentPayload] = await Promise.all([
        getBootstrapLite(),
        getSessionList(runListPageSize, null, showAllHistoryRef.current),
        getSkills(),
        getAgentSchedules(),
      ]);
      setWorkspaces(payload.workspaces);
      setWorkspace(payload.activeWorkspace);
      setSkillCatalog(skillsPayload.skills);
      setSkillsError(null);
      applyAgentScheduleState(agentPayload);
      const normalizedItems = normalizeSessionItems(listPayload.items);
      setRunItems(normalizedItems);
      setRunListNextCursor(listPayload.nextCursor);
      setApprovals(listPayload.approvals.length ? listPayload.approvals : payload.approvals);
      setRunnerState(payload.defaults.runner);
      setDefaultCodexModel(payload.defaults.codexModel);
      setDefaultClaudeModel(payload.defaults.claudeModel);
      setModel(payload.defaults.model);
      setReasoningEffort(payload.defaults.reasoningEffort);
      setSandbox(payload.defaults.sandbox);
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
      setSkillsLoading(false);
      setAgentsLoading(false);
      setLoading(false);
    }
  }

  async function refreshSkillCatalog(workspace = activeWorkspace): Promise<void> {
    if (!workspace) return;
    setSkillsLoading(true);
    try {
      const payload = await getSkills(workspace);
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
    const payload = await getSessionList(runListPageSize, null, showAllHistoryRef.current);
    const normalizedItems = normalizeSessionItems(payload.items);
    setRunItems(normalizedItems);
    setRunListNextCursor(payload.nextCursor);
    setApprovals(payload.approvals);

    if (isDraftSessionRef.current) return;

    const sessions = buildSessionCards(normalizedItems);
    const preferred = preferredSessionId && !selectedSessionIdRef.current
      ? sessions.find((session) => session.id === preferredSessionId)
      : null;
    if (preferred) {
      setSelectedSessionId(preferred.id);
      setSelectedRunId(preferred.latestRunId);
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
      const payload = await getSessionList(runListPageSize, runListNextCursor, showAllHistoryRef.current);
      setRunItems((prev) => {
        const next = new Map(prev.map((item) => [item.id, item]));
        for (const item of payload.items) next.set(item.id, item);
        return normalizeSessionItems([...next.values()]);
      });
      setRunListNextCursor(payload.nextCursor);
      setApprovals(payload.approvals);
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
          ? payload.messages.map((message) => chatMessageToTimelineEntry(message))
          : mergeTimelineEntries(
            payload.messages.map((message) => chatMessageToTimelineEntry(message)),
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
      const next = { ...prev, [nextSessionId]: [...(prev[nextSessionId] || []), ...(prev[previousSessionId] || [])] };
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

  function applyIncomingMessage(message: ChatMessage): void {
    const nextEntry = chatMessageToTimelineEntry(message);
    setMessagesByRunId((prev) => ({
      ...prev,
      [message.sessionId]: upsertTimelineEntry(prev[message.sessionId] || [], nextEntry),
    }));
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

  function setRunner(nextRunner: RunRunner): void {
    setRunnerState(nextRunner);
    setModel((current) => {
      if (modelOptionsForRunner(nextRunner).includes(current)) return current;
      return nextRunner === "claude" ? defaultClaudeModel : defaultCodexModel;
    });
  }

  useEffect(() => {
    setNewSessionUseCustomModel(!modelOptionsForRunner(runner).includes(model));
  }, [model, runner]);

  function buildQueuedMessage(
    sessionKey: string,
    promptValue: string,
    overrides?: {
      attachments?: AttachmentRef[];
      planMode?: boolean;
      sandbox?: SandboxMode;
      approvalPolicy?: ApprovalPolicy;
      skills?: SelectedSkillRef[];
      agents?: SelectedAgentRef[];
    },
  ): QueuedMessage {
    const planMode = overrides?.planMode ?? shouldUsePlanMode(sessionKey);
    const existingSession = allSessions.find((session) => session.id === sessionKey);
    const requestRunner = sessionKey === draftSessionKey ? runner : (existingSession?.runner || runner);
    const requestModel =
      selectedRunRecord?.config.runner === requestRunner && selectedRunRecord.config.model
        ? selectedRunRecord.config.model
        : requestRunner === runner
          ? model
          : requestRunner === "claude"
            ? defaultClaudeModel
            : defaultCodexModel;
    return {
      id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionKey,
      prompt: promptValue,
      attachments: readAttachmentRefs(overrides?.attachments),
      createdAt: Date.now(),
      workspace: activeWorkspace,
      runner: requestRunner,
      model: requestModel,
      reasoningEffort,
      sandbox: overrides?.sandbox ?? (planMode ? "read-only" : sandbox),
      approvalPolicy: overrides?.approvalPolicy ?? (planMode ? "never" : approvalPolicy),
      planMode,
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

  async function startCodexRun(request: QueuedMessage, focusSession: boolean): Promise<{ sessionId: string; latestRunId: string | null }> {
    const optimisticEntry = buildOptimisticUserEntry(request.sessionKey, request.id, request.prompt, request.attachments);
    setMessagesByRunId((prev) => ({
      ...prev,
      [request.sessionKey]: upsertTimelineEntry(prev[request.sessionKey] || [], optimisticEntry),
    }));

    const input: SendMessageInput = {
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
      skills: request.skills,
      agents: request.agents,
      sessionId: request.sessionKey === draftSessionKey ? undefined : request.sessionKey,
    };

    try {
      const payload = await sendMessage(input);
      const nextSessionKey = payload.sessionId;

      if (request.sessionKey === draftSessionKey) {
        moveDraftTimelineEntries(nextSessionKey);
        moveSessionCollections(draftSessionKey, nextSessionKey);
        setPlanState(draftSessionKey, "idle");
      }

      setIsDraftSession(false);

      if (request.planMode) {
        setPlanState(nextSessionKey, "active");
      }

      applyIncomingMessage(payload.message);

      if (focusSession) {
        setSelectedSessionId(nextSessionKey);
        setSelectedRunId(payload.latestRunId);
        setRightPanelTab("terminal");
        setMobileThreadsOpen(false);
      } else if (selectedSessionId && nextSessionKey === selectedSessionId) {
        setSelectedRunId(payload.latestRunId);
      }

      return {
        sessionId: nextSessionKey,
        latestRunId: payload.latestRunId,
      };
    } catch (error) {
      setMessagesByRunId((prev) => {
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
    const focusSession = selectedSessionId === queued.sessionKey;
    let accepted = false;
    try {
      setSubmitting(true);
      const result = await startCodexRun(queued, focusSession);
      accepted = true;
      removeQueuedMessage(queued.sessionKey, queued.id);
      setProcessingQueueItem((current) => current?.item.id === queued.id
        ? {
            ...current,
            runSessionKey: result.sessionId,
          }
        : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run queued message";
      pushSlashEntries(queued.sessionKey, [
        buildLocalTimelineEntry(
          queued.sessionKey,
          `queue_${queued.id}_error`,
          "error",
          "System",
          `Queued message failed: ${message}`,
          Date.now(),
        ),
      ]);
      removeQueuedMessage(queued.sessionKey, queued.id);
    } finally {
      if (!accepted) {
        setProcessingQueueItem((current) => current?.item.id === queued.id ? null : current);
      }
      setSubmitting(false);
    }
  }

  async function submitSessionMessage(
    promptValue: string,
    options?: {
      sessionKey?: string;
      attachments?: AttachmentRef[];
      planMode?: boolean;
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

    if (!activeWorkspace) {
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
        const payload = await uploadAttachment(file, activeWorkspace);
        uploaded.push(payload.attachment);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed";
        failures.push(`${file.name}: ${message}`);
      }
    }

    if (uploaded.length > 0) {
      setPendingAttachments((current) => [...current, ...uploaded].slice(0, attachmentMaxFiles));
      setPendingAttachmentWorkspace(activeWorkspace);
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
        buildLocalTimelineEntry(sessionKey, `slash_${messageId}_speech`, "assistant", "System", buildSpeechSupportText(), Date.now()),
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
    if (!prompt.trim()) return;
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

    const trimmedPrompt = prompt.trim();
    const slashCommand = parseSlashCommand(prompt);
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
      setPrompt("");
      return;
    }

    if (slashCommand) {
      setSubmitting(true);
      try {
        await runSlashCommand(slashCommand, sessionKey);
        setPrompt("");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    try {
      const shouldQueueBehindActiveRun = sessionKey !== draftSessionKey && busySessionIds.has(sessionKey);
      if (shouldQueueBehindActiveRun) {
        enqueueMessage(buildQueuedMessage(sessionKey, trimmedPrompt, {
          attachments: pendingAttachments,
          skills: selectedSkillRefs,
          agents: selectedAgentRefs,
        }));
        setPrompt("");
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
      setPrompt("");
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

  async function onAcceptApproval(item: ApprovalQueueItem): Promise<void> {
    if (item.kind === "claude_permission") {
      const payload = await acceptApproval(item.runId, item.id, item.suggestedApprovalPolicy);
      const nextSessionKey = runSessionId(payload.run);
      await refreshRunList(nextSessionKey);
      setSelectedSessionId(nextSessionKey);
      setSelectedRunId(payload.run.id);
      void loadSelectedRunRecord(payload.run.id);
      setRightPanelTab("approvals");
      setMobileContextOpen(false);
      return;
    }

    const payload = await rerun(item.runId, {
      sandbox: item.suggestedSandbox,
      approvalPolicy: item.suggestedApprovalPolicy,
      approvalId: item.id,
    });

    const nextSessionKey = runSessionId(payload.run);
    await refreshRunList(nextSessionKey);
    setIsDraftSession(false);
    setSelectedSessionId(nextSessionKey);
    setSelectedRunId(payload.run.id);
    void loadRunMessagesPage(nextSessionKey, { reset: true });
    void loadSelectedRunRecord(payload.run.id);
    setRightPanelTab("approvals");
    setMobileContextOpen(false);
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
    if (!selectedAgentId || !activeWorkspace) return;
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
        agentId: selectedAgentId,
        hour,
        minute,
        workspace: activeWorkspace,
        runner,
        model,
        reasoningEffort,
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
      setSelectedSessionId(target.id);
      setSelectedRunId(target.latestRunId);
    }
    setMobileThreadsOpen(false);
  }

  function createDraftSession(nextRunner: RunRunner): void {
    setRunner(nextRunner);
    setIsDraftSession(true);
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

  function onNewSession(): void {
    setNewSessionDialogOpen(true);
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

  function onToggleVoiceRecording(): void {
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
      selectedSkills={selectedSkills}
      skillCatalog={skillCatalog}
      actionId={agentActionId}
      onReload={onReloadAgentsAndSkills}
      onCreateSchedule={onCreateAgentSchedule}
      onToggleSchedule={onToggleAgentSchedule}
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

  const desktopGridColumns = leftSidebarOpen
    ? rightDockOpen
      ? "lg:grid-cols-[382px_minmax(0,1fr)_410px]"
      : "lg:grid-cols-[382px_minmax(0,1fr)]"
    : rightDockOpen
      ? "lg:grid-cols-[minmax(0,1fr)_410px]"
      : "lg:grid-cols-1";

  return (
    <div className="h-[100dvh] w-full overflow-hidden bg-background text-[color:var(--text)]">
      <header className="fixed inset-x-0 top-0 z-20 bg-surface-1/95 px-2 py-2 shadow-[0_14px_30px_-24px_rgba(0,0,0,0.9)] lg:hidden">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <Button size="sm" variant="ghost" onClick={() => setMobileThreadsOpen(true)}>
            <PanelLeft className="mr-1.5 h-4 w-4" /> Chats
          </Button>
          <div className="max-w-[48vw] truncate text-sm font-semibold" title={mobileHeaderTitle}>
            {mobileHeaderTitle}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setMobileContextOpen(true)}>
            <PanelRight className="mr-1.5 h-4 w-4" /> Tools
          </Button>
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
          <SessionsPanel
            sessions={filteredSessions}
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
            onCloseSidebar={() => setLeftSidebarOpen(false)}
          />
        </aside>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background lg:rounded-lg">
          <CenterPanel
            loading={loading || Boolean(selectedSessionId && loadingMessagesByRunId[selectedSessionId] && timeline.length === 0)}
            loadingOlderMessages={Boolean(selectedSessionId && loadingMessagesByRunId[selectedSessionId] && timeline.length > 0)}
            selectedSession={selectedSession}
            activeWorkspace={activeWorkspace}
            runner={runner}
            setRunner={setRunner}
            model={model}
            setModel={setModel}
            reasoningEffort={reasoningEffort}
            setReasoningEffort={setReasoningEffort}
            approvalsCount={pendingApprovals.length}
            rightPanelTab={rightPanelTab}
            rightDockOpen={rightDockOpen}
            onOpenRightPanel={(tab) => setRightPanelTab(tab)}
            leftSidebarOpen={leftSidebarOpen}
            onOpenLeftSidebar={() => setLeftSidebarOpen(true)}
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
            onNewSession={onNewSession}
            hasPendingIndicator={Boolean(selectedSession && selectedSession.status === "running" && !hasPendingTimelineEntry)}
            ansi={ansi}
            timelineScrollRef={timelineScrollRef}
            timelineBottomRef={timelineBottomRef}
            onTimelineScroll={onTimelineScroll}
            onLoadOlderTimelineMessages={onLoadOlderTimelineMessages}
            slashSuggestions={slashSuggestions}
            onSelectSlashCommand={onSelectSlashCommand}
            queueItems={queuedMessagesForActiveSession}
            processingQueueItemId={processingQueueItem?.item.sessionKey === sessionTimelineKey ? processingQueueItem.item.id : null}
            onRemoveQueueItem={(messageId) => removeQueuedMessage(sessionTimelineKey, messageId)}
            onRetryMessage={onRetryTimelineMessage}
            onSelectAttachments={uploadPendingFiles}
            onRemovePendingAttachment={removePendingAttachment}
            voiceSupported={voiceSupported}
            voiceListening={voiceListening}
            voiceError={voiceError}
            voiceRecordingSeconds={voiceRecordingSeconds}
            onToggleVoiceRecording={onToggleVoiceRecording}
            onSendButtonClick={onSendButtonClick}
            planSessionState={planSessionState}
            onDisablePlanMode={onDisablePlanMode}
            onAnswerPlanQuestions={onAnswerPlanQuestions}
            onApprovePlanImplementation={onApprovePlanImplementation}
            onSubmitPlanFeedback={onSubmitPlanFeedback}
          />
        </main>

        {rightDockOpen ? (
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
            model={model}
            setModel={setModel}
            reasoningEffort={reasoningEffort}
            setReasoningEffort={setReasoningEffort}
            sandbox={sandbox}
            setSandbox={setSandbox}
            approvalPolicy={approvalPolicy}
            setApprovalPolicy={setApprovalPolicy}
            theme={theme}
            toggleTheme={toggleTheme}
            approvals={pendingApprovals}
            onAcceptApproval={onAcceptApproval}
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

      <Dialog.Root open={newSessionDialogOpen} onOpenChange={setNewSessionDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-card-border bg-surface-1 p-4 shadow-xl outline-none">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <Dialog.Title className="text-base font-semibold">Create new session</Dialog.Title>
                <Dialog.Description className="mt-1 text-xs text-foreground/65">
                  Choose runner, model, and thinking effort.
                </Dialog.Description>
              </div>
              <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setNewSessionDialogOpen(false)} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
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
                className="h-16 justify-start gap-3 rounded-md border border-card-border px-3 text-left"
                onClick={() => setRunner("claude")}
              >
                <Bot className="h-5 w-5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">Claude Code</span>
                  <span className="block truncate text-xs opacity-70">{runner === "claude" ? model : defaultClaudeModel}</span>
                </span>
              </Button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground/75">Model</label>
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
                    setModel(next);
                  }}
                >
                  {modelOptionsForRunner(runner).map((modelOption) => (
                    <option key={modelOption} value={modelOption}>
                      {modelOption}
                    </option>
                  ))}
                  <option value="__custom__">Custom model...</option>
                </select>
                {newSessionUseCustomModel ? (
                  <input
                    className="mt-2 h-9 w-full rounded-md border border-card-border bg-control px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 md:text-sm"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={runner === "claude" ? "Enter Claude model id" : "Enter Codex model id"}
                  />
                ) : null}
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground/75">Thinking effort</label>
                <select
                  className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  value={reasoningEffort}
                  onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
                >
                  {reasoningEffortOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
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
              <SessionsPanel
                sessions={filteredSessions}
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
                onCloseSidebar={() => setMobileThreadsOpen(false)}
              />
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
                model={model}
                setModel={setModel}
                reasoningEffort={reasoningEffort}
                setReasoningEffort={setReasoningEffort}
                sandbox={sandbox}
                setSandbox={setSandbox}
                approvalPolicy={approvalPolicy}
                setApprovalPolicy={setApprovalPolicy}
                theme={theme}
                toggleTheme={toggleTheme}
                approvals={pendingApprovals}
                onAcceptApproval={onAcceptApproval}
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
  );
}

type SessionsPanelProps = {
  sessions: SessionCard[];
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
  onNewSession: () => void;
  mode: SidebarMode;
  setMode: (mode: SidebarMode) => void;
  agentsPanel: ReactNode;
  backendConnectionStatus: BackendConnectionStatus;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  onSignOut: () => void;
  onCloseSidebar: () => void;
};

function SessionsPanel({
  sessions,
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
  onCloseSidebar,
}: SessionsPanelProps): JSX.Element {
  const sessionFilterValue: SessionFilterValue = showAllHistory ? "all-history" : statusFilter;
  const environmentLabel = deploymentLabel();
  const [visibleSessionCount, setVisibleSessionCount] = useState(sidebarListPageSize);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const visibleSessions = sessions.slice(0, visibleSessionCount);
  const hasHiddenLoadedSessions = visibleSessionCount < sessions.length;
  const canLoadMoreSessions = hasHiddenLoadedSessions || hasMoreRuns;

  useEffect(() => {
    setVisibleSessionCount(sidebarListPageSize);
  }, [statusFilter, showAllHistory, mode]);

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

  function onLoadMoreVisibleSessions(): void {
    if (hasHiddenLoadedSessions) {
      setVisibleSessionCount((current) => Math.min(current + sidebarListPageSize, sessions.length));
      return;
    }

    void onLoadMoreRuns();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative z-10 px-3 pb-3 pt-3 shadow-[0_14px_28px_-28px_rgba(0,0,0,0.9)]">
        <div className="flex items-center gap-1">
          <div className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-md bg-surface-2 p-1 text-xs">
            <button
              type="button"
              className={cn(
                "flex h-8 items-center justify-center gap-1.5 rounded px-2",
                mode === "agents" ? "bg-control-hover font-medium text-foreground" : "text-foreground/60 hover:bg-control-hover",
              )}
              onClick={() => setMode("agents")}
            >
              <Bot className="h-3.5 w-3.5" /> Agents
            </button>
            <button type="button" className="flex h-8 items-center justify-center gap-1.5 rounded px-2 text-foreground/60 hover:bg-control-hover">
              <Bot className="h-3.5 w-3.5" /> Cowork
            </button>
            <button
              type="button"
              className={cn(
                "flex h-8 items-center justify-center gap-1.5 rounded px-2",
                mode === "code" ? "bg-control-hover font-medium text-foreground" : "text-foreground/60 hover:bg-control-hover",
              )}
              onClick={() => setMode("code")}
            >
              <FileCode2 className="h-3.5 w-3.5" /> Code
            </button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="hidden h-8 w-8 shrink-0 p-0 lg:inline-flex"
            onClick={onCloseSidebar}
            aria-label="Close left sidebar"
            title="Close sidebar"
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </Button>
        </div>

        {mode === "code" ? (
          <nav className="mt-3 space-y-1 text-sm">
            <button type="button" onClick={onNewSession} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-foreground/85 hover:bg-control-hover">
              <span className="text-lg leading-none">+</span> New session
            </button>
            <button type="button" className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-foreground/75 hover:bg-control-hover">
              <Layers className="h-3.5 w-3.5" /> Customize
            </button>
            <label className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-foreground/75 hover:bg-control-hover">
              {loadingRunList ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <PanelRight className="h-3.5 w-3.5" />}
              <select
                className="h-7 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
                value={sessionFilterValue}
                onChange={(event) => onSessionFilterChange(event.target.value as SessionFilterValue)}
                disabled={loadingRunList}
              >
                <option value="all">More: all sessions</option>
                <option value="all-history">More: All History</option>
                <option value="running">More: running</option>
                <option value="completed">More: completed</option>
                <option value="failed">More: failed</option>
                <option value="stopped">More: stopped</option>
              </select>
            </label>
          </nav>
        ) : null}
      </div>

      {mode === "agents" ? (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto px-3 py-3">
          {agentsPanel}
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2 px-1 text-xs text-foreground/55">
          <span>Recents</span>
          <span>{sessions.length}</span>
        </div>

        <div className="scrollbar-thin flex-1 space-y-1 overflow-auto pr-1">
          {sessions.length === 0 ? (
            <div className="rounded-md border border-dashed border-card-border bg-surface-2 px-3 py-2 text-xs text-foreground/70">
              No sessions yet
            </div>
          ) : null}

          {visibleSessions.map((session) => {
            const sourceBadge = getSessionSourceBadge(session);
            return (
              <div
                key={session.id}
                className={cn(
                  "w-full rounded-md border border-transparent px-2.5 py-1.5 text-left transition hover:bg-control-hover",
                  selectedSessionId === session.id ? "bg-control-hover text-foreground" : "text-foreground/82",
                )}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => onSelectSession(session.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", session.status === "running" || session.status === "queued" ? "bg-brand" : "bg-foreground/35")} />
                    <p className="min-w-0 flex-1 truncate text-sm" title={session.summary}>
                      {session.summary || "Session"}
                    </p>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 pl-3.5">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none", sourceBadge.className)}>
                      {sourceBadge.label}
                    </span>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none", statusClass(session.status))}>
                      {session.status}
                    </span>
                    {session.historyOnly ? (
                      <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-semibold leading-none text-foreground/65">
                        history
                      </span>
                    ) : null}
                    {session.scheduled ? (
                      <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold leading-none text-brand">
                        scheduled
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate text-[11px] leading-none text-foreground/45">
                      {new Date(session.updatedAt).toLocaleTimeString()}
                    </span>
                  </div>
                </button>
              </div>
            );
          })}

          {canLoadMoreSessions ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onLoadMoreVisibleSessions}
              disabled={loadingMoreRuns}
              className="w-full"
            >
              {loadingMoreRuns ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Load more
            </Button>
          ) : null}
        </div>
      </div>
      )}

      <div className="relative z-10 p-3 shadow-[0_-14px_28px_-28px_rgba(0,0,0,0.9)]">
        <div ref={accountMenuRef} className="relative">
          {accountMenuOpen ? (
            <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-md border border-card-border bg-surface-1 p-1 text-sm shadow-[0_16px_42px_-20px_rgba(0,0,0,0.95)]">
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

type CenterPanelProps = {
  loading: boolean;
  loadingOlderMessages: boolean;
  selectedSession: SessionCard | null;
  activeWorkspace: string;
  runner: RunRunner;
  setRunner: (value: RunRunner) => void;
  model: string;
  setModel: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  approvalsCount: number;
  rightPanelTab: DockTab;
  rightDockOpen: boolean;
  onOpenRightPanel: (tab: DockTab) => void;
  leftSidebarOpen: boolean;
  onOpenLeftSidebar: () => void;
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
  onRetryMessage: (entry: TimelineEntry) => Promise<void>;
  onSelectAttachments: (files: FileList | null) => Promise<void>;
  onRemovePendingAttachment: (attachmentId: string) => void;
  voiceSupported: boolean;
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
  const sourceBadge = props.selectedSession ? getSessionSourceBadge(props.selectedSession) : null;
  const [copiedEntryKey, setCopiedEntryKey] = useState<string | null>(null);
  const [attachmentDropActive, setAttachmentDropActive] = useState(false);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const attachmentDragDepthRef = useRef(0);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineBlocks = useMemo(() => buildTimelineRenderBlocks(props.timeline), [props.timeline]);
  const selectedSessionBusy = Boolean(props.selectedSession && !props.selectedSession.historyOnly && (props.selectedSession.status === "queued" || props.selectedSession.status === "running"));
  const attachmentDropDisabled = props.submitting || props.isUploadingAttachments;
  const composerModelOptions = modelOptionsForRunner(props.runner);
  const composerModelSelectOptions = composerModelOptions.includes(props.model)
    ? composerModelOptions
    : [props.model, ...composerModelOptions];
  const composerRunnerLabel = runnerLabel(props.runner);

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
      <div className="relative z-10 hidden h-12 shrink-0 items-center justify-between gap-3 bg-background/95 px-4 shadow-[0_14px_32px_-28px_rgba(0,0,0,0.95)] lg:flex">
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
              <h1 className="truncate text-sm font-semibold" title={props.selectedSession ? props.selectedSession.summary : "No active chat"}>
                {props.selectedSession ? props.selectedSession.summary : "No active chat"}
              </h1>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-foreground/55">
              {props.selectedSession ? <span className="truncate font-mono">{props.selectedSession.id}</span> : <span>Create or select a session</span>}
              {props.selectedSession ? <span>{props.selectedSession.status}</span> : null}
              {sourceBadge ? <span>{sourceBadge.label}</span> : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant={props.rightDockOpen && props.rightPanelTab === "terminal" ? "primary" : "ghost"} size="sm" className="h-7 w-7 p-0" onClick={() => props.onOpenRightPanel("terminal")} aria-label="Open terminal" title="Terminal">
            <Terminal className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant={props.rightDockOpen && props.rightPanelTab === "approvals" ? "primary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => props.onOpenRightPanel("approvals")} title="Approvals">
            <ShieldAlert className="mr-1 h-3.5 w-3.5" />
            {props.approvalsCount}
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
        <div
          ref={props.timelineScrollRef}
          onScroll={props.onTimelineScroll}
          className="scrollbar-thin min-h-0 flex-1 overflow-auto px-4 pb-4 pt-4 lg:px-8"
        >
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          {props.loading ? <p className="text-sm text-foreground/70">Loading...</p> : null}

          {!props.loading && !props.selectedSession ? (
            <div className="mx-auto max-w-3xl rounded-md border border-dashed border-card-border bg-surface-2 px-4 py-3 text-sm text-foreground/75">
              Start a new session or pick one from chats.
            </div>
          ) : null}

          {props.hiddenTimelineCount > 0 ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={props.onLoadOlderTimelineMessages}
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
		            const hasLaterUserMessage = props.timeline.some((item) => item.role === "user" && item.at > entry.at);
	              const showUserDeliveryState = entry.role === "user"
	                && (entry.deliveryStatus === "pending" || entry.deliveryStatus === "failed");
	              const canRetryUserMessage = entry.role === "user" && entry.deliveryStatus === "failed";
              const canCopyMessage = (entry.role === "assistant" || entry.role === "plan" || entry.role === "user")
                && Boolean(entry.text.trim());
              const messageAlignment = entry.role === "user"
                ? "items-end"
                : entry.role === "system"
                  ? "items-center"
                  : "items-start";

	            return (
                <div key={entry.key} className={cn("flex w-full flex-col animate-fade-up", messageAlignment)}>
	              <article
	                className={cn(
	                  "relative shadow-none",
	                  entry.role === "user" && "ml-auto max-w-[min(760px,82%)] rounded-lg border border-card-border bg-control px-3 py-2 text-foreground",
                    entry.role === "user" && entry.deliveryStatus === "failed" && "border-rose-500/60 bg-danger-bg text-danger-fg",
	                  entry.role === "assistant" && "mr-auto w-full bg-transparent px-0 py-0 text-foreground/90",
	                  entry.role === "plan" && "mr-auto w-full rounded-md border border-card-border bg-surface-1 px-3 py-2",
	                  entry.role === "tool" && "w-full bg-transparent px-0 py-0",
                  entry.role === "system" && "mx-auto max-w-fit rounded-md border border-card-border bg-surface-1 px-3 py-1 text-xs text-foreground/75",
                  entry.role === "error" && "mr-auto max-w-[90%] rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-rose-900 dark:border-danger-fg/40 dark:bg-danger-bg/90 dark:text-danger-fg",
                )}
              >
                {entry.role !== "system" && entry.role !== "assistant" && entry.role !== "user" && entry.title ? (
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-foreground/70">{entry.title}</div>
                ) : null}

                {entry.attachments && entry.attachments.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {entry.attachments.map((attachment) => (
                      <AttachmentChip
                        key={`${entry.key}_${attachment.id}`}
                        attachment={attachment}
                        className={entry.role === "user"
                          ? "border-card-border bg-surface-2 text-foreground"
                          : "border-card-border bg-surface-1/80 text-foreground"}
                      />
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
                      onAnswerPlanQuestions={props.onAnswerPlanQuestions}
                      onApprovePlanImplementation={props.onApprovePlanImplementation}
                      onSubmitPlanFeedback={props.onSubmitPlanFeedback}
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
		                  <div className={cn(
                        "break-words text-sm leading-relaxed",
                        entry.role === "user" && "whitespace-pre-wrap",
                      )}
                      >
                        {entry.text}
                      </div>
		                )}

                {showUserDeliveryState ? (
                  <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-foreground/70">
                    <span>{entry.deliveryStatus === "failed" ? "Failed to send" : "Sending..."}</span>
                    {canRetryUserMessage ? (
                      <button
                        type="button"
                      className="rounded-md border border-card-border px-2 py-0.5 font-semibold transition hover:bg-control-hover disabled:cursor-not-allowed disabled:opacity-70"
                        onClick={() => void props.onRetryMessage(entry)}
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

        <form
          className={cn(
            "relative bg-background px-4 py-3 shadow-[0_-16px_34px_-30px_rgba(0,0,0,0.95)] transition lg:px-8",
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
                <option key={runnerOption} value={runnerOption}>
                  {runnerLabel(runnerOption)}
                </option>
              ))}
            </select>
            <select
              className="h-6 appearance-none rounded-md border-0 bg-control px-2 text-xs text-foreground outline-none hover:bg-control-hover focus:ring-2 focus:ring-brand/20"
              style={{ width: compactSelectWidth(props.model) }}
              value={props.model}
              onChange={(event) => props.setModel(event.target.value)}
              aria-label="Model"
              title="Model"
            >
              {composerModelSelectOptions.map((modelOption) => (
                <option key={modelOption} value={modelOption}>
                  {modelOption}
                </option>
              ))}
            </select>
            <select
              className="h-6 appearance-none rounded-md border-0 bg-control px-2 text-xs text-foreground outline-none hover:bg-control-hover focus:ring-2 focus:ring-brand/20"
              style={{ width: compactSelectWidth(props.reasoningEffort) }}
              value={props.reasoningEffort}
              onChange={(event) => props.setReasoningEffort(event.target.value as ReasoningEffort)}
              aria-label="Thinking effort"
              title="Thinking effort"
            >
              {reasoningEffortOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

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
                {selectedSessionBusy ? (
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
                className="absolute bottom-full left-0 right-12 z-20 mb-2 max-h-[360px] overflow-hidden rounded-md border border-card-border bg-surface-1 p-2 shadow-xl outline-none"
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
                  <div className="max-h-[292px] space-y-1 overflow-auto pr-1">
                    {props.filteredAgents.map((agent, index) => (
                      <button
                        key={agent.id}
                        type="button"
                        className={cn(
                          "w-full rounded-md border px-2 py-2 text-left transition",
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
                          <div className="mt-0.5 max-h-8 overflow-hidden text-[11px] leading-snug text-foreground/65">{agent.description}</div>
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
                className="absolute bottom-full left-0 right-12 z-20 mb-2 max-h-[360px] overflow-hidden rounded-md border border-card-border bg-surface-1 p-2 shadow-xl outline-none"
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
                  <div className="max-h-[292px] space-y-1 overflow-auto pr-1">
                    {props.filteredSkills.map((skill, index) => (
                      <button
                        key={skill.id}
                        type="button"
                        className={cn(
                          "w-full rounded-md border px-2 py-2 text-left transition",
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
                          <div className="mt-0.5 max-h-8 overflow-hidden text-[11px] leading-snug text-foreground/65">{skill.description}</div>
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
              className="min-h-[44px] w-full resize-none rounded-lg border border-card-border bg-surface-1 px-3 py-2 text-base outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20 md:text-sm"
              placeholder="Type / for commands"
              value={props.prompt}
              onChange={(event) => props.setPrompt(event.target.value)}
              onKeyDown={props.onComposerKeyDown}
            />

            <Button
              type="button"
              disabled={props.submitting || props.isUploadingAttachments}
              aria-label={selectedSessionBusy ? "Queue message" : "Send message"}
              title={selectedSessionBusy ? "Queue message" : "Send message"}
              onClick={props.onSendButtonClick}
              className="h-[44px] w-[44px] shrink-0 rounded-lg p-0"
            >
              {props.submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
              disabled={!props.voiceSupported}
              aria-label={props.voiceListening ? "Stop recording" : "Start recording"}
              title={props.voiceListening ? "Stop recording" : props.voiceError || "Start recording"}
            >
              {props.voiceListening ? <MicOff className="mr-1.5 h-4 w-4" /> : <Mic className="mr-1.5 h-4 w-4" />}
              {props.voiceListening ? `Stop ${formatRecordingDuration(props.voiceRecordingSeconds)}` : "Record"}
            </Button>
          </div>
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
  model: string;
  setModel: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  sandbox: SandboxMode;
  setSandbox: (value: SandboxMode) => void;
  approvalPolicy: ApprovalPolicy;
  setApprovalPolicy: (value: ApprovalPolicy) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  approvals: ApprovalQueueItem[];
  onAcceptApproval: (item: ApprovalQueueItem) => Promise<void>;
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
  const activeModelOptions = modelOptionsForRunner(props.runner);
  const [useCustomModel, setUseCustomModel] = useState(() => !activeModelOptions.includes(props.model));
  const [terminalHistoryCursor, setTerminalHistoryCursor] = useState<number | null>(null);
  const terminalRunning = props.selectedTerminal?.status === "running";
  const terminalBusy = props.terminalAction === "starting" || props.terminalAction === "stopping";
  const selectedSessionSourceBadge = props.selectedSession ? getSessionSourceBadge(props.selectedSession) : null;
  const activeTabLabel = {
    terminal: "Terminal",
    approvals: "Approvals",
    context: "Context",
  }[props.rightPanelTab];

  useEffect(() => {
    if (!modelOptionsForRunner(props.runner).includes(props.model)) {
      setUseCustomModel(true);
    }
  }, [props.model, props.runner]);

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
          {props.rightPanelTab === "approvals" ? <Badge>{props.approvals.length}</Badge> : null}
        </div>
        <button type="button" className="rounded-md p-1 text-foreground/55 hover:bg-control-hover hover:text-foreground" onClick={props.onClose} aria-label="Close dock" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      {props.mobile ? (
        <div className="relative z-10 grid shrink-0 grid-cols-3 gap-1 bg-background px-2 py-2 shadow-[0_12px_26px_-26px_rgba(0,0,0,0.9)]">
          {([
            ["terminal", Terminal, ""],
            ["approvals", ShieldAlert, props.approvals.length ? String(props.approvals.length) : ""],
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

        {props.rightPanelTab === "approvals" ? (
          <section className="space-y-2">
            {props.approvals.length === 0 ? <p className="rounded-md border border-dashed border-card-border bg-surface-2 px-3 py-2 text-sm text-foreground/65">Approval queue is empty.</p> : null}
            {props.approvals.map((item) => (
              <div key={item.id} className="rounded-md border border-card-border bg-surface-2 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <ShieldAlert className="h-4 w-4 text-[color:var(--warn)]" />
                  {item.kind === "claude_permission" ? "Claude permission" : "Pending escalation"}
                </div>
                <p className="mb-2 line-clamp-6 text-xs text-foreground/75">{item.reason}</p>
                <div className="mb-2 rounded-md bg-control p-2 font-mono text-[11px]">
                  {item.kind === "claude_permission"
                    ? `tool: ${item.command || item.toolName || "Claude tool"}`
                    : `sandbox: ${item.suggestedSandbox} | approval: ${item.suggestedApprovalPolicy}`}
                </div>
                <Button size="sm" onClick={() => void props.onAcceptApproval(item)}>
                  {item.kind === "claude_permission" ? "Approve" : "Approve and rerun"}
                </Button>
              </div>
            ))}
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
                  <p className="mb-2 text-xs text-foreground/60">runner: {props.selectedSession.runner === "claude" ? "Claude Code" : "Codex"} | source: {props.selectedSession.sourceRaw || props.selectedSession.sourceTag}</p>
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
              <h3 className="mb-2 text-sm font-semibold">Run defaults</h3>
              <div className="space-y-2">
                <select className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none" value={props.runner} onChange={(event) => props.setRunner(event.target.value as RunRunner)}>
                  {runnerOptions.map((runnerOption) => <option key={runnerOption} value={runnerOption}>{runnerOption === "claude" ? "Claude Code" : "Codex"}</option>)}
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
                  {activeModelOptions.map((modelOption) => <option key={modelOption} value={modelOption}>{modelOption}</option>)}
                  <option value="__custom__">Custom model...</option>
                </select>
                {useCustomModel ? <input className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none" value={props.model} onChange={(event) => props.setModel(event.target.value)} placeholder="Custom model id" /> : null}
                <select className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none" value={props.reasoningEffort} onChange={(event) => props.setReasoningEffort(event.target.value as ReasoningEffort)}>
                  {reasoningEffortOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
                <select className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none" value={props.sandbox} onChange={(event) => props.setSandbox(event.target.value as SandboxMode)}>
                  {sandboxOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
                <select className="h-9 w-full rounded-md border border-card-border bg-control px-3 text-sm outline-none" value={props.approvalPolicy} onChange={(event) => props.setApprovalPolicy(event.target.value as ApprovalPolicy)}>
                  {approvalPolicies.map((policy) => <option key={policy} value={policy}>{policy}</option>)}
                </select>
              </div>
            </div>

            <div className="rounded-md border border-card-border bg-surface-2 p-3">
              <button type="button" onClick={() => window.location.assign("/taskmanager")} className="mb-2 flex w-full items-center justify-between rounded-md bg-control px-3 py-2 text-left text-sm hover:bg-control-hover">
                <span className="flex items-center gap-2"><ClipboardList className="h-4 w-4" /> Luma Tasks</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
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
  selectedSkills: SkillListItem[];
  skillCatalog: SkillListItem[];
  actionId: string | null;
  onReload: () => Promise<void>;
  onCreateSchedule: () => Promise<void>;
  onToggleSchedule: (schedule: AgentSchedule) => Promise<void>;
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
  const selectedAgent = props.agents.find((agent) => agent.id === props.selectedAgentId) || null;
  const selectedSkillRefs = props.selectedSkills.map(selectedSkillRef);
  const syncConflictCount = props.skillSyncResult?.conflicts.length || 0;
  const syncErrorCount = props.skillSyncResult?.errors.length || 0;
  const [visibleExecutionCount, setVisibleExecutionCount] = useState(sidebarListPageSize);
  const visibleExecutions = props.executions.slice(0, visibleExecutionCount);
  const hasHiddenExecutions = visibleExecutionCount < props.executions.length;

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
            <p className="mt-1 text-xs text-foreground/60">Asia/Tehran</p>
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
          {props.schedules.map((schedule) => (
            <div key={schedule.id} className={cn("border border-card-border bg-surface-2 px-3 py-2", props.compact ? "rounded-md" : "rounded-xl")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{schedule.agentName}</p>
                  <p className="text-xs text-foreground/65">
                    {formatTehranSchedule(schedule)} | next {formatDateTime(schedule.nextRunAt)}
                  </p>
                  {schedule.runConfig.skills.length > 0 ? (
                    <p className="mt-0.5 text-[11px] text-foreground/60">{formatSkillSummary(schedule.runConfig.skills, props.skillCatalog)}</p>
                  ) : null}
                </div>
                <Badge>{schedule.status}</Badge>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1">
                <Button size="sm" variant="ghost" className="px-2" onClick={() => void props.onRunNow(schedule)} disabled={props.actionId === schedule.id}>
                  {props.actionId === schedule.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                </Button>
                <Button size="sm" variant="ghost" className="px-2" onClick={() => void props.onToggleSchedule(schedule)} disabled={props.actionId === schedule.id}>
                  {schedule.status === "active" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                </Button>
                <Button size="sm" variant="ghost" className="px-2 text-rose-700" onClick={() => void props.onDeleteSchedule(schedule)} disabled={props.actionId === schedule.id}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
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
