import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Archive,
  Check,
  ChevronsUpDown,
  Circle,
  CircleStop,
  Command,
  X,
  Folder,
  FolderOpen,
  Layers,
  LoaderCircle,
  LogIn,
  LogOut,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Pin,
  PinOff,
  Play,
  RefreshCcw,
  RotateCcw,
  Save,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UserRoundPen,
} from "lucide-react";
import { allowedRpcMethods, type AllowedRpcMethod, type GuardRequirement, type MethodGroup, type SseEvent } from "@assistant/shared";
import {
  ApiRequestError,
  bootstrap,
  checkSession,
  enqueueThreadMessage,
  getSessionToken,
  login,
  logout,
  patchUiState,
  respondToServerRequest,
  rpc,
  setWorkspaceRoot,
} from "@/lib/api";
import { cn, isObject, safeJsonStringify } from "@/lib/utils";
import { useAssistantStore } from "@/store/useAssistantStore";
import type { PendingApproval, ThreadRecord, TimelineEntry } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const loginSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

type ContextTab = "context" | "admin";

type GuardPromptState = {
  method: AllowedRpcMethod;
  params: Record<string, unknown>;
  guard: GuardRequirement;
};

type CommandSession = {
  sessionId: string;
  title: string;
  output: string;
  running: boolean;
};

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type RequestUserInputOption = {
  label: string;
  description?: string;
  isOther?: boolean;
};

type RequestUserInputQuestion = {
  id: string;
  header?: string;
  question?: string;
  options: RequestUserInputOption[];
};

const UI_DEBUG_LOGS = String(import.meta.env.VITE_DEBUG_LOGS ?? "false").toLowerCase() === "true";
const TOOL_TIMELINE_CACHE_KEY = "assistant_tool_timeline_cache_v1";

function uiDebug(event: string, payload: Record<string, unknown> = {}): void {
  if (!UI_DEBUG_LOGS) return;
  // eslint-disable-next-line no-console
  console.log(`[ui-debug] ${event}`, payload);
}

function coerceTextContent(contentItems: unknown): string {
  if (!Array.isArray(contentItems)) return "";

  return contentItems
    .map((item) => {
      if (isObject(item) && item.type === "text") {
        return typeof item.text === "string" ? item.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseMcpServers(raw: unknown): Record<string, unknown>[] {
  if (!isObject(raw)) return [];
  if (Array.isArray(raw.data)) return raw.data as Record<string, unknown>[];
  if (Array.isArray(raw.servers)) return raw.servers as Record<string, unknown>[];
  return [];
}

function parseLoadedThreadIds(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  if (Array.isArray(raw.data)) return raw.data.filter((entry): entry is string => typeof entry === "string");
  if (Array.isArray(raw.threadIds)) return raw.threadIds.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function parseRequestUserInputQuestions(params: Record<string, unknown>): RequestUserInputQuestion[] {
  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  const questions: RequestUserInputQuestion[] = [];

  for (const rawQuestion of rawQuestions) {
    if (!isObject(rawQuestion)) continue;
    const id = typeof rawQuestion.id === "string" ? rawQuestion.id : "";
    if (!id) continue;

    const rawOptions = Array.isArray(rawQuestion.options) ? rawQuestion.options : [];
    const options: RequestUserInputOption[] = [];
    for (const rawOption of rawOptions) {
      if (!isObject(rawOption)) continue;
      const label = typeof rawOption.label === "string" ? rawOption.label : "";
      if (!label) continue;
      const option: RequestUserInputOption = {
        label,
      };
      if (typeof rawOption.description === "string") {
        option.description = rawOption.description;
      }
      if (Boolean(rawOption.isOther)) {
        option.isOther = true;
      }
      options.push(option);
    }

    questions.push({
      id,
      header: typeof rawQuestion.header === "string" ? rawQuestion.header : undefined,
      question: typeof rawQuestion.question === "string" ? rawQuestion.question : undefined,
      options,
    });
  }

  return questions;
}

function parseCachedTimelineEntry(raw: unknown): TimelineEntry | null {
  if (!isObject(raw)) return null;
  if (typeof raw.key !== "string" || raw.key.trim().length === 0) return null;
  const role = raw.role;
  if (role !== "tool" && role !== "plan") return null;

  return {
    key: raw.key,
    role,
    title: typeof raw.title === "string" ? raw.title : undefined,
    text: typeof raw.text === "string" ? raw.text : "",
    pending: raw.pending === true,
    meta: isObject(raw.meta) ? (raw.meta as TimelineEntry["meta"]) : undefined,
  };
}

function loadToolTimelineCache(): Record<string, TimelineEntry[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TOOL_TIMELINE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return {};

    const cache: Record<string, TimelineEntry[]> = {};
    for (const [threadId, entries] of Object.entries(parsed)) {
      if (typeof threadId !== "string" || !Array.isArray(entries)) continue;
      const normalized = entries.map(parseCachedTimelineEntry).filter((entry): entry is TimelineEntry => Boolean(entry));
      if (normalized.length > 0) {
        cache[threadId] = normalized;
      }
    }
    return cache;
  } catch {
    return {};
  }
}

function saveToolTimelineCache(cache: Record<string, TimelineEntry[]>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOOL_TIMELINE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore storage failures
  }
}

function isPersistableToolEntry(entry: TimelineEntry): boolean {
  if (!entry.key.startsWith("item:")) return false;
  return entry.role === "tool" || entry.role === "plan";
}

function mergeThreadEntriesWithToolCache(serverEntries: TimelineEntry[], cachedEntries: TimelineEntry[]): TimelineEntry[] {
  if (cachedEntries.length === 0) return serverEntries;

  const serverByKey = new Map(serverEntries.map((entry) => [entry.key, entry] as const));
  const merged: TimelineEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: TimelineEntry): void => {
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    merged.push(entry);
  };

  for (const cached of cachedEntries) {
    push(serverByKey.get(cached.key) || cached);
  }

  for (const serverEntry of serverEntries) {
    push(serverEntry);
  }

  return merged;
}

function detectPlanModeId(raw: unknown): string | null {
  const rows = isObject(raw)
    ? Array.isArray(raw.data)
      ? raw.data
      : Array.isArray(raw.items)
        ? raw.items
        : Array.isArray(raw.modes)
          ? raw.modes
          : []
    : Array.isArray(raw)
      ? raw
      : [];

  const candidates: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      candidates.push(row);
      continue;
    }
    if (!isObject(row)) continue;
    // Prefer wire-safe identifiers before display labels (name).
    for (const key of ["mode", "id", "key", "slug", "value", "name"]) {
      const value = row[key];
      if (typeof value === "string" && value.trim().length > 0) {
        candidates.push(value.trim());
      }
    }
  }

  const planCandidate = candidates.find((value) => value.toLowerCase().includes("plan"));
  if (planCandidate) return planCandidate;
  return null;
}

function buildPlanCollaborationMode(mode: string, model: string): Record<string, unknown> {
  return {
    mode,
    settings: {
      model,
      developer_instructions: null,
    },
  };
}

type RateLimitView = {
  id: string;
  name: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  secondaryUsedPercent: number | null;
  secondaryRemainingPercent: number | null;
  secondaryWindowDurationMins: number | null;
  secondaryResetsAt: number | null;
};

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(0, Math.min(100, value));
}

function parseRateLimitBucket(rawBucket: unknown, fallbackId = "default"): RateLimitView | null {
  if (!isObject(rawBucket)) return null;
  const id = typeof rawBucket.limitId === "string" && rawBucket.limitId.trim().length > 0 ? rawBucket.limitId : fallbackId;
  const name = typeof rawBucket.limitName === "string" && rawBucket.limitName.trim().length > 0 ? rawBucket.limitName : id;

  const primary = isObject(rawBucket.primary) ? rawBucket.primary : {};
  const secondary = isObject(rawBucket.secondary) ? rawBucket.secondary : {};

  const usedPercent = clampPercent(parseNumber(primary.usedPercent));
  const secondaryUsedPercent = clampPercent(parseNumber(secondary.usedPercent));

  return {
    id,
    name,
    usedPercent,
    remainingPercent: usedPercent === null ? null : clampPercent(100 - usedPercent),
    windowDurationMins: parseNumber(primary.windowDurationMins),
    resetsAt: parseNumber(primary.resetsAt),
    secondaryUsedPercent,
    secondaryRemainingPercent: secondaryUsedPercent === null ? null : clampPercent(100 - secondaryUsedPercent),
    secondaryWindowDurationMins: parseNumber(secondary.windowDurationMins),
    secondaryResetsAt: parseNumber(secondary.resetsAt),
  };
}

function parseRateLimits(raw: unknown): RateLimitView[] {
  if (!isObject(raw)) return [];
  const buckets: RateLimitView[] = [];

  const byId = isObject(raw.rateLimitsByLimitId) ? raw.rateLimitsByLimitId : null;
  if (byId) {
    for (const [limitId, bucket] of Object.entries(byId)) {
      const parsed = parseRateLimitBucket(bucket, limitId);
      if (parsed) buckets.push(parsed);
    }
  }

  if (buckets.length === 0 && raw.rateLimits !== undefined) {
    const fallback = parseRateLimitBucket(raw.rateLimits, "codex");
    if (fallback) buckets.push(fallback);
  }

  return buckets;
}

function formatResetTime(epochSeconds: number | null): string {
  if (epochSeconds === null) return "unknown";
  const millis = epochSeconds * 1000;
  if (!Number.isFinite(millis)) return "unknown";
  return new Date(millis).toLocaleString();
}

function parseThreadTokenUsageRows(raw: unknown): Array<{ label: string; value: number }> {
  if (!isObject(raw)) return [];
  const labelByKey: Record<string, string> = {
    totalTokens: "Total tokens",
    totalInputTokens: "Input tokens",
    totalOutputTokens: "Output tokens",
    inputTokens: "Input tokens",
    outputTokens: "Output tokens",
    promptTokens: "Prompt tokens",
    completionTokens: "Completion tokens",
    cachedInputTokens: "Cached input tokens",
    cacheReadInputTokens: "Cache read tokens",
    reasoningTokens: "Reasoning tokens",
  };

  const values = new Map<string, number>();
  const pushTokenValue = (key: string, value: unknown): void => {
    const parsed = parseNumber(value);
    if (parsed === null) return;
    const normalized = key.trim();
    if (!normalized.toLowerCase().includes("token")) return;
    if (values.has(normalized)) return;
    values.set(normalized, parsed);
  };

  for (const [key, value] of Object.entries(raw)) {
    pushTokenValue(key, value);
  }

  const nested = [raw.usage, raw.tokenUsage, raw.totals];
  for (const candidate of nested) {
    if (!isObject(candidate)) continue;
    for (const [key, value] of Object.entries(candidate)) {
      pushTokenValue(key, value);
    }
  }

  const preferredOrder = [
    "totalTokens",
    "totalInputTokens",
    "inputTokens",
    "promptTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "totalOutputTokens",
    "outputTokens",
    "completionTokens",
    "reasoningTokens",
  ];
  const sorted = Array.from(values.entries()).sort((a, b) => {
    const ai = preferredOrder.indexOf(a[0]);
    const bi = preferredOrder.indexOf(b[0]);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a[0].localeCompare(b[0]);
  });

  return sorted.map(([key, value]) => ({
    label: labelByKey[key] || key,
    value,
  }));
}

function buildStatusMarkdown(input: {
  threadId: string;
  activeTurnId: string | null;
  bridgeState: { running: boolean; initialized: boolean; lastStatus: Record<string, unknown> | null } | null;
  rateLimits: unknown;
  tokenUsage: unknown;
}): string {
  const sections: string[] = [];
  sections.push("### Status");
  sections.push(`- Bridge: ${input.bridgeState?.running ? "running" : "stopped"} / ${input.bridgeState?.initialized ? "initialized" : "not initialized"}`);
  sections.push(`- Thread: \`${input.threadId}\``);
  sections.push(`- Turn: ${input.activeTurnId ? `\`${input.activeTurnId}\`` : "idle"}`);

  const rateLimits = parseRateLimits(input.rateLimits);
  sections.push("");
  sections.push("#### Rate limits");
  if (rateLimits.length === 0) {
    sections.push("- Not available (login may be required).");
  } else {
    for (const bucket of rateLimits) {
      const used = bucket.usedPercent === null ? "unknown" : `${bucket.usedPercent.toFixed(1)}%`;
      const remaining = bucket.remainingPercent === null ? "unknown" : `${bucket.remainingPercent.toFixed(1)}%`;
      sections.push(
        `- ${bucket.name}: used ${used}, remaining ${remaining}, reset ${formatResetTime(bucket.resetsAt)}${bucket.windowDurationMins !== null ? `, window ${bucket.windowDurationMins}m` : ""}`,
      );
      if (bucket.secondaryUsedPercent !== null || bucket.secondaryRemainingPercent !== null) {
        const secondaryUsed = bucket.secondaryUsedPercent === null ? "unknown" : `${bucket.secondaryUsedPercent.toFixed(1)}%`;
        const secondaryRemaining = bucket.secondaryRemainingPercent === null ? "unknown" : `${bucket.secondaryRemainingPercent.toFixed(1)}%`;
        sections.push(
          `  - secondary: used ${secondaryUsed}, remaining ${secondaryRemaining}, reset ${formatResetTime(bucket.secondaryResetsAt)}${bucket.secondaryWindowDurationMins !== null ? `, window ${bucket.secondaryWindowDurationMins}m` : ""}`,
        );
      }
    }
  }

  const tokenRows = parseThreadTokenUsageRows(input.tokenUsage);
  sections.push("");
  sections.push("#### Thread token usage");
  if (tokenRows.length === 0) {
    sections.push("- No token usage event received for this thread yet.");
  } else {
    for (const row of tokenRows) {
      sections.push(`- ${row.label}: ${Math.round(row.value)}`);
    }
  }

  return sections.join("\n");
}

function getThreadTitle(thread: ThreadRecord): string {
  return thread.name || thread.preview || thread.id;
}

function summarizeItem(item: Record<string, unknown>): string {
  const clone = { ...item };
  delete clone.id;
  return safeJsonStringify(clone);
}

function normalizeItemType(item: Record<string, unknown>): string {
  return typeof item.type === "string" ? item.type : "item";
}

function normalizeItemTypeLower(item: Record<string, unknown>): string {
  return normalizeItemType(item).toLowerCase();
}

function extractItemStatus(item: Record<string, unknown>): string | null {
  if (typeof item.status === "string") return item.status;
  if (isObject(item.state) && typeof item.state.status === "string") return item.state.status;
  return null;
}

function extractItemText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim().length > 0) {
    return item.text;
  }

  const fromContent = coerceTextContent(item.content);
  if (fromContent.trim().length > 0) return fromContent;

  if (isObject(item.message)) {
    const message = item.message as Record<string, unknown>;
    if (typeof message.text === "string" && message.text.trim().length > 0) {
      return message.text;
    }

    const messageContent = coerceTextContent(message.content);
    if (messageContent.trim().length > 0) return messageContent;
  }

  if (typeof item.summary === "string" && item.summary.trim().length > 0) {
    return item.summary;
  }

  return "";
}

function detectMessageRole(item: Record<string, unknown>): string | null {
  if (typeof item.role === "string") return item.role;
  if (isObject(item.message) && typeof item.message.role === "string") return item.message.role;
  return null;
}

function isUserLikeItem(item: Record<string, unknown>): boolean {
  const type = normalizeItemTypeLower(item);
  if (type === "usermessage" || type === "user_message") return true;
  return type === "message" && detectMessageRole(item) === "user";
}

function isAgentLikeItem(item: Record<string, unknown>): boolean {
  const type = normalizeItemTypeLower(item);
  if (type === "agentmessage" || type === "agent_message" || type === "assistantmessage" || type === "assistant_message") return true;
  const role = detectMessageRole(item);
  return type === "message" && (role === "assistant" || role === "agent");
}

function isPlanLikeItem(item: Record<string, unknown>): boolean {
  const type = normalizeItemTypeLower(item);
  return type === "plan" || type === "reasoning";
}

function formatToolTitle(item: Record<string, unknown>, inProgress: boolean): string {
  const type = normalizeItemTypeLower(item);
  const labelByType: Record<string, string> = {
    commandexecution: "Command",
    filechange: "File change",
    mcptoolcall: "MCP tool",
    toolcall: "Tool call",
    reasoning: "Reasoning",
    plan: "Plan",
  };
  const base = labelByType[type] || type;
  return inProgress ? `${base} (in progress)` : base;
}

function summarizeToolItem(item: Record<string, unknown>): string {
  const type = normalizeItemTypeLower(item);
  const status = extractItemStatus(item);

  if (type === "commandexecution") {
    const command =
      typeof item.command === "string"
        ? item.command
        : isObject(item.command) && typeof item.command.command === "string"
          ? item.command.command
          : null;
    if (command && status) return `${command}\nStatus: ${status}`;
    if (command) return `Command: ${command}`;
  }

  if (type === "filechange") {
    const path =
      typeof item.path === "string"
        ? item.path
        : isObject(item.file) && typeof item.file.path === "string"
          ? item.file.path
          : null;
    if (path && status) return `${path}\nStatus: ${status}`;
    if (path) return `Path: ${path}`;
  }

  const text = extractItemText(item);
  if (text.trim().length > 0) return text;

  if (status) return `Status: ${status}`;
  return formatToolTitle(item, false);
}

function resolvePlanText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim().length > 0) {
    return item.text;
  }
  if (typeof item.plan === "string" && item.plan.trim().length > 0) {
    return item.plan;
  }
  const summary = Array.isArray(item.summary) ? item.summary : [];
  if (summary.length > 0) {
    const parts = summary
      .map((entry) => (typeof entry === "string" ? entry : isObject(entry) && typeof entry.text === "string" ? entry.text : ""))
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }

  const contentText = coerceTextContent(item.content);
  if (contentText.trim().length > 0) return contentText;

  return "";
}

function planFallbackText(item: Record<string, unknown>, inProgress: boolean): string {
  const type = normalizeItemTypeLower(item);
  if (type === "reasoning") {
    return inProgress ? "Thinking" : "Reasoning completed";
  }
  return inProgress ? "Planning" : "Plan updated";
}

type ToolMetaContext = {
  threadId?: string | null;
  turnId?: string | null;
};

type FileChangeDetail = NonNullable<NonNullable<TimelineEntry["meta"]>["fileChanges"]>[number];

function countDiffChanges(diff: string): { added: number; removed: number } {
  const lines = diff.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function parseFileChangeDetails(item: Record<string, unknown>): FileChangeDetail[] {
  const rawChanges = Array.isArray(item.changes) ? item.changes : [];
  const details = rawChanges
    .map((change) => {
      if (!isObject(change)) return null;
      const path =
        typeof change.path === "string"
          ? change.path
          : typeof change.filePath === "string"
            ? change.filePath
            : typeof change.targetPath === "string"
              ? change.targetPath
              : "";
      if (!path) return null;

      const kind =
        typeof change.kind === "string"
          ? change.kind
          : typeof change.type === "string"
            ? change.type
            : typeof change.action === "string"
              ? change.action
              : "modify";

      const diff =
        typeof change.diff === "string"
          ? change.diff
          : typeof change.patch === "string"
            ? change.patch
            : "";

      const counts = countDiffChanges(diff);
      return {
        path,
        kind,
        diff,
        added: counts.added,
        removed: counts.removed,
      };
    })
    .filter((entry): entry is FileChangeDetail => Boolean(entry));

  return details;
}

function createToolMeta(item: Record<string, unknown>, ctx: ToolMetaContext = {}): TimelineEntry["meta"] {
  const type = normalizeItemType(item);
  const status = extractItemStatus(item);
  const command =
    typeof item.command === "string"
      ? item.command
      : isObject(item.command) && typeof item.command.command === "string"
        ? item.command.command
        : null;
  const path =
    typeof item.path === "string"
      ? item.path
      : isObject(item.file) && typeof item.file.path === "string"
        ? item.file.path
        : null;
  const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
  const grantRoot = typeof item.grantRoot === "string" ? item.grantRoot : null;
  const errorMessage =
    typeof item.error === "string"
      ? item.error
      : isObject(item.error) && typeof item.error.message === "string"
        ? item.error.message
        : null;
  const fileChanges = normalizeItemTypeLower(item) === "filechange" ? parseFileChangeDetails(item) : undefined;

  return {
    type,
    status,
    command,
    path,
    threadId: ctx.threadId ?? null,
    turnId: ctx.turnId ?? null,
    durationMs,
    grantRoot,
    errorMessage,
    fileChanges,
  };
}

function statusLabel(status: unknown): string {
  if (!isObject(status)) return "idle";
  if (typeof status.type === "string") return status.type;
  return "idle";
}

function extractTurns(thread: ThreadRecord): Record<string, unknown>[] {
  const raw = (thread as Record<string, unknown>).turns;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is Record<string, unknown> => isObject(entry));
}

function extractInProgressTurnId(thread: ThreadRecord): string | null {
  const turns = extractTurns(thread);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const status =
      typeof turn.status === "string"
        ? turn.status
        : isObject(turn.status) && typeof turn.status.type === "string"
          ? turn.status.type
          : null;
    if (status === "inProgress" && typeof turn.id === "string") {
      return turn.id;
    }
  }
  return null;
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
        code: ({ inline, className, children }: any) => {
          if (inline) {
            return <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[12px]">{children}</code>;
          }
          return (
            <code
              className={cn(
                "block overflow-x-auto rounded-xl border border-card-border bg-[#0f2433] p-3 font-mono text-[12px] text-slate-100",
                className,
              )}
            >
              {children}
            </code>
          );
        },
        pre: ({ children }) => <div className="my-2">{children}</div>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function ThinkingDots({ label = "Thinking" }: { label?: string }): JSX.Element {
  return (
    <div className="inline-flex items-center gap-2 text-sm text-foreground/80">
      <Sparkles className="h-4 w-4 text-brand" />
      <span>{label}</span>
      <span className="dot-wave" aria-label={`${label} in progress`} role="status">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
}

function ToolMessage({ entry }: { entry: TimelineEntry }): JSX.Element {
  const type = (entry.meta?.type || "").toLowerCase();
  const status = entry.meta?.status || null;
  const statusLabelText = status ? String(status).replace(/[-_]/g, " ") : null;
  const fileChanges = entry.meta?.fileChanges || [];
  const fileChangeCount = fileChanges.length;

  const preview = (() => {
    if (type === "commandexecution") {
      if (entry.meta?.command) {
        return `${entry.pending ? "Running" : "Command"}: ${entry.meta.command}`;
      }
      return entry.pending ? "Running command" : "Command update";
    }
    if (type === "filechange") {
      if (fileChangeCount > 0) {
        return `${entry.pending ? "Applying" : "Applied"} file changes (${fileChangeCount} file${fileChangeCount > 1 ? "s" : ""})`;
      }
      if (entry.meta?.path) {
        return `${entry.pending ? "Updating" : "File change"}: ${entry.meta.path}`;
      }
      return entry.pending ? "Applying file change" : "File change update";
    }
    if (entry.text.trim().length > 0) {
      return entry.text.replace(/\s+/g, " ").trim();
    }
    return entry.pending ? "Working" : "Update";
  })();

  if (type === "commandexecution") {
    const command = entry.meta?.command || entry.text;
    return (
      <div className="space-y-2">
        <details className="rounded-xl border border-card-border bg-white/80 p-2">
          <summary className="cursor-pointer list-none text-sm font-medium text-foreground">
            <span className="block truncate">{preview}</span>
          </summary>
          <div className="mt-2 space-y-2">
            <pre className="max-h-28 overflow-auto rounded-xl border border-card-border bg-[#102b3b] p-2 text-xs text-slate-100">{command}</pre>
            <div className="flex items-center justify-between gap-2 text-xs text-foreground/75">
              <span>{statusLabelText ? `Status: ${statusLabelText}` : entry.pending ? "Running command" : "Command update"}</span>
              {entry.pending ? <ThinkingDots label="Running" /> : null}
            </div>
          </div>
        </details>
      </div>
    );
  }

  if (type === "filechange") {
    return (
      <div className="space-y-1 text-sm">
        <details className="rounded-xl border border-card-border bg-white/80 p-2">
          <summary className="cursor-pointer list-none text-sm font-medium text-foreground">
            <span className="block truncate">{preview}</span>
          </summary>
          <div className="mt-2 space-y-2">
            <div className="grid grid-cols-2 gap-2 text-xs text-foreground/75 sm:grid-cols-3">
              <div>
                <span className="font-semibold text-foreground/85">Status:</span> {statusLabelText || (entry.pending ? "in progress" : "completed")}
              </div>
              <div>
                <span className="font-semibold text-foreground/85">Files:</span> {fileChangeCount || 1}
              </div>
              {typeof entry.meta?.durationMs === "number" ? (
                <div>
                  <span className="font-semibold text-foreground/85">Duration:</span> {entry.meta.durationMs} ms
                </div>
              ) : null}
              {entry.meta?.threadId ? (
                <div className="col-span-2 sm:col-span-3">
                  <span className="font-semibold text-foreground/85">Thread:</span>{" "}
                  <span className="font-mono">{entry.meta.threadId}</span>
                </div>
              ) : null}
              {entry.meta?.turnId ? (
                <div className="col-span-2 sm:col-span-3">
                  <span className="font-semibold text-foreground/85">Turn:</span>{" "}
                  <span className="font-mono">{entry.meta.turnId}</span>
                </div>
              ) : null}
              {entry.meta?.grantRoot ? (
                <div className="col-span-2 sm:col-span-3">
                  <span className="font-semibold text-foreground/85">Grant root:</span>{" "}
                  <span className="font-mono break-all">{entry.meta.grantRoot}</span>
                </div>
              ) : null}
              {entry.meta?.errorMessage ? (
                <div className="col-span-2 sm:col-span-3 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-red-700">
                  <span className="font-semibold">Error:</span> {entry.meta.errorMessage}
                </div>
              ) : null}
            </div>

            {fileChangeCount > 0 ? (
              <div className="space-y-2">
                {fileChanges.map((change, index) => {
                  const changeKind = (change.kind || "modify").replace(/[-_]/g, " ");
                  return (
                    <details key={`${change.path}-${index}`} className="rounded-lg border border-card-border bg-muted/70 px-2 py-1">
                      <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate font-mono" title={change.path}>
                          {change.path}
                        </span>
                        <span className="shrink-0 text-foreground/75">
                          {changeKind}  +{change.added}  -{change.removed}
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
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-foreground/70">
                <span className="font-semibold text-foreground/80">Path:</span>{" "}
                <span className="font-mono break-all">{entry.meta?.path || entry.text || "-"}</span>
              </div>
            )}

            {entry.pending ? (
              <div className="pt-1">
                <ThinkingDots label="Applying changes" />
              </div>
            ) : null}
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <details className="rounded-xl border border-card-border bg-white/80 p-2">
        <summary className="cursor-pointer list-none text-sm font-medium text-foreground">
          <span className="block truncate">{preview}</span>
        </summary>
        {entry.text ? <pre className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{entry.text}</pre> : null}
      </details>
      {entry.pending ? <ThinkingDots label="Working" /> : null}
    </div>
  );
}

function App(): JSX.Element {
  const {
    bridgeState,
    defaults,
    capabilities,
    uiState,
    account,
    threads,
    archivedThreads,
    loadedThreadIds,
    mcpServers,
    activeThreadId,
    activeThreadArchived,
    activeTurnId,
    showArchived,
    timelines,
    setBootstrap,
    setUiState,
    setAccount,
    setMcpServers,
    setShowArchived,
    setActiveThread,
    setActiveTurnId,
    setLoadedThreadIds,
    upsertThread,
    moveThreadToArchive,
    moveThreadToActive,
    setThreadTimeline,
    appendTimelineEntry,
    upsertTimelineEntry,
    pinThread,
    unpinThread,
    clearSession,
  } = useAssistantStore();

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [chatgptAuthUrl, setChatgptAuthUrl] = useState<string | null>(null);
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [toastText, setToastText] = useState<string | null>(null);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [planModeId, setPlanModeId] = useState("plan");
  const [rateLimitsSnapshot, setRateLimitsSnapshot] = useState<Record<string, unknown> | null>(null);
  const [threadTokenUsageById, setThreadTokenUsageById] = useState<Record<string, Record<string, unknown>>>({});
  const [requestInputSelections, setRequestInputSelections] = useState<Record<string, string>>({});
  const [requestInputOtherText, setRequestInputOtherText] = useState<Record<string, string>>({});
  const [isSubmittingRequestInput, setIsSubmittingRequestInput] = useState(false);
  const [activeContextTab, setActiveContextTab] = useState<ContextTab>("context");
  const [guardPrompt, setGuardPrompt] = useState<GuardPromptState | null>(null);
  const [guardAcceptForSession, setGuardAcceptForSession] = useState(true);
  const [guardPassword, setGuardPassword] = useState("");
  const [isSubmittingGuard, setIsSubmittingGuard] = useState(false);

  const [commandInput, setCommandInput] = useState("");
  const [commandSessions, setCommandSessions] = useState<CommandSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [stdinInput, setStdinInput] = useState("");

  const [fileRoot, setFileRoot] = useState("");
  const [workspaceRootInput, setWorkspaceRootInput] = useState("");
  const [isUpdatingWorkspaceRoot, setIsUpdatingWorkspaceRoot] = useState(false);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFileText, setSelectedFileText] = useState("");
  const [pluginRows, setPluginRows] = useState<Record<string, unknown>[]>([]);
  const [configText, setConfigText] = useState("");
  const [adminMethod, setAdminMethod] = useState<AllowedRpcMethod>("plugin/list");
  const [adminParamsText, setAdminParamsText] = useState("{}");
  const [adminResultText, setAdminResultText] = useState("");

  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const skipNextUiSyncRef = useRef(true);
  const commandSessionsRef = useRef<CommandSession[]>([]);
  const toolTimelineCacheRef = useRef<Record<string, TimelineEntry[]>>(loadToolTimelineCache());
  const syncInFlightRef = useRef(false);
  const syncTimerRef = useRef<number | null>(null);
  const lastBootstrapSyncRef = useRef(0);
  const lastSseToastAtRef = useRef(0);

  const activeTimeline = activeThreadId ? timelines[activeThreadId] || [] : [];
  const activeThread = (activeThreadArchived ? archivedThreads : threads).find((thread) => thread.id === activeThreadId) || null;
  const activeThreadTokenUsage = activeThreadId ? threadTokenUsageById[activeThreadId] || null : null;
  const activeApproval = pendingApprovals[0] || null;
  const activeApprovalQuestions = useMemo(
    () => (activeApproval && activeApproval.method === "tool/requestUserInput" ? parseRequestUserInputQuestions(activeApproval.params) : []),
    [activeApproval],
  );
  const mobileHeaderTitle = activeThread ? getThreadTitle(activeThread) : "Assistant";

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: async () => {
      await hydrateFromBootstrap();
      setIsAuthenticated(true);
      setToast("Session unlocked");
    },
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      clearSession();
      setPendingApprovals([]);
      setIsAuthenticated(false);
      setChatgptAuthUrl(null);
      setRateLimitsSnapshot(null);
      setThreadTokenUsageById({});
      setGuardPrompt(null);
      setCommandSessions([]);
      setActiveSessionId(null);
      setWorkspaceRootInput("");
      setFileEntries([]);
      setSelectedFilePath(null);
      setSelectedFileText("");
    },
  });

  const settingsSummary = useMemo(
    () => [
      { label: "cwd", value: defaults?.cwd || "-" },
      { label: "approval", value: defaults?.approvalPolicy || "-" },
      { label: "sandbox", value: defaults?.sandboxType || "-" },
    ],
    [defaults],
  );

  const activeCommandSession = commandSessions.find((session) => session.sessionId === activeSessionId) || null;

  useEffect(() => {
    commandSessionsRef.current = commandSessions;
  }, [commandSessions]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const threadIds = Object.keys(timelines);
    if (threadIds.length === 0) return;

    const nextCache = { ...toolTimelineCacheRef.current };
    let changed = false;

    for (const threadId of threadIds) {
      const entries = timelines[threadId] || [];
      const persistable = entries.filter(isPersistableToolEntry).slice(-200);
      const previous = toolTimelineCacheRef.current[threadId] || [];
      const prevJson = JSON.stringify(previous);
      const nextJson = JSON.stringify(persistable);

      if (persistable.length === 0) {
        if (previous.length > 0) {
          delete nextCache[threadId];
          changed = true;
        }
        continue;
      }

      if (prevJson !== nextJson) {
        nextCache[threadId] = persistable;
        changed = true;
      }
    }

    if (!changed) return;
    toolTimelineCacheRef.current = nextCache;
    saveToolTimelineCache(nextCache);
  }, [isAuthenticated, timelines]);

  useEffect(() => {
    if (!activeApproval || activeApproval.method !== "tool/requestUserInput") {
      setRequestInputSelections({});
      setRequestInputOtherText({});
      return;
    }

    const questions = parseRequestUserInputQuestions(activeApproval.params);
    const nextSelections: Record<string, string> = {};
    for (const question of questions) {
      if (question.options.length > 0) {
        nextSelections[question.id] = question.options[0].label;
      }
    }
    setRequestInputSelections(nextSelections);
    setRequestInputOtherText({});
  }, [activeApproval]);

  function setToast(message: string): void {
    setToastText(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastText(null);
    }, 2300);
  }

  async function resolvePlanModeId(): Promise<string> {
    if (planModeId.trim().length > 0) {
      return planModeId;
    }

    try {
      const result = (await safeRpc("collaborationMode/list", {})) as Record<string, unknown> | null;
      const detected = detectPlanModeId(result);
      const next = detected || "plan";
      setPlanModeId(next);
      return next;
    } catch {
      return "plan";
    }
  }

  async function setPlanMode(next: boolean): Promise<void> {
    if (next) {
      const resolved = await resolvePlanModeId();
      setPlanModeId(resolved);
      setPlanModeEnabled(true);
      setToast(`Plan mode enabled (${resolved})`);
      return;
    }

    setPlanModeEnabled(false);
    setToast("Plan mode disabled");
  }

  async function safeRpc<T = unknown>(
    method: AllowedRpcMethod,
    params: Record<string, unknown> = {},
    guard?: { acceptRisk?: boolean; acceptForSession?: boolean; reauthPassword?: string },
  ): Promise<T | null> {
    try {
      return await rpc<T>(method, params, guard);
    } catch (error) {
      if (error instanceof ApiRequestError && error.guard && !guard?.acceptRisk) {
        setGuardPrompt({ method, params, guard: error.guard });
        setGuardAcceptForSession(true);
        setGuardPassword("");
        return null;
      }

      throw error;
    }
  }

  async function refreshLoadedThreads(): Promise<void> {
    try {
      const result = (await safeRpc("thread/loaded/list", {})) as Record<string, unknown> | null;
      if (!result) return;
      setLoadedThreadIds(parseLoadedThreadIds(result));
    } catch {
      // no-op
    }
  }

  function buildTimelineEntries(thread: ThreadRecord): TimelineEntry[] {
    const entries: TimelineEntry[] = [];
    const turns = Array.isArray((thread as Record<string, unknown>).turns)
      ? ((thread as Record<string, unknown>).turns as Record<string, unknown>[])
      : [];

    for (const turn of turns) {
      const items = Array.isArray(turn.items) ? (turn.items as Record<string, unknown>[]) : [];
      for (const item of items) {
        const id = typeof item.id === "string" ? item.id : `${Date.now()}-${Math.random()}`;

        if (isUserLikeItem(item)) {
          entries.push({
            key: `item:${id}`,
            role: "user",
            title: "You",
            text: extractItemText(item),
          });
          continue;
        }

        if (isAgentLikeItem(item)) {
          entries.push({
            key: `item:${id}`,
            role: "agent",
            title: "Assistant",
            text: extractItemText(item),
          });
          continue;
        }

        if (isPlanLikeItem(item)) {
          const text = resolvePlanText(item);
          entries.push({
            key: `item:${id}`,
            role: "plan",
            title: "Plan",
            text: text || planFallbackText(item, false),
            pending: false,
            meta: createToolMeta(item, {
              threadId: thread.id,
              turnId: typeof turn.id === "string" ? turn.id : null,
            }),
          });
          continue;
        }

        entries.push({
          key: `item:${id}`,
          role: "tool",
          title: formatToolTitle(item, false),
          text: summarizeToolItem(item),
          pending: false,
          meta: createToolMeta(item, {
            threadId: thread.id,
            turnId: typeof turn.id === "string" ? turn.id : null,
          }),
        });
      }
    }

    return entries;
  }

  async function hydrateFromBootstrap(options: { restoreSelection?: boolean } = {}): Promise<void> {
    const restoreSelection = options.restoreSelection ?? true;
    uiDebug("bootstrap.start", { restoreSelection });
    const payload = await bootstrap();
    setBootstrap(payload);
    setRateLimitsSnapshot(isObject(payload.data?.rateLimits) ? (payload.data?.rateLimits as Record<string, unknown>) : null);
    const detectedPlanModeId = detectPlanModeId(payload.data?.collaborationModes);
    if (detectedPlanModeId) {
      setPlanModeId(detectedPlanModeId);
    }

    if (restoreSelection) {
      const configuredTab = payload.data?.uiState?.panelLayout?.contextTab;
      if (configuredTab === "context" || configuredTab === "admin") {
        setActiveContextTab(configuredTab);
      } else if (configuredTab === "ops") {
        setActiveContextTab("context");
      }
    }

    const cwd = payload.defaults?.cwd || "";
    setWorkspaceRootInput(cwd);
    setFileRoot((prev) => prev || cwd);

    const preferredThreadId = payload.data?.uiState?.lastActiveThreadId || null;
    const initialThreads = payload.data?.threads?.data || [];

    if (restoreSelection && preferredThreadId) {
      await openThread(preferredThreadId, false);
    } else if (restoreSelection && !activeThreadId && initialThreads.length > 0) {
      await openThread(initialThreads[0].id, false);
    }

    await refreshLoadedThreads();
    uiDebug("bootstrap.done", {
      restoreSelection,
      activeThreads: payload.data?.threads?.data?.length || 0,
      archivedThreads: payload.data?.archivedThreads?.data?.length || 0,
    });
  }

  async function syncActiveThreadFromServer(): Promise<void> {
    const state = useAssistantStore.getState();
    const threadId = state.activeThreadId;
    if (!threadId) return;
    uiDebug("sync.thread.start", { threadId, activeTurnId: state.activeTurnId });

    const result = (await safeRpc("thread/read", {
      threadId,
      includeTurns: true,
    })) as Record<string, unknown> | null;
    if (!result) {
      uiDebug("sync.thread.skip", { threadId, reason: "no_result" });
      return;
    }

    const thread = isObject(result.thread) ? (result.thread as ThreadRecord) : null;
    if (!thread?.id) {
      uiDebug("sync.thread.skip", { threadId, reason: "invalid_thread" });
      return;
    }

    const serverEntries = buildTimelineEntries(thread);
    const currentTimeline = state.timelines[thread.id] || [];
    const optimisticEntries = currentTimeline.filter((entry) => entry.key.startsWith("local-user-"));
    const serverKeys = new Set(serverEntries.map((entry) => entry.key));
    const preservedItemEntries = currentTimeline.filter((entry) => {
      if (serverKeys.has(entry.key)) return false;
      if (!entry.key.startsWith("item:")) return false;

      // Always keep local tool cards, even after turn completion, because some event-only
      // items are not persisted into thread/read history by app-server.
      if (entry.role === "tool") return true;

      // Keep local in-flight item cards (plan/agent) until server history catches up.
      if (entry.pending) return true;
      if (state.activeTurnId && (entry.role === "plan" || entry.role === "agent")) return true;
      return false;
    });
    const optimisticKeysToKeep = new Set(
      optimisticEntries
        .filter((optimistic) => {
          const exists = serverEntries.some(
            (entry) => entry.role === "user" && entry.text.trim().toLowerCase() === optimistic.text.trim().toLowerCase(),
          );
          return !exists;
        })
        .map((entry) => entry.key),
    );
    const preservedKeys = new Set(preservedItemEntries.map((entry) => entry.key));
    const serverByKey = new Map(serverEntries.map((entry) => [entry.key, entry] as const));

    const mergedEntries: TimelineEntry[] = [];
    const pushedKeys = new Set<string>();
    const pushIfMissing = (entry: TimelineEntry): void => {
      if (pushedKeys.has(entry.key)) return;
      pushedKeys.add(entry.key);
      mergedEntries.push(entry);
    };

    // Keep the visible order from live timeline first, but replace entries
    // with authoritative server versions when available.
    for (const entry of currentTimeline) {
      if (optimisticKeysToKeep.has(entry.key)) {
        pushIfMissing(entry);
      }

      if (preservedKeys.has(entry.key)) {
        pushIfMissing(entry);
      }

      const serverEntry = serverByKey.get(entry.key);
      if (serverEntry) {
        pushIfMissing(serverEntry);
      }
    }

    // Append any new server entries not seen in the previous local timeline.
    for (const serverEntry of serverEntries) {
      pushIfMissing(serverEntry);
    }

    setThreadTimeline(thread.id, mergedEntries);
    upsertThread(thread, state.activeThreadArchived);

    const inProgressTurnId = extractInProgressTurnId(thread);
    if (inProgressTurnId && state.activeTurnId !== inProgressTurnId) {
      setActiveTurnId(inProgressTurnId);
    } else if (!inProgressTurnId && state.activeTurnId) {
      setActiveTurnId(null);
    }

    uiDebug("sync.thread.done", {
      threadId: thread.id,
      serverEntries: serverEntries.length,
      optimisticEntries: optimisticEntries.length,
      preservedItemEntries: preservedItemEntries.length,
      mergedEntries: mergedEntries.length,
      inProgressTurnId,
    });
  }

  async function probeSession(): Promise<void> {
    setIsCheckingSession(true);
    try {
      const authenticated = await checkSession();
      uiDebug("session.probe", { authenticated });
      if (!authenticated) {
        setIsAuthenticated(false);
        return;
      }
      await hydrateFromBootstrap();
      setIsAuthenticated(true);
    } catch {
      setIsAuthenticated(false);
    } finally {
      setIsCheckingSession(false);
    }
  }

  function closeMobilePanels(): void {
    setMobileThreadsOpen(false);
    setMobileContextOpen(false);
  }

  async function openThread(threadId: string, archived: boolean): Promise<void> {
    try {
      const result = (await safeRpc("thread/read", {
        threadId,
        includeTurns: true,
      })) as Record<string, unknown> | null;

      if (!result) return;

      const thread = isObject(result.thread) ? (result.thread as ThreadRecord) : null;
      if (!thread?.id) return;

      const entries = buildTimelineEntries(thread);
      const cached = toolTimelineCacheRef.current[thread.id] || [];
      const mergedEntries = mergeThreadEntriesWithToolCache(entries, cached);

      setActiveThread(thread.id, archived);
      setThreadTimeline(thread.id, mergedEntries);
      closeMobilePanels();
      await refreshLoadedThreads();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to open thread");
    }
  }

  async function createThread(): Promise<void> {
    try {
      const result = (await safeRpc("thread/start", {
        model: defaults?.model,
        cwd: defaults?.cwd,
        approvalPolicy: defaults?.approvalPolicy,
      })) as Record<string, unknown> | null;

      if (!result) return;

      const thread = isObject(result.thread) ? (result.thread as ThreadRecord) : null;
      if (!thread?.id) throw new Error("Failed to create thread");

      upsertThread(thread, false);
      setActiveThread(thread.id, false);
      setThreadTimeline(thread.id, []);
      setShowArchived(false);
      closeMobilePanels();
      await refreshLoadedThreads();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to create thread");
    }
  }

  async function archiveOrUnarchiveThread(): Promise<void> {
    if (!activeThreadId) return;

    try {
      if (activeThreadArchived) {
        const result = await safeRpc("thread/unarchive", { threadId: activeThreadId });
        if (!result) return;
        moveThreadToActive(activeThreadId);
        setActiveThread(activeThreadId, false);
        setShowArchived(false);
      } else {
        const result = await safeRpc("thread/archive", { threadId: activeThreadId });
        if (!result) return;
        moveThreadToArchive(activeThreadId);
        setActiveThread(activeThreadId, true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Archive operation failed");
    }
  }

  async function renameThread(): Promise<void> {
    if (!activeThreadId) return;
    const name = window.prompt("Thread name", activeThread?.name || "")?.trim();
    if (!name) return;

    try {
      const result = (await safeRpc("thread/name/set", {
        threadId: activeThreadId,
        name,
      })) as Record<string, unknown> | null;

      if (!result) return;
      if (isObject(result.thread)) {
        upsertThread(result.thread as ThreadRecord, activeThreadArchived);
      } else if (activeThread) {
        upsertThread({ ...activeThread, name }, activeThreadArchived);
      }
      setToast("Thread renamed");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Rename failed");
    }
  }

  async function forkThread(): Promise<void> {
    if (!activeThreadId) return;
    try {
      const result = (await safeRpc("thread/fork", {
        threadId: activeThreadId,
      })) as Record<string, unknown> | null;
      if (!result) return;

      const thread = isObject(result.thread) ? (result.thread as ThreadRecord) : null;
      if (!thread?.id) throw new Error("Fork did not return a thread");

      upsertThread(thread, false);
      setShowArchived(false);
      await openThread(thread.id, false);
      setToast("Thread forked");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Fork failed");
    }
  }

  async function compactThread(): Promise<void> {
    if (!activeThreadId) return;
    try {
      const result = await safeRpc("thread/compact/start", { threadId: activeThreadId });
      if (!result) return;
      setToast("Compaction started");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Compaction failed");
    }
  }

  async function rollbackThread(): Promise<void> {
    if (!activeThreadId) return;
    const raw = window.prompt("Drop last N turns", "1")?.trim();
    if (!raw) return;
    const count = Number(raw);
    if (!Number.isInteger(count) || count <= 0) {
      setToast("Rollback count must be a positive integer");
      return;
    }

    try {
      const result = await safeRpc("thread/rollback", { threadId: activeThreadId, count });
      if (!result) return;
      await openThread(activeThreadId, activeThreadArchived);
      setToast("Rollback applied");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Rollback failed");
    }
  }

  async function unsubscribeThread(): Promise<void> {
    if (!activeThreadId) return;
    try {
      const result = await safeRpc("thread/unsubscribe", { threadId: activeThreadId });
      if (!result) return;
      await refreshLoadedThreads();
      setToast("Thread unsubscribed from live updates");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Unsubscribe failed");
    }
  }

  async function interruptTurn(): Promise<void> {
    if (!activeThreadId) return;
    try {
      let turnId = activeTurnId;
      if (!turnId) {
        const readResult = (await safeRpc("thread/read", {
          threadId: activeThreadId,
          includeTurns: true,
        })) as Record<string, unknown> | null;
        const thread = readResult && isObject(readResult.thread) ? (readResult.thread as ThreadRecord) : null;
        if (thread) {
          turnId = extractInProgressTurnId(thread);
        }
      }

      const result = await safeRpc("turn/interrupt", {
        threadId: activeThreadId,
        ...(turnId ? { turnId } : {}),
      });
      if (!result) return;
      setToast("Interrupt requested");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Interrupt failed");
    }
  }

  async function sendMessage(inputText: string): Promise<void> {
    const text = inputText.trim();
    if (!text) return;

    if (activeThreadArchived) {
      setToast("This thread is archived. Unarchive it before sending a message.");
      return;
    }

    let threadId = activeThreadId;

    if (!threadId) {
      await createThread();
      threadId = useAssistantStore.getState().activeThreadId;
      if (!threadId) return;
    }

    appendTimelineEntry(threadId, {
      key: `local-user-${Date.now()}`,
      role: "user",
      title: "You",
      text,
    });
    uiDebug("message.send.optimistic", { threadId, textLength: text.length });

    try {
      const selectedPlanMode = planModeEnabled ? await resolvePlanModeId() : null;
      const planModel = defaults?.model || "gpt-5.4";
      const collaborationModePayload =
        selectedPlanMode ? buildPlanCollaborationMode(selectedPlanMode, planModel) : null;
      const queueResult = await enqueueThreadMessage({
        threadId,
        text,
        ...(collaborationModePayload ? { collaborationMode: collaborationModePayload } : {}),
      });
      uiDebug("message.send.enqueued", {
        threadId,
        queueItemId: queueResult.queueItemId,
        collaborationMode: collaborationModePayload,
      });
      // Non-blocking refresh keeps timeline state aligned when queue starts processing.
      void syncActiveThreadFromServer();
    } catch (error) {
      uiDebug("message.send.error", {
        threadId,
        message: error instanceof Error ? error.message : "unknown",
      });
      setToast(error instanceof Error ? error.message : "Failed to send message");
    }
  }

  async function showStatusSummaryInTimeline(): Promise<void> {
    if (activeThreadArchived) {
      setToast("This thread is archived. Unarchive it before running /status.");
      return;
    }

    let threadId = activeThreadId;
    if (!threadId) {
      await createThread();
      threadId = useAssistantStore.getState().activeThreadId;
      if (!threadId) return;
    }

    const latestRateLimits = (await refreshRateLimits(false)) || rateLimitsSnapshot;
    const tokenUsage = threadTokenUsageById[threadId] || null;
    const text = buildStatusMarkdown({
      threadId,
      activeTurnId,
      bridgeState,
      rateLimits: latestRateLimits,
      tokenUsage,
    });

    appendTimelineEntry(threadId, {
      key: `item:local-status-${Date.now()}`,
      role: "tool",
      title: "Status",
      text,
      pending: false,
      meta: {
        type: "statusSummary",
        threadId,
        turnId: activeTurnId || null,
      },
    });
  }

  async function refreshAccount(): Promise<void> {
    try {
      const result = (await safeRpc("account/read", { refreshToken: false })) as Record<string, unknown> | null;
      if (!result) return;
      setAccount(result.account || null);
    } catch {
      setAccount(null);
    }
  }

  async function refreshRateLimits(showErrorToast = false): Promise<Record<string, unknown> | null> {
    try {
      const result = (await safeRpc("account/rateLimits/read", {})) as Record<string, unknown> | null;
      if (!result) return null;
      setRateLimitsSnapshot(result);
      return result;
    } catch (error) {
      if (showErrorToast) {
        setToast(error instanceof Error ? error.message : "Failed to refresh rate limits");
      }
      return null;
    }
  }

  async function applyWorkspacePath(inputPath?: string): Promise<void> {
    const requested = (inputPath ?? workspaceRootInput).trim();
    if (!requested) {
      setToast("Workspace path is required");
      return;
    }

    setIsUpdatingWorkspaceRoot(true);
    try {
      const root = await setWorkspaceRoot(requested);
      setWorkspaceRootInput(root);
      setFileRoot(root);
      await hydrateFromBootstrap({ restoreSelection: false });
      setToast("Workspace updated");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to update workspace");
    } finally {
      setIsUpdatingWorkspaceRoot(false);
    }
  }

  async function refreshMcpServers(): Promise<void> {
    try {
      const result = (await safeRpc("mcpServerStatus/list", {
        cursor: null,
        limit: 100,
        detail: "toolsAndAuthOnly",
      })) as Record<string, unknown> | null;
      if (!result) return;
      setMcpServers(parseMcpServers(result));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to refresh MCP servers");
    }
  }

  async function startChatGptLogin(): Promise<void> {
    try {
      const result = (await safeRpc("account/login/start", {
        type: "chatgpt",
      })) as Record<string, unknown> | null;

      if (!result) return;
      const authUrl = typeof result.authUrl === "string" ? result.authUrl : null;
      if (!authUrl) throw new Error("No auth URL returned by server");
      setChatgptAuthUrl(authUrl);
      setToast("Open login URL on your PC browser to complete ChatGPT login");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Unable to start ChatGPT login");
    }
  }

  async function reloadMcpConfig(): Promise<void> {
    try {
      const result = await safeRpc("config/mcpServer/reload", {});
      if (!result) return;
      await refreshMcpServers();
      setToast("MCP config reloaded");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "MCP reload failed");
    }
  }

  async function runMcpOauth(serverName: string): Promise<void> {
    try {
      const result = (await safeRpc("mcpServer/oauth/login", {
        name: serverName,
      })) as Record<string, unknown> | null;

      if (!result) return;

      const url =
        typeof result.authorizationUrl === "string"
          ? result.authorizationUrl
          : typeof result.authUrl === "string"
            ? result.authUrl
            : typeof result.url === "string"
              ? result.url
              : null;

      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      }

      setToast(`OAuth login requested for ${serverName}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "OAuth login failed");
    }
  }

  async function handleApprovalDecision(decision: "accept" | "acceptForSession" | "decline" | "cancel"): Promise<void> {
    if (!activeApproval) return;

    const result = activeApproval.method === "tool/requestUserInput" ? { decision } : decision;

    try {
      await respondToServerRequest({
        requestId: activeApproval.id,
        result,
      });
      setPendingApprovals((prev) => prev.filter((item) => item.id !== activeApproval.id));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to submit decision");
    }
  }

  async function handleRequestUserInputSubmit(): Promise<void> {
    if (!activeApproval || activeApproval.method !== "tool/requestUserInput") return;
    const questions = parseRequestUserInputQuestions(activeApproval.params);
    if (questions.length === 0) return;

    const answers = questions.map((question) => {
      const selectedLabel = requestInputSelections[question.id] || "";
      const selectedOption = question.options.find((option) => option.label === selectedLabel) || null;
      const otherText = requestInputOtherText[question.id] || "";
      return {
        id: question.id,
        value: selectedOption
          ? {
              label: selectedOption.label,
              ...(selectedOption.isOther ? { isOther: true, text: otherText } : {}),
            }
          : {
              label: selectedLabel,
            },
      };
    });

    setIsSubmittingRequestInput(true);
    try {
      await respondToServerRequest({
        requestId: activeApproval.id,
        result: {
          answers,
        },
      });
      setPendingApprovals((prev) => prev.filter((item) => item.id !== activeApproval.id));
      setRequestInputSelections({});
      setRequestInputOtherText({});
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to submit answers");
    } finally {
      setIsSubmittingRequestInput(false);
    }
  }

  async function confirmGuardedRpc(): Promise<void> {
    if (!guardPrompt) return;

    setIsSubmittingGuard(true);
    try {
      const result = await safeRpc(guardPrompt.method, guardPrompt.params, {
        acceptRisk: true,
        acceptForSession: guardAcceptForSession,
        ...(guardPrompt.guard.requiresReauthPassword ? { reauthPassword: guardPassword } : {}),
      });

      if (result === null) return;

      setToast("Action approved and executed");
      setGuardPrompt(null);
      setGuardPassword("");
      setGuardAcceptForSession(true);
      await refreshLoadedThreads();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to execute guarded action");
    } finally {
      setIsSubmittingGuard(false);
    }
  }

  function dedupeOptimisticUserMessage(threadId: string, itemId: string, text: string): boolean {
    const currentTimeline = useAssistantStore.getState().timelines[threadId] || [];
    let idx = -1;
    for (let i = currentTimeline.length - 1; i >= 0; i -= 1) {
      const entry = currentTimeline[i];
      if (entry.role === "user" && entry.key.startsWith("local-user-") && entry.text.trim() === text.trim()) {
        idx = i;
        break;
      }
    }

    if (idx === -1) return false;

    const next = [...currentTimeline];
    next[idx] = {
      ...next[idx],
      key: `item:${itemId}`,
      title: "You",
      text,
    };
    setThreadTimeline(threadId, next);
    return true;
  }

  function upsertCommandSession(partial: Partial<CommandSession> & { sessionId: string; title?: string }): void {
    setCommandSessions((prev) => {
      const idx = prev.findIndex((entry) => entry.sessionId === partial.sessionId);
      if (idx === -1) {
        return [
          {
            sessionId: partial.sessionId,
            title: partial.title || partial.sessionId,
            output: partial.output || "",
            running: partial.running ?? true,
          },
          ...prev,
        ];
      }

      const next = [...prev];
      next[idx] = {
        ...next[idx],
        ...partial,
        output: partial.output !== undefined ? partial.output : next[idx].output,
      };
      return next;
    });
  }

  function handleNotification(method: string, params: Record<string, unknown>): void {
    const currentState = useAssistantStore.getState();
    const threadId = (params.threadId as string | undefined) || currentState.activeThreadId || null;
    if (
      method.startsWith("turn/") ||
      method.startsWith("item/") ||
      method === "thread/status/changed" ||
      method === "thread/tokenUsage/updated" ||
      method === "account/rateLimits/updated" ||
      method === "serverRequest/resolved"
    ) {
      uiDebug("sse.notification", {
        method,
        threadId: params.threadId ?? threadId ?? null,
        turnId: params.turnId ?? null,
        itemId: params.itemId ?? null,
      });
    }

    if (method === "thread/started" && isObject(params.thread) && typeof params.thread.id === "string") {
      upsertThread(params.thread as ThreadRecord, false);
      void refreshLoadedThreads();
      return;
    }

    if (method === "thread/name/updated") {
      if (isObject(params.thread) && typeof params.thread.id === "string") {
        upsertThread(params.thread as ThreadRecord, false);
        upsertThread(params.thread as ThreadRecord, true);
      }
      return;
    }

    if (method === "thread/status/changed") {
      if (typeof params.threadId === "string") {
        const status = isObject(params.status) ? params.status : { type: String(params.status || "unknown") };
        upsertThread({ id: params.threadId, status } as ThreadRecord, false);
        upsertThread({ id: params.threadId, status } as ThreadRecord, true);
      }
      return;
    }

    if (method === "thread/archived" && typeof params.threadId === "string") {
      moveThreadToArchive(params.threadId);
      if (currentState.activeThreadId === params.threadId) {
        setActiveThread(params.threadId, true);
      }
      void refreshLoadedThreads();
      return;
    }

    if (method === "thread/unarchived" && typeof params.threadId === "string") {
      moveThreadToActive(params.threadId);
      if (currentState.activeThreadId === params.threadId) {
        setActiveThread(params.threadId, false);
      }
      void refreshLoadedThreads();
      return;
    }

    if (method === "thread/closed" && typeof params.threadId === "string") {
      setLoadedThreadIds(currentState.loadedThreadIds.filter((id) => id !== params.threadId));
      return;
    }

    if (method === "turn/started" && isObject(params.turn) && typeof params.turn.id === "string") {
      setActiveTurnId(params.turn.id);
      return;
    }

    if (method === "turn/completed") {
      setActiveTurnId(null);
      if (threadId) {
        const timeline = useAssistantStore.getState().timelines[threadId] || [];
        if (timeline.some((entry) => entry.pending)) {
          setThreadTimeline(
            threadId,
            timeline.map((entry) => ({
              ...entry,
              pending: false,
            })),
          );
        }
      }
      return;
    }

    if (method === "item/started" && isObject(params.item) && threadId) {
      const item = params.item as Record<string, unknown>;
      const itemId = typeof item.id === "string" ? item.id : `${Date.now()}-${Math.random()}`;

      if (isUserLikeItem(item)) {
        const text = extractItemText(item);
        if (dedupeOptimisticUserMessage(threadId, itemId, text)) {
          return;
        }

        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "user",
          title: "You",
          text: text || existing?.text || "",
        }));
        return;
      }

      if (isPlanLikeItem(item)) {
        const text = resolvePlanText(item);
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "plan",
          title: normalizeItemTypeLower(item) === "reasoning" ? "Reasoning" : "Plan",
          text: text || existing?.text || planFallbackText(item, true),
          pending: true,
          meta: createToolMeta(item, {
            threadId: typeof params.threadId === "string" ? params.threadId : threadId,
            turnId: typeof params.turnId === "string" ? params.turnId : null,
          }),
        }));
        return;
      }

      if (isAgentLikeItem(item)) {
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "agent",
          title: "Assistant",
          text: extractItemText(item) || existing?.text || "",
        }));
        return;
      }

      upsertTimelineEntry(threadId, `item:${itemId}`, () => ({
        key: `item:${itemId}`,
        role: "tool",
        title: formatToolTitle(item, true),
        text: summarizeToolItem(item),
        pending: true,
        meta: createToolMeta(item, {
          threadId: typeof params.threadId === "string" ? params.threadId : threadId,
          turnId: typeof params.turnId === "string" ? params.turnId : null,
        }),
      }));
      return;
    }

    if (method === "item/completed" && isObject(params.item) && threadId) {
      const item = params.item as Record<string, unknown>;
      const itemId = typeof item.id === "string" ? item.id : `${Date.now()}-${Math.random()}`;

      if (isUserLikeItem(item)) {
        const text = extractItemText(item);
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "user",
          title: "You",
          text: text || existing?.text || "",
        }));
        return;
      }

      if (isPlanLikeItem(item)) {
        const text = resolvePlanText(item);
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "plan",
          title: normalizeItemTypeLower(item) === "reasoning" ? "Reasoning" : "Plan",
          text: text || existing?.text || planFallbackText(item, false),
          pending: false,
          meta: createToolMeta(item, {
            threadId: typeof params.threadId === "string" ? params.threadId : threadId,
            turnId: typeof params.turnId === "string" ? params.turnId : null,
          }),
        }));
        return;
      }

      if (isAgentLikeItem(item)) {
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "agent",
          title: "Assistant",
          text: extractItemText(item) || existing?.text || "",
        }));
        return;
      }

      upsertTimelineEntry(threadId, `item:${itemId}`, () => ({
        key: `item:${itemId}`,
        role: "tool",
        title: formatToolTitle(item, false),
        text: summarizeToolItem(item),
        pending: false,
        meta: createToolMeta(item, {
          threadId: typeof params.threadId === "string" ? params.threadId : threadId,
          turnId: typeof params.turnId === "string" ? params.turnId : null,
        }),
      }));
      return;
    }

    if (method === "item/agentMessage/delta" && threadId) {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      if (!itemId) return;

      const delta = typeof params.delta === "string" ? params.delta : "";
      upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
        key: `item:${itemId}`,
        role: "agent",
        title: "Assistant",
        text: `${existing?.text || ""}${delta}`,
      }));
      return;
    }

    if ((method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") && threadId) {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      if (!itemId) return;
      const delta =
        typeof params.delta === "string"
          ? params.delta
          : typeof params.outputDelta === "string"
            ? params.outputDelta
            : "";

      if (!delta) return;

      upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
        key: `item:${itemId}`,
        role: "tool",
        title: existing?.title || "Command",
        text: `${existing?.text || ""}${delta}`,
        pending: true,
        meta: existing?.meta,
      }));
      return;
    }

    if (method.startsWith("command/exec")) {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : typeof params.id === "string" ? params.id : null;
      if (!sessionId) return;

      const output =
        typeof params.output === "string"
          ? params.output
          : typeof params.delta === "string"
            ? params.delta
            : typeof params.stdout === "string"
              ? params.stdout
              : "";

      upsertCommandSession({
        sessionId,
        ...(output
          ? {
              output: `${commandSessionsRef.current.find((entry) => entry.sessionId === sessionId)?.output || ""}${output}`,
            }
          : {}),
        ...(typeof params.running === "boolean" ? { running: params.running } : {}),
      });
      return;
    }

    if (method === "account/login/completed") {
      if (params.success === true) {
        void refreshAccount();
        void refreshRateLimits(false);
        setToast("ChatGPT login completed");
      } else {
        setToast(typeof params.error === "string" ? params.error : "Login failed");
      }
      return;
    }

    if (method === "account/updated") {
      void refreshAccount();
      void refreshRateLimits(false);
      return;
    }

    if (method === "account/rateLimits/updated") {
      setRateLimitsSnapshot({ ...params });
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const targetThreadId = typeof params.threadId === "string" ? params.threadId : threadId;
      if (targetThreadId) {
        setThreadTokenUsageById((prev) => ({
          ...prev,
          [targetThreadId]: { ...params },
        }));
      }
      return;
    }

    if (method === "mcpServer/oauthLogin/completed") {
      void refreshMcpServers();
      const name = typeof params.name === "string" ? params.name : "server";
      setToast(`MCP OAuth update: ${name}`);
      return;
    }

    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (requestId !== undefined && requestId !== null) {
        setPendingApprovals((prev) => prev.filter((item) => item.id !== (requestId as string | number)));
      }
    }
  }

  function connectEvents(): void {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const token = getSessionToken();
    const url = token ? `/api/events?sessionToken=${encodeURIComponent(token)}` : "/api/events";
    uiDebug("sse.connecting", { url, hasToken: Boolean(token) });
    const source = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = source;

    source.onopen = () => {
      uiDebug("sse.open", { readyState: source.readyState });
    };

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as SseEvent;

        if (payload.kind === "notification") {
          handleNotification(payload.method, payload.params);
          return;
        }

        if (payload.kind === "serverRequest") {
          uiDebug("sse.server_request", { id: payload.id, method: payload.method });
          setPendingApprovals((prev) => [
            ...prev,
            {
              id: payload.id,
              method: payload.method,
              params: payload.params,
            },
          ]);
          return;
        }
      } catch {
        // no-op
      }
    };

    source.onerror = () => {
      uiDebug("sse.error", { readyState: source.readyState });
      const now = Date.now();
      if (now - lastSseToastAtRef.current > 10_000) {
        lastSseToastAtRef.current = now;
        setToast("Live stream interrupted, reconnecting...");
      }
    };
  }

  async function runCommandExec(): Promise<void> {
    const command = commandInput.trim();
    if (!command) return;

    try {
      const result = (await safeRpc("command/exec", {
        command,
        cwd: defaults?.cwd,
        tty: false,
      })) as Record<string, unknown> | null;

      if (!result) return;

      const sessionId =
        typeof result.sessionId === "string"
          ? result.sessionId
          : typeof result.id === "string"
            ? result.id
            : `cmd-${Date.now()}`;

      const output =
        typeof result.output === "string"
          ? result.output
          : typeof result.stdout === "string"
            ? result.stdout
            : safeJsonStringify(result);

      upsertCommandSession({
        sessionId,
        title: command,
        output,
        running: Boolean(result.running ?? false),
      });
      setActiveSessionId(sessionId);
      setCommandInput("");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Command failed");
    }
  }

  async function commandWrite(closeStdin = false): Promise<void> {
    if (!activeSessionId) return;
    try {
      const result = (await safeRpc("command/exec/write", {
        sessionId: activeSessionId,
        chars: closeStdin ? undefined : stdinInput,
        closeStdin,
      })) as Record<string, unknown> | null;

      if (!result) return;

      const output =
        typeof result.output === "string"
          ? result.output
          : typeof result.stdout === "string"
            ? result.stdout
            : "";

      if (output) {
        const existing = commandSessions.find((entry) => entry.sessionId === activeSessionId);
        upsertCommandSession({
          sessionId: activeSessionId,
          output: `${existing?.output || ""}${output}`,
          running: Boolean(result.running ?? existing?.running ?? true),
        });
      }

      if (!closeStdin) setStdinInput("");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to write stdin");
    }
  }

  async function terminateCommand(): Promise<void> {
    if (!activeSessionId) return;
    try {
      const result = await safeRpc("command/exec/terminate", { sessionId: activeSessionId });
      if (!result) return;
      upsertCommandSession({ sessionId: activeSessionId, running: false });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Terminate failed");
    }
  }

  async function browseDirectory(pathInput: string): Promise<void> {
    const target = pathInput.trim();
    if (!target) return;

    try {
      const result = (await safeRpc("fs/readDirectory", { path: target })) as Record<string, unknown> | null;
      if (!result) return;

      const rows = Array.isArray(result.entries)
        ? result.entries
        : Array.isArray(result.items)
          ? result.items
          : Array.isArray(result.data)
            ? result.data
            : [];

      const parsed = rows
        .map((entry) => {
          if (!isObject(entry)) return null;

          const fullPath =
            typeof entry.path === "string"
              ? entry.path
              : typeof entry.fullPath === "string"
                ? entry.fullPath
                : null;
          if (!fullPath) return null;

          const name = typeof entry.name === "string" ? entry.name : fullPath.split("/").slice(-1)[0] || fullPath;
          const isDirectory = Boolean(entry.isDirectory ?? entry.directory ?? entry.type === "directory");

          return {
            name,
            path: fullPath,
            isDirectory,
          } satisfies FileEntry;
        })
        .filter((entry): entry is FileEntry => Boolean(entry));

      setFileRoot(target);
      setFileEntries(parsed);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to read directory");
    }
  }

  async function readFile(filePath: string): Promise<void> {
    try {
      const result = (await safeRpc("fs/readFile", { path: filePath })) as Record<string, unknown> | null;
      if (!result) return;

      const content =
        typeof result.content === "string"
          ? result.content
          : typeof result.text === "string"
            ? result.text
            : "";

      setSelectedFilePath(filePath);
      setSelectedFileText(content);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to read file");
    }
  }

  async function saveFile(): Promise<void> {
    if (!selectedFilePath) return;
    try {
      const result = await safeRpc("fs/writeFile", {
        path: selectedFilePath,
        content: selectedFileText,
      });
      if (!result) return;
      setToast("File saved");
      await browseDirectory(fileRoot);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to write file");
    }
  }

  async function removePath(targetPath: string): Promise<void> {
    if (!window.confirm(`Remove ${targetPath}?`)) return;

    try {
      const result = await safeRpc("fs/remove", {
        path: targetPath,
      });
      if (!result) return;
      if (selectedFilePath === targetPath) {
        setSelectedFilePath(null);
        setSelectedFileText("");
      }
      await browseDirectory(fileRoot);
      setToast("Removed");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Remove failed");
    }
  }

  async function loadPlugins(): Promise<void> {
    try {
      const result = (await safeRpc("plugin/list", { limit: 100 })) as Record<string, unknown> | null;
      if (!result) return;
      const rows = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
      setPluginRows(rows);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to load plugins");
    }
  }

  async function loadConfig(): Promise<void> {
    try {
      const result = (await safeRpc("config/read", {})) as Record<string, unknown> | null;
      if (!result) return;
      setConfigText(safeJsonStringify(result));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to read config");
    }
  }

  async function executeAdminRpc(): Promise<void> {
    try {
      const parsed = JSON.parse(adminParamsText || "{}");
      if (!isObject(parsed)) {
        setToast("Admin params must be a JSON object");
        return;
      }

      const result = await safeRpc(adminMethod, parsed as Record<string, unknown>);
      if (!result) return;

      setAdminResultText(safeJsonStringify(result));
    } catch (error) {
      if (error instanceof SyntaxError) {
        setToast("Invalid JSON in admin params");
      } else {
        setToast(error instanceof Error ? error.message : "Admin RPC failed");
      }
    }
  }

  function methodEnabled(method: AllowedRpcMethod): boolean {
    const methods = capabilities?.methods || [];
    const row = methods.find((entry) => entry.method === method);
    return Boolean(row?.enabled);
  }

  function methodGroupAllowed(group: MethodGroup): boolean {
    return Boolean(capabilities?.groups?.[group]);
  }

  useEffect(() => {
    void probeSession();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      connectEvents();
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;

    const runBackgroundSync = async (): Promise<void> => {
      if (cancelled || syncInFlightRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;

      syncInFlightRef.current = true;
      try {
        const state = useAssistantStore.getState();

        // Always sync active thread so we still get updates even when SSE drops.
        if (state.activeThreadId) {
          await syncActiveThreadFromServer();
        }

        await refreshLoadedThreads();

        const now = Date.now();
        if (!state.activeTurnId && now - lastBootstrapSyncRef.current > 30_000) {
          await hydrateFromBootstrap({ restoreSelection: false });
          lastBootstrapSyncRef.current = now;
        }
      } catch {
        // best-effort polling fallback
      } finally {
        syncInFlightRef.current = false;
      }
    };

    const scheduleNext = (): void => {
      if (cancelled) return;
      const state = useAssistantStore.getState();
      const delayMs = state.activeTurnId ? 1500 : 4000;
      syncTimerRef.current = window.setTimeout(() => {
        void (async () => {
          await runBackgroundSync();
          scheduleNext();
        })();
      }, delayMs);
    };

    // Kick off quickly after authentication and then continue in background.
    syncTimerRef.current = window.setTimeout(() => {
      void (async () => {
        await runBackgroundSync();
        scheduleNext();
      })();
    }, 1200);

    return () => {
      cancelled = true;
      if (syncTimerRef.current) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !activeThreadId || !activeTurnId) return;

    let cancelled = false;
    let timer: number | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        await syncActiveThreadFromServer();
      } catch (error) {
        uiDebug("active-turn.sync.error", {
          threadId: activeThreadId,
          turnId: activeTurnId,
          message: error instanceof Error ? error.message : "unknown",
        });
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void tick();
          }, 1200);
        }
      }
    };

    timer = window.setTimeout(() => {
      void tick();
    }, 700);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [isAuthenticated, activeThreadId, activeTurnId]);

  useEffect(() => {
    timelineBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeTimeline.length]);

  useEffect(() => {
    if (!isAuthenticated || !uiState) return;

    if (skipNextUiSyncRef.current) {
      skipNextUiSyncRef.current = false;
      return;
    }

    void patchUiState(uiState).catch(() => {
      // non-blocking
    });
  }, [isAuthenticated, uiState]);

  useEffect(() => {
    if (!isAuthenticated) return;

    setUiState({
      ...(uiState || {
        lastActiveThreadId: null,
        pinnedThreadIds: [],
        panelLayout: { contextTab: "context" },
        filters: { showArchived: false },
        composer: { draftByThread: {} },
      }),
      panelLayout: {
        ...(uiState?.panelLayout || { contextTab: "context" }),
        contextTab: activeContextTab,
      },
    });
  }, [activeContextTab]);

  return (
    <div className="h-[100dvh] w-full overflow-hidden">
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
          <ThreadsPanel
            threads={threads}
            archivedThreads={archivedThreads}
            showArchived={showArchived}
            activeThreadId={activeThreadId}
            loadedThreadIds={loadedThreadIds}
            pinnedThreadIds={uiState?.pinnedThreadIds || []}
            onTogglePin={(threadId, isPinned) => {
              if (isPinned) {
                unpinThread(threadId);
              } else {
                pinThread(threadId);
              }
            }}
            onToggleArchived={setShowArchived}
            onCreateThread={() => void createThread()}
            onOpenThread={(threadId) => void openThread(threadId, showArchived)}
          />
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="hidden items-start justify-between gap-3 lg:flex">
            <div className="min-w-0">
              <CardTitle className="truncate text-base" title={activeThread ? getThreadTitle(activeThread) : "No active chat"}>
                {activeThread ? getThreadTitle(activeThread) : "No active chat"}
              </CardTitle>
              <p className="mt-1 font-mono text-[11px] text-foreground/70">
                {activeThread ? `Thread: ${activeThread.id}` : "Create or select a chat to start"}
              </p>
              {activeThread ? (
                <div className="mt-1 flex items-center gap-2">
                  <Badge>{statusLabel(activeThread.status)}</Badge>
                  {loadedThreadIds.includes(activeThread.id) ? <Badge>loaded</Badge> : <Badge>not-loaded</Badge>}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" disabled={!activeThreadId} onClick={() => void archiveOrUnarchiveThread()}>
                <Archive className="mr-1.5 h-4 w-4" /> {activeThreadArchived ? "Unarchive" : "Archive"}
              </Button>
              <Button variant="ghost" size="sm" disabled={!activeThreadId} onClick={() => void renameThread()}>
                <UserRoundPen className="mr-1.5 h-4 w-4" /> Rename
              </Button>
            </div>
          </CardHeader>

          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-0">
            <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-auto px-3 pb-2 pt-3">
              {!activeTimeline.length ? (
                <div className="rounded-2xl border border-dashed border-card-border bg-muted px-4 py-3 text-sm text-foreground/75">No messages yet.</div>
              ) : null}

              {activeTimeline.map((entry) => (
                <article
                  key={entry.key}
                  className={cn(
                    "animate-fade-up rounded-2xl border px-3 py-2 shadow-card",
                    entry.role === "user" && "ml-auto max-w-[90%] border-transparent bg-gradient-to-br from-brand to-brand-dark text-white",
                    entry.role === "agent" && "mr-auto max-w-[90%] border-card-border bg-white",
                    entry.role === "plan" && "mr-auto max-w-full border-brand/35 bg-brand-soft/45",
                    entry.role === "tool" && "max-w-full border-dashed border-card-border bg-muted font-mono text-xs",
                  )}
                >
                  {entry.title ? <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-foreground/70">{entry.title}</div> : null}
                  {entry.role === "tool" ? (
                    <ToolMessage entry={entry} />
                  ) : entry.role === "plan" ? (
                    <div className="break-words text-sm leading-relaxed">
                      {entry.pending ? (
                        <>
                          {entry.text ? <MarkdownMessage text={entry.text} /> : null}
                          <div className="mt-1">
                            <ThinkingDots label={entry.title || "Thinking"} />
                          </div>
                        </>
                      ) : (
                        <MarkdownMessage text={entry.text} />
                      )}
                    </div>
                  ) : (
                    <div className="break-words text-sm leading-relaxed">
                      <MarkdownMessage text={entry.text} />
                    </div>
                  )}
                </article>
              ))}

              {activeTurnId && !activeTimeline.some((entry) => entry.pending) ? (
                <article className="mr-auto max-w-full animate-fade-up rounded-2xl border border-brand/35 bg-brand-soft/45 px-3 py-2 shadow-card">
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-foreground/70">Reasoning</div>
                  <ThinkingDots label="Thinking" />
                </article>
              ) : null}

              <div ref={timelineBottomRef} />
            </div>

            <ChatComposer
              onSend={sendMessage}
              onShowStatus={showStatusSummaryInTimeline}
              statusAvailable={Boolean(capabilities?.methods?.some((entry) => entry.method === "account/rateLimits/read" && entry.enabled))}
              planModeEnabled={planModeEnabled}
              planModeId={planModeId}
              onSetPlanMode={(next) => void setPlanMode(next)}
            />
          </CardContent>
        </Card>

        <Card className="hidden min-h-0 flex-col overflow-auto lg:flex">
          <RightPanel
            tab={activeContextTab}
            onTabChange={setActiveContextTab}
            account={account}
            rateLimitsSnapshot={rateLimitsSnapshot}
            activeThreadTokenUsage={activeThreadTokenUsage}
            workspaceRootInput={workspaceRootInput}
            isUpdatingWorkspaceRoot={isUpdatingWorkspaceRoot}
            settings={settingsSummary}
            mcpServers={mcpServers}
            chatgptAuthUrl={chatgptAuthUrl}
            activeThreadId={activeThreadId}
            activeThreadArchived={activeThreadArchived}
            activeTurnId={activeTurnId}
            capabilities={capabilities}
            commandInput={commandInput}
            onCommandInputChange={setCommandInput}
            commandSessions={commandSessions}
            activeSessionId={activeSessionId}
            stdinInput={stdinInput}
            onStdinInputChange={setStdinInput}
            onSelectCommandSession={setActiveSessionId}
            onCommandRun={() => void runCommandExec()}
            onCommandWrite={() => void commandWrite(false)}
            onCommandCloseStdin={() => void commandWrite(true)}
            onCommandTerminate={() => void terminateCommand()}
            fileRoot={fileRoot}
            fileEntries={fileEntries}
            selectedFilePath={selectedFilePath}
            selectedFileText={selectedFileText}
            onFileRootChange={setFileRoot}
            onBrowseDirectory={(target) => void browseDirectory(target)}
            onOpenFile={(filePath) => void readFile(filePath)}
            onSelectedFileTextChange={setSelectedFileText}
            onSaveFile={() => void saveFile()}
            onRemovePath={(targetPath) => void removePath(targetPath)}
            pluginRows={pluginRows}
            configText={configText}
            onLoadPlugins={() => void loadPlugins()}
            onLoadConfig={() => void loadConfig()}
            adminMethod={adminMethod}
            adminParamsText={adminParamsText}
            adminResultText={adminResultText}
            onAdminMethodChange={setAdminMethod}
            onAdminParamsTextChange={setAdminParamsText}
            onAdminRun={() => void executeAdminRpc()}
            onLogin={() => void startChatGptLogin()}
            onLogout={() => logoutMutation.mutate()}
            onWorkspaceRootInputChange={setWorkspaceRootInput}
            onWorkspaceApply={() => void applyWorkspacePath()}
            onUseFileRootAsWorkspace={() => void applyWorkspacePath(fileRoot)}
            onRefreshStatus={() => void refreshRateLimits(true)}
            onReloadMcp={() => void reloadMcpConfig()}
            onMcpOauth={(name) => void runMcpOauth(name)}
            onArchiveToggle={() => void archiveOrUnarchiveThread()}
            onInterrupt={() => void interruptTurn()}
          />
        </Card>
      </div>

      <Dialog.Root open={mobileThreadsOpen} onOpenChange={setMobileThreadsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-30 bg-black/45 backdrop-blur-[1px]" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-40 w-[min(360px,95vw)] border-r border-card-border bg-background p-3 outline-none">
            <Dialog.Title className="sr-only">Chats Drawer</Dialog.Title>
            <Dialog.Description className="sr-only">Thread list and chat selection panel for mobile.</Dialog.Description>
            <Card className="flex h-full min-h-0 flex-col overflow-hidden animate-slide-in">
              <ThreadsPanel
                threads={threads}
                archivedThreads={archivedThreads}
                showArchived={showArchived}
                activeThreadId={activeThreadId}
                loadedThreadIds={loadedThreadIds}
                pinnedThreadIds={uiState?.pinnedThreadIds || []}
                onTogglePin={(threadId, isPinned) => {
                  if (isPinned) {
                    unpinThread(threadId);
                  } else {
                    pinThread(threadId);
                  }
                }}
                onToggleArchived={setShowArchived}
                onCreateThread={() => void createThread()}
                onOpenThread={(threadId) => {
                  void openThread(threadId, showArchived);
                  setMobileThreadsOpen(false);
                }}
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
            <Dialog.Description className="sr-only">Context, ops, and admin controls for mobile.</Dialog.Description>
            <Card className="flex h-full min-h-0 flex-col animate-slide-in overflow-auto">
              <RightPanel
                tab={activeContextTab}
                onTabChange={setActiveContextTab}
                account={account}
                rateLimitsSnapshot={rateLimitsSnapshot}
                activeThreadTokenUsage={activeThreadTokenUsage}
                workspaceRootInput={workspaceRootInput}
                isUpdatingWorkspaceRoot={isUpdatingWorkspaceRoot}
                settings={settingsSummary}
                mcpServers={mcpServers}
                chatgptAuthUrl={chatgptAuthUrl}
                activeThreadId={activeThreadId}
                activeThreadArchived={activeThreadArchived}
                activeTurnId={activeTurnId}
                capabilities={capabilities}
                commandInput={commandInput}
                onCommandInputChange={setCommandInput}
                commandSessions={commandSessions}
                activeSessionId={activeSessionId}
                stdinInput={stdinInput}
                onStdinInputChange={setStdinInput}
                onSelectCommandSession={setActiveSessionId}
                onCommandRun={() => void runCommandExec()}
                onCommandWrite={() => void commandWrite(false)}
                onCommandCloseStdin={() => void commandWrite(true)}
                onCommandTerminate={() => void terminateCommand()}
                fileRoot={fileRoot}
                fileEntries={fileEntries}
                selectedFilePath={selectedFilePath}
                selectedFileText={selectedFileText}
                onFileRootChange={setFileRoot}
                onBrowseDirectory={(target) => void browseDirectory(target)}
                onOpenFile={(filePath) => void readFile(filePath)}
                onSelectedFileTextChange={setSelectedFileText}
                onSaveFile={() => void saveFile()}
                onRemovePath={(targetPath) => void removePath(targetPath)}
                pluginRows={pluginRows}
                configText={configText}
                onLoadPlugins={() => void loadPlugins()}
                onLoadConfig={() => void loadConfig()}
                adminMethod={adminMethod}
                adminParamsText={adminParamsText}
                adminResultText={adminResultText}
                onAdminMethodChange={setAdminMethod}
                onAdminParamsTextChange={setAdminParamsText}
                onAdminRun={() => void executeAdminRpc()}
                onLogin={() => void startChatGptLogin()}
                onLogout={() => logoutMutation.mutate()}
                onWorkspaceRootInputChange={setWorkspaceRootInput}
                onWorkspaceApply={() => void applyWorkspacePath()}
                onUseFileRootAsWorkspace={() => void applyWorkspacePath(fileRoot)}
                onRefreshStatus={() => void refreshRateLimits(true)}
                onReloadMcp={() => void reloadMcpConfig()}
                onMcpOauth={(name) => void runMcpOauth(name)}
                onArchiveToggle={() => void archiveOrUnarchiveThread()}
                onInterrupt={() => void interruptTurn()}
              />
            </Card>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(activeApproval)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(760px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-card-border bg-white p-5 shadow-soft outline-none">
            <Dialog.Title className="mb-1 text-lg font-bold">Approval required</Dialog.Title>
            <Dialog.Description className="mb-2 text-sm text-foreground/70">
              {activeApproval ? activeApproval.method : "Pending request"}
            </Dialog.Description>
            {activeApproval?.method === "tool/requestUserInput" && activeApprovalQuestions.length > 0 ? (
              <div className="space-y-3">
                <div className="max-h-[44vh] space-y-3 overflow-auto pr-1">
                  {activeApprovalQuestions.map((question) => {
                    const selectedLabel = requestInputSelections[question.id] || "";
                    const selectedOption = question.options.find((option) => option.label === selectedLabel) || null;
                    return (
                      <div key={question.id} className="rounded-2xl border border-card-border bg-muted/50 p-3">
                        {question.header ? <div className="font-mono text-[11px] uppercase tracking-wide text-foreground/70">{question.header}</div> : null}
                        {question.question ? <p className="mt-1 text-sm font-medium text-foreground">{question.question}</p> : null}
                        <div className="mt-2 space-y-2">
                          {question.options.map((option) => (
                            <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded-xl border border-card-border bg-white px-2 py-2">
                              <input
                                type="radio"
                                name={`rui-${question.id}`}
                                checked={selectedLabel === option.label}
                                onChange={() =>
                                  setRequestInputSelections((prev) => ({
                                    ...prev,
                                    [question.id]: option.label,
                                  }))
                                }
                                className="mt-0.5"
                              />
                              <span className="min-w-0">
                                <span className="text-sm font-medium">{option.label}</span>
                                {option.description ? <span className="mt-0.5 block text-xs text-foreground/70">{option.description}</span> : null}
                              </span>
                            </label>
                          ))}
                        </div>
                        {selectedOption?.isOther ? (
                          <div className="mt-2">
                            <input
                              type="text"
                              value={requestInputOtherText[question.id] || ""}
                              onChange={(event) =>
                                setRequestInputOtherText((prev) => ({
                                  ...prev,
                                  [question.id]: event.target.value,
                                }))
                              }
                              placeholder="Type your answer..."
                              className="w-full rounded-xl border border-card-border bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void handleRequestUserInputSubmit()} disabled={isSubmittingRequestInput}>
                    {isSubmittingRequestInput ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Submit answers
                  </Button>
                  <Button variant="ghost" onClick={() => void handleApprovalDecision("cancel")}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <pre className="scrollbar-thin max-h-[40vh] overflow-auto rounded-2xl border border-card-border bg-muted p-3 font-mono text-xs">
                  {activeApproval ? safeJsonStringify(activeApproval.params) : ""}
                </pre>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={() => void handleApprovalDecision("accept")}>Accept</Button>
                  <Button variant="ghost" onClick={() => void handleApprovalDecision("acceptForSession")}>
                    Accept for session
                  </Button>
                  <Button variant="ghost" onClick={() => void handleApprovalDecision("decline")}>
                    Decline
                  </Button>
                  <Button variant="ghost" onClick={() => void handleApprovalDecision("cancel")}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(guardPrompt)} onOpenChange={(open) => (open ? null : setGuardPrompt(null))}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(600px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-amber-300 bg-white p-5 shadow-soft outline-none">
            <Dialog.Title className="mb-2 flex items-center gap-2 text-lg font-bold text-amber-900">
              <ShieldAlert className="h-5 w-5" /> Risk Confirmation Required
            </Dialog.Title>
            <Dialog.Description className="text-sm text-foreground/80">
              {guardPrompt ? `${guardPrompt.method} (${guardPrompt.guard.group}, tier ${guardPrompt.guard.tier})` : ""}
            </Dialog.Description>
            <p className="mt-2 text-sm text-foreground/75">{guardPrompt?.guard.reason}</p>

            <label className="mt-3 inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={guardAcceptForSession} onChange={(event) => setGuardAcceptForSession(event.target.checked)} />
              Accept for session (15 minutes)
            </label>

            {guardPrompt?.guard.requiresReauthPassword ? (
              <div className="mt-3">
                <label className="mb-1 block font-mono text-xs uppercase tracking-wide text-foreground/70">Re-enter password</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={guardPassword}
                  onChange={(event) => setGuardPassword(event.target.value)}
                  className="w-full rounded-2xl border border-card-border px-3 py-2 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
              </div>
            ) : null}

            <pre className="scrollbar-thin mt-3 max-h-[24vh] overflow-auto rounded-2xl border border-card-border bg-muted p-3 font-mono text-xs">
              {guardPrompt ? safeJsonStringify(guardPrompt.params) : ""}
            </pre>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => void confirmGuardedRpc()} disabled={isSubmittingGuard}>
                {isSubmittingGuard ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
                Confirm and Run
              </Button>
              <Button variant="ghost" onClick={() => setGuardPrompt(null)}>
                Cancel
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!isAuthenticated && !isCheckingSession}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-card-border bg-white p-6 shadow-soft outline-none">
            <Dialog.Title className="text-2xl font-bold tracking-tight">Personal Codex Assistant</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-foreground/70">
              Enter your assistant password to continue.
            </Dialog.Description>

            <form className="mt-4 space-y-3" onSubmit={handleSubmit((values) => loginMutation.mutate(values.password))}>
              <div>
                <label className="mb-1 block font-mono text-xs uppercase tracking-wide text-foreground/70">Password</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  className="w-full rounded-2xl border border-card-border px-3 py-2 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  {...register("password")}
                />
                {errors.password ? <p className="mt-1 text-xs text-red-600">{errors.password.message}</p> : null}
              </div>

              {loginMutation.error ? (
                <p className="text-sm text-red-600">{loginMutation.error instanceof Error ? loginMutation.error.message : "Login failed"}</p>
              ) : null}

              <Button type="submit" disabled={isSubmitting || loginMutation.isPending} className="w-full">
                <ShieldCheck className="mr-2 h-4 w-4" /> Unlock
              </Button>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {isCheckingSession ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/65 backdrop-blur-sm">
          <div className="rounded-2xl border border-card-border bg-white px-4 py-3 text-sm font-medium">Checking existing session...</div>
        </div>
      ) : null}

      {toastText ? <div className="fixed bottom-4 right-4 z-50 rounded-xl bg-[#102735] px-4 py-2 text-sm text-white shadow-soft">{toastText}</div> : null}
    </div>
  );
}

function ChatComposer({
  onSend,
  onShowStatus,
  statusAvailable,
  planModeEnabled,
  planModeId,
  onSetPlanMode,
}: {
  onSend: (text: string) => Promise<void>;
  onShowStatus: () => Promise<void>;
  statusAvailable: boolean;
  planModeEnabled: boolean;
  planModeId: string;
  onSetPlanMode: (next: boolean) => void | Promise<void>;
}): JSX.Element {
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isRunningSlashCommand, setIsRunningSlashCommand] = useState(false);

  const slashMode = useMemo(() => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    if (trimmed.includes(" ")) return null;
    return trimmed.slice(1).toLowerCase();
  }, [text]);

  const slashCommands = useMemo(
    () => [
      {
        id: "plan",
        token: "/plan",
        title: planModeEnabled ? "Disable Plan Mode" : "Enable Plan Mode",
        description: planModeEnabled ? "Next messages use normal mode." : `Next messages use plan mode (${planModeId}).`,
      },
      {
        id: "status",
        token: "/status",
        title: "Show usage status",
        description: statusAvailable ? "Show ChatGPT rate-limit usage and thread token usage." : "Status unavailable on this server.",
      },
    ],
    [planModeEnabled, planModeId, statusAvailable],
  );

  const visibleSlashCommands = useMemo(() => {
    if (slashMode === null) return [];
    return slashCommands.filter((command) => command.token.slice(1).startsWith(slashMode) || command.id.startsWith(slashMode));
  }, [slashCommands, slashMode]);

  async function runSlashCommand(token: string): Promise<boolean> {
    if (token === "/plan") {
      setIsRunningSlashCommand(true);
      try {
        await onSetPlanMode(!planModeEnabled);
        setText("");
        return true;
      } finally {
        setIsRunningSlashCommand(false);
      }
    }

    if (token === "/status") {
      if (!statusAvailable) {
        setText("");
        return true;
      }
      setIsRunningSlashCommand(true);
      try {
        await onShowStatus();
        setText("");
        return true;
      } finally {
        setIsRunningSlashCommand(false);
      }
    }

    return false;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const value = text.trim();
    if (!value || isSending || isRunningSlashCommand) return;

    if (value.startsWith("/")) {
      const handled = await runSlashCommand(value.toLowerCase());
      if (handled) return;
    }

    setIsSending(true);
    try {
      await onSend(value);
      setText("");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <form className="border-t border-card-border bg-white/75 p-3" onSubmit={onSubmit}>
      {planModeEnabled ? (
        <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-brand/40 bg-brand-soft/70 px-2.5 py-1 text-xs text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-brand-dark" />
          <span>Plan mode: {planModeId}</span>
          <button
            type="button"
            className="rounded-full p-0.5 text-foreground/70 transition hover:bg-black/10 hover:text-foreground"
            onClick={() => void onSetPlanMode(false)}
            aria-label="Disable plan mode"
            title="Disable plan mode"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      <div className="relative flex items-end gap-2">
        <textarea
          className="min-h-[44px] max-h-40 w-full resize-y rounded-2xl border border-card-border bg-white px-3 py-2 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
          placeholder="Message Codex..."
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {visibleSlashCommands.length > 0 ? (
          <div className="absolute bottom-[calc(100%+8px)] left-0 right-14 z-20 overflow-hidden rounded-2xl border border-card-border bg-white shadow-soft">
            <div className="border-b border-card-border/70 px-3 py-2 text-[11px] font-mono uppercase tracking-wide text-foreground/65">Commands</div>
            <div className="p-1">
              {visibleSlashCommands.map((command) => (
                <button
                  key={command.id}
                  type="button"
                  className="flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left transition hover:bg-muted"
                  onClick={() => void runSlashCommand(command.token)}
                >
                  <Command className="mt-0.5 h-4 w-4 shrink-0 text-foreground/65" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-brand-dark">{command.token}</span>
                      <span className="text-xs font-semibold text-foreground">{command.title}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-foreground/70">{command.description}</div>
                  </div>
                  <ChevronsUpDown className="ml-auto mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/45" />
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <Button
          type="submit"
          className="h-[44px] w-[44px] shrink-0 rounded-full p-0"
          disabled={isSending || isRunningSlashCommand}
          aria-label="Send message"
          title="Send"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}

function ThreadsPanel({
  threads,
  archivedThreads,
  showArchived,
  activeThreadId,
  loadedThreadIds,
  pinnedThreadIds,
  onTogglePin,
  onToggleArchived,
  onCreateThread,
  onOpenThread,
}: {
  threads: ThreadRecord[];
  archivedThreads: ThreadRecord[];
  showArchived: boolean;
  activeThreadId: string | null;
  loadedThreadIds: string[];
  pinnedThreadIds: string[];
  onTogglePin: (threadId: string, isPinned: boolean) => void;
  onToggleArchived: (show: boolean) => void;
  onCreateThread: () => void;
  onOpenThread: (threadId: string) => void;
}): JSX.Element {
  const data = showArchived ? archivedThreads : threads;

  return (
    <>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4" /> Chats
        </CardTitle>
        <Button size="sm" onClick={onCreateThread}>
          New
        </Button>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <label className="inline-flex items-center gap-2 text-xs text-foreground/75">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => onToggleArchived(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-card-border"
          />
          Show archived
        </label>

        <div className="scrollbar-thin flex-1 space-y-2 overflow-auto pr-1">
          {!data.length ? (
            <div className="rounded-2xl border border-dashed border-card-border bg-muted px-3 py-2 text-xs text-foreground/70">
              {showArchived ? "No archived chats" : "No chats yet"}
            </div>
          ) : null}

          {data.map((thread) => {
            const isPinned = pinnedThreadIds.includes(thread.id);
            return (
              <div
                key={thread.id}
                className={cn(
                  "w-full rounded-2xl border bg-white px-3 py-2 text-left shadow-card transition hover:-translate-y-0.5 hover:border-brand/60",
                  activeThreadId === thread.id ? "border-brand bg-brand-soft/60" : "border-card-border",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm font-semibold"
                    title={getThreadTitle(thread)}
                    onClick={() => onOpenThread(thread.id)}
                  >
                    {getThreadTitle(thread)}
                  </button>
                  <div className="flex items-center gap-1">
                    {loadedThreadIds.includes(thread.id) ? <Badge>loaded</Badge> : null}
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-black/5"
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePin(thread.id, isPinned);
                      }}
                    >
                      {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="mt-1 w-full truncate text-left text-xs text-foreground/70"
                  onClick={() => onOpenThread(thread.id)}
                >
                  {thread.preview || "No preview"}
                </button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </>
  );
}

function RightPanel(props: {
  tab: ContextTab;
  onTabChange: (tab: ContextTab) => void;
  account: unknown;
  rateLimitsSnapshot: Record<string, unknown> | null;
  activeThreadTokenUsage: Record<string, unknown> | null;
  workspaceRootInput: string;
  isUpdatingWorkspaceRoot: boolean;
  settings: { label: string; value: string }[];
  mcpServers: Record<string, unknown>[];
  chatgptAuthUrl: string | null;
  activeThreadId: string | null;
  activeThreadArchived: boolean;
  activeTurnId: string | null;
  capabilities: { groups?: Record<string, boolean>; methods?: Array<{ method: string; enabled: boolean; riskTier: number }> } | null;
  commandInput: string;
  onCommandInputChange: (text: string) => void;
  commandSessions: CommandSession[];
  activeSessionId: string | null;
  stdinInput: string;
  onStdinInputChange: (text: string) => void;
  onSelectCommandSession: (id: string) => void;
  onCommandRun: () => void;
  onCommandWrite: () => void;
  onCommandCloseStdin: () => void;
  onCommandTerminate: () => void;
  fileRoot: string;
  fileEntries: FileEntry[];
  selectedFilePath: string | null;
  selectedFileText: string;
  onFileRootChange: (text: string) => void;
  onBrowseDirectory: (target: string) => void;
  onOpenFile: (path: string) => void;
  onSelectedFileTextChange: (text: string) => void;
  onSaveFile: () => void;
  onRemovePath: (targetPath: string) => void;
  pluginRows: Record<string, unknown>[];
  configText: string;
  onLoadPlugins: () => void;
  onLoadConfig: () => void;
  adminMethod: AllowedRpcMethod;
  adminParamsText: string;
  adminResultText: string;
  onAdminMethodChange: (method: AllowedRpcMethod) => void;
  onAdminParamsTextChange: (value: string) => void;
  onAdminRun: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onWorkspaceRootInputChange: (value: string) => void;
  onWorkspaceApply: () => void;
  onUseFileRootAsWorkspace: () => void;
  onRefreshStatus: () => void;
  onReloadMcp: () => void;
  onMcpOauth: (name: string) => void;
  onArchiveToggle: () => void;
  onInterrupt: () => void;
}): JSX.Element {
  const {
    tab,
    onTabChange,
    account,
    rateLimitsSnapshot,
    activeThreadTokenUsage,
    workspaceRootInput,
    isUpdatingWorkspaceRoot,
    settings,
    mcpServers,
    chatgptAuthUrl,
    activeThreadId,
    activeThreadArchived,
    activeTurnId,
    capabilities,
    commandInput,
    onCommandInputChange,
    commandSessions,
    activeSessionId,
    stdinInput,
    onStdinInputChange,
    onSelectCommandSession,
    onCommandRun,
    onCommandWrite,
    onCommandCloseStdin,
    onCommandTerminate,
    fileRoot,
    fileEntries,
    selectedFilePath,
    selectedFileText,
    onFileRootChange,
    onBrowseDirectory,
    onOpenFile,
    onSelectedFileTextChange,
    onSaveFile,
    onRemovePath,
    pluginRows,
    configText,
    onLoadPlugins,
    onLoadConfig,
    adminMethod,
    adminParamsText,
    adminResultText,
    onAdminMethodChange,
    onAdminParamsTextChange,
    onAdminRun,
    onLogin,
    onLogout,
    onWorkspaceRootInputChange,
    onWorkspaceApply,
    onUseFileRootAsWorkspace,
    onRefreshStatus,
    onReloadMcp,
    onMcpOauth,
    onArchiveToggle,
    onInterrupt,
  } = props;

  const accountLabel = useMemo(() => {
    if (!isObject(account)) return "Not authenticated";
    if (account.type === "chatgpt") {
      const email = typeof account.email === "string" ? account.email : "ChatGPT account";
      const plan = typeof account.planType === "string" ? ` (${account.planType})` : "";
      return `${email}${plan}`;
    }
    return `Authenticated: ${String(account.type || "unknown")}`;
  }, [account]);

  const rateLimitRows = useMemo(() => parseRateLimits(rateLimitsSnapshot), [rateLimitsSnapshot]);
  const tokenUsageRows = useMemo(() => parseThreadTokenUsageRows(activeThreadTokenUsage), [activeThreadTokenUsage]);

  const activeSession = commandSessions.find((entry) => entry.sessionId === activeSessionId) || null;

  return (
    <div className="space-y-4 p-3">
      <div className="grid grid-cols-2 gap-1 rounded-2xl border border-card-border bg-muted p-1">
        <Button size="sm" variant={tab === "context" ? "primary" : "ghost"} onClick={() => onTabChange("context")}>
          Context
        </Button>
        <Button size="sm" variant={tab === "admin" ? "primary" : "ghost"} onClick={() => onTabChange("admin")}>
          Admin
        </Button>
      </div>

      {tab === "context" ? (
        <>
          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Thread controls</h3>
              <Badge>{activeThreadId ? "active" : "none"}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={onArchiveToggle} disabled={!activeThreadId}>
                <Archive className="mr-1.5 h-4 w-4" /> {activeThreadArchived ? "Unarchive" : "Archive"}
              </Button>
              <Button size="sm" variant="ghost" onClick={onInterrupt} disabled={!activeThreadId}>
                <CircleStop className="mr-1.5 h-4 w-4" /> Interrupt
              </Button>
            </div>
          </section>

          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Account</h3>
              <Badge>chatgpt</Badge>
            </div>
            <p className="text-xs text-foreground/75">{accountLabel}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={onLogin}>
                <LogIn className="mr-1.5 h-4 w-4" /> Login
              </Button>
              <Button size="sm" variant="ghost" onClick={onLogout}>
                <LogOut className="mr-1.5 h-4 w-4" /> Logout
              </Button>
            </div>
            {chatgptAuthUrl ? (
              <a className="mt-2 inline-block text-xs font-medium text-brand underline" href={chatgptAuthUrl} target="_blank" rel="noreferrer">
                Open ChatGPT auth link
              </a>
            ) : null}
          </section>

          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Usage status</h3>
              <Button size="sm" variant="ghost" onClick={onRefreshStatus}>
                <RefreshCcw className="mr-1.5 h-4 w-4" /> Refresh
              </Button>
            </div>

            <div className="space-y-2">
              <div className="space-y-1">
                <div className="text-xs font-semibold text-foreground/80">Rate limits</div>
                {rateLimitRows.length === 0 ? (
                  <div className="text-xs text-foreground/70">No rate-limit data yet.</div>
                ) : (
                  <div className="space-y-1">
                    {rateLimitRows.map((bucket) => (
                      <div key={bucket.id} className="rounded-lg border border-card-border bg-muted/70 px-2 py-1 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{bucket.name}</span>
                          <span className="font-mono text-foreground/75">
                            {bucket.remainingPercent === null ? "remaining ?" : `${bucket.remainingPercent.toFixed(1)}% remaining`}
                          </span>
                        </div>
                        <div className="mt-1 text-foreground/70">
                          used {bucket.usedPercent === null ? "?" : `${bucket.usedPercent.toFixed(1)}%`} / reset {formatResetTime(bucket.resetsAt)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <div className="text-xs font-semibold text-foreground/80">Active thread tokens</div>
                {tokenUsageRows.length === 0 ? (
                  <div className="text-xs text-foreground/70">No token-usage update yet.</div>
                ) : (
                  <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 text-xs">
                    {tokenUsageRows.map((row) => (
                      <Fragment key={row.label}>
                        <dt className="text-foreground/70">{row.label}</dt>
                        <dd className="font-mono text-right">{Math.round(row.value)}</dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Workspace root</h3>
              <Badge>active</Badge>
            </div>
            <input
              value={workspaceRootInput}
              onChange={(event) => onWorkspaceRootInputChange(event.target.value)}
              placeholder="/absolute/path/to/workspace"
              className="w-full rounded-xl border border-card-border px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={onWorkspaceApply} disabled={isUpdatingWorkspaceRoot}>
                {isUpdatingWorkspaceRoot ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Apply workspace
              </Button>
              <Button size="sm" variant="ghost" onClick={onUseFileRootAsWorkspace} disabled={isUpdatingWorkspaceRoot || !fileRoot.trim()}>
                Use file browser path
              </Button>
            </div>
            <p className="mt-2 text-xs text-foreground/70">
              This updates defaults for new turns/threads and filesystem guard scope.
            </p>
          </section>

          <section className="rounded-2xl border border-card-border bg-white p-3">
            <h3 className="mb-2 text-sm font-bold">Thread settings</h3>
            <dl className="grid grid-cols-[82px_1fr] gap-x-2 gap-y-1 text-xs">
              {settings.map((item) => (
                <Fragment key={item.label}>
                  <dt className="font-mono text-foreground/65">{item.label}</dt>
                  <dd className="font-mono break-all text-foreground">{item.value}</dd>
                </Fragment>
              ))}
            </dl>
          </section>

          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">MCP servers</h3>
              <Button size="sm" variant="ghost" onClick={onReloadMcp}>
                <RefreshCcw className="mr-1.5 h-4 w-4" /> Reload
              </Button>
            </div>

            <div className="space-y-2">
              {!mcpServers.length ? (
                <div className="rounded-xl border border-dashed border-card-border bg-muted px-3 py-2 text-xs text-foreground/70">
                  No MCP servers discovered.
                </div>
              ) : null}

              {mcpServers.map((server, index) => {
                const name =
                  typeof server.name === "string"
                    ? server.name
                    : typeof server.serverName === "string"
                      ? server.serverName
                      : typeof server.id === "string"
                        ? server.id
                        : `server-${index + 1}`;

                const auth =
                  isObject(server.authStatus) && typeof server.authStatus.status === "string"
                    ? server.authStatus.status
                    : typeof server.authStatus === "string"
                      ? server.authStatus
                      : isObject(server.auth) && typeof server.auth.status === "string"
                        ? server.auth.status
                        : "unknown";

                const toolCount = Array.isArray(server.tools)
                  ? server.tools.length
                  : typeof server.toolCount === "number"
                    ? server.toolCount
                    : 0;

                const unauth = auth.toLowerCase().includes("unauth");

                return (
                  <div key={name} className="rounded-xl border border-card-border bg-muted px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{name}</span>
                      <Badge>{auth}</Badge>
                    </div>
                    <div className="mt-1 text-foreground/70">tools: {toolCount}</div>
                    {unauth ? (
                      <Button size="sm" variant="ghost" className="mt-2" onClick={() => onMcpOauth(name)}>
                        <Layers className="mr-1.5 h-4 w-4" /> OAuth login
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      ) : null}

      {tab === "admin" ? (
        <>
          <section className="rounded-2xl border border-card-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Plugins</h3>
              <Button size="sm" variant="ghost" onClick={onLoadPlugins}>
                Load
              </Button>
            </div>
            <div className="space-y-1 text-xs">
              {pluginRows.length === 0 ? <div className="text-foreground/70">No plugin data loaded.</div> : null}
              {pluginRows.slice(0, 12).map((row, idx) => (
                <div key={String(row.id || row.name || idx)} className="rounded-lg border border-card-border px-2 py-1">
                  <div className="font-semibold">{String(row.name || row.id || `plugin-${idx + 1}`)}</div>
                  <div className="text-foreground/70">{String(row.version || row.marketplacePath || "")}</div>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

export default App;
