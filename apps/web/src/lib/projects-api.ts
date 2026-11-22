import type { Project, MemoryInput, MemoryItem, MemoryRevision, ProjectRunContext } from "@luma/shared";
import { request } from "./api";

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const memory = (project: string, id: string) => `${base(project)}/memory/${encodeURIComponent(id)}`;
export const getProjects = () => request<{ projects: Project[] }>("/api/projects");
export const createProject = (input: Pick<Project, "name" | "instructions" | "allowAgentMemory">) => request<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(input) });
export const updateProject = (project: Project, input: Pick<Project, "name" | "instructions" | "allowAgentMemory">) => request<{ project: Project }>(base(project.id), { method: "PATCH", body: JSON.stringify({ ...input, expectedRevision: project.revision }) });
export const moveSessionToProject = (session: string, projectId: string | null) => request<{ sessionId: string; projectId: string | null }>(`/api/sessions/${encodeURIComponent(session)}/project`, { method: "PUT", body: JSON.stringify({ projectId }) });
export const listProjectMemory = (id: string, query: string, includeDeleted: boolean, offset = 0) => request<{ items: MemoryItem[] }>(`${base(id)}/memory?${new URLSearchParams({ q: query, includeDeleted: includeDeleted ? "1" : "0", limit: "50", offset: String(offset) })}`);
export const getProjectMemory = (project: string, id: string) => request<{ item: MemoryItem }>(memory(project, id));
export const addProjectMemory = (project: string, input: MemoryInput) => request<{ item: MemoryItem }>(`${base(project)}/memory`, { method: "POST", body: JSON.stringify(input) });
export const editProjectMemory = (item: MemoryItem, input: MemoryInput) => request<{ item: MemoryItem }>(memory(item.projectId, item.id), { method: "PATCH", body: JSON.stringify({ ...input, expectedRevision: item.revision }) });
export const removeProjectMemory = (item: MemoryItem) => request<{ item: MemoryItem }>(memory(item.projectId, item.id), { method: "DELETE", body: JSON.stringify({ expectedRevision: item.revision, reason: "Removed by user from project memory." }) });
export const undoProjectMemory = (item: MemoryItem, restoreRevision?: number) => request<{ item: MemoryItem }>(`${memory(item.projectId, item.id)}/undo`, { method: "POST", body: JSON.stringify({ expectedRevision: item.revision, restoreRevision, reason: restoreRevision ? `User restored revision ${restoreRevision}.` : "User undid the latest change." }) });
export const getMemoryHistory = (project: string, id?: string, offset = 0) => request<{ history: MemoryRevision[] }>(`${id ? `${memory(project, id)}/history` : `${base(project)}/memory-history`}?limit=50&offset=${offset}`);
export const getProjectRunContext = (id: string) => request<{ context: ProjectRunContext | null }>(`/api/runs/${encodeURIComponent(id)}/project-context`);
