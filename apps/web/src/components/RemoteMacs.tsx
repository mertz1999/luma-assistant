import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Laptop, LoaderCircle, Send, Square, X } from "lucide-react";
import type { RemoteCommand, RemoteDevice, RemoteResult, RemoteSession } from "@luma/shared";
import { request } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

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

export function RemoteMacs({ open, setOpen }: { open: boolean; setOpen(open: boolean): void }) {
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/55" />
        <Dialog.Content className="fixed inset-x-2 top-[50%] z-[81] mx-auto flex max-h-[calc(100dvh-16px)] max-w-4xl -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-card-border bg-surface-1 shadow-xl outline-none">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-card-border px-4 py-3">
            <div>
              <Dialog.Title className="flex items-center gap-2 font-semibold"><Laptop className="h-4 w-4" /> Remote Macs</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-foreground/65">Open sessions running in Luma Desktop.</Dialog.Description>
            </div>
            <Dialog.Close asChild><Button variant="ghost" size="sm" aria-label="Close Remote Macs"><X className="h-4 w-4" /></Button></Dialog.Close>
          </header>
          {open ? <RemoteMacsBody /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RemoteMacsBody() {
  const client = useQueryClient();
  const [deviceId, setDeviceId] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const devices = useQuery({
    queryKey: devicesKey,
    queryFn: ({ signal }) => request<{ devices: RemoteDevice[] }>("/api/remote/devices", { signal }),
    refetchInterval: refreshMs,
    gcTime: 0,
    retry: false,
  });
  const deviceList = devices.data?.devices ?? [];
  const device = deviceList.find(item => item.id === deviceId) ?? deviceList.find(item => item.online) ?? deviceList[0];
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
    <div className="min-h-0 overflow-y-auto">
      <div className="space-y-3 border-b border-card-border p-4">
        <div className="flex flex-wrap items-end gap-2">
          {device ? (
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
              Mac
              <select value={device.id} onChange={event => { setDeviceId(event.target.value); setConfirmRemove(false); }}
                className="h-9 min-w-0 rounded-md border border-card-border bg-control px-2 text-sm">
                {deviceList.map(item => <option key={item.id} value={item.id}>{item.name} · {item.online ? "Online" : "Offline"}</option>)}
              </select>
            </label>
          ) : null}
          <Button type="button" variant="soft" size="sm" disabled={pair.isPending} onClick={() => pair.mutate()}>Pair a Mac</Button>
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
      {device && !devices.isError ? <RemoteSessions key={device.id} device={device} /> : null}
      {device && !device.online ? (
        <p role="status" className="p-4 text-sm text-foreground/75">{device.name} is offline. Keep Luma Desktop open and the Mac awake and connected.</p>
      ) : null}
    </div>
  );
}

function RemoteSessions({ device }: { device: RemoteDevice }) {
  const [sessionId, setSessionId] = useState("");
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const cursor = pages[pages.length - 1];
  const sessions = useQuery({
    queryKey: ["remote-sessions", device.id, cursor],
    queryFn: ({ signal }) => deviceRequest(device.id, { kind: "sessions", cursor }, signal),
    enabled: device.online,
    refetchInterval: refreshMs,
    gcTime: 0,
    retry: false,
  });
  const items = sessions.data?.items ?? [];
  const selected = items.find(session => session.id === sessionId);

  return (
    <div className={cn("min-h-[16rem] sm:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)]", device.online ? "grid" : "hidden")}>
      <nav aria-label="Mac sessions" className="min-w-0 border-b border-card-border p-3 sm:border-b-0 sm:border-r">
        <h3 className="mb-2 text-xs font-semibold text-foreground/70">Sessions</h3>
        <ul className="max-h-48 space-y-1 overflow-auto sm:max-h-[55dvh]">
          {items.map(session => (
            <li key={session.id}>
              <button type="button" aria-current={session.id === sessionId ? "true" : undefined}
                className={cn("flex w-full min-w-0 items-start gap-2 rounded-md p-2 text-left text-sm hover:bg-control-hover", session.id === sessionId && "bg-brand-soft")}
                onClick={() => setSessionId(session.id)}>
                {session.status === "running" ? <LoaderCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-brand motion-safe:animate-spin" /> : null}
                <span className="min-w-0">
                  <span className="block truncate" dir="auto">{session.title}</span>
                  <span className="block truncate text-xs text-foreground/65">
                    {session.projectName ? `${session.projectName} · ` : ""}<span className="capitalize">{session.status}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {sessions.isPending ? <p className="text-sm text-foreground/65">Loading sessions…</p> : null}
        {sessions.error ? <p role="alert" className="text-sm text-danger-fg">{errorText(sessions.error)}</p> : null}
        {sessions.isSuccess && !items.length ? <p className="text-sm text-foreground/65">No shared sessions on this page.</p> : null}
        {cursor || sessions.data?.nextCursor ? <div className="mt-2 flex gap-1">
          {cursor ? <Button type="button" variant="ghost" size="sm" onClick={() => { setSessionId(""); setPages(pages.slice(0, -1)); }}>Newer</Button> : null}
          {sessions.data?.nextCursor ? <Button type="button" variant="ghost" size="sm" onClick={() => { setSessionId(""); setPages([...pages, sessions.data!.nextCursor!]); }}>Older</Button> : null}
        </div> : null}
      </nav>
      {selected && !sessions.isError ? <RemoteConversation key={selected.id} device={device} session={selected} />
        : <p className="p-4 text-sm text-foreground/65">Choose a session to see its messages.</p>}
    </div>
  );
}

function RemoteConversation({ device, session }: { device: RemoteDevice; session: RemoteSession }) {
  const client = useQueryClient();
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [draft, setDraft] = useState("");
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

  return (
    <section aria-label="Mac conversation" className="min-w-0 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold" dir="auto">{session.title}</h3>
          <p role="status" className="text-xs capitalize text-foreground/65">{session.runner} · {session.status}</p>
        </div>
        {device.canControl && active ? (
          <Button type="button" variant="soft" size="sm" disabled={action.isPending}
            onClick={() => perform({ kind: "stop", sessionId: session.id, runId: latestRunId })}>
            <Square className="mr-1 h-3 w-3" />Stop run
          </Button>
        ) : null}
      </div>
      {before || messages.data?.nextCursor ? <div className="my-2 flex gap-1">
        {before ? <Button type="button" variant="ghost" size="sm" onClick={() => setPages(pages.slice(0, -1))}>Newer messages</Button> : null}
        {messages.data?.nextCursor ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setPages([...pages, messages.data!.nextCursor!])}>Older messages</Button>
        ) : null}
      </div> : null}
      <div className="my-2 max-h-[42dvh] min-h-24 space-y-3 overflow-auto p-1" aria-label="Messages">
        {messages.isPending ? <p className="text-sm text-foreground/65">Loading messages…</p> : null}
        {messages.error ? <p role="alert" className="text-sm text-danger-fg">{errorText(messages.error)}</p> : null}
        {messages.isSuccess && !messages.data.messages.length ? <p className="text-sm text-foreground/65">No messages on this page.</p> : null}
        {!messages.isError ? messages.data?.messages.map(message => (
          <article key={message.id} className={cn("rounded-md bg-surface-2 px-3 py-2", message.role === "user" && "bg-brand-soft")}>
            <p className="mb-1 text-xs font-semibold capitalize text-foreground/70">{message.role === "user" ? "You" : message.role}{message.deliveryStatus === "pending" ? " · Queued" : ""}</p>
            <p dir="auto" className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
          </article>
        )) : null}
      </div>
      {device.canControl && session.canSend && !messages.isError ? (
        <form className="space-y-2" onSubmit={event => {
          event.preventDefault();
          const text = draft.trim();
          if (!text || sending.current) return;
          if (!sendAttempt.current || sendAttempt.current.text !== text) sendAttempt.current = { id: crypto.randomUUID(), text };
          perform({ kind: "send", sessionId: session.id, text, clientMessageId: sendAttempt.current.id });
        }}>
          <textarea className="min-h-14 w-full rounded-md border border-card-border bg-control px-2 py-1.5 text-sm"
            aria-label="Message to this Mac" placeholder="Send a follow-up…" maxLength={8000} value={draft}
            disabled={action.isPending} onChange={event => setDraft(event.target.value)} />
          <Button type="submit" size="sm" disabled={!draft.trim() || action.isPending}>
            <Send className="mr-1.5 h-3.5 w-3.5" />Send message
          </Button>
        </form>
      ) : <p className="text-xs text-foreground/60">{device.canControl ? "Follow-ups are available after this session starts." : "Viewing only. Enable remote control in Desktop settings to send or stop."}</p>}
      {action.error ? <p role="alert" className="mt-2 text-sm text-danger-fg">{errorText(action.error)}</p> : null}
    </section>
  );
}
