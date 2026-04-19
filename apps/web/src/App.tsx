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
  CircleStop,
  Layers,
  LogIn,
  LogOut,
  MessageSquare,
  PanelLeft,
  PanelRight,
  RefreshCcw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { type AllowedRpcMethod, type SseEvent } from "@assistant/shared";
import { rpc, bootstrap, login, logout, respondToServerRequest } from "@/lib/api";
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

function getThreadTitle(thread: ThreadRecord): string {
  return thread.name || thread.preview || thread.id;
}

function summarizeItem(item: Record<string, unknown>): string {
  const clone = { ...item };
  delete clone.id;
  return safeJsonStringify(clone);
}

function resolvePlanText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim().length > 0) {
    return item.text;
  }
  if (typeof item.plan === "string" && item.plan.trim().length > 0) {
    return item.plan;
  }
  return summarizeItem(item);
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
          <blockquote className="my-2 border-l-2 border-foreground/30 pl-3 italic text-foreground/80">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand underline underline-offset-2 hover:text-brand-dark"
          >
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

function App(): JSX.Element {
  const {
    defaults,
    account,
    threads,
    archivedThreads,
    mcpServers,
    activeThreadId,
    activeThreadArchived,
    activeTurnId,
    showArchived,
    timelines,
    setBootstrap,
    setAccount,
    setMcpServers,
    setShowArchived,
    setActiveThread,
    setActiveTurnId,
    upsertThread,
    moveThreadToArchive,
    moveThreadToActive,
    setThreadTimeline,
    appendTimelineEntry,
    upsertTimelineEntry,
    clearSession,
  } = useAssistantStore();

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [chatgptAuthUrl, setChatgptAuthUrl] = useState<string | null>(null);
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [toastText, setToastText] = useState<string | null>(null);

  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const activeTimeline = activeThreadId ? timelines[activeThreadId] || [] : [];
  const visibleThreads = showArchived ? archivedThreads : threads;
  const activeThread = (activeThreadArchived ? archivedThreads : threads).find((thread) => thread.id === activeThreadId) || null;
  const activeApproval = pendingApprovals[0] || null;
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

  function setToast(message: string): void {
    setToastText(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastText(null);
    }, 2300);
  }

  async function hydrateFromBootstrap(): Promise<void> {
    const payload = await bootstrap();
    setBootstrap(payload);

    const initialThreads = payload.data?.threads?.data || [];
    if (!activeThreadId && initialThreads.length > 0) {
      await openThread(initialThreads[0].id, false);
    }
  }

  async function probeSession(): Promise<void> {
    setIsCheckingSession(true);
    try {
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
      const result = (await rpc("thread/read", {
        threadId,
        includeTurns: true,
      })) as Record<string, unknown>;

      const thread = isObject(result.thread) ? (result.thread as ThreadRecord) : null;
      if (!thread?.id) return;

      const entries: TimelineEntry[] = [];
      const turns = Array.isArray((thread as Record<string, unknown>).turns)
        ? ((thread as Record<string, unknown>).turns as Record<string, unknown>[])
        : [];

      for (const turn of turns) {
        const items = Array.isArray(turn.items) ? (turn.items as Record<string, unknown>[]) : [];
        for (const item of items) {
          const id = typeof item.id === "string" ? item.id : `${Date.now()}-${Math.random()}`;

          if (item.type === "userMessage") {
            entries.push({
              key: `history:${id}`,
              role: "user",
              title: "You",
              text: coerceTextContent(item.content),
            });
            continue;
          }

          if (item.type === "agentMessage") {
            entries.push({
              key: `history:${id}`,
              role: "agent",
              title: "Assistant",
              text: typeof item.text === "string" ? item.text : "",
            });
            continue;
          }

          if (item.type === "plan") {
            entries.push({
              key: `history:${id}`,
              role: "plan",
              title: "Plan",
              text: resolvePlanText(item),
            });
            continue;
          }

          entries.push({
            key: `history:${id}`,
            role: "tool",
            title: typeof item.type === "string" ? item.type : "item",
            text: summarizeItem(item),
          });
        }
      }

      setActiveThread(thread.id, archived);
      setThreadTimeline(thread.id, entries);
      closeMobilePanels();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to open thread");
    }
  }

  async function createThread(): Promise<void> {
    try {
      const result = (await rpc("thread/start", {
        model: defaults?.model,
        cwd: defaults?.cwd,
        approvalPolicy: defaults?.approvalPolicy,
      })) as Record<string, unknown>;

      const thread = isObject(result.thread) ? (result.thread as ThreadRecord) : null;
      if (!thread?.id) throw new Error("Failed to create thread");

      upsertThread(thread, false);
      setActiveThread(thread.id, false);
      setThreadTimeline(thread.id, []);
      setShowArchived(false);
      closeMobilePanels();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to create thread");
    }
  }

  async function archiveOrUnarchiveThread(): Promise<void> {
    if (!activeThreadId) return;

    try {
      if (activeThreadArchived) {
        await rpc("thread/unarchive", { threadId: activeThreadId });
        moveThreadToActive(activeThreadId);
        setActiveThread(activeThreadId, false);
        setShowArchived(false);
      } else {
        await rpc("thread/archive", { threadId: activeThreadId });
        moveThreadToArchive(activeThreadId);
        setActiveThread(activeThreadId, true);
        setShowArchived(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Archive operation failed");
    }
  }

  async function interruptTurn(): Promise<void> {
    if (!activeThreadId || !activeTurnId) return;
    try {
      await rpc("turn/interrupt", {
        threadId: activeThreadId,
        turnId: activeTurnId,
      });
      setToast("Interrupt requested");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Interrupt failed");
    }
  }

  async function sendMessage(inputText: string): Promise<void> {
    const text = inputText.trim();
    if (!text) return;

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

    try {
      const result = (await rpc("turn/start", {
        threadId,
        input: [{ type: "text", text }],
      })) as Record<string, unknown>;

      if (isObject(result.turn) && typeof result.turn.id === "string") {
        setActiveTurnId(result.turn.id);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to send message");
    }
  }

  async function refreshAccount(): Promise<void> {
    try {
      const result = (await rpc("account/read", { refreshToken: false })) as Record<string, unknown>;
      setAccount(result.account || null);
    } catch {
      setAccount(null);
    }
  }

  async function refreshMcpServers(): Promise<void> {
    try {
      const result = (await rpc("mcpServerStatus/list", {
        cursor: null,
        limit: 100,
        detail: "toolsAndAuthOnly",
      })) as Record<string, unknown>;
      setMcpServers(parseMcpServers(result));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Failed to refresh MCP servers");
    }
  }

  async function startChatGptLogin(): Promise<void> {
    try {
      const result = (await rpc("account/login/start", {
        type: "chatgpt",
      })) as Record<string, unknown>;

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
      await rpc("config/mcpServer/reload", {});
      await refreshMcpServers();
      setToast("MCP config reloaded");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "MCP reload failed");
    }
  }

  async function runMcpOauth(serverName: string): Promise<void> {
    try {
      const result = (await rpc("mcpServer/oauth/login", {
        name: serverName,
      })) as Record<string, unknown>;

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

  function handleNotification(method: string, params: Record<string, unknown>): void {
    const threadId = (params.threadId as string | undefined) || activeThreadId || null;

    if (method === "thread/started" && isObject(params.thread) && typeof params.thread.id === "string") {
      upsertThread(params.thread as ThreadRecord, false);
      return;
    }

    if (method === "thread/archived" && typeof params.threadId === "string") {
      moveThreadToArchive(params.threadId);
      if (activeThreadId === params.threadId) {
        setActiveThread(params.threadId, true);
      }
      return;
    }

    if (method === "thread/unarchived" && typeof params.threadId === "string") {
      moveThreadToActive(params.threadId);
      if (activeThreadId === params.threadId) {
        setActiveThread(params.threadId, false);
      }
      return;
    }

    if (method === "turn/started" && isObject(params.turn) && typeof params.turn.id === "string") {
      setActiveTurnId(params.turn.id);
      return;
    }

    if (method === "turn/completed") {
      setActiveTurnId(null);
      return;
    }

    if (method === "item/started" && isObject(params.item) && threadId) {
      const item = params.item as Record<string, unknown>;
      const itemId = typeof item.id === "string" ? item.id : `${Date.now()}-${Math.random()}`;

      if (item.type === "userMessage") {
        const text = coerceTextContent(item.content);
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

      if (item.type === "plan") {
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "plan",
          title: "Plan",
          text: resolvePlanText(item) || existing?.text || "",
        }));
        return;
      }

      if (item.type === "agentMessage") {
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "agent",
          title: "Assistant",
          text: typeof item.text === "string" ? item.text : existing?.text || "",
        }));
        return;
      }

      upsertTimelineEntry(threadId, `item:${itemId}`, () => ({
        key: `item:${itemId}`,
        role: "tool",
        title: `${String(item.type || "item")} (in progress)`,
        text: summarizeItem(item),
      }));
      return;
    }

    if (method === "item/completed" && isObject(params.item) && threadId) {
      const item = params.item as Record<string, unknown>;
      const itemId = typeof item.id === "string" ? item.id : `${Date.now()}-${Math.random()}`;

      if (item.type === "plan") {
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "plan",
          title: "Plan",
          text: resolvePlanText(item) || existing?.text || "",
        }));
        return;
      }

      if (item.type === "agentMessage") {
        upsertTimelineEntry(threadId, `item:${itemId}`, (existing) => ({
          key: `item:${itemId}`,
          role: "agent",
          title: "Assistant",
          text: typeof item.text === "string" ? item.text : existing?.text || "",
        }));
        return;
      }

      upsertTimelineEntry(threadId, `item:${itemId}`, () => ({
        key: `item:${itemId}`,
        role: "tool",
        title: String(item.type || "item"),
        text: summarizeItem(item),
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
        title: "commandExecution",
        text: `${existing?.text || ""}${delta}`,
      }));
      return;
    }

    if (method === "account/login/completed") {
      if (params.success === true) {
        void refreshAccount();
        setToast("ChatGPT login completed");
      } else {
        setToast(typeof params.error === "string" ? params.error : "Login failed");
      }
      return;
    }

    if (method === "account/updated") {
      void refreshAccount();
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

    const source = new EventSource("/api/events", { withCredentials: true });
    eventSourceRef.current = source;

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as SseEvent;

        if (payload.kind === "notification") {
          handleNotification(payload.method, payload.params);
          return;
        }

        if (payload.kind === "serverRequest") {
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
      setToast("Live stream interrupted, reconnecting...");
    };
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
    timelineBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeTimeline.length]);

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

      <div className="mx-auto grid h-full min-h-0 max-w-[1800px] grid-cols-1 gap-3 p-3 pt-14 lg:grid-cols-[320px_minmax(0,1fr)_340px] lg:pt-3">
        <Card className="hidden min-h-0 flex-col overflow-hidden lg:flex">
          <ThreadsPanel
            threads={threads}
            archivedThreads={archivedThreads}
            showArchived={showArchived}
            activeThreadId={activeThreadId}
            onToggleArchived={setShowArchived}
            onCreateThread={() => void createThread()}
            onOpenThread={(threadId) => void openThread(threadId, showArchived)}
          />
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="hidden items-start justify-between gap-3 lg:flex">
            <div className="min-w-0">
              <CardTitle
                className="truncate text-base"
                title={activeThread ? getThreadTitle(activeThread) : "No active chat"}
              >
                {activeThread ? getThreadTitle(activeThread) : "No active chat"}
              </CardTitle>
              <p className="mt-1 font-mono text-[11px] text-foreground/70">
                {activeThread ? `Thread: ${activeThread.id}` : "Create or select a chat to start"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" disabled={!activeThreadId} onClick={() => void archiveOrUnarchiveThread()}>
                <Archive className="mr-1.5 h-4 w-4" /> {activeThreadArchived ? "Unarchive" : "Archive"}
              </Button>
              <Button variant="ghost" size="sm" disabled={!activeThreadId || !activeTurnId} onClick={() => void interruptTurn()}>
                <CircleStop className="mr-1.5 h-4 w-4" /> Interrupt
              </Button>
            </div>
          </CardHeader>

          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-0">
            <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-auto px-3 pb-2 pt-3">
              {!activeTimeline.length ? (
                <div className="rounded-2xl border border-dashed border-card-border bg-muted px-4 py-3 text-sm text-foreground/75">
                  No messages yet.
                </div>
              ) : null}

              {activeTimeline.map((entry) => (
                <article
                  key={entry.key}
                  className={cn(
                    "animate-fade-up rounded-2xl border px-3 py-2 shadow-card",
                    entry.role === "user" && "ml-auto max-w-[90%] border-transparent bg-gradient-to-br from-brand to-brand-dark text-white",
                    entry.role === "agent" && "mr-auto max-w-[90%] border-card-border bg-white",
                    entry.role === "plan" && "mr-auto max-w-full border-brand/35 bg-brand-soft/55",
                    entry.role === "tool" && "max-w-full border-dashed border-card-border bg-muted font-mono text-xs",
                  )}
                >
                  {entry.title ? (
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-foreground/70">{entry.title}</div>
                  ) : null}
                  {entry.role === "tool" ? (
                    <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">{entry.text}</pre>
                  ) : (
                    <div className="break-words text-sm leading-relaxed">
                      <MarkdownMessage text={entry.text} />
                    </div>
                  )}
                </article>
              ))}

              <div ref={timelineBottomRef} />
            </div>

            <ChatComposer onSend={sendMessage} />
          </CardContent>
        </Card>

        <Card className="hidden min-h-0 flex-col overflow-auto lg:flex">
          <ContextPanel
            account={account}
            settings={settingsSummary}
            mcpServers={mcpServers}
            chatgptAuthUrl={chatgptAuthUrl}
            activeThreadId={activeThreadId}
            activeThreadArchived={activeThreadArchived}
            activeTurnId={activeTurnId}
            onLogin={() => void startChatGptLogin()}
            onLogout={() => logoutMutation.mutate()}
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
            <Card className="flex h-full min-h-0 flex-col overflow-hidden animate-slide-in">
              <ThreadsPanel
                threads={threads}
                archivedThreads={archivedThreads}
                showArchived={showArchived}
                activeThreadId={activeThreadId}
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
          <Dialog.Content className="fixed inset-y-0 right-0 z-40 w-[min(370px,95vw)] border-l border-card-border bg-background p-3 outline-none">
            <Card className="flex h-full min-h-0 flex-col animate-slide-in overflow-auto">
              <ContextPanel
                account={account}
                settings={settingsSummary}
                mcpServers={mcpServers}
                chatgptAuthUrl={chatgptAuthUrl}
                activeThreadId={activeThreadId}
                activeThreadArchived={activeThreadArchived}
                activeTurnId={activeTurnId}
                onLogin={() => void startChatGptLogin()}
                onLogout={() => logoutMutation.mutate()}
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
            <h2 className="mb-1 text-lg font-bold">Approval required</h2>
            <p className="mb-2 text-sm text-foreground/70">
              {activeApproval ? activeApproval.method : "Pending request"}
            </p>
            <pre className="scrollbar-thin max-h-[40vh] overflow-auto rounded-2xl border border-card-border bg-muted p-3 font-mono text-xs">
              {activeApproval ? safeJsonStringify(activeApproval.params) : ""}
            </pre>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => void handleApprovalDecision("accept")}>Accept</Button>
              <Button variant="ghost" onClick={() => void handleApprovalDecision("acceptForSession")}>Accept for session</Button>
              <Button variant="ghost" onClick={() => void handleApprovalDecision("decline")}>Decline</Button>
              <Button variant="ghost" onClick={() => void handleApprovalDecision("cancel")}>Cancel</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!isAuthenticated && !isCheckingSession}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-card-border bg-white p-6 shadow-soft outline-none">
            <h1 className="text-2xl font-bold tracking-tight">Personal Codex Assistant</h1>
            <p className="mt-1 text-sm text-foreground/70">Enter your assistant password to continue.</p>

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
                <p className="text-sm text-red-600">
                  {loginMutation.error instanceof Error ? loginMutation.error.message : "Login failed"}
                </p>
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

      {toastText ? (
        <div className="fixed bottom-4 right-4 z-50 rounded-xl bg-[#102735] px-4 py-2 text-sm text-white shadow-soft">{toastText}</div>
      ) : null}
    </div>
  );
}

function ChatComposer({
  onSend,
}: {
  onSend: (text: string) => Promise<void>;
}): JSX.Element {
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const value = text.trim();
    if (!value || isSending) return;

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
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <textarea
          className="min-h-[48px] max-h-44 w-full resize-y rounded-2xl border border-card-border bg-white px-3 py-2 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
          placeholder="Message Codex..."
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" className="sm:h-auto" disabled={isSending}>
          <Send className="mr-1.5 h-4 w-4" /> Send
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
  onToggleArchived,
  onCreateThread,
  onOpenThread,
}: {
  threads: ThreadRecord[];
  archivedThreads: ThreadRecord[];
  showArchived: boolean;
  activeThreadId: string | null;
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
        <Button size="sm" onClick={onCreateThread}>New</Button>
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

          {data.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={cn(
                "w-full rounded-2xl border bg-white px-3 py-2 text-left shadow-card transition hover:-translate-y-0.5 hover:border-brand/60",
                activeThreadId === thread.id ? "border-brand bg-brand-soft/60" : "border-card-border",
              )}
              onClick={() => onOpenThread(thread.id)}
            >
              <div className="truncate text-sm font-semibold">{getThreadTitle(thread)}</div>
              <div className="mt-1 truncate text-xs text-foreground/70">{thread.preview || "No preview"}</div>
            </button>
          ))}
        </div>
      </CardContent>
    </>
  );
}

function ContextPanel({
  account,
  settings,
  mcpServers,
  chatgptAuthUrl,
  activeThreadId,
  activeThreadArchived,
  activeTurnId,
  onLogin,
  onLogout,
  onReloadMcp,
  onMcpOauth,
  onArchiveToggle,
  onInterrupt,
}: {
  account: unknown;
  settings: { label: string; value: string }[];
  mcpServers: Record<string, unknown>[];
  chatgptAuthUrl: string | null;
  activeThreadId: string | null;
  activeThreadArchived: boolean;
  activeTurnId: string | null;
  onLogin: () => void;
  onLogout: () => void;
  onReloadMcp: () => void;
  onMcpOauth: (name: string) => void;
  onArchiveToggle: () => void;
  onInterrupt: () => void;
}): JSX.Element {
  const accountLabel = useMemo(() => {
    if (!isObject(account)) return "Not authenticated";
    if (account.type === "chatgpt") {
      const email = typeof account.email === "string" ? account.email : "ChatGPT account";
      const plan = typeof account.planType === "string" ? ` (${account.planType})` : "";
      return `${email}${plan}`;
    }
    return `Authenticated: ${String(account.type || "unknown")}`;
  }, [account]);

  return (
    <div className="space-y-4 p-3">
      <section className="rounded-2xl border border-card-border bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold">Thread controls</h3>
          <Badge>{activeThreadId ? "active" : "none"}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={onArchiveToggle} disabled={!activeThreadId}>
            <Archive className="mr-1.5 h-4 w-4" /> {activeThreadArchived ? "Unarchive" : "Archive"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onInterrupt} disabled={!activeThreadId || !activeTurnId}>
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
    </div>
  );
}

export default App;
