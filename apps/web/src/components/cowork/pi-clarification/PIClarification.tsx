import { useEffect, useState, useCallback, type ReactNode } from "react";
import type {
  PICase,
  PICaseDetail,
  PISettings,
  PIStatus,
  PISpec,
  PIImplementationTask,
} from "@luma/shared";
import { PIStateSchema } from "@luma/shared";
import { piRequest } from "../../../lib/api";
import { PIWorkflowControls } from "./PIWorkflowControls";

const inputClass =
  "w-full rounded-md border border-card-border bg-control px-3 py-2 text-sm";
const buttonClass =
  "rounded-md border border-card-border bg-control px-3 py-2 text-sm hover:bg-control-hover disabled:opacity-40";
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-card-border bg-surface-1 p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-3 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
function Label({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-foreground/70">{label}</span>
      {children}
    </label>
  );
}
const mutation = (data: unknown = {}) => ({
  method: "POST",
  body: JSON.stringify(data),
});

export function PIClarification(): JSX.Element {
  const [demo, setDemo] = useState(false),
    [tab, setTab] = useState("cases"),
    [status, setStatus] = useState<PIStatus | null>(null),
    [cases, setCases] = useState<PICase[]>([]),
    [settings, setSettings] = useState<PISettings | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<PICaseDetail | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [state, setState] = useState(""),
    [priority, setPriority] = useState(""),
    [sender, setSender] = useState(""),
    [approved, setApproved] = useState(""),
    [since, setSince] = useState(""),
    [sort, setSort] = useState("newest");
  const [jobs, setJobs] = useState<Record<string, unknown>[]>([]),
    [audit, setAudit] = useState<unknown[]>([]);
  const refresh = useCallback(async () => {
    const params = new URLSearchParams({ q: query, sort });
    if (state) params.set("state", state);
    if (priority) params.set("priority", priority);
    if (sender) params.set("sender", sender);
    if (approved) params.set("approved", approved);
    if (since) params.set("since", new Date(since).toISOString());
    const [nextStatus, nextCases, nextSettings] = await Promise.all([
      piRequest<PIStatus>("/status", undefined, demo),
      piRequest<PICase[]>(`/cases?${params}`, undefined, demo),
      piRequest<PISettings>("/settings", undefined, demo),
    ]);
    setStatus(nextStatus);
    setCases(nextCases);
    setSettings(nextSettings);
    if (selected)
      setDetail(
        await piRequest<PICaseDetail>(`/cases/${selected}`, undefined, demo),
      );
    else setDetail(null);
    if (tab === "operations") {
      const [nextJobs, nextAudit] = await Promise.all([
        piRequest<Record<string, unknown>[]>("/jobs", undefined, demo),
        piRequest<unknown[]>("/audit", undefined, demo),
      ]);
      setJobs(nextJobs);
      setAudit(nextAudit);
    }
  }, [
    demo,
    selected,
    query,
    state,
    priority,
    sender,
    approved,
    since,
    sort,
    tab,
  ]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      refresh().catch((e) => {
        if (alive) setError(e.message);
      });
    void load();
    const interval = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [refresh]);
  async function act(fn: () => Promise<unknown>, message = "Saved") {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await fn();
      setNotice(message);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  async function replay(scenario: "ar" | "ppo") {
    setBusy(true);
    setError(null);
    try {
      const result = await piRequest<PICaseDetail>(
        "/replay",
        mutation({ scenario }),
        true,
      );
      setDemo(true);
      setSelected(result.case.id);
      setDetail(result);
      setTab("cases");
      setNotice(
        scenario === "ar"
          ? "Synthetic journey completed. Approval and task handoff are simulated; no Gmail sends."
          : "Synthetic high-risk case escalated; no task handoff or Gmail sends.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replay failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="h-full overflow-y-auto p-4 text-foreground sm:p-6"
      aria-label="PI Clarification workspace"
    >
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-foreground/60">
            Cowork
          </p>
          <h1 className="text-2xl font-semibold">PI Clarification Agent</h1>
          <p className="mt-1 text-sm text-foreground/65">
            {settings?.mailbox || "admin@proimagetx.ai"} ·{" "}
            {demo ? "Synthetic test database" : "Live configuration"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {status?.demoAvailable === true ? (
            <>
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() => {
                  setSelected(null);
                  setDemo(!demo);
                  setNotice("");
                }}
              >
                {demo ? "Open real mailbox workspace" : "Open test workspace"}
              </button>
            </>
          ) : null}
          <button
            className={buttonClass}
            disabled={busy || !status}
            onClick={() =>
              void act(
                () =>
                  piRequest(
                    status?.paused ? "/resume" : "/pause",
                    mutation(),
                    demo,
                  ),
                status?.paused ? "Agent resumed" : "Agent paused",
              )
            }
          >
            {status?.paused ? "Resume agent" : "Pause agent"}
          </button>
        </div>
      </header>
      <div className="mb-4 rounded-lg border border-card-border bg-surface-2 p-3 text-sm">
        <strong>
          {!status
            ? "Checking email send lock…"
            : status.sendLocked
              ? "Email sending locked"
              : "Email send policy active"}
        </strong>
        <p className="mt-1 text-foreground/70">
          {!status
            ? "Loading server policy…"
            : status.sendLocked
              ? "The AI cannot send emails or create Gmail drafts. Local drafts are available."
              : "Messages require autonomous mode, allowlisted recipients and all server policy checks."}{" "}
          {status && !status.enabled ? "Background worker is disabled." : ""}
        </p>
      </div>
      {!demo && status?.gmail.processingBlockedReason ? (
        <p
          role="note"
          className="mb-3 rounded border border-card-border p-3 text-sm"
        >
          {status.gmail.processingBlockedReason}.
          {status.demoAvailable ? " Synthetic replay remains available." : ""}
        </p>
      ) : null}
      {status?.requiredThreadSender ? (
        <p className="mb-3 rounded border border-card-border p-3 text-sm">
          Production mailbox: only threads containing an actual message from{" "}
          <strong>
            {status.requiredThreadSenders?.join(" or ") ||
              status.requiredThreadSender}
          </strong>{" "}
          are admitted. To/CC, display names and quoted text do not qualify a
          thread.
        </p>
      ) : null}
      {status?.aiRunner && status.aiRunner !== "api" ? (
        <p className="mb-3 text-sm">
          AI runner: {status.aiRunner} · {status.repositoryCount || 0} PI
          repositories ·{" "}
          {status.modelInputMode === "automatic"
            ? "Automatic email analysis"
            : "Reviewed summaries required"}{" "}
          · Target deployments prohibited
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mb-3 rounded border border-rose-400 p-3 text-sm text-rose-600"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="mb-3 rounded border border-card-border p-3 text-sm"
        >
          {notice}
        </p>
      ) : null}
      {!status && !error ? <p role="status">Loading PI workspace…</p> : null}
      <nav
        className="mb-5 flex flex-wrap gap-2"
        aria-label="PI workspace views"
      >
        {[
          "cases",
          "settings",
          ...(status?.demoAvailable === true ? ["test mode"] : []),
          "operations",
        ].map((t) => (
          <button
            key={t}
            aria-current={tab === t ? "page" : undefined}
            className={`${buttonClass} ${tab === t ? "font-semibold ring-1 ring-current" : ""}`}
            onClick={() => setTab(t)}
          >
            {t.replace(/^./, (s) => s.toUpperCase())}
          </button>
        ))}
      </nav>
      {tab === "cases" ? (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[
              ["New", "RECEIVED"],
              ["Waiting on client", "NEEDS_CLIENT_DETAILS"],
              ["Awaiting approval", "AWAITING_SCOPE_APPROVAL"],
              ["Ready / handed off", "READY_FOR_IMPLEMENTATION"],
              ["Escalated", "ESCALATED"],
              ["Failed jobs", "failed"],
            ].map(([label, key]) => (
              <div
                key={key}
                className="rounded-lg border border-card-border p-3"
              >
                <p className="text-xs text-foreground/60">{label}</p>
                <p className="mt-1 text-2xl font-semibold">
                  {key === "failed"
                    ? status?.jobs.failed || 0
                    : key === "READY_FOR_IMPLEMENTATION"
                      ? (status?.metrics[key] || 0) +
                        (status?.metrics.HANDED_OFF || 0)
                      : status?.metrics[key] || 0}
                </p>
              </div>
            ))}
          </div>
          <p className="mb-4 text-xs text-foreground/60">
            Gmail: {status?.gmail.connected ? "Connected" : "Not connected"} ·
            Last successful sync:{" "}
            {status?.gmail.lastSync
              ? new Date(status.gmail.lastSync).toLocaleString()
              : "Never"}
            {status?.gmail.lastError ? ` · ${status.gmail.lastError}` : ""}
          </p>
          <div className="mb-4 grid grid-cols-2 gap-2 xl:grid-cols-7">
            <Label label="Search">
              <input
                className={inputClass}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Case ID or title"
              />
            </Label>
            <Label label="Status">
              <select
                className={inputClass}
                value={state}
                onChange={(e) => setState(e.target.value)}
              >
                <option value="">All statuses</option>
                {PIStateSchema.options.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Label>
            <Label label="Priority">
              <select
                className={inputClass}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="">All</option>
                {["low", "normal", "urgent"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Label>
            <Label label="Sender">
              <input
                className={inputClass}
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                placeholder="Exact email"
              />
            </Label>
            <Label label="Approval">
              <select
                className={inputClass}
                value={approved}
                onChange={(e) => setApproved(e.target.value)}
              >
                <option value="">Any</option>
                <option value="yes">Approved</option>
                <option value="no">Unapproved</option>
              </select>
            </Label>
            <Label label="Since">
              <input
                type="date"
                className={inputClass}
                value={since}
                onChange={(e) => setSince(e.target.value)}
              />
            </Label>
            <Label label="Sort">
              <select
                className={inputClass}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </Label>
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(230px,1fr)_minmax(0,2fr)]">
            <Panel title={`${cases.length} cases`}>
              <div className="space-y-2">
                {cases.length === 0 ? (
                  <p className="text-sm text-foreground/65">
                    {status?.demoAvailable === false
                      ? "No qualifying production threads yet. Send from the required sender or reply within an existing qualifying thread, then wait for polling or use Poll Gmail now."
                      : "No cases match. Configure an allowlisted mailbox or run a synthetic example in Test mode."}
                  </p>
                ) : (
                  cases.map((c) => (
                    <button
                      key={c.id}
                      className={`w-full rounded border border-card-border p-3 text-left hover:bg-control-hover ${selected === c.id ? "ring-1 ring-current" : ""}`}
                      onClick={() => setSelected(c.id)}
                    >
                      <p className="text-xs text-foreground/60">
                        {c.id}
                        {c.demo ? " · DEMO" : ""} · {c.priority}
                      </p>
                      <p className="my-1 text-sm font-medium">{c.title}</p>
                      <p className="text-xs">
                        {c.state} · v{c.specVersion} · {c.riskLevel}
                      </p>
                    </button>
                  ))
                )}
              </div>
            </Panel>
            {detail ? (
              <CaseDetail
                detail={detail}
                demo={demo}
                busy={busy}
                settings={settings}
                sendLocked={status?.sendLocked !== false}
                receiveOnly={status?.receiveOnly === true}
                act={act}
              />
            ) : (
              <Panel title="Case details">
                <p className="text-sm text-foreground/65">
                  Select a case to review the thread, decisions, specifications
                  and approval evidence.
                </p>
              </Panel>
            )}
          </div>
        </>
      ) : null}
      {tab === "settings" && settings ? (
        <Settings
          settings={settings}
          demo={demo}
          status={status}
          busy={busy}
          act={act}
        />
      ) : null}
      {tab === "test mode" ? (
        <Panel title="Entirely mocked conversation simulator">
          <p className="mb-4 text-sm text-foreground/70">
            The isolated demo mailbox uses synthetic messages, deterministic
            reasoning and a fake read-only Investigator. AR runs investigation →
            clarification → spec → explicit approval → internal task handoff.
            PPO demonstrates mandatory human escalation. No real email or
            patient data is used.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => void replay("ar")}
            >
              {busy ? "Running…" : "Replay AR TYPE NOT POPULATED"}
            </button>
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => void replay("ppo")}
            >
              Replay PPO authorization handling
            </button>
          </div>
        </Panel>
      ) : null}
      {tab === "operations" ? (
        <div className="space-y-4">
          <Panel title="Worker and integrations">
            <JsonView value={status} />
            <p className="my-3 text-sm">
              Prompt version: {status?.promptVersion}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                className={buttonClass}
                disabled={busy || demo}
                onClick={() =>
                  void act(
                    () => piRequest("/gmail/sync", mutation()),
                    "Reconciliation queued",
                  )
                }
              >
                Poll Gmail now
              </button>
            </div>
          </Panel>
          <Panel title="Durable jobs">
            {jobs.map((j) => (
              <div
                key={String(j.id)}
                className="mb-2 rounded border border-card-border p-2 text-xs"
              >
                <p>
                  {String(j.kind)} · {String(j.state)} · attempts{" "}
                  {String(j.attempts)} · {String(j.case_id || "mailbox")}
                </p>
                {j.last_error ? <p>{String(j.last_error)}</p> : null}
                {j.state === "failed" ? (
                  <button
                    className={buttonClass}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          piRequest(`/jobs/${j.id}/retry`, mutation(), demo),
                        "Job retry queued",
                      )
                    }
                  >
                    Retry failed job
                  </button>
                ) : null}
              </div>
            ))}
          </Panel>
          <Panel title="Append-only audit">
            <JsonView value={audit} />
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, message?: string) => Promise<void>;
function CaseDetail({
  detail: d,
  demo,
  busy,
  settings,
  sendLocked,
  receiveOnly,
  act,
}: {
  detail: PICaseDetail;
  demo: boolean;
  busy: boolean;
  settings: PISettings | null;
  sendLocked: boolean;
  receiveOnly: boolean;
  act: Act;
}) {
  const [view, setView] = useState("thread"),
    [reason, setReason] = useState(""),
    [action, setAction] = useState("escalate"),
    [contactId, setContactId] = useState(""),
    [specJson, setSpecJson] = useState(""),
    [reply, setReply] = useState(""),
    [workflow, setWorkflow] = useState(""),
    [targetCaseId, setTargetCaseId] = useState(""),
    [attachmentPreview, setAttachmentPreview] = useState("");
  const current = d.specs.at(-1);
  useEffect(
    () => setSpecJson(current ? JSON.stringify(current.spec, null, 2) : ""),
    [current?.digest, d.case.id],
  );
  const changed =
    current && d.specs.length > 1
      ? Object.keys(current.spec).filter(
          (k) =>
            JSON.stringify(current.spec[k as keyof PISpec]) !==
            JSON.stringify(d.specs[d.specs.length - 2].spec[k as keyof PISpec]),
        )
      : [];
  function download(task: PIImplementationTask) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(task, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${task.taskId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Panel title={`${d.case.id} · ${d.case.state}`}>
      <p className="mb-2 text-xs text-foreground/60">
        Owner: {d.case.owner} · SLA: {new Date(d.case.slaAt).toLocaleString()} ·
        revision {d.case.revision}
      </p>
      {!demo ? (
        <a
          className="mb-3 inline-block text-sm underline"
          href={`https://mail.google.com/mail/u/${encodeURIComponent(d.case.mailbox)}/#all/${encodeURIComponent(d.case.threadId)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open original Gmail thread
        </a>
      ) : (
        <p className="mb-3 text-xs">Synthetic thread · no Gmail link</p>
      )}
      <div className="mb-3 flex flex-wrap gap-1">
        {[
          "thread",
          "specifications",
          "approvals",
          "outbound",
          "evidence",
          "timeline",
          "task",
          "review",
        ].map((v) => (
          <button
            key={v}
            className={`${buttonClass} ${v === view ? "font-semibold" : ""}`}
            onClick={() => setView(v)}
          >
            {v}
          </button>
        ))}
      </div>
      {view === "thread" ? (
        <div className="space-y-3">
          {d.messages.map((m) => (
            <article
              key={m.id}
              className="rounded border border-card-border p-3"
            >
              <p className="text-xs text-foreground/60">
                {m.from} ·{" "}
                {m.direction === "outgoing"
                  ? "Mailbox sent / context"
                  : "Incoming"}{" "}
                · {new Date(m.date).toLocaleString()} ·{" "}
                {m.identityVerified
                  ? "Transport identity verified"
                  : "Identity unverified"}
              </p>
              <h3 className="my-2 text-sm font-semibold">{m.subject}</h3>
              <p className="whitespace-pre-wrap text-sm">{m.body}</p>
              {(m.attachments || []).map((a) => (
                <div
                  key={a.id}
                  className="mt-2 rounded border border-card-border p-2 text-xs"
                >
                  <p>
                    {a.label} · {a.mimeType} · {a.size} bytes
                  </p>
                  <button
                    className={buttonClass}
                    disabled={
                      busy ||
                      demo ||
                      a.size > 256000 ||
                      !["text/plain", "text/csv"].includes(a.mimeType)
                    }
                    onClick={() =>
                      void act(async () => {
                        const result = await piRequest<{ text: string }>(
                          `/cases/${d.case.id}/messages/${encodeURIComponent(m.id)}/attachment/${encodeURIComponent(a.id)}`,
                        );
                        setAttachmentPreview(result.text);
                      }, "Safe attachment preview loaded locally; it was not sent to the model")
                    }
                  >
                    Preview safe text
                  </button>
                </div>
              ))}
            </article>
          ))}
          {attachmentPreview ? (
            <Panel title="Safe attachment preview">
              <p className="whitespace-pre-wrap break-words text-sm">
                {attachmentPreview}
              </p>
            </Panel>
          ) : null}
          {demo ? (
            <div className="space-y-2">
              <Label label="Simulate client reply">
                <textarea
                  className={inputClass}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Generic, de-identified reply"
                />
              </Label>
              <button
                className={buttonClass}
                disabled={busy || !reply.trim()}
                onClick={() =>
                  void act(
                    () =>
                      piRequest(
                        "/simulate-reply",
                        mutation({ caseId: d.case.id, body: reply }),
                        true,
                      ),
                    "Synthetic reply processed",
                  )
                }
              >
                Submit simulated reply
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {view === "specifications" ? (
        <div className="space-y-4">
          {changed.length ? (
            <details className="rounded border border-card-border p-3">
              <summary className="cursor-pointer text-sm">
                Changed since prior version: {changed.join(", ")}
              </summary>
              <div className="mt-3 space-y-3">
                {changed.map((k) => (
                  <div key={k}>
                    <h3 className="text-sm font-medium">{k}</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <p className="text-xs">Previous</p>
                        <JsonView
                          value={
                            d.specs[d.specs.length - 2].spec[k as keyof PISpec]
                          }
                        />
                      </div>
                      <div>
                        <p className="text-xs">Current</p>
                        <JsonView value={current!.spec[k as keyof PISpec]} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {d.specs.map((r) => (
            <div key={r.id}>
              <h3 className="mb-1 text-sm font-semibold">
                Version {r.version} ·{" "}
                {d.approvals.some(
                  (a) => a.specId === r.id && a.result === "approved",
                )
                  ? "Approval evidence recorded"
                  : "Unapproved"}
              </h3>
              <p className="mb-2 break-all font-mono text-xs">
                SHA-256 {r.digest}
              </p>
              <JsonView value={r.spec} />
            </div>
          ))}
          <p className="text-xs text-foreground/65">
            Snapshots are immutable. Editing creates a new version and
            invalidates existing authorization.
          </p>
          {current ? (
            <>
              <Label label="Propose next specification version (JSON)">
                <textarea
                  className={`${inputClass} min-h-64 font-mono text-xs`}
                  value={specJson}
                  onChange={(e) => setSpecJson(e.target.value)}
                />
              </Label>
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() =>
                  void act(
                    () =>
                      piRequest(
                        `/cases/${d.case.id}/specs`,
                        mutation(JSON.parse(specJson)),
                        demo,
                      ),
                    "New specification version created",
                  )
                }
              >
                Save as new version
              </button>
            </>
          ) : (
            <p className="text-sm">
              {receiveOnly
                ? "Emails are received locally. AI specification drafting is disabled in receive-only mode."
                : "No specification yet. Request a draft after the evidence is sufficient."}
            </p>
          )}
        </div>
      ) : null}
      {view === "approvals" ? (
        <>
          <p className="mb-3 text-sm">
            Only a verified, authorized stakeholder reply to the exact delivered
            version grants scope approval. Administrative review does not
            replace client approval.
          </p>
          <JsonView value={d.approvals} />
          <div className="mt-3 space-y-2">
            <Label label="Authorized approver">
              <select
                className={inputClass}
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
              >
                <option value="">Select a configured contact</option>
                {settings?.contacts
                  .filter((c) => c.active && c.canApproveScope)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.address} · {c.workflows.join(", ")}
                    </option>
                  ))}
              </select>
            </Label>
            <button
              className={buttonClass}
              disabled={busy || !contactId}
              onClick={() =>
                void act(
                  () =>
                    piRequest(
                      `/cases/${d.case.id}/approval-request`,
                      mutation({ contactIds: [contactId] }),
                      demo,
                    ),
                  "Approval request prepared under current send policy",
                )
              }
            >
              Prepare scope approval request
            </button>
          </div>
        </>
      ) : null}
      {view === "outbound" ? (
        <div className="space-y-3">
          {d.outbox.length ? (
            d.outbox.map((o) => (
              <article
                key={o.id}
                className="rounded border border-card-border p-3"
              >
                <p className="text-xs">
                  {o.kind} · {o.state} · {o.recipients.join(", ")}
                </p>
                <p className="my-2 font-medium">{o.subject}</p>
                <p className="whitespace-pre-wrap text-sm">{o.bodyText}</p>
                <p className="mt-2 text-xs text-foreground/60">
                  Provider ID: {o.providerId || "Not delivered"}
                  {o.error ? ` · ${o.error}` : ""}
                </p>
                {["prepared", "draft", "blocked"].includes(o.state) ? (
                  <button
                    className={buttonClass}
                    disabled={busy || sendLocked || demo}
                    onClick={() =>
                      void act(
                        () =>
                          piRequest(
                            `/outbox/${o.id}/request-send`,
                            mutation(),
                            demo,
                          ),
                        "Send review queued; all server gates still apply",
                      )
                    }
                  >
                    Request send review
                  </button>
                ) : null}
                {["sending", "uncertain"].includes(o.state) ? (
                  <button
                    className={buttonClass}
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          piRequest(
                            `/outbox/${o.id}/reconcile`,
                            mutation(),
                            demo,
                          ),
                        "Provider lookup queued; no resend",
                      )
                    }
                  >
                    Reconcile uncertain delivery
                  </button>
                ) : null}
              </article>
            ))
          ) : (
            <p>No outbound drafts.</p>
          )}
        </div>
      ) : null}
      {view === "evidence" ? (
        <div className="space-y-3">
          <h3>Read-only investigations</h3>
          <JsonView value={d.investigations} />
          <h3>Agent proposals and rationale</h3>
          <JsonView value={d.runs} />
        </div>
      ) : null}
      {view === "timeline" ? (
        <ol className="space-y-3">
          {d.events.map((e) => (
            <li key={e.id} className="border-l-2 border-card-border pl-3">
              <p className="text-sm font-medium">{e.kind}</p>
              <p className="text-xs text-foreground/60">
                {new Date(e.at).toLocaleString()} · {e.actor}
              </p>
              <JsonView value={e.data} />
            </li>
          ))}
        </ol>
      ) : null}
      {view === "task" ? (
        <div className="space-y-3">
          {d.handoffs.length ? (
            d.handoffs.map((t) => (
              <div key={t.taskId}>
                <p className="mb-2 text-sm">
                  {t.handoffStatus} · v{t.specVersion} · Internal queue only
                </p>
                <JsonView value={t} />
                <div className="mt-2 flex gap-2">
                  <button className={buttonClass} onClick={() => download(t)}>
                    Download full task
                  </button>
                  <button
                    className={buttonClass}
                    onClick={() =>
                      void act(
                        () =>
                          navigator.clipboard.writeText(
                            JSON.stringify(t, null, 2),
                          ),
                        "Task brief copied",
                      )
                    }
                  >
                    Copy task brief
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm">
              No approved task yet. Exact-version authorization and resolved
              blockers are required.
            </p>
          )}
          <button
            className={buttonClass}
            disabled={busy || d.case.state !== "READY_FOR_IMPLEMENTATION"}
            onClick={() =>
              void act(
                () =>
                  piRequest(`/cases/${d.case.id}/handoff`, mutation(), demo),
                "Approved task queued",
              )
            }
          >
            Publish approved task
          </button>
        </div>
      ) : null}
      {view === "review" ? (
        <div className="space-y-3">
          {!demo ? (
            <PIWorkflowControls
              detail={d}
              settings={settings}
              busy={busy}
              act={act}
            />
          ) : null}
          <button
            className={buttonClass}
            disabled={busy || receiveOnly}
            onClick={() =>
              void act(
                () => piRequest(`/cases/${d.case.id}/run`, mutation(), demo),
                "Draft/reasoning job queued",
              )
            }
          >
            Request agent draft
          </button>
          <Label label="Review action">
            <select
              className={inputClass}
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              {[
                "escalate",
                "suspend",
                "reopen",
                "reject",
                "close",
                "reassign",
                "return_for_clarification",
                "set_workflow",
                "merge",
              ].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </Label>
          {action === "reassign" ? (
            <Label label="Human owner">
              <select
                className={inputClass}
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
              >
                <option value="">Select contact</option>
                {settings?.contacts
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.address}
                    </option>
                  ))}
              </select>
            </Label>
          ) : null}
          {action === "set_workflow" ? (
            <Label label="Workflow">
              <select
                className={inputClass}
                value={workflow}
                onChange={(e) => setWorkflow(e.target.value)}
              >
                <option value="">Select configured workflow</option>
                {[
                  ...new Set(
                    settings?.contacts
                      .filter((c) => c.active)
                      .flatMap((c) => c.workflows) || [],
                  ),
                ].map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </Label>
          ) : null}
          {action === "merge" ? (
            <Label label="Existing incident case ID">
              <input
                className={inputClass}
                value={targetCaseId}
                onChange={(e) => setTargetCaseId(e.target.value)}
              />
            </Label>
          ) : null}
          <Label label="Reason / unresolved question">
            <textarea
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Label>
          <button
            className={buttonClass}
            disabled={busy || !reason.trim()}
            onClick={() =>
              void act(
                () =>
                  piRequest(
                    `/cases/${d.case.id}/action`,
                    mutation({
                      action,
                      reason,
                      ...(action === "reassign" ? { contactId } : {}),
                      ...(action === "set_workflow" ? { workflow } : {}),
                      ...(action === "merge" ? { targetCaseId } : {}),
                    }),
                    demo,
                  ),
                "Review action recorded",
              )
            }
          >
            Apply review action
          </button>
          <p className="text-xs">
            Suspended/closed cases can have retained message bodies erased.
            Immutable specifications and approval evidence remain for audit.
          </p>
          <button
            className={buttonClass}
            disabled={
              busy ||
              !["SUSPENDED", "CLOSED", "REJECTED"].includes(d.case.state)
            }
            onClick={() =>
              void act(
                () => piRequest(`/cases/${d.case.id}/erase`, mutation(), demo),
                "Mutable case content erased; immutable audit evidence retained",
              )
            }
          >
            Erase retained message content
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

function Settings({
  settings: s,
  demo,
  status,
  busy,
  act,
}: {
  settings: PISettings;
  demo: boolean;
  status: PIStatus | null;
  busy: boolean;
  act: Act;
}) {
  const [raw, setRaw] = useState(JSON.stringify(s, null, 2)),
    [prompt, setPrompt] = useState("");
  useEffect(() => {
    setRaw(JSON.stringify(s, null, 2));
    void piRequest<{ content: string }>("/prompt", undefined, demo)
      .then((r) => setPrompt(r.content))
      .catch(() => {});
  }, [demo]);
  return (
    <div className="space-y-4">
      <Panel title="Gmail connection">
        <p className="mb-3 text-sm">
          {status?.gmail.connected ? "Connected" : "Not connected"} ·{" "}
          {s.mailbox}.{" "}
          {status?.gmail.authenticationMode === "federated_readonly"
            ? "Connected through the existing cluster Auth0/Google federation. Access is restricted to Gmail read-only; no browser consent is required."
            : "Connect this Google Workspace/Gmail mailbox with a server-side OAuth client. While sending is locked, consent requests Gmail read-only access."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className={buttonClass}
            disabled={busy || demo}
            onClick={() =>
              void act(
                async () => {
                  if (
                    status?.gmail.authenticationMode === "federated_readonly"
                  ) {
                    await piRequest("/gmail/federation/connect", mutation());
                    return;
                  }
                  const result = await piRequest<{ url: string }>(
                    "/gmail/oauth/start",
                  );
                  window.location.assign(result.url);
                },
                status?.gmail.authenticationMode === "federated_readonly"
                  ? "Read-only cluster Gmail connection verified"
                  : "Opening Google consent",
              )
            }
          >
            Connect Gmail read-only
          </button>
          <button
            className={buttonClass}
            disabled={busy || demo || !status?.gmail.connected}
            onClick={() =>
              void act(
                () => piRequest("/gmail/disconnect", mutation()),
                "Gmail disconnected; check revocation status in the response audit",
              )
            }
          >
            Disconnect Gmail
          </button>
        </div>
      </Panel>
      <Panel title="PI contacts, policies and operations">
        <p className="mb-3 text-sm text-foreground/70">
          Edit the validated configuration below. Contacts need explicit
          workflow scopes, active status, verification source, and separate
          clarify/approve roles. Sandbox recipients are mandatory for outbound
          proposals. Configure allowlists, filters, limits, timezone, SLA,
          escalation contacts, risk workflows and data policy here. No
          credentials belong in this editor.
        </p>
        <Label label="Settings JSON">
          <textarea
            spellCheck={false}
            className={`${inputClass} min-h-[520px] font-mono text-xs`}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            disabled={demo}
          />
        </Label>
        <button
          className={`${buttonClass} mt-3`}
          disabled={busy || demo}
          onClick={() =>
            void act(
              () =>
                piRequest("/settings", {
                  method: "PUT",
                  body: JSON.stringify(JSON.parse(raw)),
                }),
              "Validated settings version saved",
            )
          }
        >
          Save settings version
        </button>
        <p className="mt-3 text-xs">
          Deployment send lock:{" "}
          {status?.sendLocked
            ? "ON — autonomous sending cannot be enabled here"
            : "OFF — further policy checks apply"}
          . Live processing remains blocked until privacyReviewed,
          providerAgreementsConfirmed and dataPolicyReference are configured.
          The model/provider URL and secrets are configured server-side.
        </p>
      </Panel>
      <Panel title="Agent prompt release">
        <p className="mb-3 text-sm text-foreground/70">
          Each release is SHA-256 versioned. Prompts cannot grant capabilities
          or bypass backend approval/email policy.
        </p>
        <Label label="PI agent prompt">
          <textarea
            className={`${inputClass} min-h-72 font-mono text-xs`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Label>
        <button
          className={`${buttonClass} mt-3`}
          disabled={busy || !prompt}
          onClick={() =>
            void act(
              () =>
                piRequest(
                  "/prompt",
                  { method: "PUT", body: JSON.stringify({ content: prompt }) },
                  demo,
                ),
              "Prompt release saved",
            )
          }
        >
          Release prompt version
        </button>
      </Panel>
    </div>
  );
}
