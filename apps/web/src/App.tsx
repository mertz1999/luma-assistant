import { isValidElement, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Convert from "ansi-to-html";
import DiffViewer from "react-diff-viewer-continued";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CircleStop,
  FileCode2,
  FolderTree,
  Lock,
  Layers,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  Moon,
  PanelLeft,
  PanelRight,
  Paperclip,
  Play,
  Rocket,
  Send,
  ShieldAlert,
  Sun,
  X,
} from "lucide-react";
import type {
  ApprovalPolicy,
  ApprovalQueueItem,
  AttachmentRef,
  ChatMessage,
  DiffSnapshot,
  FileTreeNode,
  RunRecord,
  RunSourceTag,
  SandboxMode,
  SendMessageInput,
  SessionListItem,
  TerminalSessionSnapshot,
  WorkspaceOption,
} from "@agentic/shared";
import {
  archiveSession,
  connectEvents,
  deleteSession,
  sendMessage,
  getAccountStatus,
  getBootstrapLite,
  getDiff,
  getFileTree,
  getMcpStatus,
  getSessionList,
  getSessionMessages,
  getSystemStatus,
  getTerminal,
  interruptTerminal,
  loginWithPassword,
  getRun,
  rerun,
  retryMessage,
  setApiAuthToken,
  sendTerminalInput,
  setActiveWorkspace,
  startTerminal,
  stopRun,
  stopTerminal,
  uploadAttachment,
} from "@/lib/api";
import { parsePlanningMessage, type PlanningSegment } from "@/lib/planning";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/useUiStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type StatusFilter = "all" | "running" | "completed" | "failed" | "stopped";

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

type SessionCard = {
  id: string;
  sessionId: string;
  latestRunId: string | null;
  messageCount: number;
  lastMessagePreview: string;
  summary: string;
  status: SessionListItem["status"];
  updatedAt: number;
  sourceTag: RunSourceTag;
  sourceRaw: string;
  workspace: string;
  historyOnly: boolean;
};

type PlanSessionState = "idle" | "armed" | "active";

const sandboxOptions: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const approvalPolicies: ApprovalPolicy[] = ["untrusted", "on-failure", "on-request", "never"];
const modelOptions = ["gpt-5.3-codex", "gpt-5.4", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"];
const toolOutputModalLimit = 2500;
const draftSessionKey = "__draft__";
const runListPageSize = 60;
const messagePageSize = 30;
const queueStorageKey = "agentic_cli_queue_v1";
const terminalHistoryStorageKey = "agentic_cli_terminal_history_v1";
const terminalHistoryLimit = 80;
const authSessionStorageKey = "agentic_cli_auth_session_v1";
const authSessionMaxAgeMs = 24 * 60 * 60 * 1000;
const planInstructionPath = "/Users/applestation/Project/archive/agentic-assistant/plan.md";
const attachmentMaxFiles = 10;
// Account for the chat stack gap and bottom padding so "visually at bottom"
// still counts as bottom without making the auto-follow area too large.
const timelineAutoScrollThresholdPx = 64;

type StoredAuthSession = {
  token: string;
  expiresAt: number;
};

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
  model: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  planMode: boolean;
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
    `The next request will ask Codex to read and follow \`${planInstructionPath}\`.`,
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
    const raw = window.localStorage.getItem(terminalHistoryStorageKey);
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
    const raw = window.localStorage.getItem(authSessionStorageKey);
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
    const raw = window.localStorage.getItem(queueStorageKey);
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
        const model = typeof item.model === "string" ? item.model : "";
        const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
        const planMode = typeof item.planMode === "boolean" ? item.planMode : false;
        const attachments = readAttachmentRefs(item.attachments);

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
          model,
          sandbox: item.sandbox,
          approvalPolicy: item.approvalPolicy,
          planMode,
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
    return {
      label: "in-app",
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
    sourceTag: item.sourceTag,
    sourceRaw: item.sourceRaw,
    workspace: item.workspace,
    historyOnly: item.historyOnly,
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
  return {
    key: message.id,
    messageId: message.id,
    clientMessageId: message.clientMessageId,
    sessionId: message.sessionId,
    role: message.role,
    kind: message.kind,
    title: message.title,
    text: message.text,
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
  const index = next.findIndex((entry) => sameTimelineMessage(entry, nextEntry));
  if (index >= 0) {
    next[index] = nextEntry;
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
        sourceTag: input.sourceTag as RunSourceTag,
        sourceRaw: input.sourceRaw,
        workspace: input.workspace,
        latestRunId: typeof input.latestRunId === "string" ? input.latestRunId : null,
        lastMessagePreview: input.lastMessagePreview,
        messageCount: input.messageCount,
        historyOnly: input.historyOnly,
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
    .join("\n");
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
          <a href={href} target="_blank" rel="noreferrer" className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark">
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto rounded-lg border border-card-border">
            <table className="min-w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border-b border-card-border bg-muted px-2 py-1 text-left">{children}</th>,
        td: ({ children }) => <td className="border-b border-card-border px-2 py-1 align-top">{children}</td>,
        code: ({ inline, children }: any) => {
          const raw = flattenMarkdownText(children).replace(/\n$/, "");

          if (inline) {
            return <code className="font-[inherit] text-[0.98em] font-medium text-[#0f2433]">{raw}</code>;
          }

          const isSingleLine = !raw.includes("\n");
          if (isSingleLine) {
            return (
              <code className="block overflow-x-auto whitespace-nowrap font-[inherit] text-[1.04em] font-semibold tracking-[-0.015em] text-[#0f2433]">
                {raw}
              </code>
            );
          }

          return (
            <code className="block overflow-x-auto whitespace-pre-wrap break-words font-[inherit] text-[0.98em] leading-relaxed text-[#0f2433]">
              {raw}
            </code>
          );
        },
        pre: ({ children }) => <div className="my-1.5">{children}</div>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function ThinkingDots({ label = "Thinking" }: { label?: string }): JSX.Element {
  return (
    <div className="inline-flex items-center gap-2 text-sm text-foreground/80">
      <Rocket className="h-4 w-4 text-brand" />
      <span>{label}</span>
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
              "w-full rounded-xl border bg-white px-3 py-2 text-left text-sm transition hover:border-brand/50 hover:bg-brand-soft/30 disabled:cursor-not-allowed disabled:opacity-70",
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
            "flex items-center gap-2 rounded-xl border border-dashed bg-white px-3 py-2",
            currentCustomAnswer.trim() && currentAnswer === currentCustomAnswer ? "border-brand bg-brand-soft/25" : "border-card-border",
          )}
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground/60">Custom</span>
          <input
            className="h-9 w-full rounded-lg border border-card-border bg-white px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            value={currentCustomAnswer}
            onChange={(event) => updateCustomAnswerAt(currentIndex, event.target.value)}
            placeholder="Add your own answer"
            disabled={isDisabled || submitting}
          />
        </div>

        {totalQuestions > 1 ? (
          <div className="rounded-xl border border-card-border bg-white/70 px-3 py-2 text-xs text-foreground/70">
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
    <section className="rounded-2xl border border-amber-300/70 bg-amber-50/80 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Final approval</p>
          <h3 className="text-sm font-semibold">Do you want to implement this plan?</h3>
        </div>
        <Badge>{isDisabled ? "Submitted" : "Required"}</Badge>
      </div>

      <div className="mb-3 text-sm leading-relaxed">
        <MarkdownMessage text={text.trim() || "Do you want to implement this plan now?"} />
      </div>

      <div className="space-y-2">
        <Button type="button" onClick={() => void submitApprove()} disabled={isDisabled || submitting !== null} className="w-full justify-center">
          {submitting === "approve" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Yes, implement
        </Button>

        <div className="flex items-center gap-2 rounded-xl border border-dashed border-amber-300/80 bg-white px-3 py-2">
          <input
            className="h-9 w-full rounded-lg border border-card-border bg-white px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Add plan changes before approval"
            disabled={isDisabled || submitting !== null}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
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

type ToolDetailModalState = {
  title: string;
  command: string;
  output: string;
  status?: string;
  exitCode?: number | null;
  at: number;
};

function ToolEntry({
  entry,
  ansi,
  onOpenOutput,
}: {
  entry: TimelineEntry;
  ansi: Convert;
  onOpenOutput: (state: ToolDetailModalState) => void;
}): JSX.Element {
  const type = (entry.meta?.type || "").toLowerCase();
  const status = entry.meta?.status || null;
  const statusLabel = status ? String(status).replace(/[-_]/g, " ") : null;

  if (type === "commandexecution") {
    const command = entry.meta?.command || entry.text;
    const output = entry.meta?.output || "";
    const shouldTruncate = output.length > toolOutputModalLimit;
    const visibleOutput = shouldTruncate ? output.slice(0, toolOutputModalLimit) : output;
    const preview = `${entry.pending ? "Running" : "Command"}: ${command}`;

    return (
      <details className="rounded-xl border border-card-border bg-white/80 p-2" open={entry.pending}>
        <summary className="cursor-pointer list-none text-sm font-medium text-foreground">
          <span className="block truncate">{truncatePreview(preview, 132)}</span>
        </summary>
        <div className="mt-2 space-y-2">
          <pre className="max-h-32 overflow-auto rounded-xl border border-card-border bg-[#102b3b] p-2 text-xs text-slate-100">{command}</pre>

          {visibleOutput.trim() ? (
            <div>
              <div
                className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-card-border bg-black/5 p-2 font-mono text-xs"
                dangerouslySetInnerHTML={{ __html: ansi.toHtml(visibleOutput) }}
              />
              {shouldTruncate ? (
                <button
                  type="button"
                  className="mt-2 text-xs font-medium text-brand underline"
                  onClick={() =>
                    onOpenOutput({
                      title: "Command output",
                      command,
                      output,
                      status: status || undefined,
                      exitCode: entry.meta?.exitCode,
                      at: entry.at,
                    })
                  }
                >
                  View full output
                </button>
              ) : null}
            </div>
          ) : (
            <div className="rounded-lg border border-card-border bg-black/5 px-2 py-1 text-xs text-foreground/70">No output captured.</div>
          )}

          <div className="flex items-center justify-between gap-2 text-xs text-foreground/75">
            <span>
              {statusLabel ? `Status: ${statusLabel}` : entry.pending ? "Running command" : "Command update"}
              {entry.meta?.exitCode !== null && entry.meta?.exitCode !== undefined ? ` | Exit: ${entry.meta.exitCode}` : ""}
            </span>
            {entry.pending ? <ThinkingDots label="Running" /> : null}
          </div>
        </div>
      </details>
    );
  }

  if (type === "filechange") {
    const fileChanges = entry.meta?.fileChanges || [];
    const fileChangeCount = fileChanges.length;
    const preview = fileChangeCount
      ? `${entry.pending ? "Applying" : "Applied"} file changes (${fileChangeCount} file${fileChangeCount > 1 ? "s" : ""})`
      : entry.meta?.path
        ? `${entry.pending ? "Updating" : "File change"}: ${entry.meta.path}`
        : entry.pending
          ? "Applying file changes"
          : "File change update";

    return (
      <details className="rounded-xl border border-card-border bg-white/80 p-2" open={entry.pending}>
        <summary className="cursor-pointer list-none text-sm font-medium text-foreground">
          <span className="block truncate">{preview}</span>
        </summary>

        <div className="mt-2 space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-2 text-foreground/75 sm:grid-cols-3">
            <div>
              <span className="font-semibold text-foreground/85">Status:</span> {statusLabel || (entry.pending ? "in progress" : "completed")}
            </div>
            <div>
              <span className="font-semibold text-foreground/85">Files:</span> {fileChangeCount || 1}
            </div>
            {typeof entry.meta?.durationMs === "number" ? (
              <div>
                <span className="font-semibold text-foreground/85">Duration:</span> {entry.meta.durationMs} ms
              </div>
            ) : null}
            {entry.meta?.errorMessage ? (
              <div className="col-span-2 sm:col-span-3 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-red-700">
                <span className="font-semibold">Error:</span> {entry.meta.errorMessage}
              </div>
            ) : null}
          </div>

          {fileChangeCount ? (
            <div className="space-y-2">
              {fileChanges.map((change, index) => (
                <details key={`${change.path}-${index}`} className="rounded-lg border border-card-border bg-muted/70 px-2 py-1">
                  <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-mono" title={change.path}>
                      {change.path}
                    </span>
                    <span className="shrink-0 text-foreground/75">
                      {change.kind} +{change.added} -{change.removed}
                    </span>
                  </summary>
                  <div className="mt-2">
                    {change.diff ? (
                      <pre className="max-h-52 overflow-auto rounded-lg border border-card-border bg-[#0f2433] p-2 font-mono text-[11px] text-slate-100">
                        {change.diff}
                      </pre>
                    ) : (
                      <div className="text-xs text-foreground/65">No diff payload returned for this file.</div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <div className="text-xs text-foreground/70">
              <span className="font-semibold text-foreground/80">Path:</span>{" "}
              <span className="font-mono break-all">{entry.meta?.path || "-"}</span>
            </div>
          )}

          {entry.pending ? (
            <div className="pt-1">
              <ThinkingDots label="Applying changes" />
            </div>
          ) : null}
        </div>
      </details>
    );
  }

  return (
    <details className="rounded-xl border border-card-border bg-white/80 p-2" open={entry.pending}>
      <summary className="cursor-pointer list-none text-sm font-medium text-foreground">
        <span className="block truncate">{truncatePreview(entry.text, 132)}</span>
      </summary>
      {entry.text ? <pre className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{entry.text}</pre> : null}
      {entry.pending ? <ThinkingDots label="Working" /> : null}
    </details>
  );
}

function ToolDetailModal({
  state,
  ansi,
  onClose,
}: {
  state: ToolDetailModalState;
  ansi: Convert;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-[80] bg-black/45 p-3 sm:p-6">
      <div className="mx-auto mt-4 max-w-3xl rounded-2xl border border-[color:var(--panel-border)] bg-[color:var(--bg)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[color:var(--panel-border)] px-4 py-3">
          <div>
            <p className="text-sm font-semibold">{state.title}</p>
            <p className="text-xs text-[color:var(--text-soft)]">{new Date(state.at).toLocaleString()}</p>
          </div>
          <button className="focus-ring glass h-11 w-11 rounded-xl" type="button" onClick={onClose}>
            <X className="mx-auto h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[75vh] space-y-3 overflow-auto p-4">
          <section>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-soft)]">Command</p>
            <pre className="overflow-x-auto rounded-xl border border-[color:var(--panel-border)] bg-black/5 p-3 font-mono text-xs">{state.command}</pre>
          </section>

          <section>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--text-soft)]">Output</p>
            <div
              className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-[color:var(--panel-border)] bg-black/5 p-3 font-mono text-xs"
              dangerouslySetInnerHTML={{ __html: ansi.toHtml(state.output || "") }}
            />
          </section>

          {(state.status || state.exitCode !== null && state.exitCode !== undefined) ? (
            <p className="text-xs text-[color:var(--text-soft)]">
              {state.status ? `status: ${state.status}` : ""}{" "}
              {state.exitCode !== null && state.exitCode !== undefined ? `| exit: ${state.exitCode}` : ""}
            </p>
          ) : null}
        </div>
      </div>
      <button className="absolute inset-0 -z-10" type="button" onClick={onClose} aria-label="close output modal" />
    </div>
  );
}

export function App(): JSX.Element {
  const {
    selectedRunId,
    setSelectedRunId,
    toolTab,
    setToolTab,
    rightPanelTab,
    setRightPanelTab,
    mobileThreadsOpen,
    setMobileThreadsOpen,
    mobileContextOpen,
    setMobileContextOpen,
    theme,
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
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [loadingRunList, setLoadingRunList] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalQueueItem[]>([]);

  const [fileNodes, setFileNodes] = useState<FileTreeNode[]>([]);
  const [diff, setDiff] = useState<DiffSnapshot | null>(null);

  const [prompt, setPrompt] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRef[]>([]);
  const [pendingAttachmentWorkspace, setPendingAttachmentWorkspace] = useState<string | null>(null);
  const [uploadingAttachmentNames, setUploadingAttachmentNames] = useState<string[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [model, setModel] = useState("gpt-5.3-codex");
  const [sandbox, setSandbox] = useState<SandboxMode>("danger-full-access");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>("on-request");
  const [planFlowBySession, setPlanFlowBySession] = useState<Record<string, PlanSessionState>>({});

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isDraftSession, setIsDraftSession] = useState(false);
  const [slashEntriesBySession, setSlashEntriesBySession] = useState<Record<string, TimelineEntry[]>>({});
  const [queuedBySession, setQueuedBySession] = useState<Record<string, QueuedMessage[]>>(() => loadQueuedMessages());
  const [terminalHistoryBySession, setTerminalHistoryBySession] = useState<Record<string, string[]>>(() => loadTerminalCommandHistory());
  const [processingQueueItemId, setProcessingQueueItemId] = useState<string | null>(null);
  const [toolDetailModal, setToolDetailModal] = useState<ToolDetailModalState | null>(null);
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
      return;
    }
    window.localStorage.removeItem(authSessionStorageKey);
  }, [authReady, isAuthenticated, authToken, authExpiresAt]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    const onUnauthorized = () => {
      setApiAuthToken(null);
      setAuthTokenState(null);
      setAuthExpiresAt(0);
      setAuthError("Session expired. Please enter password again.");
    };
    window.addEventListener("agentic:unauthorized", onUnauthorized as EventListener);
    return () => {
      window.removeEventListener("agentic:unauthorized", onUnauthorized as EventListener);
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
        window.localStorage.removeItem(queueStorageKey);
        return;
      }
      window.localStorage.setItem(queueStorageKey, JSON.stringify(queuedBySession));
    } catch {
      // ignore localStorage write errors
    }
  }, [queuedBySession]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      if (Object.keys(terminalHistoryBySession).length === 0) {
        window.localStorage.removeItem(terminalHistoryStorageKey);
        return;
      }
      window.localStorage.setItem(terminalHistoryStorageKey, JSON.stringify(terminalHistoryBySession));
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
    if (!authReady || !isAuthenticated) return;
    const es = connectEvents((event) => {
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

      if (event.kind === "run.diffUpdated" && event.runId === selectedRunIdRef.current) {
        setDiff(event.payload as unknown as DiffSnapshot);
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

    let hasOpenedOnce = false;
    let shouldRefreshSelectedSession = false;

    es.onopen = () => {
      if (!hasOpenedOnce) {
        hasOpenedOnce = true;
        shouldRefreshSelectedSession = false;
        return;
      }
      const currentSelectedSessionId = selectedSessionIdRef.current;
      if (!shouldRefreshSelectedSession || !currentSelectedSessionId) return;
      shouldRefreshSelectedSession = false;
      void loadRunMessagesPage(currentSelectedSessionId, { reset: true });
    };

    es.onerror = () => {
      if (!hasOpenedOnce) return;
      shouldRefreshSelectedSession = true;
    };

    return () => es.close();
  }, [authReady, isAuthenticated]);

  useEffect(() => {
    const selectedIsHistory = runItems.some((item) => item.id === selectedSessionId && item.historyOnly);
    if (!selectedRunId || isDraftSession || selectedIsHistory) {
      setDiff(null);
      return;
    }
    void loadDiff(selectedRunId);
  }, [selectedRunId, selectedSessionId, isDraftSession, runItems]);

  useEffect(() => {
    if (!activeWorkspace) return;
    void loadFileTree();
  }, [activeWorkspace]);

  const allSessions = useMemo(() => buildSessionCards(runItems), [runItems]);
  const filteredSessions = useMemo(() => {
    if (statusFilter === "all") return allSessions;
    return allSessions.filter((session) => session.status === statusFilter);
  }, [allSessions, statusFilter]);

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
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of allSessions) {
      if (!item.historyOnly && item.status === "running") ids.add(item.sessionId);
    }
    return ids;
  }, [allSessions]);
  const queuedMessagesForActiveSession = queuedBySession[sessionTimelineKey] || [];

  const mobileHeaderTitle = selectedSession
    ? truncatePreview(selectedSession.summary || `Session ${selectedSession.id}`, 34)
    : "Agentic CLI";

  const hasPendingTimelineEntry = timeline.some((entry) => entry.pending);

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
    const node = terminalOutputRef.current;
    if (!node || !selectedSessionId || !selectedTerminal) return;
    node.scrollTop = node.scrollHeight;
  }, [selectedSessionId, selectedTerminal?.output]);

  useEffect(() => {
    if (submitting || processingQueueItemId) return;

    for (const [sessionKey, queued] of Object.entries(queuedBySession)) {
      if (!queued.length) continue;
      if (sessionKey === draftSessionKey) continue;
      if (runningSessionIds.has(sessionKey)) continue;

      setProcessingQueueItemId(queued[0].id);
      void runQueuedMessage(queued[0]);
      return;
    }
  }, [queuedBySession, runningSessionIds, submitting, processingQueueItemId]);

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

  async function loadBootstrapLite(): Promise<void> {
    setLoading(true);
    setLoadingRunList(true);
    try {
      const [payload, listPayload] = await Promise.all([
        getBootstrapLite(),
        getSessionList(runListPageSize, null, showAllHistoryRef.current),
      ]);
      setWorkspaces(payload.workspaces);
      setWorkspace(payload.activeWorkspace);
      const normalizedItems = normalizeSessionItems(listPayload.items);
      setRunItems(normalizedItems);
      setRunListNextCursor(listPayload.nextCursor);
      setApprovals(listPayload.approvals.length ? listPayload.approvals : payload.approvals);
      setModel(payload.defaults.model);
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
      setLoading(false);
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
    const preferred = preferredSessionId ? sessions.find((session) => session.id === preferredSessionId) : null;
    if (preferred) {
      setSelectedSessionId(preferred.id);
      setSelectedRunId(preferred.latestRunId);
      return;
    }

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

  async function loadDiff(runId: string): Promise<void> {
    try {
      const payload = await getDiff(runId);
      setDiff(payload);
    } catch {
      setDiff(null);
    }
  }

  async function loadFileTree(): Promise<void> {
    const payload = await getFileTree(".", 2);
    setFileNodes(payload.nodes);
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

  function buildQueuedMessage(
    sessionKey: string,
    promptValue: string,
    overrides?: {
      attachments?: AttachmentRef[];
      planMode?: boolean;
      sandbox?: SandboxMode;
      approvalPolicy?: ApprovalPolicy;
    },
  ): QueuedMessage {
    const planMode = overrides?.planMode ?? shouldUsePlanMode(sessionKey);
    return {
      id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionKey,
      prompt: promptValue,
      attachments: readAttachmentRefs(overrides?.attachments),
      createdAt: Date.now(),
      workspace: activeWorkspace,
      model,
      sandbox: overrides?.sandbox ?? (planMode ? "read-only" : sandbox),
      approvalPolicy: overrides?.approvalPolicy ?? (planMode ? "never" : approvalPolicy),
      planMode,
    };
  }

  function enqueueMessage(request: QueuedMessage): void {
    const sessionKey = request.sessionKey;
    const queued: QueuedMessage = {
      ...request,
      attachments: readAttachmentRefs(request.attachments),
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
      model: request.model,
      sandbox: request.sandbox,
      approvalPolicy: request.approvalPolicy,
      planMode: request.planMode,
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
        setRightPanelTab("tools");
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
    try {
      setSubmitting(true);
      await startCodexRun(queued, focusSession);
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
    } finally {
      removeQueuedMessage(queued.sessionKey, queued.id);
      setProcessingQueueItemId((current) => (current === queued.id ? null : current));
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
      await submitSessionMessage(trimmedPrompt, {
        sessionKey,
        attachments: pendingAttachments,
        onError: (message) => window.alert(message),
      });
      setPrompt("");
      clearComposerAttachments();
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
    setRightPanelTab("tools");
    setMobileContextOpen(false);
  }

  async function onChangeWorkspace(nextWorkspace: string): Promise<void> {
    await setActiveWorkspace(nextWorkspace);
    setWorkspace(nextWorkspace);
    await loadFileTree();
  }

  function onSelectSession(sessionId: string): void {
    setIsDraftSession(false);
    const target = allSessions.find((item) => item.id === sessionId);
    if (target) {
      setSelectedSessionId(target.id);
      setSelectedRunId(target.latestRunId);
    }
    setMobileThreadsOpen(false);
  }

  function onNewSession(): void {
    setIsDraftSession(true);
    setSelectedSessionId(null);
    setSelectedRunId(null);
    setSelectedRunRecord(null);
    setDiff(null);
    setPrompt("");
    clearComposerAttachments();
    setPlanState(draftSessionKey, "idle");
    setSlashEntriesBySession((prev) => {
      if (!(draftSessionKey in prev)) return prev;
      const next = { ...prev };
      delete next[draftSessionKey];
      return next;
    });
    setMobileThreadsOpen(false);
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
      setRightPanelTab("tools");
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

  if (!authReady) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-[color:var(--bg)] text-[color:var(--text)]">
        <div className="flex items-center gap-2 rounded-xl border border-card-border bg-white px-4 py-3 shadow-sm">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span className="text-sm">Preparing secure session...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-[color:var(--bg)] px-4 text-[color:var(--text)]">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Lock className="h-5 w-5" />
              Sign in
            </CardTitle>
            <p className="text-sm text-foreground/70">
              Enter password to access this panel. Auth session is saved in browser for 24 hours.
            </p>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={(event) => void onAuthenticate(event)}>
              <input
                className="h-11 w-full rounded-xl border border-card-border bg-white px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 md:text-sm"
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
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-full overflow-hidden text-[color:var(--text)]">
      <header className="fixed inset-x-0 top-0 z-20 border-b border-card-border bg-white/85 px-3 py-2 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <Button size="sm" variant="ghost" onClick={() => setMobileThreadsOpen(true)}>
            <PanelLeft className="mr-1.5 h-4 w-4" /> Chats
          </Button>
          <div className="max-w-[48vw] truncate text-sm font-semibold" title={mobileHeaderTitle}>
            {mobileHeaderTitle}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setMobileContextOpen(true)}>
            <PanelRight className="mr-1.5 h-4 w-4" /> Context
          </Button>
        </div>
      </header>

      <div className="mx-auto grid h-full min-h-0 max-w-[1800px] grid-cols-1 gap-3 p-3 pt-14 lg:grid-cols-[320px_minmax(0,1fr)_360px] lg:pt-3">
        <Card className="hidden min-h-0 flex-col overflow-hidden lg:flex">
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
          />
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CenterPanel
            loading={loading || Boolean(selectedSessionId && loadingMessagesByRunId[selectedSessionId] && timeline.length === 0)}
            loadingOlderMessages={Boolean(selectedSessionId && loadingMessagesByRunId[selectedSessionId] && timeline.length > 0)}
            selectedSession={selectedSession}
            timeline={visibleTimeline}
            hiddenTimelineCount={hiddenTimelineCount}
            prompt={prompt}
            setPrompt={setPrompt}
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
            setToolDetailModal={setToolDetailModal}
            slashSuggestions={slashSuggestions}
            onSelectSlashCommand={onSelectSlashCommand}
            queueItems={queuedMessagesForActiveSession}
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
            onAnswerPlanQuestions={onAnswerPlanQuestions}
            onApprovePlanImplementation={onApprovePlanImplementation}
            onSubmitPlanFeedback={onSubmitPlanFeedback}
          />
        </Card>

        <Card className="hidden min-h-0 flex-col overflow-auto lg:flex">
          <RightPanel
            rightPanelTab={rightPanelTab}
            setRightPanelTab={setRightPanelTab}
            toolTab={toolTab}
            setToolTab={setToolTab}
            workspaces={workspaces}
            activeWorkspace={activeWorkspace}
            onChangeWorkspace={onChangeWorkspace}
            model={model}
            setModel={setModel}
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
            diff={diff}
            fileNodes={fileNodes}
            selectedSessionId={selectedSessionId}
            selectedSession={selectedSession}
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
        </Card>
      </div>

      <Dialog.Root open={mobileThreadsOpen} onOpenChange={setMobileThreadsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-30 bg-black/45 backdrop-blur-[1px]" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-40 w-[min(360px,95vw)] border-r border-card-border bg-background p-3 outline-none">
            <Dialog.Title className="sr-only">Chats Drawer</Dialog.Title>
            <Dialog.Description className="sr-only">Session list and chat selection panel for mobile.</Dialog.Description>
            <Card className="flex h-full min-h-0 flex-col overflow-hidden animate-slide-in">
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
              />
            </Card>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={mobileContextOpen} onOpenChange={setMobileContextOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-30 bg-black/45 backdrop-blur-[1px]" />
          <Dialog.Content className="fixed inset-y-0 right-0 z-40 w-[min(390px,95vw)] border-l border-card-border bg-background p-3 outline-none">
            <Dialog.Title className="sr-only">Context Drawer</Dialog.Title>
            <Dialog.Description className="sr-only">Context and tools panel for mobile.</Dialog.Description>
            <Card className="flex h-full min-h-0 flex-col overflow-auto animate-slide-in">
              <RightPanel
                rightPanelTab={rightPanelTab}
                setRightPanelTab={setRightPanelTab}
                toolTab={toolTab}
                setToolTab={setToolTab}
                workspaces={workspaces}
                activeWorkspace={activeWorkspace}
                onChangeWorkspace={onChangeWorkspace}
                model={model}
                setModel={setModel}
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
                diff={diff}
                fileNodes={fileNodes}
                selectedSessionId={selectedSessionId}
                selectedSession={selectedSession}
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
            </Card>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {toolDetailModal ? <ToolDetailModal state={toolDetailModal} ansi={ansi} onClose={() => setToolDetailModal(null)} /> : null}
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
}: SessionsPanelProps): JSX.Element {
  return (
    <>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4" /> Chats
        </CardTitle>
        <Button size="sm" onClick={onNewSession}>
          New
        </Button>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div>
          <label className="mb-1 block text-xs font-semibold text-foreground/75">Status filter</label>
          <select
            className="h-9 w-full rounded-xl border border-card-border bg-white px-3 text-xs outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="all">all</option>
            <option value="running">running</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
            <option value="stopped">stopped</option>
          </select>
        </div>

        <label className="flex items-start gap-2 rounded-xl border border-card-border bg-white px-3 py-2 text-xs text-foreground/80">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-card-border text-brand focus:ring-brand/20"
            checked={showAllHistory}
            onChange={(event) => onToggleShowAllHistory(event.target.checked)}
            disabled={loadingRunList}
          />
          <span className="flex items-center gap-2">
            Show all Codex history
            {loadingRunList ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-brand" /> : null}
          </span>
        </label>

        <div className="scrollbar-thin flex-1 space-y-2 overflow-auto pr-1">
          {sessions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-card-border bg-muted px-3 py-2 text-xs text-foreground/70">
              No sessions yet
            </div>
          ) : null}

          {sessions.map((session) => {
            const sourceBadge = getSessionSourceBadge(session);
            return (
              <div
                key={session.id}
                className={cn(
                  "w-full rounded-2xl border bg-white px-3 py-2 text-left shadow-card transition hover:-translate-y-0.5 hover:border-brand/60",
                  selectedSessionId === session.id ? "border-brand bg-brand-soft/60" : "border-card-border",
                )}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => onSelectSession(session.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide", sourceBadge.className)}>
                        {sourceBadge.label}
                      </span>
                      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", statusClass(session.status))}>
                        {session.status}
                      </span>
                    </div>
                    <span className="text-[11px] text-foreground/70">{new Date(session.updatedAt).toLocaleTimeString()}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm font-semibold" title={session.summary}>
                    {session.summary || "Session"}
                  </p>
                  <p className="mt-1 truncate text-xs text-foreground/70">{describeSessionMeta(session)}</p>
                </button>
              </div>
            );
          })}

          {hasMoreRuns ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void onLoadMoreRuns()}
              disabled={loadingMoreRuns}
              className="w-full"
            >
              {loadingMoreRuns ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Load more
            </Button>
          ) : null}
        </div>
      </CardContent>
    </>
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
          className="rounded-full p-0.5 transition hover:bg-black/5"
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
  timeline: TimelineEntry[];
  hiddenTimelineCount: number;
  prompt: string;
  setPrompt: (value: string) => void;
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
  setToolDetailModal: (state: ToolDetailModalState | null) => void;
  slashSuggestions: SlashCommandSuggestion[];
  onSelectSlashCommand: (command: SlashCommandKey) => Promise<void>;
  queueItems: QueuedMessage[];
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
  onAnswerPlanQuestions: (answers: PlanQuestionAnswer[]) => Promise<void>;
  onApprovePlanImplementation: () => Promise<void>;
  onSubmitPlanFeedback: (feedback: string) => Promise<void>;
};

function CenterPanel(props: CenterPanelProps): JSX.Element {
  const sourceBadge = props.selectedSession ? getSessionSourceBadge(props.selectedSession) : null;

  return (
    <>
      <CardHeader className="hidden items-start justify-between gap-3 lg:flex">
        <div className="min-w-0">
          <CardTitle className="truncate text-base" title={props.selectedSession ? props.selectedSession.summary : "No active chat"}>
            {props.selectedSession ? props.selectedSession.summary : "No active chat"}
          </CardTitle>
          <p className="mt-1 font-mono text-[11px] text-foreground/70">
            {props.selectedSession ? `Session: ${props.selectedSession.id}` : "Create or select a chat to start"}
          </p>
          {props.selectedSession ? (
            <div className="mt-1 flex items-center gap-2">
              <Badge className={statusClass(props.selectedSession.status)}>{props.selectedSession.status}</Badge>
              {sourceBadge ? <Badge className={sourceBadge.className}>{sourceBadge.label}</Badge> : null}
            </div>
          ) : null}
        </div>

        <Button variant="ghost" size="sm" onClick={props.onNewSession}>
          New session
        </Button>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-0">
        <div
          ref={props.timelineScrollRef}
          onScroll={props.onTimelineScroll}
          className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-auto px-3 pb-2 pt-3"
        >
          {props.loading ? <p className="text-sm text-foreground/70">Loading...</p> : null}

          {!props.loading && !props.selectedSession ? (
            <div className="rounded-2xl border border-dashed border-card-border bg-muted px-4 py-3 text-sm text-foreground/75">
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

	          {props.timeline.map((entry) => {
	            const hasLaterUserMessage = props.timeline.some((item) => item.role === "user" && item.at > entry.at);
              const showUserDeliveryState = entry.role === "user"
                && (entry.deliveryStatus === "pending" || entry.deliveryStatus === "failed");
              const canRetryUserMessage = entry.role === "user" && entry.deliveryStatus === "failed";

	            return (
	              <article
	                key={entry.key}
	                className={cn(
	                  "animate-fade-up rounded-2xl border px-3 py-2 shadow-card",
	                  entry.role === "user" && "ml-auto max-w-[90%] border-transparent bg-gradient-to-br from-brand to-brand-dark text-white",
                    entry.role === "user" && entry.deliveryStatus === "failed" && "border-rose-200/80 from-rose-600 to-rose-700",
	                  entry.role === "assistant" && "mr-auto max-w-[90%] border-card-border bg-white",
	                  entry.role === "plan" && "mr-auto max-w-full border-brand/35 bg-brand-soft/45",
	                  entry.role === "tool" && "max-w-full border-dashed border-card-border bg-muted font-mono text-xs",
                  entry.role === "system" && "mx-auto max-w-fit rounded-full border-card-border bg-white/90 px-3 py-1 text-xs text-foreground/75",
                  entry.role === "error" && "mr-auto max-w-[90%] border-rose-300 bg-rose-50 text-rose-900",
                )}
              >
                {entry.role !== "system" && entry.title ? (
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-foreground/70">{entry.title}</div>
                ) : null}

                {entry.attachments && entry.attachments.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {entry.attachments.map((attachment) => (
                      <AttachmentChip
                        key={`${entry.key}_${attachment.id}`}
                        attachment={attachment}
                        className={entry.role === "user"
                          ? "border-white/20 bg-white/10 text-white"
                          : "border-card-border bg-white/80 text-foreground"}
                      />
                    ))}
                  </div>
                ) : null}

                {entry.role === "tool" ? (
                  <ToolEntry entry={entry} ansi={props.ansi} onOpenOutput={props.setToolDetailModal} />
                ) : entry.role === "assistant" || entry.role === "plan" ? (
                  <div className="break-words text-sm leading-relaxed">
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
	                  <div className="break-words text-sm leading-relaxed">{entry.text}</div>
	                )}

                {showUserDeliveryState ? (
                  <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-white/85">
                    <span>{entry.deliveryStatus === "failed" ? "Failed to send" : "Sending..."}</span>
                    {canRetryUserMessage ? (
                      <button
                        type="button"
                        className="rounded-full border border-white/30 px-2 py-0.5 font-semibold transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-70"
                        onClick={() => void props.onRetryMessage(entry)}
                        disabled={props.submitting}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                ) : null}
	              </article>
	            );
	          })}

          {props.hasPendingIndicator ? (
            <article className="mr-auto max-w-full animate-fade-up rounded-2xl border border-brand/35 bg-brand-soft/45 px-3 py-2 shadow-card">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-foreground/70">Reasoning</div>
              <ThinkingDots label="Thinking" />
            </article>
          ) : null}

          <div ref={props.timelineBottomRef} />
        </div>

        <form
          className="border-t border-card-border bg-white/75 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSendButtonClick();
          }}
        >
          <input
            ref={props.composerFileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void props.onSelectAttachments(event.target.files)}
          />

          {props.planSessionState !== "idle" ? (
            <div className="mb-3 rounded-2xl border border-brand/30 bg-brand-soft/40 px-3 py-2 text-sm text-foreground/80">
              {props.planSessionState === "armed"
                ? "Plan mode is enabled. Your next message will start the planning workflow."
                : "Planning workflow is active. Messages stay read-only until final approval."}
            </div>
          ) : null}

          {props.pendingAttachments.length > 0 || props.isUploadingAttachments || props.attachmentError ? (
            <div className="mb-3 rounded-2xl border border-card-border bg-white/90 px-3 py-2">
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
                      className="border-card-border bg-muted/60 text-foreground"
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

          <div className="relative flex items-end gap-2">
            {props.slashSuggestions.length > 0 ? (
              <div className="absolute bottom-full left-0 right-12 z-10 mb-2 space-y-1 rounded-2xl border border-card-border bg-white/95 p-2 shadow-lg backdrop-blur">
                {props.slashSuggestions.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="w-full rounded-xl border border-transparent px-2 py-2 text-left transition hover:border-card-border hover:bg-muted"
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
              className="min-h-[44px] max-h-40 w-full resize-y rounded-2xl border border-card-border bg-white px-3 py-2 text-base md:text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
              placeholder="Message Codex... (type / for commands, including /plan)"
              value={props.prompt}
              onChange={(event) => props.setPrompt(event.target.value)}
            />

            <Button
              type="button"
              disabled={props.submitting || props.isUploadingAttachments}
              aria-label="Send message"
              title="Send message"
              onClick={props.onSendButtonClick}
              className="h-[44px] w-[44px] shrink-0 rounded-full p-0"
            >
              {props.submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
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

          {props.queueItems.length > 0 ? (
            <div className="mt-2 rounded-xl border border-card-border bg-white/85 p-2">
              <div className="mb-1 text-xs font-semibold text-foreground/80">Queued messages ({props.queueItems.length})</div>
              <div className="space-y-1">
                {props.queueItems.slice(0, 5).map((item) => (
                  <div key={item.id} className="flex items-center gap-2 rounded-lg bg-muted/60 px-2 py-1">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-foreground/80" title={item.prompt}>
                        {truncatePreview(item.prompt, 140)}
                      </div>
                      {item.attachments.length > 0 ? (
                        <div className="text-[11px] text-foreground/60">{formatAttachmentSummary(item.attachments)}</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="rounded p-1 text-foreground/70 transition hover:bg-black/5 hover:text-foreground"
                      onClick={() => props.onRemoveQueueItem(item.id)}
                      aria-label="Remove queued message"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </form>
      </CardContent>
    </>
  );
}

type RightPanelProps = {
  rightPanelTab: "context" | "tools";
  setRightPanelTab: (tab: "context" | "tools") => void;
  toolTab: "approvals" | "diff" | "files";
  setToolTab: (tab: "approvals" | "diff" | "files") => void;
  workspaces: WorkspaceOption[];
  activeWorkspace: string;
  onChangeWorkspace: (workspace: string) => Promise<void>;
  model: string;
  setModel: (value: string) => void;
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
  diff: DiffSnapshot | null;
  fileNodes: FileTreeNode[];
  selectedSessionId: string | null;
  selectedSession: SessionCard | null;
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

function RightPanel(props: RightPanelProps): JSX.Element {
  const [useCustomModel, setUseCustomModel] = useState(() => !modelOptions.includes(props.model));
  const terminalRunning = props.selectedTerminal?.status === "running";
  const terminalBusy = props.terminalAction === "starting" || props.terminalAction === "stopping";
  const selectedSessionSourceBadge = props.selectedSession ? getSessionSourceBadge(props.selectedSession) : null;

  useEffect(() => {
    if (!modelOptions.includes(props.model)) {
      setUseCustomModel(true);
    }
  }, [props.model]);

  return (
    <div className="space-y-4 p-3">
      <div className="grid grid-cols-2 gap-1 rounded-2xl border border-card-border bg-muted p-1">
        <Button size="sm" variant={props.rightPanelTab === "context" ? "primary" : "ghost"} onClick={() => props.setRightPanelTab("context")}>
          Context
        </Button>
        <Button size="sm" variant={props.rightPanelTab === "tools" ? "primary" : "ghost"} onClick={() => props.setRightPanelTab("tools")}>
          Tools
        </Button>
      </div>

      {props.rightPanelTab === "context" ? (
        <>
          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Workspace</h3>
              <Badge>active</Badge>
            </div>
            <select
              className="h-10 w-full rounded-xl border border-card-border bg-white px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
              value={props.activeWorkspace}
              onChange={(event) => void props.onChangeWorkspace(event.target.value)}
            >
              {props.workspaces.map((workspace) => (
                <option key={workspace.path} value={workspace.path}>
                  {workspace.name} - {workspace.path}
                </option>
              ))}
            </select>
          </section>

          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Session</h3>
              {selectedSessionSourceBadge ? (
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide", selectedSessionSourceBadge.className)}>
                  {selectedSessionSourceBadge.label}
                </span>
              ) : (
                <Badge>none</Badge>
              )}
            </div>

            {props.selectedSession ? (
              <>
                <p className="mb-2 truncate text-xs text-foreground/70" title={props.selectedSession.sessionId}>
                  {props.selectedSession.sessionId}
                </p>
                <p className="mb-2 text-xs text-foreground/70">
                  {describeSessionMeta(props.selectedSession)}
                </p>
                <p className="mb-2 text-xs text-foreground/60">
                  source: {props.selectedSession.sourceRaw || props.selectedSession.sourceTag}
                </p>
                {props.selectedSession.historyOnly ? (
                  <p className="mb-2 text-xs text-foreground/70">
                    External Codex session. Archive and delete only apply to sessions with local app runs.
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={props.sessionAction !== null || props.selectedSession.historyOnly}
                    onClick={() => void props.onArchiveSession()}
                  >
                    {props.sessionAction === "archive" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Archive
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                    disabled={props.sessionAction !== null || props.selectedSession.historyOnly}
                    onClick={() => void props.onDeleteSession()}
                  >
                    {props.sessionAction === "delete" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Delete
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-foreground/70">Select a chat to manage it.</p>
            )}
          </section>

          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Run defaults</h3>
              <Badge>next run</Badge>
            </div>

            <div className="space-y-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground/75">Model</label>
                <select
                  className="h-10 w-full rounded-xl border border-card-border bg-white px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
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
                  {modelOptions.map((modelOption) => (
                    <option key={modelOption} value={modelOption}>
                      {modelOption}
                    </option>
                  ))}
                  <option value="__custom__">Custom model...</option>
                </select>
                {useCustomModel ? (
                  <input
                    className="mt-2 h-10 w-full rounded-xl border border-card-border bg-white px-3 text-base md:text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                    value={props.model}
                    onChange={(event) => props.setModel(event.target.value)}
                    placeholder="Enter model id (e.g. gpt-5.4)"
                  />
                ) : null}
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground/75">Sandbox</label>
                <select
                  className="h-10 w-full rounded-xl border border-card-border bg-white px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  value={props.sandbox}
                  onChange={(event) => props.setSandbox(event.target.value as SandboxMode)}
                >
                  {sandboxOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground/75">Approval policy</label>
                <select
                  className="h-10 w-full rounded-xl border border-card-border bg-white px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  value={props.approvalPolicy}
                  onChange={(event) => props.setApprovalPolicy(event.target.value as ApprovalPolicy)}
                >
                  {approvalPolicies.map((policy) => (
                    <option key={policy} value={policy}>
                      {policy}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          {props.debugLogs.length > 0 ? (
            <section className="rounded-2xl border border-card-border bg-white p-3">
              <details>
                <summary className="cursor-pointer list-none text-sm font-bold text-foreground">
                  Debug logs ({props.debugLogs.length})
                </summary>
                <div className="mt-2 space-y-2">
                  {props.debugLogs.map((entry) => (
                    <div key={entry.key} className="rounded-xl border border-card-border bg-muted/50 px-3 py-2">
                      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-foreground/65">
                        <span className="font-mono">{entry.runId}</span>
                        <span>{new Date(entry.at).toLocaleString()}</span>
                      </div>
                      <div
                        className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground/80"
                        dangerouslySetInnerHTML={{ __html: props.ansi.toHtml(entry.text) }}
                      />
                    </div>
                  ))}
                </div>
              </details>
            </section>
          ) : null}

          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Appearance</h3>
              <Badge>theme</Badge>
            </div>
            <Button variant="ghost" onClick={props.toggleTheme} className="w-full justify-between">
              <span className="flex items-center gap-2">
                <Layers className="h-4 w-4" />
                {props.theme === "light" ? "Light mode" : "Dark mode"}
              </span>
              {props.theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </Button>
          </section>
        </>
      ) : null}

      {props.rightPanelTab === "tools" ? (
        <>
          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Session terminal</h3>
              <Badge>{terminalRunning ? "running" : "stopped"}</Badge>
            </div>

            {!props.selectedSessionId ? (
              <p className="text-xs text-foreground/70">Select a chat to open a terminal.</p>
            ) : (
              <>
                <p className="mb-2 truncate font-mono text-[11px] text-foreground/70" title={props.selectedSessionId}>
                  {props.selectedSessionId}
                </p>

                <div className="mb-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void props.onStartTerminal()}
                    disabled={terminalRunning || terminalBusy}
                  >
                    {props.terminalAction === "starting" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Open terminal
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void props.onStopTerminal()}
                    disabled={!terminalRunning || terminalBusy}
                  >
                    {props.terminalAction === "stopping" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Stop
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void props.onInterruptTerminal()}
                    disabled={!terminalRunning || props.terminalAction === "sending"}
                  >
                    Ctrl+C
                  </Button>
                </div>

                {props.selectedTerminal ? (
                  <p className="mb-2 text-[11px] text-foreground/70">
                    {props.selectedTerminal.workspace} {props.selectedTerminal.pid ? `| pid ${props.selectedTerminal.pid}` : ""}
                  </p>
                ) : (
                  <p className="mb-2 text-[11px] text-foreground/70">No terminal for this session yet.</p>
                )}

                <div
                  ref={props.terminalOutputRef}
                  className="h-[20rem] overflow-auto rounded-xl border border-card-border bg-slate-950 p-2 font-mono text-[11px] leading-5 text-slate-100 md:h-[24rem]"
                >
                  <pre className="min-w-max whitespace-pre">
                    {props.selectedTerminal?.output
                      || (props.selectedTerminal
                        ? (props.selectedTerminal.status === "running" ? "$ terminal ready" : "$ terminal stopped")
                        : "$ terminal not started")}
                  </pre>
                </div>

                <form
                  className="mt-2 flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void props.onSubmitTerminalInput(`${props.terminalInput}\n`);
                  }}
                >
                  <input
                    className="h-10 w-full rounded-xl border border-card-border bg-white px-3 font-mono text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 md:text-sm"
                    value={props.terminalInput}
                    onChange={(event) => props.setTerminalInput(event.target.value)}
                    placeholder={terminalRunning ? "Type command and press Enter" : "Start terminal to run commands"}
                    disabled={!terminalRunning || props.terminalAction === "sending"}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!terminalRunning || !props.terminalInput.trim() || props.terminalAction === "sending"}
                  >
                    {props.terminalAction === "sending" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "Run"}
                  </Button>
                </form>

                {props.terminalHistory.length ? (
                  <div className="mt-3 rounded-xl border border-card-border bg-white p-2">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-[11px] font-semibold text-foreground/80">Recent commands</p>
                      <Badge>{props.terminalHistory.length}</Badge>
                    </div>
                    <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                      {props.terminalHistory.map((command, index) => (
                        <div key={`${command}_${index}`} className="rounded-lg border border-card-border bg-muted px-2 py-1.5">
                          <p className="truncate font-mono text-[11px]" title={command}>{command}</p>
                          <div className="mt-1 flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => props.setTerminalInput(command)}
                            >
                              Use
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-[11px]"
                              disabled={!terminalRunning || props.terminalAction === "sending"}
                              onClick={() => void props.onSubmitTerminalInput(`${command}\n`)}
                            >
                              Run
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>

          <section className="space-y-2">
            {props.approvals.length === 0 ? <p className="text-sm text-foreground/70">Approval queue is empty.</p> : null}

            {props.approvals.map((item) => (
              <div key={item.id} className="rounded-xl border border-card-border bg-white p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <ShieldAlert className="h-4 w-4 text-[color:var(--warn)]" />
                  Pending escalation
                </div>
                <p className="mb-2 line-clamp-5 text-xs text-foreground/75">{item.reason}</p>
                <div className="mb-2 rounded-lg bg-black/5 p-2 font-mono text-[11px]">
                  sandbox: {item.suggestedSandbox} | approval: {item.suggestedApprovalPolicy}
                </div>
                <Button size="sm" onClick={() => void props.onAcceptApproval(item)}>
                  Approve and rerun
                </Button>
              </div>
            ))}
          </section>
        </>
      ) : null}

      {props.mobile ? <div className="h-4" /> : null}
    </div>
  );
}

function ToolTabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <Button size="sm" variant={active ? "primary" : "ghost"} className="h-8 px-2 text-[11px]" onClick={onClick}>
      {label}
    </Button>
  );
}

function FileTree({ nodes }: { nodes: FileTreeNode[] }): JSX.Element {
  if (!nodes.length) return <p className="text-sm text-foreground/70">No files found.</p>;
  return (
    <div className="space-y-1 text-xs">
      {nodes.map((node) => (
        <FileTreeRow key={node.path} node={node} level={0} />
      ))}
    </div>
  );
}

function FileTreeRow({ node, level }: { node: FileTreeNode; level: number }): JSX.Element {
  const pad = level * 14;
  return (
    <div>
      <div className="flex items-center gap-2 rounded-lg border border-card-border bg-white p-2" style={{ paddingLeft: 8 + pad }}>
        {node.type === "directory" ? <FolderTree className="h-3.5 w-3.5" /> : <FileCode2 className="h-3.5 w-3.5" />}
        <span className="truncate">{node.name}</span>
      </div>
      {node.children?.map((child) => (
        <div key={child.path} className="mt-1">
          <FileTreeRow node={child} level={level + 1} />
        </div>
      ))}
    </div>
  );
}

export default App;
