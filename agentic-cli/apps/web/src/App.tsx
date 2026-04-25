import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Convert from "ansi-to-html";
import DiffViewer from "react-diff-viewer-continued";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CircleStop,
  FileCode2,
  FolderTree,
  Layers,
  LoaderCircle,
  MessageSquare,
  MicOff,
  Moon,
  PanelLeft,
  PanelRight,
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
  DiffSnapshot,
  FileTreeNode,
  RunRecord,
  SandboxMode,
  StartRunInput,
  WorkspaceOption,
} from "@agentic/shared";
import {
  archiveSession,
  connectEvents,
  deleteSession,
  getAccountStatus,
  getBootstrap,
  getDiff,
  getFileTree,
  getMcpStatus,
  getRuns,
  getSystemStatus,
  rerun,
  setActiveWorkspace,
  startRun,
  stopRun,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/useUiStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type StatusFilter = "all" | "running" | "completed" | "failed" | "stopped";

type TimelineRole = "user" | "assistant" | "tool" | "plan" | "system" | "error";

type FileChangeDetail = {
  kind: string;
  path: string;
  diff?: string;
  added: number;
  removed: number;
};

type TimelineEntry = {
  key: string;
  role: TimelineRole;
  title?: string;
  text: string;
  pending: boolean;
  at: number;
  meta?: {
    type?: "commandexecution" | "filechange";
    runId?: string;
    status?: string;
    command?: string;
    output?: string;
    exitCode?: number | null;
    fileChanges?: FileChangeDetail[];
    errorMessage?: string;
    path?: string;
    durationMs?: number;
  };
};

type SessionCard = {
  id: string;
  latestRun: RunRecord;
  runCount: number;
  summary: string;
  status: RunRecord["status"];
  updatedAt: number;
};

const sandboxOptions: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const approvalPolicies: ApprovalPolicy[] = ["untrusted", "on-failure", "on-request", "never"];
const modelOptions = ["gpt-5.3-codex", "gpt-5.4", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"];
const toolOutputModalLimit = 2500;
const draftSessionKey = "__draft__";
const queueStorageKey = "agentic_cli_queue_v1";

type SlashCommandKey = "/mcp" | "/account" | "/status" | "/help";

type SlashCommandSuggestion = {
  key: SlashCommandKey;
  title: string;
  description: string;
};

type QueuedMessage = {
  id: string;
  sessionKey: string;
  prompt: string;
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
  { key: "/status", title: "System status", description: "Show both account and MCP status." },
  { key: "/account", title: "Account status", description: "Show Codex account/login status." },
  { key: "/mcp", title: "MCP status", description: "Show configured MCP servers and auth status." },
  { key: "/help", title: "Slash help", description: "List available slash commands." },
];

function normalizeSlashCommand(raw: string): SlashCommandKey | null {
  const lower = raw.toLowerCase();
  if (lower === "/status") return "/status";
  if (lower === "/account" || lower === "/account-status") return "/account";
  if (lower === "/mcp" || lower === "/mcp-status") return "/mcp";
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

function isSandboxMode(value: unknown): value is SandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
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

        if (!id || !prompt || !workspace || !model || !isSandboxMode(item.sandbox) || !isApprovalPolicy(item.approvalPolicy)) {
          continue;
        }

        normalized.push({
          id,
          sessionKey,
          prompt,
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

function statusClass(status: string): string {
  if (status === "running") return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200";
  if (status === "completed") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200";
  if (status === "failed") return "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200";
  if (status === "stopped") return "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200";
}

function normalizeSessionTitle(raw: string, fallback: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;

  const dashIndex = collapsed.indexOf("---");
  const trimmed = dashIndex >= 0 ? collapsed.slice(0, dashIndex).trim() : collapsed;
  const title = trimmed || fallback;
  return title.length > 160 ? `${title.slice(0, 157)}...` : title;
}

function buildSessionCards(runs: RunRecord[]): SessionCard[] {
  const grouped = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (run.archivedAt !== null) continue;
    const key = runSessionId(run);
    const list = grouped.get(key) || [];
    list.push(run);
    grouped.set(key, list);
  }

  return [...grouped.entries()]
    .map(([id, list]) => {
      const desc = [...list].sort((a, b) => b.createdAt - a.createdAt);
      const asc = [...list].sort((a, b) => a.createdAt - b.createdAt);
      const latestRun = desc[0];
      const firstPrompt = asc.find((run) => run.config.prompt.trim())?.config.prompt || "";
      return {
        id,
        latestRun,
        runCount: list.length,
        summary: normalizeSessionTitle(firstPrompt, latestRun.summary || "Session"),
        status: latestRun.status,
        updatedAt: latestRun.updatedAt || latestRun.createdAt,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
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

function truncatePreview(input: string, max = 120): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
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

function parseFileChanges(item: Record<string, unknown>): FileChangeDetail[] {
  const raw = Array.isArray(item.changes) ? item.changes : [];
  const result: FileChangeDetail[] = [];
  for (const change of raw) {
    if (!isRecord(change)) continue;
    const path = typeof change.path === "string" ? change.path : "";
    if (!path) continue;
    const kind = typeof change.kind === "string" ? change.kind : "modify";
    const diff = typeof change.diff === "string" ? change.diff : undefined;
    const added = typeof change.added === "number" ? change.added : 0;
    const removed = typeof change.removed === "number" ? change.removed : 0;
    result.push({ kind, path, diff, added, removed });
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

function buildSessionTimeline(runs: RunRecord[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const orderedRuns = [...runs].sort((a, b) => a.createdAt - b.createdAt);

  for (const run of orderedRuns) {
    if (run.config.prompt.trim()) {
      entries.push({
        key: `${run.id}_user`,
        role: "user",
        title: "You",
        text: run.config.prompt.trim(),
        pending: false,
        at: run.createdAt,
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
        changes: FileChangeDetail[];
        errorMessage?: string;
        path?: string;
        durationMs?: number;
      }
    >();

    const dedupe = new Set<string>();
    const orderedEvents = [...run.events].sort((a, b) => a.at - b.at);

    for (const event of orderedEvents) {
      const raw = (event.text || "").trim();
      if (!raw) continue;

      if (event.source === "stderr") {
        entries.push({
          key: `${run.id}_${event.id}_stderr`,
          role: "error",
          title: "stderr",
          text: raw,
          pending: false,
          at: event.at,
          meta: { runId: run.id },
        });
        continue;
      }

      const parsed = toJson(raw);
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
          changes: [] as FileChangeDetail[],
          errorMessage: undefined,
          path: undefined,
          durationMs: undefined,
        };

        if (event.at < existing.at) existing.at = event.at;
        if (typeof item?.status === "string" && item.status.trim()) existing.status = item.status;
        if (typeof item?.error_message === "string") existing.errorMessage = item.error_message;
        if (typeof item?.path === "string") existing.path = item.path;
        if (typeof item?.duration_ms === "number") existing.durationMs = item.duration_ms;
        const changes = parseFileChanges(item || {});
        if (changes.length) existing.changes = changes;
        existing.pending = parsedType === "item.started" || existing.status === "in_progress";

        fileChangeByItemId.set(itemId, existing);
        continue;
      }

      if (itemType === "error") {
        const message = typeof item?.message === "string" ? item.message : raw;
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

    const commandEntries = [...commandByItemId.values()].map((command) => {
      const status = command.status || (command.pending ? "in_progress" : "completed");
      const preview = `$ ${truncatePreview(command.command)}`;
      return {
        key: `${run.id}_${command.itemId}_command`,
        role: "tool" as const,
        title: "Tool",
        text: preview,
        pending: command.pending,
        at: command.at,
        meta: {
          type: "commandexecution" as const,
          runId: run.id,
          status,
          command: command.command,
          output: command.output,
          exitCode: command.exitCode,
        },
      };
    });

    const fileEntries = [...fileChangeByItemId.values()].map((change) => {
      const count = change.changes.length;
      const summary =
        count > 0
          ? `${change.pending ? "Applying" : "Applied"} file changes (${count} file${count > 1 ? "s" : ""})`
          : change.path
            ? `${change.pending ? "Updating" : "Updated"}: ${change.path}`
            : change.pending
              ? "Applying file changes"
              : "File changes";

      return {
        key: `${run.id}_${change.itemId}_file`,
        role: "tool" as const,
        title: "Tool",
        text: summary,
        pending: change.pending,
        at: change.at,
        meta: {
          type: "filechange" as const,
          runId: run.id,
          status: change.status,
          fileChanges: change.changes,
          errorMessage: change.errorMessage,
          path: change.path,
          durationMs: change.durationMs,
        },
      };
    });

    entries.push(...commandEntries, ...fileEntries);

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
  }

  return entries.sort((a, b) => a.at - b.at);
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
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalQueueItem[]>([]);

  const [fileNodes, setFileNodes] = useState<FileTreeNode[]>([]);
  const [diff, setDiff] = useState<DiffSnapshot | null>(null);

  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-5.3-codex");
  const [sandbox, setSandbox] = useState<SandboxMode>("read-only");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>("on-request");
  const [planMode, setPlanMode] = useState(false);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isDraftSession, setIsDraftSession] = useState(false);
  const [slashEntriesBySession, setSlashEntriesBySession] = useState<Record<string, TimelineEntry[]>>({});
  const [queuedBySession, setQueuedBySession] = useState<Record<string, QueuedMessage[]>>(() => loadQueuedMessages());
  const [processingQueueItemId, setProcessingQueueItemId] = useState<string | null>(null);
  const [toolDetailModal, setToolDetailModal] = useState<ToolDetailModalState | null>(null);
  const [sessionAction, setSessionAction] = useState<"archive" | "delete" | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const ansi = useMemo(() => new Convert({ newline: true, escapeXML: true }), []);
  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceHoldTimerRef = useRef<number | null>(null);
  const voiceHoldSuppressResetTimerRef = useRef<number | null>(null);
  const voiceHoldTriggeredRef = useRef(false);
  const suppressNextSendClickRef = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

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
    };

    recognition.onend = () => {
      setVoiceListening(false);
    };

    recognition.onerror = (event) => {
      setVoiceError(toSpeechErrorMessage(event.error));
      setVoiceListening(false);
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
      if (voiceHoldTimerRef.current !== null) {
        window.clearTimeout(voiceHoldTimerRef.current);
        voiceHoldTimerRef.current = null;
      }
      if (voiceHoldSuppressResetTimerRef.current !== null) {
        window.clearTimeout(voiceHoldSuppressResetTimerRef.current);
        voiceHoldSuppressResetTimerRef.current = null;
      }
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
    void loadBootstrap();
  }, []);

  useEffect(() => {
    const es = connectEvents((event) => {
      if (event.kind === "heartbeat") return;

      if (event.kind === "run.stdout" || event.kind === "run.stderr" || event.kind === "run.item") {
        const runId = event.runId;
        if (!runId) return;

        setRuns((prev) => {
          const idx = prev.findIndex((entry) => entry.id === runId);
          if (idx < 0) return prev;
          const current = prev[idx];
          const line =
            event.kind === "run.item"
              ? JSON.stringify(event.payload || {})
              : String(event.payload?.text || "");
          const source = event.kind === "run.stderr" ? ("stderr" as const) : ("stdout" as const);
          const nextEvents = [
            ...current.events,
            {
              id: `live_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              at: Date.now(),
              source,
              text: line,
            },
          ];

          const next = [...prev];
          next[idx] = {
            ...current,
            events: nextEvents.slice(-1800),
            updatedAt: Date.now(),
          };
          return next;
        });

        return;
      }

      void refreshRuns();
      if (event.kind === "run.diffUpdated" && event.runId === selectedRunId) {
        setDiff(event.payload as unknown as DiffSnapshot);
      }
    });

    return () => es.close();
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setDiff(null);
      return;
    }
    void loadDiff(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    if (!activeWorkspace) return;
    void loadFileTree();
  }, [activeWorkspace]);

  const allSessions = useMemo(() => buildSessionCards(runs), [runs]);
  const filteredSessions = useMemo(() => {
    if (statusFilter === "all") return allSessions;
    return allSessions.filter((session) => session.status === statusFilter);
  }, [allSessions, statusFilter]);

  const selectedSession = useMemo(
    () => allSessions.find((session) => session.id === selectedSessionId) || null,
    [allSessions, selectedSessionId],
  );

  const selectedRun = selectedSession?.latestRun || null;

  const selectedSessionRuns = useMemo(() => {
    if (!selectedSessionId) return [];
    return runs
      .filter((run) => runSessionId(run) === selectedSessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [runs, selectedSessionId]);

  const sessionTimelineKey = selectedSessionId || draftSessionKey;
  const timeline = useMemo(() => {
    const base = buildSessionTimeline(selectedSessionRuns);
    const slashEntries = slashEntriesBySession[sessionTimelineKey] || [];
    return [...base, ...slashEntries].sort((a, b) => a.at - b.at);
  }, [selectedSessionRuns, sessionTimelineKey, slashEntriesBySession]);
  const pendingApprovals = useMemo(() => approvals.filter((item) => item.status === "pending"), [approvals]);
  const slashSuggestions = useMemo(() => {
    const trimmed = prompt.trimStart();
    if (!trimmed.startsWith("/")) return [] as SlashCommandSuggestion[];
    const token = trimmed.split(/\s+/)[0].toLowerCase();
    return slashCommandSuggestions.filter((item) => item.key.startsWith(token) || item.key.includes(token));
  }, [prompt]);
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of runs) {
      if (run.status === "running") ids.add(runSessionId(run));
    }
    return ids;
  }, [runs]);
  const queuedMessagesForActiveSession = queuedBySession[sessionTimelineKey] || [];

  const mobileHeaderTitle = selectedSession
    ? truncatePreview(selectedSession.summary || `Session ${selectedSession.id}`, 34)
    : "Agentic CLI";

  const hasPendingTimelineEntry = timeline.some((entry) => entry.pending);

  useEffect(() => {
    timelineBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [timeline.length, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      if (isDraftSession) {
        setSelectedRunId(null);
        return;
      }
      if (allSessions.length > 0) {
        setSelectedSessionId(allSessions[0].id);
        setSelectedRunId(allSessions[0].latestRun.id);
      }
      return;
    }

    const selected = allSessions.find((session) => session.id === selectedSessionId);
    if (selected) {
      setSelectedRunId(selected.latestRun.id);
      return;
    }

    if (allSessions.length > 0) {
      setSelectedSessionId(allSessions[0].id);
      setSelectedRunId(allSessions[0].latestRun.id);
      return;
    }

    setSelectedRunId(null);
  }, [allSessions, isDraftSession, selectedSessionId, setSelectedRunId]);

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

  async function loadBootstrap(): Promise<void> {
    setLoading(true);
    try {
      const payload = await getBootstrap();
      setWorkspaces(payload.workspaces);
      setWorkspace(payload.activeWorkspace);
      setRuns(payload.runs);
      setApprovals(payload.approvals);
      setModel(payload.defaults.model);
      setSandbox(payload.defaults.sandbox);

      const sessions = buildSessionCards(payload.runs);
      if (!selectedSessionId && !isDraftSession && sessions.length > 0) {
        setSelectedSessionId(sessions[0].id);
        setSelectedRunId(sessions[0].latestRun.id);
      }
    } finally {
      setLoading(false);
    }
  }

  async function refreshRuns(): Promise<void> {
    const payload = await getRuns();
    setRuns(payload.runs);
    setApprovals(payload.approvals);

    const sessions = buildSessionCards(payload.runs);
    if (!selectedSessionId && !isDraftSession && sessions.length > 0) {
      setSelectedSessionId(sessions[0].id);
      setSelectedRunId(sessions[0].latestRun.id);
      return;
    }

    if (selectedSessionId) {
      const selected = sessions.find((session) => session.id === selectedSessionId);
      if (selected) {
        setSelectedRunId(selected.latestRun.id);
      } else if (sessions.length > 0) {
        setSelectedSessionId(sessions[0].id);
        setSelectedRunId(sessions[0].latestRun.id);
      } else {
        setSelectedSessionId(null);
        setSelectedRunId(null);
      }
    }
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

  function enqueueMessage(promptValue: string): void {
    const sessionKey = selectedSessionId || draftSessionKey;
    const queued: QueuedMessage = {
      id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionKey,
      prompt: promptValue,
      createdAt: Date.now(),
      workspace: activeWorkspace,
      model,
      sandbox,
      approvalPolicy,
      planMode,
    };

    setQueuedBySession((prev) => ({
      ...prev,
      [sessionKey]: [...(prev[sessionKey] || []), queued],
    }));
  }

  async function startCodexRun(request: QueuedMessage, focusSession: boolean): Promise<void> {
    const input: StartRunInput = {
      prompt: request.prompt,
      workspace: request.workspace,
      model: request.model,
      sandbox: request.sandbox,
      approvalPolicy: request.approvalPolicy,
      planMode: request.planMode,
      sessionId: request.sessionKey === draftSessionKey ? undefined : request.sessionKey,
    };

    const payload = await startRun(input);
    await refreshRuns();
    setIsDraftSession(false);

    if (focusSession) {
      setSelectedSessionId(runSessionId(payload.run));
      setSelectedRunId(payload.run.id);
      setRightPanelTab("tools");
      setMobileThreadsOpen(false);
      return;
    }

    if (selectedSessionId && runSessionId(payload.run) === selectedSessionId) {
      setSelectedRunId(payload.run.id);
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
        {
          key: `queue_${queued.id}_error`,
          role: "error",
          title: "System",
          text: `Queued message failed: ${message}`,
          pending: false,
          at: Date.now(),
        },
      ]);
    } finally {
      removeQueuedMessage(queued.sessionKey, queued.id);
      setProcessingQueueItemId((current) => (current === queued.id ? null : current));
      setSubmitting(false);
    }
  }

  function pushSlashEntries(sessionKey: string, entries: TimelineEntry[]): void {
    setSlashEntriesBySession((prev) => {
      const current = prev[sessionKey] || [];
      const nextEntries = [...current, ...entries].slice(-200);
      return { ...prev, [sessionKey]: nextEntries };
    });
  }

  async function runSlashCommand(command: SlashCommandKey, sessionKey: string): Promise<void> {
    const now = Date.now();
    const messageId = `${now}_${Math.random().toString(36).slice(2, 7)}`;
    const input = prompt.trim();
    pushSlashEntries(sessionKey, [
      {
        key: `slash_${messageId}_user`,
        role: "user",
        title: "You",
        text: input,
        pending: false,
        at: now,
      },
    ]);

    if (command === "/help") {
      pushSlashEntries(sessionKey, [
        {
          key: `slash_${messageId}_help`,
          role: "assistant",
          title: "System",
          text: buildSlashHelpText(),
          pending: false,
          at: now + 1,
        },
      ]);
      return;
    }

    if (command === "/account") {
      const payload = await getAccountStatus();
      pushSlashEntries(sessionKey, [
        {
          key: `slash_${messageId}_account`,
          role: "assistant",
          title: "System",
          text: [
            "### Token quota",
            formatTokenStatus(payload.tokenStatus),
            "",
            formatStatusBlock("Codex Account", payload.account, false),
          ].join("\n"),
          pending: false,
          at: Date.now(),
        },
      ]);
      return;
    }

    if (command === "/mcp") {
      const payload = await getMcpStatus();
      pushSlashEntries(sessionKey, [
        {
          key: `slash_${messageId}_mcp`,
          role: "assistant",
          title: "System",
          text: formatStatusBlock("Codex MCP", payload.mcp, true),
          pending: false,
          at: Date.now(),
        },
      ]);
      return;
    }

    const payload = await getSystemStatus();
    pushSlashEntries(sessionKey, [
      {
        key: `slash_${messageId}_status`,
        role: "assistant",
        title: "System",
        text: [
          "### Token quota",
          formatTokenStatus(payload.tokenStatus),
          "",
          formatStatusBlock("Codex Account", payload.account, false),
          formatStatusBlock("Codex MCP", payload.mcp, true),
        ].join("\n\n"),
        pending: false,
        at: Date.now(),
      },
    ]);
  }

  async function onStartRun(): Promise<void> {
    if (!prompt.trim()) return;
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
        {
          key: `slash_${messageId}_user`,
          role: "user",
          title: "You",
          text: trimmedPrompt,
          pending: false,
          at: now,
        },
        {
          key: `slash_${messageId}_error`,
          role: "error",
          title: "System",
          text: `Unknown slash command. Try \`/help\`.\n\n${buildSlashHelpText()}`,
          pending: false,
          at: now + 1,
        },
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

    const isRealSession = sessionKey !== draftSessionKey;
    const hasRunningSessionTask = isRealSession && runningSessionIds.has(sessionKey);
    if (isRealSession && (hasRunningSessionTask || submitting || processingQueueItemId !== null)) {
      enqueueMessage(trimmedPrompt);
      setPrompt("");
      return;
    }

    const request: QueuedMessage = {
      id: `direct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionKey,
      prompt: trimmedPrompt,
      createdAt: Date.now(),
      workspace: activeWorkspace,
      model,
      sandbox,
      approvalPolicy,
      planMode,
    };

    setSubmitting(true);
    try {
      await startCodexRun(request, true);
      setPrompt("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start run";
      window.alert(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onStopRun(): Promise<void> {
    if (!selectedRunId) return;
    setStopping(true);
    try {
      await stopRun(selectedRunId);
      await refreshRuns();
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

    await refreshRuns();
    setIsDraftSession(false);
    setSelectedSessionId(runSessionId(payload.run));
    setSelectedRunId(payload.run.id);
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
    setSelectedSessionId(sessionId);
    const target = allSessions.find((item) => item.id === sessionId);
    if (target) setSelectedRunId(target.latestRun.id);
    setMobileThreadsOpen(false);
  }

  function onNewSession(): void {
    setIsDraftSession(true);
    setSelectedSessionId(null);
    setSelectedRunId(null);
    setPrompt("");
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

  function onSendButtonPressStart(): void {
    if (typeof window === "undefined") return;
    if (submitting || !voiceSupported || !speechRecognitionRef.current) return;

    if (voiceHoldTimerRef.current !== null) {
      window.clearTimeout(voiceHoldTimerRef.current);
      voiceHoldTimerRef.current = null;
    }
    if (voiceHoldSuppressResetTimerRef.current !== null) {
      window.clearTimeout(voiceHoldSuppressResetTimerRef.current);
      voiceHoldSuppressResetTimerRef.current = null;
    }

    voiceHoldTriggeredRef.current = false;
    voiceHoldTimerRef.current = window.setTimeout(() => {
      voiceHoldTriggeredRef.current = true;
      suppressNextSendClickRef.current = true;
      startVoiceInput();
    }, 2000);
  }

  function onSendButtonPressEnd(): void {
    if (typeof window === "undefined") return;

    if (voiceHoldTimerRef.current !== null) {
      window.clearTimeout(voiceHoldTimerRef.current);
      voiceHoldTimerRef.current = null;
    }

    if (!voiceHoldTriggeredRef.current) return;
    voiceHoldTriggeredRef.current = false;
    stopVoiceInput();
    voiceHoldSuppressResetTimerRef.current = window.setTimeout(() => {
      suppressNextSendClickRef.current = false;
      voiceHoldSuppressResetTimerRef.current = null;
    }, 300);
  }

  function onSendButtonClick(): void {
    if (typeof window !== "undefined" && voiceHoldSuppressResetTimerRef.current !== null) {
      window.clearTimeout(voiceHoldSuppressResetTimerRef.current);
      voiceHoldSuppressResetTimerRef.current = null;
    }
    if (suppressNextSendClickRef.current) {
      suppressNextSendClickRef.current = false;
      return;
    }
    void onStartRun();
  }

  async function onArchiveSession(): Promise<void> {
    if (!selectedSessionId || sessionAction || !selectedSession) return;
    const ok = window.confirm("Archive this session? It will be hidden from Chats.");
    if (!ok) return;

    setSessionAction("archive");
    try {
      await archiveSession(selectedSessionId);
      await refreshRuns();
      setMobileContextOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to archive session");
    } finally {
      setSessionAction(null);
    }
  }

  async function onDeleteSession(): Promise<void> {
    if (!selectedSessionId || sessionAction || !selectedSession) return;
    const ok = window.confirm("Delete this session and all its messages? This cannot be undone.");
    if (!ok) return;

    setSessionAction("delete");
    try {
      await deleteSession(selectedSessionId);
      await refreshRuns();
      setMobileContextOpen(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to delete session");
    } finally {
      setSessionAction(null);
    }
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
            onSelectSession={onSelectSession}
            onNewSession={onNewSession}
          />
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CenterPanel
            loading={loading}
            selectedSession={selectedSession}
            selectedRun={selectedRun}
            timeline={timeline}
            prompt={prompt}
            setPrompt={setPrompt}
            submitting={submitting}
            stopping={stopping}
            onStopRun={onStopRun}
            onNewSession={onNewSession}
            hasPendingIndicator={Boolean(selectedRun && selectedRun.status === "running" && !hasPendingTimelineEntry)}
            ansi={ansi}
            timelineBottomRef={timelineBottomRef}
            setToolDetailModal={setToolDetailModal}
            slashSuggestions={slashSuggestions}
            onInsertSlashCommand={(command) => setPrompt(`${command} `)}
            queueItems={queuedMessagesForActiveSession}
            onRemoveQueueItem={(messageId) => removeQueuedMessage(sessionTimelineKey, messageId)}
            voiceSupported={voiceSupported}
            voiceListening={voiceListening}
            voiceError={voiceError}
            onSendButtonPressStart={onSendButtonPressStart}
            onSendButtonPressEnd={onSendButtonPressEnd}
            onSendButtonClick={onSendButtonClick}
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
            planMode={planMode}
            setPlanMode={setPlanMode}
            theme={theme}
            toggleTheme={toggleTheme}
            approvals={pendingApprovals}
            onAcceptApproval={onAcceptApproval}
            diff={diff}
            fileNodes={fileNodes}
            selectedSession={selectedSession}
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
                onSelectSession={onSelectSession}
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
                planMode={planMode}
                setPlanMode={setPlanMode}
                theme={theme}
                toggleTheme={toggleTheme}
                approvals={pendingApprovals}
                onAcceptApproval={onAcceptApproval}
                diff={diff}
                fileNodes={fileNodes}
                selectedSession={selectedSession}
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
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
};

function SessionsPanel({
  sessions,
  selectedSessionId,
  statusFilter,
  setStatusFilter,
  onSelectSession,
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

        <div className="scrollbar-thin flex-1 space-y-2 overflow-auto pr-1">
          {sessions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-card-border bg-muted px-3 py-2 text-xs text-foreground/70">
              No sessions yet
            </div>
          ) : null}

          {sessions.map((session) => (
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
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", statusClass(session.status))}>
                    {session.status}
                  </span>
                  <span className="text-[11px] text-foreground/70">{new Date(session.updatedAt).toLocaleTimeString()}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm font-semibold" title={session.summary}>
                  {session.summary || "Session"}
                </p>
                <p className="mt-1 text-xs text-foreground/70">
                  {`${session.runCount} message${session.runCount > 1 ? "s" : ""}`}
                </p>
              </button>
            </div>
          ))}
        </div>
      </CardContent>
    </>
  );
}

type CenterPanelProps = {
  loading: boolean;
  selectedSession: SessionCard | null;
  selectedRun: RunRecord | null;
  timeline: TimelineEntry[];
  prompt: string;
  setPrompt: (value: string) => void;
  submitting: boolean;
  stopping: boolean;
  onStopRun: () => Promise<void>;
  onNewSession: () => void;
  hasPendingIndicator: boolean;
  ansi: Convert;
  timelineBottomRef: React.RefObject<HTMLDivElement>;
  setToolDetailModal: (state: ToolDetailModalState | null) => void;
  slashSuggestions: SlashCommandSuggestion[];
  onInsertSlashCommand: (command: SlashCommandKey) => void;
  queueItems: QueuedMessage[];
  onRemoveQueueItem: (messageId: string) => void;
  voiceSupported: boolean;
  voiceListening: boolean;
  voiceError: string | null;
  onSendButtonPressStart: () => void;
  onSendButtonPressEnd: () => void;
  onSendButtonClick: () => void;
};

function CenterPanel(props: CenterPanelProps): JSX.Element {
  const { selectedRun } = props;

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
          {selectedRun ? (
            <div className="mt-1 flex items-center gap-2">
              <Badge className={statusClass(selectedRun.status)}>{selectedRun.status}</Badge>
              <Badge>{props.selectedSession?.runCount || 0} messages</Badge>
            </div>
          ) : null}
        </div>

        <Button variant="ghost" size="sm" onClick={props.onNewSession}>
          New session
        </Button>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-0">
        <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-auto px-3 pb-2 pt-3">
          {props.loading ? <p className="text-sm text-foreground/70">Loading...</p> : null}

          {!props.loading && !selectedRun && !props.selectedSession ? (
            <div className="rounded-2xl border border-dashed border-card-border bg-muted px-4 py-3 text-sm text-foreground/75">
              Start a new session or pick one from chats.
            </div>
          ) : null}

          {props.timeline.map((entry) => (
            <article
              key={entry.key}
              className={cn(
                "animate-fade-up rounded-2xl border px-3 py-2 shadow-card",
                entry.role === "user" && "ml-auto max-w-[90%] border-transparent bg-gradient-to-br from-brand to-brand-dark text-white",
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

              {entry.role === "tool" ? (
                <ToolEntry entry={entry} ansi={props.ansi} onOpenOutput={props.setToolDetailModal} />
              ) : entry.role === "assistant" || entry.role === "plan" ? (
                <div className="break-words text-sm leading-relaxed">
                  <MarkdownMessage text={entry.text} />
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
            </article>
          ))}

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
          <div className="relative flex items-end gap-2">
            {props.slashSuggestions.length > 0 ? (
              <div className="absolute bottom-full left-0 right-12 z-10 mb-2 space-y-1 rounded-2xl border border-card-border bg-white/95 p-2 shadow-lg backdrop-blur">
                {props.slashSuggestions.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="w-full rounded-xl border border-transparent px-2 py-2 text-left transition hover:border-card-border hover:bg-muted"
                    onClick={() => props.onInsertSlashCommand(item.key)}
                  >
                    <div className="text-xs font-semibold">{item.key}</div>
                    <div className="text-[11px] text-foreground/70">{item.title} - {item.description}</div>
                  </button>
                ))}
              </div>
            ) : null}

            <textarea
              className="min-h-[44px] max-h-40 w-full resize-y rounded-2xl border border-card-border bg-white px-3 py-2 text-base md:text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
              placeholder="Message Codex... (type / for commands)"
              value={props.prompt}
              onChange={(event) => props.setPrompt(event.target.value)}
            />

            <Button
              type="button"
              className="h-[44px] w-[44px] shrink-0 rounded-full p-0"
              disabled={props.submitting || (!props.prompt.trim() && !props.voiceSupported)}
              aria-label={props.voiceListening ? "Recording (release to stop)" : "Send message (hold 2s for voice input)"}
              title={props.voiceListening ? "Recording (release to stop)" : props.voiceError || "Send message (hold 2s for voice input)"}
              onPointerDown={props.onSendButtonPressStart}
              onPointerUp={props.onSendButtonPressEnd}
              onPointerCancel={props.onSendButtonPressEnd}
              onPointerLeave={props.onSendButtonPressEnd}
              onClick={props.onSendButtonClick}
            >
              {props.submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : props.voiceListening ? <MicOff className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={props.onNewSession}>
              New session
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void props.onStopRun()}
              disabled={!selectedRun || selectedRun.status !== "running" || props.stopping}
            >
              {props.stopping ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <CircleStop className="mr-1.5 h-4 w-4" />}
              Stop
            </Button>
            {selectedRun ? <span className="text-xs text-foreground/70">Run: {selectedRun.id.slice(0, 12)}</span> : null}
          </div>

          {props.queueItems.length > 0 ? (
            <div className="mt-2 rounded-xl border border-card-border bg-white/85 p-2">
              <div className="mb-1 text-xs font-semibold text-foreground/80">Queued messages ({props.queueItems.length})</div>
              <div className="space-y-1">
                {props.queueItems.slice(0, 5).map((item) => (
                  <div key={item.id} className="flex items-center gap-2 rounded-lg bg-muted/60 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground/80" title={item.prompt}>
                      {truncatePreview(item.prompt, 140)}
                    </span>
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
  planMode: boolean;
  setPlanMode: (value: boolean) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  approvals: ApprovalQueueItem[];
  onAcceptApproval: (item: ApprovalQueueItem) => Promise<void>;
  diff: DiffSnapshot | null;
  fileNodes: FileTreeNode[];
  selectedSession: SessionCard | null;
  sessionAction: "archive" | "delete" | null;
  onArchiveSession: () => Promise<void>;
  onDeleteSession: () => Promise<void>;
  mobile?: boolean;
};

function RightPanel(props: RightPanelProps): JSX.Element {
  const [useCustomModel, setUseCustomModel] = useState(() => !modelOptions.includes(props.model));

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
              <Badge>{props.selectedSession ? `${props.selectedSession.runCount} msg` : "none"}</Badge>
            </div>

            {props.selectedSession ? (
              <>
                <p className="mb-2 truncate text-xs text-foreground/70" title={props.selectedSession.id}>
                  {props.selectedSession.id}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={props.sessionAction !== null}
                    onClick={() => void props.onArchiveSession()}
                  >
                    {props.sessionAction === "archive" ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Archive
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                    disabled={props.sessionAction !== null}
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

              <div className="flex items-center justify-between rounded-xl border border-card-border bg-muted px-3 py-2">
                <div>
                  <p className="text-sm font-semibold">Plan mode</p>
                  <p className="text-xs text-foreground/70">Inject planning preamble before prompt</p>
                </div>
                <Button size="sm" variant={props.planMode ? "primary" : "ghost"} onClick={() => props.setPlanMode(!props.planMode)}>
                  {props.planMode ? "On" : "Off"}
                </Button>
              </div>
            </div>
          </section>

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
