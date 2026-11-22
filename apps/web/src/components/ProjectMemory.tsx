import { useDeferredValue, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BrainCircuit, ChevronDown, Folder, History, LoaderCircle, Pencil, Plus, Settings2, Trash2, Undo2, X } from "lucide-react";
import type { MemoryInput, MemoryItem, MemoryRevision, Project } from "@luma/shared";
import { useProjects } from "../lib/projects";
import * as api from "../lib/projects-api";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

const inputClass = "w-full rounded-md border border-card-border bg-control px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const projectHeaderButton = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-foreground/65 hover:bg-control-hover hover:text-foreground focus-visible:outline focus-visible:outline-brand";

export function ProjectSessionControls() {
  const state = useProjects();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const project = state.projects.find((item) => item.id === state.currentProjectId);
  const usage = useQuery({
    queryKey: ["project-memory", "used", state.selectedRunId],
    queryFn: () => api.getProjectRunContext(state.selectedRunId!),
    enabled: Boolean(project && state.selectedRunId),
  });
  const context = usage.data?.context;

  async function assign(projectId: string | null) {
    setError("");
    setBusy(true);
    try {
      if (state.selectedSessionId) await state.onMoveSession(projectId);
      else state.setDraftProject(projectId);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!project && (!state.selectedSessionId || state.projects.length === 0)) return null;

  return (
    <div className="relative flex min-w-0 max-w-full items-center gap-0.5" role="group" aria-label="Project controls">
      <label
        className="relative inline-flex h-6 min-w-0 max-w-40 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-foreground/65 hover:bg-control-hover hover:text-foreground focus-within:outline focus-within:outline-brand"
        title={project ? project.name : "Assign to a project"}
      >
        <Folder className="h-3 w-3 shrink-0 text-brand" aria-hidden="true" />
        <span className="min-w-0 truncate" dir="auto">{project?.name || "No project"}</span>
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        <select
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={state.selectedSessionId ? "Session project" : "New session project"}
          value={state.currentProjectId || ""}
          disabled={busy}
          onChange={(event) => void assign(event.target.value || null)}
        >
          <option value="">No project</option>
          {state.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {project ? (
        <>
          <button
            type="button"
            className={projectHeaderButton}
            aria-label="Project memory"
            title={context?.projectId === project.id ? `Project memory · ${context.memories.length} used in this run` : "Project memory"}
            onClick={() => state.setPanel({ tab: "memory", projectId: project.id })}
          >
            <BrainCircuit className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={projectHeaderButton}
            aria-label="Project settings"
            title="Project settings"
            onClick={() => state.setPanel({ tab: "settings", projectId: project.id })}
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border border-card-border bg-surface-1 p-2 text-left text-xs text-danger-fg shadow-lg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ProjectMemoryDialog() {
  const state = useProjects();
  const project = state.projects.find(item => item.id === state.panel?.projectId);
  return <Dialog.Root open={Boolean(state.panel)} onOpenChange={open => { if (!open) state.setPanel(null); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[90] flex max-h-[88dvh] w-[min(960px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-card-border bg-surface-1 text-foreground shadow-2xl outline-none">
        <div className="flex items-start justify-between gap-4 border-b border-card-border px-5 py-4">
          <div className="min-w-0"><Dialog.Title className="flex items-center gap-2 text-lg font-semibold"><BrainCircuit size={20} className="text-brand" /><span className="truncate">{state.panel?.tab === "create" ? "Create project" : project?.name || "Project"}</span></Dialog.Title><Dialog.Description className="mt-1 text-xs text-foreground/60">{state.panel?.tab === "create" ? "Group sessions and give them shared instructions and memory." : "Reusable knowledge for this project's sessions. Every memory change has history and can be undone."}</Dialog.Description></div>
          <Dialog.Close asChild><button type="button" className="rounded-md p-1.5 hover:bg-control-hover" aria-label="Close project panel"><X size={18} /></button></Dialog.Close>
        </div>
        {project && state.panel?.tab !== "create" ? <div role="tablist" aria-label="Project sections" className="flex gap-1 border-b border-card-border px-5 py-2">{([['memory', 'Memory', BrainCircuit], ['activity', 'Activity', History], ['settings', 'Settings', Settings2]] as const).map(([tab, label, Icon]) => <button type="button" role="tab" key={tab} aria-selected={state.panel?.tab === tab} onClick={() => state.setPanel({ projectId: project.id, tab })} className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs", state.panel?.tab === tab ? "bg-brand-soft text-brand" : "text-foreground/60 hover:bg-control-hover")}><Icon size={14} />{label}</button>)}</div> : null}
        <div className="min-h-0 overflow-y-auto p-5">
          {state.panel?.tab === "create" || state.panel?.tab === "settings" ? <ProjectSettings key={`${project?.id || 'new'}:${state.panel?.tab}`} project={project} /> : project && state.panel ? <MemoryWorkspace key={`${project.id}:${state.panel.tab}`} project={project} activity={state.panel.tab === "activity"} /> : <p>Project unavailable. Close this panel and refresh the project list.</p>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function ProjectSettings({ project }: { project?: Project }) {
  const state = useProjects();
  const [base] = useState(project);
  const [name, setName] = useState(project?.name || ""), [instructions, setInstructions] = useState(project?.instructions || ""), [allow, setAllow] = useState(project?.allowAgentMemory ?? true);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const input = { name, instructions, allowAgentMemory: allow };
      const result = base ? await api.updateProject(base, input) : await api.createProject(input);
      state.acceptProject(result.project);
      if (!base) state.startProjectDraft(result.project.id);
      state.setPanel(null);
      state.invalidate();
    } catch (reason) { setError(message(reason)); state.invalidate(); }
    finally { setBusy(false); }
  }
  return <form className="mx-auto max-w-2xl space-y-5" onSubmit={event => void save(event)}>
    <label className="block space-y-2 text-sm"><span className="font-medium">Project name</span><input aria-label="Project name" className={inputClass} autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Luma App" /></label>
    <label className="block space-y-2 text-sm"><span className="font-medium">Project instructions</span><textarea aria-label="Project instructions" aria-describedby="project-instructions-help" className={inputClass} rows={6} maxLength={12000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Goals, conventions, and instructions for every session in this project." /><span id="project-instructions-help" className="block text-xs text-foreground/55">These instructions are separate from learned memory. Sessions cannot edit them using memory tools.</span></label>
    <label className="flex items-start gap-3 rounded-lg border border-card-border bg-control p-4"><input aria-label="Let sessions manage project memory" aria-describedby="agent-memory-help" className="mt-0.5 accent-brand" type="checkbox" checked={allow} onChange={event => setAllow(event.target.checked)} /><span className="text-sm">Let sessions manage project memory<span id="agent-memory-help" className="mt-1 block text-xs leading-relaxed text-foreground/55">Agents can add, update, remove, and undo learned memories. Each change records its source session and reason. Plan and Ask modes can only read memory.</span></span></label>
    <p className="text-xs leading-relaxed text-foreground/55">Projects do not grant folder access. Each session still uses its selected workspace and execution environment. Cloud and This Mac keep separate project data.</p>
    {error ? <p role="alert" className="text-sm text-danger-fg">{error}</p> : null}
    <Button type="submit" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={15} className="mr-2 animate-spin" /> : null}{base ? "Save project" : "Create project"}</Button>
  </form>;
}

function MemoryWorkspace({ project, activity }: { project: Project; activity: boolean }) {
  const state = useProjects();
  const [search, setSearch] = useState(""), [includeDeleted, setIncludeDeleted] = useState(false);
  const query = useDeferredValue(search);
  const [editing, setEditing] = useState<{ item: MemoryItem | null } | null>(null), [historyId, setHistoryId] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<MemoryItem | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const memories = useInfiniteQuery({ queryKey: ["project-memory", project.id, "items", query, includeDeleted], queryFn: ({ pageParam }) => api.listProjectMemory(project.id, query, includeDeleted, pageParam), initialPageParam: 0, getNextPageParam: (page, pages) => page.items.length === 50 ? pages.length * 50 : undefined, enabled: !activity });
  const changes = useInfiniteQuery({ queryKey: ["project-memory", project.id, "activity"], queryFn: ({ pageParam }) => api.getMemoryHistory(project.id, undefined, pageParam), initialPageParam: 0, getNextPageParam: (page, pages) => page.history.length === 50 ? pages.length * 50 : undefined, enabled: activity });
  async function change(action: () => Promise<{ item: MemoryItem }>) {
    setBusy(true); setError("");
    try { const result = await action(); setLastChange(result.item); setEditing(null); state.invalidate(); }
    catch (reason) { setError(message(reason)); state.invalidate(); }
    finally { setBusy(false); }
  }
  const items = memories.data?.pages.flatMap(page => page.items) || [];
  return <div className="space-y-4">
    {!project.allowAgentMemory ? <p className="rounded-md border border-card-border bg-control p-3 text-xs text-foreground/65">Agents can read this project's memory. Only you can change it while agent editing is disabled.</p> : null}
    {lastChange ? <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-xs"><span>{lastChange.deletedAt !== null ? "Removed" : "Saved"}: {lastChange.title}</span><button type="button" disabled={busy} className="inline-flex items-center gap-1 font-semibold text-brand" onClick={() => void change(() => api.undoProjectMemory(lastChange))}><Undo2 size={13} />Undo</button></div> : null}
    {error ? <p role="alert" className="rounded-md border border-danger-fg/30 p-3 text-sm text-danger-fg">{error}</p> : null}
    {editing ? <MemoryForm key={editing.item?.id || "new"} initial={editing.item} busy={busy} onCancel={() => setEditing(null)} onSave={input => void change(() => editing.item ? api.editProjectMemory(editing.item, input) : api.addProjectMemory(project.id, input))} /> : null}
    {historyId ? <MemoryHistory projectId={project.id} memoryId={historyId} busy={busy} onClose={() => setHistoryId(null)} onChange={change} /> : null}
    {activity ? <>
      <p className="text-xs text-foreground/55">Changes from users and project sessions, including removals and undo operations.</p>
      {changes.isLoading ? <Loading /> : changes.error ? <p role="alert">{message(changes.error)}</p> : changes.data?.pages.flatMap(page => page.history).length ? <div className="space-y-3">{changes.data.pages.flatMap(page => page.history).map(revision => <RevisionCard key={revision.id} revision={revision} onOpen={() => setHistoryId(revision.memoryId)} />)}</div> : <Empty text="Memory activity will appear here when you or a session make a change." />}
      {changes.hasNextPage ? <Button variant="ghost" disabled={changes.isFetchingNextPage} onClick={() => void changes.fetchNextPage()}>Load older activity</Button> : null}
    </> : <>
      <div className="flex flex-wrap items-center gap-3"><input aria-label="Search project memory" className={cn(inputClass, "min-w-40 flex-1")} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search project memory…" /><Button onClick={() => { setHistoryId(null); setEditing({ item: null }); }}><Plus size={15} className="mr-1.5" />Add memory</Button></div>
      <label className="flex items-center gap-2 text-xs text-foreground/60"><input type="checkbox" checked={includeDeleted} onChange={event => setIncludeDeleted(event.target.checked)} />Show removed memories</label>
      {memories.isLoading ? <Loading /> : memories.error ? <p role="alert">{message(memories.error)}</p> : items.length ? <div className="grid gap-3 sm:grid-cols-2">{items.map(item => <article key={item.id} className={cn("rounded-lg border border-card-border bg-control p-4", item.deletedAt !== null && "opacity-65")}>
        <div className="mb-2 flex items-start justify-between gap-3"><h3 className="text-sm font-semibold">{item.title}</h3><span className="rounded border border-card-border px-1.5 py-0.5 text-[10px] text-foreground/55">{item.deletedAt !== null ? "removed" : item.category}</span></div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/75">{item.content}</p>
        <div className="mt-4 flex items-center gap-2 border-t border-card-border pt-3"><span className="mr-auto text-[10px] text-foreground/40">Revision {item.revision}</span><button type="button" className="rounded p-1.5 hover:bg-control-hover" onClick={() => { setEditing(null); setHistoryId(item.id); }} aria-label={`History of ${item.title}`}><History size={14} /></button>{item.deletedAt === null ? <><button type="button" className="rounded p-1.5 hover:bg-control-hover" disabled={busy} onClick={() => { setHistoryId(null); setEditing({ item }); }} aria-label={`Edit ${item.title}`}><Pencil size={14} /></button><button type="button" className="rounded p-1.5 text-danger-fg hover:bg-control-hover" disabled={busy} onClick={() => void change(() => api.removeProjectMemory(item))} aria-label={`Remove ${item.title}`}><Trash2 size={14} /></button></> : <button type="button" className="inline-flex items-center gap-1 text-xs text-brand" disabled={busy} onClick={() => void change(() => api.undoProjectMemory(item))}><Undo2 size={13} />Undo removal</button>}</div>
      </article>)}</div> : <Empty text={search ? "No matching memories." : "Save a project fact or lesson here. Sessions in this project can also create and maintain memories while they work."} />}
      {memories.hasNextPage ? <Button variant="ghost" disabled={memories.isFetchingNextPage} onClick={() => void memories.fetchNextPage()}>Load more memories</Button> : null}
    </>}
  </div>;
}

function MemoryForm({ initial, busy, onCancel, onSave }: { initial: MemoryItem | null; busy: boolean; onCancel: () => void; onSave: (input: MemoryInput) => void }) {
  const [title, setTitle] = useState(initial?.title || ""), [content, setContent] = useState(initial?.content || ""), [category, setCategory] = useState<MemoryItem["category"]>(initial?.category || "fact"), [reason, setReason] = useState(initial ? "Corrected by user." : "Added by user.");
  return <form aria-label={initial ? "Edit memory" : "Add memory"} className="space-y-3 rounded-lg border border-brand/35 bg-surface-2 p-4" onSubmit={event => { event.preventDefault(); onSave({ title, content, category, reason }); }}>
    <h3 className="text-sm font-semibold">{initial ? "Edit memory" : "Add memory"}</h3>
    <label className="block space-y-1 text-xs"><span>Title</span><input aria-label="Title" className={inputClass} autoFocus required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label className="block space-y-1 text-xs"><span>Memory</span><textarea aria-label="Memory" className={inputClass} rows={4} required maxLength={8000} value={content} onChange={event => setContent(event.target.value)} placeholder="One reusable fact, decision, preference, or lesson." /></label>
    <div className="grid gap-3 sm:grid-cols-[150px_1fr]"><label className="block space-y-1 text-xs"><span>Category</span><select aria-label="Category" className={inputClass} value={category} onChange={event => setCategory(event.target.value as MemoryItem["category"])}>{["fact", "decision", "preference", "lesson"].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="block space-y-1 text-xs"><span>Reason for change</span><input aria-label="Reason for change" className={inputClass} required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label></div>
    <div className="flex gap-2"><Button type="submit" disabled={busy || !title.trim() || !content.trim() || !reason.trim()}>Save memory</Button><Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button></div>
  </form>;
}

function MemoryHistory({ projectId, memoryId, busy, onClose, onChange }: { projectId: string; memoryId: string; busy: boolean; onClose: () => void; onChange: (action: () => Promise<{ item: MemoryItem }>) => Promise<void> }) {
  const current = useQuery({ queryKey: ["project-memory", projectId, memoryId, "current"], queryFn: () => api.getProjectMemory(projectId, memoryId) });
  const history = useInfiniteQuery({ queryKey: ["project-memory", projectId, memoryId, "history"], queryFn: ({ pageParam }) => api.getMemoryHistory(projectId, memoryId, pageParam), initialPageParam: 0, getNextPageParam: (page, pages) => page.history.length === 50 ? pages.length * 50 : undefined });
  return <section aria-label="Memory history" className="space-y-3 rounded-lg border border-brand/30 bg-surface-2 p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">History · {current.data?.item.title || "Memory"}</h3><button type="button" onClick={onClose} aria-label="Close memory history"><X size={16} /></button></div>
    {current.data ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onChange(() => api.undoProjectMemory(current.data!.item))}><Undo2 size={14} className="mr-1.5" />Undo last change</Button> : null}
    {history.isLoading ? <Loading /> : history.error || current.error ? <p role="alert">{message(history.error || current.error)}</p> : history.data?.pages.flatMap(page => page.history).map(revision => <RevisionCard key={revision.id} revision={revision} onRestore={current.data && revision.revision !== current.data.item.revision ? () => void onChange(() => api.undoProjectMemory(current.data!.item, revision.revision)) : undefined} busy={busy} />)}
    {history.hasNextPage ? <Button size="sm" variant="ghost" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>Load older revisions</Button> : null}
  </section>;
}

function RevisionCard({ revision, onOpen, onRestore, busy }: { revision: MemoryRevision; onOpen?: () => void; onRestore?: () => void; busy?: boolean }) {
  return <article className="rounded-md border border-card-border bg-surface-1 p-3 text-xs">
    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold capitalize">{revision.action}</span><span className="min-w-0 flex-1 truncate font-medium">{revision.after.title}</span><span className="text-foreground/45">r{revision.revision}</span><time className="text-foreground/45">{new Date(revision.createdAt).toLocaleString()}</time></div>
    <p className="mt-1 text-foreground/65">{revision.reason}</p>
    <p className="mt-1 break-all text-[10px] text-foreground/40">{revision.actor.kind === "user" ? "Changed by you" : `Session ${revision.actor.sessionId?.slice(0, 8)} · run ${revision.actor.runId}`}</p>
    <details className="mt-2 text-foreground/60"><summary className="cursor-pointer">View before and after</summary><div className="mt-2 grid gap-3 sm:grid-cols-2"><div><span className="font-semibold">Before</span><p className="mt-1 whitespace-pre-wrap break-words">{revision.before ? `${revision.before.deletedAt !== null ? "[Removed] " : ""}${revision.before.content}` : "Item did not exist."}</p></div><div><span className="font-semibold">After</span><p className="mt-1 whitespace-pre-wrap break-words">{revision.after.deletedAt !== null ? "[Removed] " : ""}{revision.after.content}</p></div></div></details>
    {onOpen || onRestore ? <div className="mt-2 flex gap-2">{onOpen ? <button type="button" className="text-brand" onClick={onOpen}>Open item history</button> : null}{onRestore ? <button type="button" disabled={busy} className="text-brand" onClick={onRestore}>Restore this version</button> : null}</div> : null}
  </article>;
}
function Loading() { return <div className="flex items-center gap-2 py-6 text-sm text-foreground/60"><LoaderCircle size={16} className="animate-spin" />Loading memory…</div>; }
function Empty({ text }: { text: string }) { return <div className="rounded-lg border border-dashed border-card-border p-8 text-center text-sm leading-relaxed text-foreground/55">{text}</div>; }
