import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = findWorkspaceRoot(process.cwd()) || findWorkspaceRoot(packageDir) || path.resolve(packageDir, "..", "..");
dotenv.config({ path: path.join(rootDir, ".env") });

const MCP_NAME = process.env.TASK_MANAGER_MCP_NAME || "luma-tasks";
const MCP_PORT = Number(process.env.TASK_MANAGER_MCP_PORT || 9014);
const MCP_HOST = process.env.TASK_MANAGER_MCP_HOST || "127.0.0.1";
const API_PORT = process.env.API_PORT || "9001";
const LUMA_TASKS_API_BASE = normalizeBaseUrl(process.env.LUMA_TASKS_API_BASE || `http://127.0.0.1:${API_PORT}`);
const LUMA_TASKS_USERNAME = process.env.LUMA_TASKS_USERNAME || process.env.TASK_MANAGER_ADMIN_USERNAME || "admin";
const LUMA_TASKS_PASSWORD =
  process.env.LUMA_TASKS_PASSWORD
  || process.env.TASK_MANAGER_ADMIN_PASSWORD
  || process.env.PASSWORD
  || process.env.APP_PASSWORD
  || "";
const LUMA_TASKS_AUTH_TOKEN = process.env.LUMA_TASKS_AUTH_TOKEN || "";
const DEFAULT_TIME_ZONE = process.env.TASK_MANAGER_DEFAULT_TIME_ZONE || "Asia/Tehran";

type ApiResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: { message: string };
    };

type TaskManagerStatus = "todo" | "in_progress" | "blocked" | "done";
type TaskManagerPriority = "low" | "medium" | "high" | "urgent";

type TaskManagerUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  active: boolean;
  timeZone?: string;
};

type TaskManagerProject = {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  createdBy: string;
  userIds: string[];
  createdAt: number;
  updatedAt: number;
};

type TaskManagerTask = {
  id: string;
  title: string;
  description: string;
  status: TaskManagerStatus;
  priority: TaskManagerPriority;
  projectId: string | null;
  assigneeId: string | null;
  createdBy: string;
  dueAt: number | null;
  isDeadline: boolean;
  sortOrder: number;
  labelIds: string[];
  checklist: Array<{ id: string; text: string; done: boolean }>;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

type TaskManagerBootstrap = {
  currentUser: TaskManagerUser;
  users: TaskManagerUser[];
  projects: TaskManagerProject[];
  tasks: TaskManagerTask[];
};

type LoginResponse = {
  token: string;
  expiresAt: number;
  expiresInSeconds: number;
  user: TaskManagerUser;
};

type TokenState = {
  token: string;
  expiresAt: number;
};

const statusSchema = z.enum(["todo", "in_progress", "blocked", "done"]);
const prioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const dateBucketSchema = z.enum(["all", "overdue", "today", "tomorrow", "future", "none"]);
const searchScopeSchema = z.enum(["all", "title", "description", "checklist", "project", "assignee"]);
let tokenState: TokenState | null = LUMA_TASKS_AUTH_TOKEN ? { token: LUMA_TASKS_AUTH_TOKEN, expiresAt: Number.MAX_SAFE_INTEGER } : null;

function findWorkspaceRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return current;
      } catch {
        // Ignore invalid package.json while walking upward.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nowPlus(seconds: number): number {
  return Date.now() + seconds * 1000;
}

function normalizeTimeZone(timeZone: string | undefined | null): string {
  const candidate = (timeZone || DEFAULT_TIME_ZONE).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(Date.now());
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function timeZoneParts(timestamp: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(timestamp);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value || "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function timeZoneOffsetMs(timestamp: number, timeZone: string): number {
  const parts = timeZoneParts(timestamp, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp;
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = utcGuess - timeZoneOffsetMs(utcGuess, timeZone);
  return utcGuess - timeZoneOffsetMs(first, timeZone);
}

function calendarDateWithOffset(year: number, month: number, day: number, offsetDays: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function startOfToday(timeZone: string): number {
  const parts = timeZoneParts(Date.now(), timeZone);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
}

function endOfToday(timeZone: string): number {
  const parts = timeZoneParts(Date.now(), timeZone);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 23, 59, 59, timeZone);
}

function startOfTomorrow(timeZone: string): number {
  const parts = timeZoneParts(Date.now(), timeZone);
  const tomorrow = calendarDateWithOffset(parts.year, parts.month, parts.day, 1);
  return zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0, 0, timeZone);
}

function endOfTomorrow(timeZone: string): number {
  const parts = timeZoneParts(Date.now(), timeZone);
  const tomorrow = calendarDateWithOffset(parts.year, parts.month, parts.day, 1);
  return zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 23, 59, 59, timeZone);
}

function dueBucket(task: Pick<TaskManagerTask, "dueAt">, timeZone: string): "overdue" | "today" | "tomorrow" | "future" | "none" {
  if (!task.dueAt) return "none";
  if (task.dueAt < startOfToday(timeZone)) return "overdue";
  if (task.dueAt <= endOfToday(timeZone)) return "today";
  if (task.dueAt >= startOfTomorrow(timeZone) && task.dueAt <= endOfTomorrow(timeZone)) return "tomorrow";
  return "future";
}

function calendarDaySerial(timestamp: number, timeZone: string): number {
  const parts = timeZoneParts(timestamp, timeZone);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function daysUntilDate(timestamp: number, timeZone: string): number {
  return calendarDaySerial(timestamp, timeZone) - calendarDaySerial(Date.now(), timeZone);
}

function parseDueAt(input: { due_at_ms?: number | null; due_at_iso?: string; due_date?: string; due_time?: string; time_zone?: string }): number | undefined {
  if (typeof input.due_at_ms === "number") return input.due_at_ms;
  if (input.due_at_iso?.trim()) {
    const timestamp = Date.parse(input.due_at_iso.trim());
    if (!Number.isFinite(timestamp)) throw new Error("Invalid due_at_iso.");
    return timestamp;
  }
  if (!input.due_date?.trim()) return undefined;
  const match = input.due_date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("due_date must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timeMatch = (input.due_time || "").trim().match(/^(\d{2}):(\d{2})$/);
  const hour = timeMatch ? Number(timeMatch[1]) : 23;
  const minute = timeMatch ? Number(timeMatch[2]) : 59;
  if (hour > 23 || minute > 59) throw new Error("due_time must use HH:mm from 00:00 to 23:59.");
  const timestamp = zonedTimeToUtc(year, month, day, hour, minute, timeMatch ? 0 : 59, normalizeTimeZone(input.time_zone));
  if (!Number.isFinite(timestamp)) throw new Error("Invalid due date.");
  return timestamp;
}

async function readApiPayload<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) throw new Error(text.slice(0, 500) || `HTTP ${response.status}`);
      throw new Error("Expected JSON response from Luma Tasks API.");
    }
  }

  if (!response.ok) {
    const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : `HTTP ${response.status}`;
    throw new Error(message);
  }

  const apiPayload = payload as ApiResponse<T>;
  if (!apiPayload?.ok) {
    throw new Error(apiPayload?.error?.message || "Luma Tasks API request failed.");
  }
  return apiPayload.data;
}

async function apiRequest<T>(pathName: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (auth) headers.set("Authorization", `Bearer ${await getTaskToken()}`);
  const response = await fetch(`${LUMA_TASKS_API_BASE}${pathName}`, { ...init, headers });
  return readApiPayload<T>(response);
}

async function getTaskToken(): Promise<string> {
  if (tokenState && tokenState.expiresAt > nowPlus(30)) return tokenState.token;
  if (!LUMA_TASKS_PASSWORD.trim()) {
    throw new Error("Set LUMA_TASKS_PASSWORD, TASK_MANAGER_ADMIN_PASSWORD, or PASSWORD for Luma Tasks MCP authentication.");
  }
  const login = await apiRequest<LoginResponse>(
    "/api/taskmanager/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ username: LUMA_TASKS_USERNAME, password: LUMA_TASKS_PASSWORD }),
    },
    false,
  );
  tokenState = { token: login.token, expiresAt: login.expiresAt };
  return login.token;
}

async function getBootstrap(): Promise<TaskManagerBootstrap> {
  return apiRequest<TaskManagerBootstrap>("/api/taskmanager/bootstrap");
}

function findUser(bootstrap: TaskManagerBootstrap, userRef: string | undefined): TaskManagerUser | null {
  const normalized = userRef?.trim().toLowerCase();
  if (!normalized) return null;
  return bootstrap.users.find((user) => (
    user.id.toLowerCase() === normalized
    || user.username.toLowerCase() === normalized
    || user.displayName.toLowerCase() === normalized
  )) || null;
}

function findProject(bootstrap: TaskManagerBootstrap, projectRef: string | undefined): TaskManagerProject | null {
  const normalized = projectRef?.trim().toLowerCase();
  if (!normalized) return null;
  if (["none", "no project", "null"].includes(normalized)) return { id: "", name: "No project", color: "#94a3b8", archived: false, createdBy: "", userIds: [], createdAt: 0, updatedAt: 0 };
  return bootstrap.projects.find((project) => project.id.toLowerCase() === normalized || project.name.toLowerCase() === normalized) || null;
}

function resolveUserId(bootstrap: TaskManagerBootstrap, assigneeId?: string | null, assignee?: string): string | null | undefined {
  if (assigneeId === null) return null;
  if (assigneeId?.trim()) return assigneeId.trim();
  if (!assignee?.trim()) return undefined;
  const user = findUser(bootstrap, assignee);
  if (!user) throw new Error(`Assignee not found: ${assignee}`);
  return user.id;
}

function resolveProjectId(bootstrap: TaskManagerBootstrap, projectId?: string | null, project?: string): string | null | undefined {
  if (projectId === null) return null;
  if (projectId?.trim()) return projectId.trim();
  if (!project?.trim()) return undefined;
  const found = findProject(bootstrap, project);
  if (!found) throw new Error(`Project not found: ${project}`);
  return found.id || null;
}

function resolveUserRefs(bootstrap: TaskManagerBootstrap, userRefs: string[] | undefined): string[] {
  if (!userRefs?.length) return [];
  return [...new Set(userRefs.map((item) => item.trim()).filter(Boolean).map((item) => {
    const user = findUser(bootstrap, item);
    if (!user) throw new Error(`User not found: ${item}`);
    return user.id;
  }))];
}

function simplifyTask(task: TaskManagerTask, bootstrap: TaskManagerBootstrap, timeZone: string): Record<string, unknown> {
  const project = task.projectId ? bootstrap.projects.find((item) => item.id === task.projectId) : null;
  const assignee = task.assigneeId ? bootstrap.users.find((item) => item.id === task.assigneeId) : null;
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    project: project ? { id: project.id, name: project.name } : null,
    assignee: assignee ? { id: assignee.id, username: assignee.username, displayName: assignee.displayName } : null,
    dueAt: task.dueAt,
    dueBucket: dueBucket(task, timeZone),
    isDeadline: task.isDeadline,
    deadlineDaysLeft: task.isDeadline && task.dueAt ? daysUntilDate(task.dueAt, timeZone) : null,
    completedAt: task.completedAt,
    checklist: task.checklist,
  };
}

function simplifyProject(project: TaskManagerProject, bootstrap: TaskManagerBootstrap): Record<string, unknown> {
  const creator = bootstrap.users.find((user) => user.id === project.createdBy);
  const accessUsers = project.userIds
    .map((userId) => bootstrap.users.find((user) => user.id === userId))
    .filter((user): user is TaskManagerUser => Boolean(user))
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      active: user.active,
    }));

  return {
    id: project.id,
    name: project.name,
    color: project.color,
    archived: project.archived,
    createdBy: creator
      ? { id: creator.id, username: creator.username, displayName: creator.displayName }
      : { id: project.createdBy },
    accessUsers,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function taskSearchFields(task: TaskManagerTask, bootstrap: TaskManagerBootstrap): Record<"title" | "description" | "checklist" | "project" | "assignee", string> {
  const project = task.projectId ? bootstrap.projects.find((item) => item.id === task.projectId) : null;
  const assignee = task.assigneeId ? bootstrap.users.find((item) => item.id === task.assigneeId) : null;
  return {
    title: task.title,
    description: task.description,
    checklist: task.checklist.map((item) => item.text).join(" "),
    project: project?.name || "",
    assignee: [assignee?.displayName, assignee?.username].filter(Boolean).join(" "),
  };
}

function searchTask(task: TaskManagerTask, bootstrap: TaskManagerBootstrap, query: string, scope: z.infer<typeof searchScopeSchema>): { score: number; matchedFields: string[] } | null {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (!normalizedQuery || tokens.length === 0) return null;

  const fields = taskSearchFields(task, bootstrap);
  const fieldEntries = Object.entries(fields).filter(([field]) => scope === "all" || field === scope);
  let score = 0;
  const matchedFields = new Set<string>();

  for (const [field, rawValue] of fieldEntries) {
    const value = normalizeSearchText(rawValue);
    if (!value) continue;
    if (value.includes(normalizedQuery)) {
      score += field === "title" ? 20 : 10;
      matchedFields.add(field);
      continue;
    }
    const tokenMatches = tokens.filter((token) => value.includes(token)).length;
    if (tokenMatches > 0) {
      score += tokenMatches * (field === "title" ? 4 : 2);
      matchedFields.add(field);
    }
  }

  if (score === 0) return null;
  return { score, matchedFields: [...matchedFields] };
}

function makeChecklist(items: string[] | undefined): Array<{ id: string; text: string; done: boolean }> {
  if (!items?.length) return [];
  return items
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({
      id: `mcp_check_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
      text,
      done: false,
    }));
}

function toolSuccess<T extends Record<string, unknown>>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function toolFailure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: MCP_NAME, version: "0.1.0" },
    {
      instructions:
        "Use this server to inspect and update Luma Tasks. The get_today_report tool returns final plain text that can be sent directly to Telegram with luma-tel.send_message.",
    },
  );

  server.registerTool(
    "test_connection",
    {
      title: "Test Luma Tasks Connection",
      description: "Verify that the MCP server can authenticate with Luma Tasks and read task-manager bootstrap data.",
      inputSchema: {},
    },
    async () => {
      try {
        const bootstrap = await getBootstrap();
        return toolSuccess({
          ok: true,
          apiBase: LUMA_TASKS_API_BASE,
          currentUser: {
            id: bootstrap.currentUser.id,
            username: bootstrap.currentUser.username,
            displayName: bootstrap.currentUser.displayName,
            role: bootstrap.currentUser.role,
          },
          counts: {
            users: bootstrap.users.length,
            projects: bootstrap.projects.length,
            tasks: bootstrap.tasks.length,
          },
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "get_today_report",
    {
      title: "Get Luma Tasks Today Report",
      description: "Return the plain-text Luma Tasks today report. This text is already formatted for Telegram and should be sent unchanged unless the user asks otherwise.",
      inputSchema: {
        time_zone: z.string().optional().describe("IANA timezone, e.g. Asia/Tehran. Defaults to the current task user timezone."),
        only_mine: z.boolean().optional().describe("Restrict report to tasks assigned to or created by the authenticated task user."),
        assignee: z.string().optional().describe("Optional assignee id, username, or display name."),
        project: z.string().optional().describe("Optional project id or project name."),
      },
    },
    async ({ time_zone, only_mine, assignee, project }) => {
      try {
        let assigneeId: string | undefined;
        let projectId: string | undefined;
        if (assignee || project) {
          const bootstrap = await getBootstrap();
          assigneeId = resolveUserId(bootstrap, undefined, assignee) || undefined;
          projectId = resolveProjectId(bootstrap, undefined, project) || undefined;
        }

        const params = new URLSearchParams({ format: "json" });
        if (time_zone) params.set("timezone", normalizeTimeZone(time_zone));
        if (only_mine) params.set("onlyMine", "true");
        if (assigneeId) params.set("assigneeId", assigneeId);
        if (projectId) params.set("projectId", projectId);

        const result = await apiRequest<{ report: string; timeZone: string }>(`/api/taskmanager/reports/today?${params.toString()}`);
        return toolSuccess({ ok: true, ...result });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_users",
    {
      title: "List Luma Tasks Users",
      description: "List Luma Tasks users visible to the authenticated task user. Use this to find valid assignee ids, usernames, and display names.",
      inputSchema: {
        active_only: z.boolean().default(true).describe("When true, hide disabled users."),
        query: z.string().max(120).optional().describe("Optional case-insensitive filter by id, username, or display name."),
      },
    },
    async ({ active_only, query }) => {
      try {
        const bootstrap = await getBootstrap();
        const normalizedQuery = query ? normalizeSearchText(query) : "";
        const users = bootstrap.users
          .filter((user) => !active_only || user.active)
          .filter((user) => {
            if (!normalizedQuery) return true;
            return [user.id, user.username, user.displayName, user.role, user.timeZone || ""]
              .some((value) => normalizeSearchText(value).includes(normalizedQuery));
          })
          .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.username.localeCompare(b.username))
          .map((user) => ({
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            active: user.active,
            timeZone: user.timeZone || null,
          }));

        return toolSuccess({ ok: true, users });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Luma Tasks Projects",
      description: "List Luma Tasks projects visible to the authenticated task user. Use this to check existing projects before creating or assigning tasks.",
      inputSchema: {
        include_archived: z.boolean().default(false),
        query: z.string().max(120).optional().describe("Optional case-insensitive filter by id, name, creator, or access user."),
      },
    },
    async ({ include_archived, query }) => {
      try {
        const bootstrap = await getBootstrap();
        const normalizedQuery = query ? normalizeSearchText(query) : "";
        const projects = bootstrap.projects
          .filter((project) => include_archived || !project.archived)
          .map((project) => simplifyProject(project, bootstrap))
          .filter((project) => {
            if (!normalizedQuery) return true;
            return normalizeSearchText(JSON.stringify(project)).includes(normalizedQuery);
          });

        return toolSuccess({ ok: true, projects });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create Luma Tasks Project",
      description: "Create a Luma Tasks project/list. Optionally grant project access to selected users by id, username, or display name.",
      inputSchema: {
        name: z.string().min(1).max(80),
        color: z.string().min(1).max(32).default("#12867d").describe("Project color. Use a hex color such as #12867d."),
        access_users: z.array(z.string().min(1)).max(200).optional().describe("Users who should have access. Items can be user ids, usernames, or display names."),
        all_users: z.boolean().default(false).describe("When true, grant access to all active non-admin users."),
      },
    },
    async ({ name, color, access_users, all_users }) => {
      try {
        const bootstrap = await getBootstrap();
        const userIds = all_users
          ? bootstrap.users.filter((user) => user.active && user.role !== "admin").map((user) => user.id)
          : resolveUserRefs(bootstrap, access_users);
        const result = await apiRequest<{ project: TaskManagerProject }>("/api/taskmanager/projects", {
          method: "POST",
          body: JSON.stringify({ name, color, userIds }),
        });
        const refreshed = await getBootstrap();
        return toolSuccess({ ok: true, project: simplifyProject(result.project, refreshed) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List Luma Tasks",
      description: "List tasks visible to the authenticated Luma Tasks user with optional filters.",
      inputSchema: {
        status: statusSchema.optional(),
        priority: prioritySchema.optional(),
        project: z.string().optional().describe("Project id or name."),
        assignee: z.string().optional().describe("Assignee id, username, or display name."),
        due_bucket: dateBucketSchema.default("all").describe("Filter by relative due date bucket."),
        include_done: z.boolean().default(false),
        time_zone: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ status, priority, project, assignee, due_bucket, include_done, time_zone, limit }) => {
      try {
        const bootstrap = await getBootstrap();
        const timeZone = normalizeTimeZone(time_zone || bootstrap.currentUser.timeZone);
        const projectId = resolveProjectId(bootstrap, undefined, project);
        const assigneeId = resolveUserId(bootstrap, undefined, assignee);
        const tasks = bootstrap.tasks
          .filter((task) => include_done || task.status !== "done")
          .filter((task) => !status || task.status === status)
          .filter((task) => !priority || task.priority === priority)
          .filter((task) => projectId === undefined || task.projectId === projectId)
          .filter((task) => assigneeId === undefined || task.assigneeId === assigneeId)
          .filter((task) => due_bucket === "all" || dueBucket(task, timeZone) === due_bucket)
          .sort((a, b) => (a.dueAt || Number.MAX_SAFE_INTEGER) - (b.dueAt || Number.MAX_SAFE_INTEGER) || a.sortOrder - b.sortOrder)
          .slice(0, limit)
          .map((task) => simplifyTask(task, bootstrap, timeZone));

        return toolSuccess({ ok: true, timeZone, tasks });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "search_tasks",
    {
      title: "Search Luma Tasks",
      description: "Search visible Luma Tasks by title, description, checklist, project, or assignee. Use this before updating or completing a task when the task id is unknown.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Search text, such as a task title fragment, project name, assignee name, or checklist text."),
        scope: searchScopeSchema.default("all").describe("Restrict where to search. Defaults to all searchable task fields."),
        status: statusSchema.optional(),
        priority: prioritySchema.optional(),
        project: z.string().optional().describe("Optional project id or name filter."),
        assignee: z.string().optional().describe("Optional assignee id, username, or display name filter."),
        due_bucket: dateBucketSchema.default("all").describe("Optional relative due date filter."),
        include_done: z.boolean().default(false),
        time_zone: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ query, scope, status, priority, project, assignee, due_bucket, include_done, time_zone, limit }) => {
      try {
        const bootstrap = await getBootstrap();
        const timeZone = normalizeTimeZone(time_zone || bootstrap.currentUser.timeZone);
        const projectId = resolveProjectId(bootstrap, undefined, project);
        const assigneeId = resolveUserId(bootstrap, undefined, assignee);
        const results = bootstrap.tasks
          .filter((task) => include_done || task.status !== "done")
          .filter((task) => !status || task.status === status)
          .filter((task) => !priority || task.priority === priority)
          .filter((task) => projectId === undefined || task.projectId === projectId)
          .filter((task) => assigneeId === undefined || task.assigneeId === assigneeId)
          .filter((task) => due_bucket === "all" || dueBucket(task, timeZone) === due_bucket)
          .map((task) => ({ task, match: searchTask(task, bootstrap, query, scope) }))
          .filter((item): item is { task: TaskManagerTask; match: { score: number; matchedFields: string[] } } => item.match !== null)
          .sort((a, b) => b.match.score - a.match.score || (a.task.dueAt || Number.MAX_SAFE_INTEGER) - (b.task.dueAt || Number.MAX_SAFE_INTEGER))
          .slice(0, limit)
          .map((item) => ({
            score: item.match.score,
            matchedFields: item.match.matchedFields,
            task: simplifyTask(item.task, bootstrap, timeZone),
          }));

        return toolSuccess({ ok: true, query, scope, timeZone, results });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create Luma Task",
      description: "Create a task in Luma Tasks. Project and assignee can be supplied by id or human name.",
      inputSchema: {
        title: z.string().min(1).max(160),
        description: z.string().max(4000).optional(),
        status: statusSchema.default("todo"),
        priority: prioritySchema.default("medium"),
        project: z.string().optional().describe("Project id or name."),
        assignee: z.string().optional().describe("Assignee id, username, or display name."),
        due_date: z.string().optional().describe("YYYY-MM-DD. Stored as end of day unless due_time is supplied."),
        due_time: z.string().optional().describe("HH:mm in the chosen timezone."),
        due_at_iso: z.string().optional().describe("ISO timestamp. Overrides due_date when provided."),
        due_at_ms: z.number().int().nonnegative().nullable().optional().describe("Unix timestamp in milliseconds. Overrides due_at_iso and due_date."),
        time_zone: z.string().optional(),
        is_deadline: z.boolean().default(false),
        checklist: z.array(z.string().min(1)).max(50).optional(),
      },
    },
    async (args) => {
      try {
        const bootstrap = await getBootstrap();
        const dueAt = parseDueAt(args);
        const payload = {
          title: args.title,
          description: args.description || "",
          status: args.status,
          priority: args.priority,
          projectId: resolveProjectId(bootstrap, undefined, args.project) ?? null,
          assigneeId: resolveUserId(bootstrap, undefined, args.assignee) ?? null,
          dueAt: dueAt ?? null,
          isDeadline: args.is_deadline,
          labelIds: [],
          checklist: makeChecklist(args.checklist),
        };
        const result = await apiRequest<{ task: TaskManagerTask }>("/api/taskmanager/tasks", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const refreshed = await getBootstrap();
        return toolSuccess({ ok: true, task: simplifyTask(result.task, refreshed, normalizeTimeZone(args.time_zone || refreshed.currentUser.timeZone)) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update Luma Task",
      description: "Update a Luma Tasks task by id. Omit fields that should not change.",
      inputSchema: {
        task_id: z.string().min(1),
        title: z.string().min(1).max(160).optional(),
        description: z.string().max(4000).optional(),
        status: statusSchema.optional(),
        priority: prioritySchema.optional(),
        project: z.string().optional().describe("Project id or name. Use no project to clear."),
        assignee: z.string().optional().describe("Assignee id, username, or display name."),
        due_date: z.string().optional().describe("YYYY-MM-DD. Stored as end of day unless due_time is supplied."),
        due_time: z.string().optional().describe("HH:mm in the chosen timezone."),
        due_at_iso: z.string().optional(),
        due_at_ms: z.number().int().nonnegative().nullable().optional(),
        remove_due_date: z.boolean().optional(),
        time_zone: z.string().optional(),
        is_deadline: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const bootstrap = await getBootstrap();
        const patch: Record<string, unknown> = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.description !== undefined) patch.description = args.description;
        if (args.status !== undefined) patch.status = args.status;
        if (args.priority !== undefined) patch.priority = args.priority;
        const projectId = resolveProjectId(bootstrap, undefined, args.project);
        if (projectId !== undefined) patch.projectId = projectId;
        const assigneeId = resolveUserId(bootstrap, undefined, args.assignee);
        if (assigneeId !== undefined) patch.assigneeId = assigneeId;
        const dueAt = parseDueAt(args);
        if (args.remove_due_date) patch.dueAt = null;
        else if (dueAt !== undefined) patch.dueAt = dueAt;
        if (args.is_deadline !== undefined) patch.isDeadline = args.is_deadline;

        const result = await apiRequest<{ task: TaskManagerTask }>(`/api/taskmanager/tasks/${encodeURIComponent(args.task_id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        const refreshed = await getBootstrap();
        return toolSuccess({ ok: true, task: simplifyTask(result.task, refreshed, normalizeTimeZone(args.time_zone || refreshed.currentUser.timeZone)) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete Luma Task",
      description: "Mark a Luma Tasks task as done.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async ({ task_id }) => {
      try {
        const result = await apiRequest<{ task: TaskManagerTask }>(`/api/taskmanager/tasks/${encodeURIComponent(task_id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "done", completedAt: Date.now() }),
        });
        const bootstrap = await getBootstrap();
        return toolSuccess({ ok: true, task: simplifyTask(result.task, bootstrap, normalizeTimeZone(bootstrap.currentUser.timeZone)) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add Luma Task Comment",
      description: "Add a comment to a Luma Tasks task.",
      inputSchema: {
        task_id: z.string().min(1),
        body: z.string().min(1).max(2000),
      },
    },
    async ({ task_id, body }) => {
      try {
        const result = await apiRequest<Record<string, unknown>>(`/api/taskmanager/tasks/${encodeURIComponent(task_id)}/comments`, {
          method: "POST",
          body: JSON.stringify({ body }),
        });
        return toolSuccess({ ok: true, ...result });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}

const app = createMcpExpressApp({ host: MCP_HOST });

app.get("/health", async (_req, res) => {
  const missingEnv: string[] = [];
  if (!LUMA_TASKS_AUTH_TOKEN && !LUMA_TASKS_PASSWORD.trim()) missingEnv.push("LUMA_TASKS_PASSWORD or TASK_MANAGER_ADMIN_PASSWORD or PASSWORD");

  let apiOk = false;
  let apiError: string | null = null;
  if (missingEnv.length === 0) {
    try {
      await getBootstrap();
      apiOk = true;
    } catch (error) {
      apiError = error instanceof Error ? error.message : String(error);
    }
  }

  res.status(missingEnv.length || !apiOk ? 503 : 200).json({
    ok: missingEnv.length === 0 && apiOk,
    name: MCP_NAME,
    port: MCP_PORT,
    mcpUrl: `http://127.0.0.1:${MCP_PORT}/mcp`,
    apiBase: LUMA_TASKS_API_BASE,
    username: LUMA_TASKS_USERNAME,
    missingEnv,
    apiError,
  });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[taskmanager-mcp] request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.listen(MCP_PORT, MCP_HOST, (error?: Error) => {
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[taskmanager-mcp] failed to start", error);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[taskmanager-mcp] listening on http://${MCP_HOST}:${MCP_PORT}/mcp`);
});
