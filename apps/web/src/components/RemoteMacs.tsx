import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, Folder, Laptop, LoaderCircle, PanelLeft, RefreshCw, Send, Square, X } from "lucide-react";
import type { RemoteCommand, RemoteDevice, RemoteResult, RemoteSession } from "@luma/shared";
import { request } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { SessionRows } from "./SessionRows";
import { chatComposerClass, chatEntriesClass, chatHeaderClass, chatMessageAlignment, chatMessageClass, chatTimelineClass, MarkdownMessage, ThinkingDots } from "./ChatPresentation";

const refreshMs = 2000;
const devicesKey = ["remote-macs"] as const;

function deviceRequest<T extends RemoteCommand>(id: string, command: T, signal?: AbortSignal) {
  return request<RemoteResult<T["kind"]>>(`/api/remote/devices/${encodeURIComponent(id)}/request`, {
    method: "POST",
    body: JSON.stringify(command),
    signal,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function useRemoteWorkspace(open: boolean) {
  const [deviceId, setDeviceId] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const devices = useQuery({
    queryKey: devicesKey,
    queryFn: ({ signal }) => request<{ devices: RemoteDevice[] }>("/api/remote/devices", { signal }),
    enabled: open,
    refetchInterval: open ? refreshMs : false,
    gcTime: 0,
    retry: false,
  });
  const deviceList = devices.data?.devices ?? [];
  const device = deviceList.find(item => item.id === deviceId) ?? deviceList[0];
  const currentPages = deviceId === device?.id ? pages : [null];
  const cursor = currentPages[currentPages.length - 1];
  const sessions = useQuery({
    queryKey: ["remote-sessions", device?.id, cursor],
    queryFn: ({ signal }) => deviceRequest(device!.id, { kind: "sessions", cursor }, signal),
    enabled: open && Boolean(device?.online),
    refetchInterval: open && device?.online ? refreshMs : false,
    gcTime: 0,
    retry: false,
  });
  const items = sessions.data?.items ?? [];
  const selected = deviceId === device?.id ? items.find(item => item.id === sessionId) : undefined;
  const next = sessions.data?.nextCursor;

  function switchDevice(id: string) {
    setDeviceId(id);
    setSessionId(null);
    setPages([null]);
  }

  return {
    devices, deviceList, device, sessions, items, sessionId, selected,
    switchDevice,
    selectSession(id: string) {
      if (device) setDeviceId(device.id);
      setSessionId(id);
    },
    hasPrevious: currentPages.length > 1,
    hasNext: Boolean(next),
    previousPage() {
      setSessionId(null);
      setPages(current => current.slice(0, -1));
    },
    nextPage() {
      if (!next || !device) return;
      setDeviceId(device.id);
      setSessionId(null);
      setPages([...currentPages, next]);
    },
  };
}

type RemoteWorkspace = ReturnType<typeof useRemoteWorkspace>;

export function RemoteSidebar({ workspace, onCloud, onManage, onSelect }: {
  workspace: RemoteWorkspace;
  onCloud(): void;
  onManage(): void;
  onSelect(id: string): void;
}) {
  const { device, deviceList, devices, sessions } = workspace;
  const projects = new Map<string | null, RemoteSession[]>();
  for (const session of workspace.items) {
    const group = projects.get(session.projectName) ?? [];
    group.push(session);
    projects.set(session.projectName, group);
  }
  const projectNames = [...projects.keys()].filter(name => name !== null).sort((a, b) => a.localeCompare(b));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-card-border px-3 py-2">
        <Button type="button" variant="ghost" className="h-10" onClick={onCloud}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Cloud sessions
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onManage}>{deviceList.length ? "Manage Macs" : "Pair a Mac"}</Button>
      </div>
      {device ? (
        <div className="border-b border-card-border px-3 py-2">
          <select aria-label="Mac" value={device.id} onChange={event => workspace.switchDevice(event.target.value)}
            className="h-9 w-full rounded-md border border-card-border bg-control px-2 text-sm">
            {deviceList.map(item => <option key={item.id} value={item.id}>{item.name} · {item.online ? "Online" : "Offline"}</option>)}
          </select>
        </div>
      ) : null}
      <nav aria-label="Mac sessions" className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
        {devices.isPending ? <p className="px-2 text-sm text-foreground/65">Checking paired Macs…</p> : null}
        {devices.error || (device?.online && sessions.error) ? (
          <p role="alert" className="px-2 text-sm text-danger-fg">{errorText(devices.error || sessions.error)}</p>
        ) : null}
        {device?.online && !devices.isError ? <>
          {sessions.isPending ? <p className="px-2 text-sm text-foreground/65">Loading sessions…</p> : null}
          {projectNames.map(name => (
            <details key={name} open>
              <summary className="cursor-pointer rounded-md px-2 py-1.5 text-sm font-medium text-foreground/85 hover:bg-control-hover">
                <span className="ml-1 inline-flex max-w-[90%] items-center gap-2 align-middle">
                  <Folder className="h-4 w-4 shrink-0 text-brand" />
                  <span className="truncate" dir="auto">{name}</span>
                </span>
              </summary>
              <div className="ml-4 border-l border-card-border pl-2">
                <SessionRows sessions={projects.get(name)!} selectedSessionId={workspace.sessionId} onSelectSession={onSelect} />
              </div>
            </details>
          ))}
          {projects.has(null) ? (
            <section aria-label="Recents">
              <h2 className="mb-1.5 px-2 text-xs font-semibold text-foreground/65">Recents</h2>
              <SessionRows sessions={projects.get(null)!} selectedSessionId={workspace.sessionId} onSelectSession={onSelect} />
            </section>
          ) : null}
          {sessions.isSuccess && !workspace.items.length ? <p className="px-2 text-sm text-foreground/65">No shared sessions.</p> : null}
          {workspace.hasPrevious || workspace.hasNext ? <div className="flex gap-1">
            {workspace.hasPrevious ? <Button type="button" variant="ghost" size="sm" onClick={workspace.previousPage}>Newer sessions</Button> : null}
            {workspace.hasNext ? <Button type="button" variant="ghost" size="sm" onClick={workspace.nextPage}>Older sessions</Button> : null}
          </div> : null}
        </> : null}
      </nav>
    </div>
  );
}

export function RemoteMacs({ open, setOpen, workspace }: {
  open: boolean;
  setOpen(open: boolean): void;
  workspace: RemoteWorkspace;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/55" />
        <Dialog.Content className="fixed inset-x-2 top-1/2 z-[81] mx-auto max-h-[calc(100dvh-16px)] max-w-md -translate-y-1/2 overflow-auto rounded-lg border border-card-border bg-surface-1 shadow-xl outline-none">
          <header className="flex items-start justify-between gap-4 border-b border-card-border px-4 py-3">
            <div>
              <Dialog.Title className="flex items-center gap-2 font-semibold"><Laptop className="h-4 w-4" /> Manage Macs</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-foreground/65">Pair or remove a Mac.</Dialog.Description>
            </div>
            <Dialog.Close asChild><Button type="button" variant="ghost" size="sm" aria-label="Close Manage Macs"><X className="h-4 w-4" /></Button></Dialog.Close>
          </header>
          {open ? <RemoteMacsBody workspace={workspace} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RemoteMacsBody({ workspace }: { workspace: RemoteWorkspace }) {
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { device, deviceList, devices } = workspace;
  const pair = useMutation({
    mutationFn: async () => {
      const existingIds = deviceList.map(item => item.id);
      const data = await request<{ code: string; expiresAt: number }>("/api/remote/pair", { method: "POST" });
      return { ...data, existingIds };
    },
    onMutate: () => setCopied(false),
  });
  const pairing = pair.data;
  const codeUsed = Boolean(pairing && deviceList.some(item => !pairing.existingIds.includes(item.id)));
  const resetPair = pair.reset;
  useEffect(() => { if (codeUsed) resetPair(); }, [codeUsed, resetPair]);
  const pairingCode = pairing && Date.now() < pairing.expiresAt && !codeUsed ? pairing.code : null;
  const remove = useMutation({
    mutationFn: (id: string) => request(`/api/remote/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmRemove(false);
      void client.invalidateQueries({ queryKey: devicesKey });
    },
  });

  return (
    <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-2">
          {device ? (
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
              Mac
              <select aria-label="Mac to manage" value={device.id} onChange={event => { workspace.switchDevice(event.target.value); setConfirmRemove(false); }}
                className="h-9 min-w-0 rounded-md border border-card-border bg-control px-2 text-sm">
                {deviceList.map(item => <option key={item.id} value={item.id}>{item.name} · {item.online ? "Online" : "Offline"}</option>)}
              </select>
            </label>
          ) : null}
          <Button type="button" variant="soft" size="sm" disabled={pair.isPending || !devices.isSuccess} onClick={() => pair.mutate()}>Pair a Mac</Button>
          {device ? (
            <Button type="button" variant="ghost" size="sm" disabled={remove.isPending} onClick={() => setConfirmRemove(true)}>Remove Mac</Button>
          ) : null}
        </div>
        {confirmRemove && device ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Revoke access to {device.name}?</span>
            <Button type="button" variant="danger" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(device.id)}>Revoke access</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        ) : null}
        {pairingCode ? (
          <div className="rounded-md border border-card-border bg-surface-2 p-3">
            <p className="mb-2 text-xs text-foreground/75">Paste this one-time code in Desktop settings → Remote access. It expires in five minutes.</p>
            <div className="flex items-center gap-2">
              <code aria-label="Pairing code" className="min-w-0 select-all break-all font-mono text-sm">{pairingCode}</code>
              <Button type="button" variant="ghost" size="sm" aria-label={copied ? "Code copied" : "Copy pairing code"} onClick={() => {
                void navigator.clipboard?.writeText(pairingCode).then(() => setCopied(true), () => setCopied(false));
              }}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</Button>
            </div>
          </div>
        ) : null}
        {devices.error || pair.error || remove.error
          ? <p role="alert" className="text-sm text-danger-fg">{errorText(devices.error || pair.error || remove.error)}</p> : null}
        {devices.isPending ? <p className="text-sm text-foreground/65">Checking paired Macs…</p> : null}
        {!devices.isPending && !devices.isError && !device && !pairingCode ? <p className="text-sm text-foreground/65">Pair a Mac to see its shared sessions here.</p> : null}
    </div>
  );
}

export function RemoteConversationHeader({
  title, subtitle, leftSidebarOpen, onOpenSidebar, actions,
}: {
  title: string;
  subtitle?: string;
  leftSidebarOpen: boolean;
  onOpenSidebar(): void;
  actions?: React.ReactNode;
}) {
  return (
    <div className={chatHeaderClass}>
      <div className="flex min-w-0 items-center gap-2">
        {!leftSidebarOpen ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0"
            onClick={onOpenSidebar} aria-label="Open left sidebar"><PanelLeft className="h-3.5 w-3.5" /></Button>
        ) : null}
        <Laptop className="h-4 w-4 shrink-0 text-foreground/70" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold" title={title} dir="auto">{title}</h1>
          {subtitle ? <div className="truncate text-[11px] text-foreground/60" title={subtitle}>{subtitle}</div> : null}
        </div>
      </div>
      {actions}
    </div>
  );
}

export function RemoteConversation({ device, session, leftSidebarOpen, onOpenSidebar, headerAction }: {
  device: RemoteDevice;
  session: RemoteSession;
  leftSidebarOpen: boolean;
  onOpenSidebar(): void;
  headerAction?: React.ReactNode;
}) {
  const client = useQueryClient();
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [draft, setDraft] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const timeline = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const scrollToTop = useRef(false);
  const sendAttempt = useRef<{ id: string; text: string } | null>(null);
  const sending = useRef(false);
  const before = pages[pages.length - 1];
  const latestRunId = session.latestRunId;
  const messages = useQuery({
    queryKey: ["remote-messages", device.id, session.id, before],
    queryFn: ({ signal }) => deviceRequest(device.id, { kind: "messages", sessionId: session.id, before }, signal),
    enabled: device.online,
    refetchInterval: before ? false : refreshMs,
    gcTime: 0,
    retry: false,
  });
  const action = useMutation({
    mutationFn: (command: Extract<RemoteCommand, { kind: "send" | "stop" }>) => deviceRequest(device.id, command),
    onSuccess: (_data, command) => {
      if (command.kind === "send") {
        setDraft("");
        sendAttempt.current = null;
        setPages([null]);
      }
      void client.invalidateQueries({ queryKey: ["remote-messages", device.id, session.id] });
      void client.invalidateQueries({ queryKey: ["remote-sessions", device.id] });
    },
    onSettled: () => { sending.current = false; },
  });
  const active = latestRunId && (session.status === "running" || session.status === "queued");

  function perform(command: Extract<RemoteCommand, { kind: "send" | "stop" }>) {
    if (sending.current) return;
    sending.current = true;
    action.mutate(command);
  }

  useLayoutEffect(() => {
    const node = timeline.current;
    if (!node || !messages.data) return;
    if (scrollToTop.current) {
      node.scrollTop = 0;
      scrollToTop.current = false;
    } else if (stickToBottom.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.data, device.online]);

  function changeMessagePage(next: (string | null)[]) {
    const latestPage = next.length === 1;
    stickToBottom.current = latestPage;
    scrollToTop.current = !latestPage;
    setPages(next);
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text || sending.current || !device.online || !device.canControl || !session.canSend) return;
    if (!sendAttempt.current || sendAttempt.current.text !== text) sendAttempt.current = { id: crypto.randomUUID(), text };
    stickToBottom.current = true;
    scrollToTop.current = false;
    perform({ kind: "send", sessionId: session.id, text, clientMessageId: sendAttempt.current.id });
  }

  const runner = { codex: "Codex", claude: "Claude Code", cursor: "Cursor" }[session.runner];
  return (
    <section aria-label="Mac conversation" className="flex min-h-0 flex-1 flex-col">
      <RemoteConversationHeader
        title={session.title} leftSidebarOpen={leftSidebarOpen} onOpenSidebar={onOpenSidebar}
        subtitle={[device.name, session.projectName, runner, device.online ? session.status : "Offline"].filter(Boolean).join(" · ")}
        actions={(
          <div className="flex shrink-0 items-center gap-1">
            {headerAction}
            {device.online ? (
              <Button type="button" size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0"
                aria-label="Reload chat" title="Reload chat" onClick={() => void messages.refetch()}>
                <RefreshCw className={cn("h-3.5 w-3.5", messages.isFetching && "motion-safe:animate-spin")} />
              </Button>
            ) : null}
          </div>
        )}
      />
      {device.online ? <>
        <div ref={timeline} className={chatTimelineClass} aria-label="Messages" onScroll={event => {
          const node = event.currentTarget;
          stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
        }}>
          <div className={chatEntriesClass}>
            {before || messages.data?.nextCursor ? <div className="flex flex-wrap justify-center gap-2">
              {before ? <Button type="button" variant="ghost" size="sm" onClick={() => changeMessagePage(pages.slice(0, -1))}>Newer messages</Button> : null}
              {messages.data?.nextCursor ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => changeMessagePage([...pages, messages.data!.nextCursor!])}>Load older messages</Button>
              ) : null}
            </div> : null}
            {messages.isPending ? <p className="text-sm text-foreground/65">Loading messages…</p> : null}
            {messages.error ? <p role="alert" className="text-sm text-danger-fg">{errorText(messages.error)}</p> : null}
            {messages.isSuccess && !messages.data.messages.length ? <p className="text-sm text-foreground/65">No messages on this page.</p> : null}
            {!messages.isError ? messages.data?.messages.map(message => (
              <div key={message.id} className={chatMessageAlignment(message.role)}>
                <article className={chatMessageClass(message.role, message.deliveryStatus === "failed")}>
                  {message.role === "assistant" || message.role === "plan" ? (
                    <div className="break-words text-[15px] leading-7"><MarkdownMessage text={message.text} allowImages={false} /></div>
                  ) : <p dir="auto" className="whitespace-pre-wrap break-words">{message.text}</p>}
                  {message.role === "user" && message.deliveryStatus !== "sent" ? (
                    <div className="mt-1 text-right text-[11px] text-foreground/70">
                      {message.deliveryStatus === "failed" ? "Failed to send" : "Sending…"}
                    </div>
                  ) : null}
                </article>
                {(message.role === "user" || message.role === "assistant" || message.role === "plan") && message.text.trim() ? (
                  <button type="button"
                    className="mt-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground/40 hover:bg-control-hover hover:text-foreground/75"
                    aria-label={copiedId === message.id ? "Message copied" : "Copy message"}
                    onClick={() => void navigator.clipboard?.writeText(message.text).then(() => setCopiedId(message.id), () => setCopiedId(""))}>
                    {copiedId === message.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                ) : null}
              </div>
            )) : null}
            {active && !before ? <ThinkingDots /> : null}
          </div>
        </div>
        <div className={chatComposerClass}>
          <div className="mx-auto w-full max-w-5xl space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p role="status" className="min-w-0 truncate text-xs text-foreground/65">
                {runner} · <span className="capitalize">{session.status}</span>
              </p>
              {device.canControl && active ? (
                <Button type="button" variant="ghost" size="sm" disabled={action.isPending}
                  onClick={() => perform({ kind: "stop", sessionId: session.id, runId: latestRunId })}>
                  <Square className="mr-1 h-3 w-3" />Stop run
                </Button>
              ) : null}
            </div>
            {device.canControl && session.canSend && !messages.isError ? (
              <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); sendDraft(); }}>
                <textarea aria-label="Message to this Mac" placeholder="Send a follow-up…" rows={1} maxLength={8000}
                  className="max-h-40 min-h-11 min-w-0 flex-1 resize-y rounded-lg border border-card-border bg-control px-3 py-2.5 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 md:text-sm"
                  disabled={action.isPending} value={draft} onChange={event => setDraft(event.target.value)} dir="auto"
                  onKeyDown={event => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || window.matchMedia("(pointer: coarse)").matches) return;
                    event.preventDefault();
                    sendDraft();
                  }} />
                <Button type="submit" aria-label="Send message" title="Send message" className="h-11 w-11 shrink-0 p-0"
                  disabled={!draft.trim() || action.isPending}>
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            ) : !device.canControl ? (
              <p className="text-xs text-foreground/65">View only. Enable remote control in Desktop settings to send messages or stop runs.</p>
            ) : !session.canSend ? <p className="text-xs text-foreground/65">Follow-ups are available after this session starts.</p> : null}
            {action.error ? <p role="alert" className="text-sm text-danger-fg">{errorText(action.error)}</p> : null}
          </div>
        </div>
      </> : (
        <div className="grid min-h-0 flex-1 place-items-center px-6">
          <p role="status" className="text-sm text-foreground/70">{device.name} is offline.</p>
        </div>
      )}
    </section>
  );
}
