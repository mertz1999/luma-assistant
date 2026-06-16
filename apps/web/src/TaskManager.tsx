import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Calendar,
  CalendarPlus,
  CalendarX,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  ClipboardCheck,
  Flag,
  Globe2,
  ListTodo,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Sunrise,
  Sun,
  Tag,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type {
  TaskManagerActivity,
  TaskManagerBootstrap,
  TaskManagerChecklistItem,
  TaskManagerComment,
  TaskManagerPriority,
  TaskManagerProject,
  TaskManagerStatus,
  TaskManagerTask,
  TaskManagerUser,
} from "@luma/shared";
import {
  createTaskManagerComment,
  createTaskManagerProject,
  createTaskManagerTask,
  createTaskManagerUser,
  deleteTaskManagerProject,
  deleteTaskManagerTask,
  getTaskManagerBootstrap,
  loginTaskManager,
  setTaskManagerAuthToken,
  updateTaskManagerProject,
  updateTaskManagerProfile,
  updateTaskManagerTask,
  updateTaskManagerUser,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/useUiStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type TaskView = "mine" | "today" | "upcoming" | "completed" | "admin" | "settings";
type TaskSortMode = "manual" | "priority_due";
type TaskDateBucket = "overdue" | "today" | "tomorrow" | "future" | "none";
type TimeZoneRegion = "All" | "Asia" | "Europe" | "America" | "Africa" | "Australia" | "UTC";

const tokenStorageKey = "luma.taskmanager.token";
const projectChipOrderStorageKey = "luma.taskmanager.projectChipOrder";
const defaultTaskManagerTimeZone = "Asia/Tehran";
const statusLabels: Record<TaskManagerStatus, string> = {
  todo: "Todo",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};
const priorityLabels: Record<TaskManagerPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
const priorityColors: Record<TaskManagerPriority, string> = {
  low: "#111827",
  medium: "#4f6df5",
  high: "#f59e0b",
  urgent: "#ef2f2f",
};
const priorityRank: Record<TaskManagerPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};
const colorPalette = ["#12867d", "#0ea5e9", "#f97316", "#a855f7", "#64748b", "#dc2626", "#16a34a", "#db2777"];
const timeZoneRegionOptions: TimeZoneRegion[] = ["All", "Asia", "Europe", "America", "Africa", "Australia", "UTC"];

function randomPaletteColor(): string {
  return colorPalette[Math.floor(Math.random() * colorPalette.length)] || "#12867d";
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(Date.now());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimeZone(timeZone: string | undefined | null): string {
  const candidate = (timeZone || defaultTaskManagerTimeZone).trim();
  return isValidTimeZone(candidate) ? candidate : defaultTaskManagerTimeZone;
}

function browserTimeZone(): string {
  return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || defaultTaskManagerTimeZone);
}

function availableTimeZones(currentTimeZone: string): string[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const supported = supportedValuesOf ? supportedValuesOf("timeZone") : [];
  const common = [
    browserTimeZone(),
    defaultTaskManagerTimeZone,
    "UTC",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Istanbul",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Toronto",
    "America/Sao_Paulo",
  ];
  return [...new Set([currentTimeZone, ...common, ...supported].filter(Boolean).map(normalizeTimeZone))].sort((a, b) => a.localeCompare(b));
}

function timeZoneRegion(timeZone: string): TimeZoneRegion {
  if (timeZone === "UTC" || timeZone.startsWith("Etc/")) return "UTC";
  const region = timeZone.split("/")[0];
  if (region === "Asia" || region === "Europe" || region === "America" || region === "Africa" || region === "Australia") return region;
  return "All";
}

function timeZoneDisplayName(timeZone: string): string {
  if (timeZone === "UTC") return "UTC";
  return timeZone
    .split("/")
    .slice(1)
    .join(" / ")
    .replace(/_/g, " ") || timeZone.replace(/_/g, " ");
}

function timeZoneOffsetLabel(timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
  });
  const offset = formatter.formatToParts(Date.now()).find((part) => part.type === "timeZoneName")?.value || "GMT";
  return offset.replace("GMT", "UTC");
}

function timeZoneLocalTimeLabel(timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: normalizeTimeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
  }).format(Date.now());
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
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value || 0);
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
  const firstOffset = timeZoneOffsetMs(utcGuess, timeZone);
  const firstTimestamp = utcGuess - firstOffset;
  const secondOffset = timeZoneOffsetMs(firstTimestamp, timeZone);
  return utcGuess - secondOffset;
}

function calendarDateWithOffset(year: number, month: number, day: number, offsetDays: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
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

function endOfDateInput(value: string, timeZone: string): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const timestamp = zonedTimeToUtc(year, month, day, 23, 59, 59, timeZone);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDate(timestamp: number | null, timeZone: string): string {
  if (!timestamp) return "No due date";
  const parts = timeZoneParts(timestamp, timeZone);
  const hasSpecificTime = !(parts.hour === 23 && parts.minute === 59);
  return new Intl.DateTimeFormat(
    undefined,
    hasSpecificTime
      ? { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { timeZone, month: "short", day: "numeric" },
  ).format(timestamp);
}

function calendarDaySerial(timestamp: number, timeZone: string): number {
  const parts = timeZoneParts(timestamp, timeZone);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function daysUntilDate(timestamp: number, timeZone: string): number {
  return calendarDaySerial(timestamp, timeZone) - calendarDaySerial(Date.now(), timeZone);
}

function formatDaysLeftLabel(daysLeft: number): string {
  if (daysLeft < 0) {
    const overdueDays = Math.abs(daysLeft);
    return `Overdue by ${overdueDays} ${overdueDays === 1 ? "day" : "days"}`;
  }
  if (daysLeft === 0) return "0 days left";
  if (daysLeft === 1) return "1 day left";
  return `${daysLeft} days left`;
}

function taskDateBucket(task: Pick<TaskManagerTask, "dueAt">, timeZone: string): TaskDateBucket {
  if (!task.dueAt) return "none";
  if (task.dueAt < startOfToday(timeZone)) return "overdue";
  if (task.dueAt <= endOfToday(timeZone)) return "today";
  if (task.dueAt >= startOfTomorrow(timeZone) && task.dueAt <= endOfTomorrow(timeZone)) return "tomorrow";
  return "future";
}

function formatTaskDueLabel(task: Pick<TaskManagerTask, "dueAt" | "isDeadline">, timeZone: string): string {
  const bucket = taskDateBucket(task, timeZone);
  if (bucket === "none") return "No due date";
  if (task.isDeadline && task.dueAt) return formatDaysLeftLabel(daysUntilDate(task.dueAt, timeZone));
  if (bucket === "overdue") return "Overdue";
  if (bucket === "today") return "Today";
  if (bucket === "tomorrow") return "Tomorrow";
  return formatDate(task.dueAt, timeZone);
}

function dateInputValue(timestamp: number | null, timeZone: string): string {
  if (!timestamp) return "";
  const parts = timeZoneParts(timestamp, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function timeInputValue(timestamp: number | null, timeZone: string): string {
  if (!timestamp) return "09:00";
  const parts = timeZoneParts(timestamp, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function hasSpecificDueTime(timestamp: number | null, timeZone: string): boolean {
  if (!timestamp) return false;
  const parts = timeZoneParts(timestamp, timeZone);
  return !(parts.hour === 23 && parts.minute === 59);
}

function parseDueInput(dateValue: string, includeTime: boolean, timeValue: string, timeZone: string): number | null {
  if (!dateValue) return null;
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = (includeTime ? timeValue || "09:00" : "23:59").split(":").map(Number);
  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const timestamp = zonedTimeToUtc(year, month, day, hour, minute, includeTime ? 0 : 59, timeZone);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isOwnTask(task: TaskManagerTask, currentUserId: string): boolean {
  return task.assigneeId ? task.assigneeId === currentUserId : task.createdBy === currentUserId;
}

function isAssignedToUser(task: TaskManagerTask, currentUserId: string): boolean {
  return task.assigneeId === currentUserId;
}

function taskManualOrder(task: TaskManagerTask): number {
  return task.sortOrder || task.createdAt || task.updatedAt;
}

function compareTasksByPriorityAndDueDate(a: TaskManagerTask, b: TaskManagerTask): number {
  const priorityDiff = priorityRank[b.priority] - priorityRank[a.priority];
  if (priorityDiff !== 0) return priorityDiff;
  const aDue = a.dueAt ?? Number.MAX_SAFE_INTEGER;
  const bDue = b.dueAt ?? Number.MAX_SAFE_INTEGER;
  if (aDue !== bDue) return aDue - bDue;
  if (a.isDeadline !== b.isDeadline) return a.isDeadline ? -1 : 1;
  return taskManualOrder(a) - taskManualOrder(b) || b.updatedAt - a.updatedAt;
}

function sortTasks(tasks: TaskManagerTask[], mode: TaskSortMode): TaskManagerTask[] {
  const sorted = [...tasks];
  if (mode === "priority_due") return sorted.sort(compareTasksByPriorityAndDueDate);
  return sorted.sort((a, b) => taskManualOrder(a) - taskManualOrder(b) || b.updatedAt - a.updatedAt);
}

function readProjectChipOrder(): string[] {
  try {
    const raw = localStorage.getItem(projectChipOrderStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))];
  } catch {
    return [];
  }
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function reconcileProjectChipOrder(currentOrder: string[], projects: TaskManagerProject[]): string[] {
  const activeIds = projects.filter((project) => !project.archived).map((project) => project.id);
  const activeIdSet = new Set(activeIds);
  const ordered = currentOrder.filter((id) => activeIdSet.has(id));
  for (const id of activeIds) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return sameStringList(currentOrder, ordered) ? currentOrder : ordered;
}

function sortProjectsByChipOrder(projects: TaskManagerProject[], projectOrder: string[]): TaskManagerProject[] {
  const rank = new Map(projectOrder.map((id, index) => [id, index]));
  return [...projects].sort((a, b) => {
    const aRank = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.createdAt - b.createdAt || a.name.localeCompare(b.name);
  });
}

function taskViewFromPath(): TaskView {
  if (typeof window === "undefined") return "mine";
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/taskmanager/today")) return "today";
  if (path.endsWith("/taskmanager/upcoming")) return "upcoming";
  if (path.endsWith("/taskmanager/completed")) return "completed";
  if (path.endsWith("/taskmanager/admin")) return "admin";
  if (path.endsWith("/taskmanager/settings")) return "settings";
  return "mine";
}

function taskViewPath(view: TaskView): string {
  if (view === "mine") return "/taskmanager";
  return `/taskmanager/${view}`;
}

function registerTaskManagerPwa(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/taskmanager-sw.js", { scope: "/taskmanager" }).catch(() => undefined);
}

function taskMatchesView(task: TaskManagerTask, view: TaskView, currentUserId: string, timeZone: string, includeAllMine = false): boolean {
  if (view === "mine") return (includeAllMine || isOwnTask(task, currentUserId)) && task.status !== "done";
  if (view === "today") return task.dueAt !== null && (task.dueAt <= endOfToday(timeZone) || task.isDeadline) && task.status !== "done";
  if (view === "upcoming") return task.dueAt !== null && task.dueAt > endOfToday(timeZone) && task.status !== "done";
  if (view === "completed") return task.status === "done";
  return false;
}

function emptyTaskForm(currentUserId: string): {
  title: string;
  description: string;
  status: TaskManagerStatus;
  priority: TaskManagerPriority;
  projectId: string;
  assigneeId: string;
  dueDate: string;
  includeDueTime: boolean;
  dueTime: string;
  isDeadline: boolean;
  labelIds: string[];
  checklistText: string;
} {
  return {
    title: "",
    description: "",
    status: "todo",
    priority: "medium",
    projectId: "",
    assigneeId: currentUserId,
    dueDate: "",
    includeDueTime: false,
    dueTime: "09:00",
    isDeadline: false,
    labelIds: [],
    checklistText: "",
  };
}

export function TaskManager(): JSX.Element {
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const [token, setToken] = useState(() => localStorage.getItem(tokenStorageKey) || "");
  const [bootstrap, setBootstrap] = useState<TaskManagerBootstrap | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("");
  const [view, setView] = useState<TaskView>(() => taskViewFromPath());
  const [projectFilter, setProjectFilter] = useState("all");
  const [mobileProjectId, setMobileProjectId] = useState("all");
  const [projectChipOrder, setProjectChipOrder] = useState<string[]>(() => readProjectChipOrder());
  const [taskSortModes, setTaskSortModes] = useState<Record<string, TaskSortMode>>({});
  const [adminOwnTasksOnly, setAdminOwnTasksOnly] = useState(false);
  const [adminUserFilter, setAdminUserFilter] = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [taskForm, setTaskForm] = useState(emptyTaskForm(""));
  const [commentText, setCommentText] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectColor, setNewProjectColor] = useState("");
  const [newUser, setNewUser] = useState({ username: "", displayName: "", password: "", role: "user" as "admin" | "user" });
  const columnScrollerRef = useRef<HTMLDivElement | null>(null);
  const columnDragRef = useRef<{ dragging: boolean; startX: number; scrollLeft: number }>({
    dragging: false,
    startX: 0,
    scrollLeft: 0,
  });
  const autoRefreshInFlightRef = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    registerTaskManagerPwa();
  }, []);

  useEffect(() => {
    localStorage.setItem(projectChipOrderStorageKey, JSON.stringify(projectChipOrder));
  }, [projectChipOrder]);

  useEffect(() => {
    setTaskManagerAuthToken(token || null);
    if (!token) {
      setBootstrap(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [token]);

  useEffect(() => {
    function syncViewFromPath(): void {
      setView(taskViewFromPath());
    }
    window.addEventListener("popstate", syncViewFromPath);
    return () => window.removeEventListener("popstate", syncViewFromPath);
  }, []);

  const currentUser = bootstrap?.currentUser;
  const currentTimeZone = normalizeTimeZone(currentUser?.timeZone);
  const selectedTask = bootstrap?.tasks.find((task) => task.id === selectedTaskId) || null;

  useEffect(() => {
    if (!bootstrap) return;
    setProjectChipOrder((current) => reconcileProjectChipOrder(current, bootstrap.projects));
  }, [bootstrap]);

  useEffect(() => {
    if (!bootstrap || adminUserFilter === "all") return;
    if (!bootstrap.users.some((user) => user.id === adminUserFilter)) setAdminUserFilter("all");
  }, [adminUserFilter, bootstrap]);

  useEffect(() => {
    if (currentUser && currentUser.role !== "admin" && view === "admin") {
      setView("mine");
      window.history.replaceState(null, "", taskViewPath("mine"));
    }
  }, [currentUser, view]);

  const filteredTasks = useMemo(() => {
    if (!bootstrap || !currentUser) return [];
    const adminSelectedUserId = currentUser.role === "admin" && adminUserFilter !== "all" ? adminUserFilter : null;
    const adminSeeingAllTasks = currentUser.role === "admin" && !adminOwnTasksOnly && !adminSelectedUserId;
    const adminSeeingOwnTasksOnly = currentUser.role === "admin" && adminOwnTasksOnly;
    return bootstrap.tasks
      .filter((task) => taskMatchesView(task, view === "admin" ? "mine" : view, currentUser.id, currentTimeZone, currentUser.role === "admin"))
      .filter((task) => {
        if (adminSeeingAllTasks) return true;
        if (currentUser.role === "admin") {
          const matchesSelectedUser = adminSelectedUserId ? isAssignedToUser(task, adminSelectedUserId) : false;
          const matchesCurrentUser = adminSeeingOwnTasksOnly ? isAssignedToUser(task, currentUser.id) : false;
          return matchesSelectedUser || matchesCurrentUser;
        }
        return isOwnTask(task, currentUser.id);
      })
      .filter((task) => projectFilter === "all" || task.projectId === projectFilter)
      .sort((a, b) => taskManualOrder(a) - taskManualOrder(b) || b.updatedAt - a.updatedAt);
  }, [adminOwnTasksOnly, adminUserFilter, bootstrap, currentUser, currentTimeZone, projectFilter, view]);

  const orderedAllProjects = useMemo(() => {
    if (!bootstrap) return [];
    return sortProjectsByChipOrder(bootstrap.projects, projectChipOrder);
  }, [bootstrap, projectChipOrder]);

  const orderedProjects = useMemo(() => orderedAllProjects.filter((project) => !project.archived), [orderedAllProjects]);

  const taskProjectColumns = useMemo(() => {
    if (!bootstrap) return [];
    const activeProjects = orderedProjects.filter((project) => projectFilter === "all" || project.id === projectFilter);
    const projectById = new Map(activeProjects.map((project) => [project.id, project]));
    const grouped = new Map<string, { id: string; name: string; color: string; tasks: TaskManagerTask[] }>();
    const noProjectColumn = { id: "no-project", name: "No project", color: "#94a3b8", tasks: [] as TaskManagerTask[] };

    for (const task of filteredTasks) {
      const project = task.projectId ? projectById.get(task.projectId) : null;
      if (!project) {
        noProjectColumn.tasks.push(task);
        continue;
      }
      const existing = grouped.get(project.id);
      if (existing) {
        existing.tasks.push(task);
      } else {
        grouped.set(project.id, {
          id: project.id,
          name: project.name,
          color: project.color,
          tasks: [task],
        });
      }
    }

    const columns = activeProjects.map((project) => {
      const column = grouped.get(project.id) || { id: project.id, name: project.name, color: project.color, tasks: [] };
      return { ...column, tasks: sortTasks(column.tasks, taskSortModes[column.id] || "manual") };
    });
    if (noProjectColumn.tasks.length > 0 || activeProjects.length === 0) {
      columns.push({ ...noProjectColumn, tasks: sortTasks(noProjectColumn.tasks, taskSortModes["no-project"] || "manual") });
    }
    return columns;
  }, [bootstrap, filteredTasks, orderedProjects, projectFilter, taskSortModes]);

  const mobileProjectTabs = useMemo(
    () => [
      { id: "all", name: "All", color: "#94a3b8", count: filteredTasks.length, sortMode: taskSortModes.all || "manual" },
      ...taskProjectColumns.map((column) => ({ id: column.id, name: column.name, color: column.color, count: column.tasks.length, sortMode: taskSortModes[column.id] || "manual" })),
    ],
    [filteredTasks, taskProjectColumns, taskSortModes],
  );

  const mobileTasks = useMemo(() => {
    if (mobileProjectId === "all") return sortTasks(filteredTasks, taskSortModes.all || "manual");
    return taskProjectColumns.find((column) => column.id === mobileProjectId)?.tasks || [];
  }, [filteredTasks, mobileProjectId, taskProjectColumns, taskSortModes]);

  useEffect(() => {
    if (mobileProjectId === "all") return;
    if (!mobileProjectTabs.some((tab) => tab.id === mobileProjectId)) setMobileProjectId("all");
  }, [mobileProjectId, mobileProjectTabs]);

  useEffect(() => {
    if (!token || !bootstrap) return;

    const timer = window.setInterval(() => {
      if (autoRefreshInFlightRef.current) return;
      autoRefreshInFlightRef.current = true;
      void refresh({ silent: true }).finally(() => {
        autoRefreshInFlightRef.current = false;
      });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [bootstrap, token]);

  async function refresh(options: { silent?: boolean } = {}): Promise<void> {
    try {
      if (!options.silent) setLoading(true);
      setError(null);
      const next = await getTaskManagerBootstrap();
      setBootstrap(next);
      setTaskForm((form) => (form.assigneeId ? form : emptyTaskForm(next.currentUser.id)));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Unable to load task manager.");
      localStorage.removeItem(tokenStorageKey);
      setToken("");
      setTaskManagerAuthToken(null);
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  async function handleLogin(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      setSaving(true);
      setError(null);
      const result = await loginTaskManager({ username: loginUsername, password: loginPassword });
      localStorage.setItem(tokenStorageKey, result.token);
      setTaskManagerAuthToken(result.token);
      setToken(result.token);
      setLoginPassword("");
      window.history.replaceState(null, "", taskViewPath(view));
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login failed.");
    } finally {
      setSaving(false);
    }
  }

  function logout(): void {
    localStorage.removeItem(tokenStorageKey);
    setTaskManagerAuthToken(null);
    setToken("");
    setBootstrap(null);
    window.history.replaceState(null, "", "/taskmanager/login");
  }

  async function saveTask(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!taskForm.title.trim()) return;
    const checklist: TaskManagerChecklistItem[] = taskForm.checklistText
      .split("\n")
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text, index) => ({ id: `check_${Date.now()}_${index}`, text, done: false }));
    try {
      setSaving(true);
      const payload = {
        title: taskForm.title,
        description: taskForm.description,
        status: taskForm.status,
        priority: taskForm.priority,
        projectId: taskForm.projectId || null,
        assigneeId: taskForm.assigneeId || null,
        dueAt: parseDueInput(taskForm.dueDate, taskForm.includeDueTime, taskForm.dueTime, currentTimeZone),
        isDeadline: Boolean(taskForm.dueDate && taskForm.isDeadline),
        labelIds: taskForm.labelIds,
        checklist,
      };
      if (selectedTask && !creatingTask) {
        await updateTaskManagerTask(selectedTask.id, payload);
      } else {
        await createTaskManagerTask(payload);
      }
      setCreatingTask(false);
      setSelectedTaskId(null);
      if (currentUser) setTaskForm(emptyTaskForm(currentUser.id));
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save task.");
    } finally {
      setSaving(false);
    }
  }

  async function patchTask(task: TaskManagerTask, patch: Partial<TaskManagerTask>): Promise<void> {
    try {
      const nextTask = {
        ...task,
        ...patch,
        updatedAt: Date.now(),
      };
      setBootstrap((current) => current
        ? {
            ...current,
            tasks: current.tasks.map((item) => item.id === task.id ? nextTask : item),
          }
        : current);
      await updateTaskManagerTask(task.id, patch);
      await refresh({ silent: true });
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : "Unable to update task.");
    }
  }

  function toggleTaskSortMode(listId: string): void {
    setTaskSortModes((current) => ({
      ...current,
      [listId]: current[listId] === "priority_due" ? "manual" : "priority_due",
    }));
  }

  function moveProjectChip(projectId: string, direction: "left" | "right"): void {
    if (!bootstrap || projectId === "all" || projectId === "no-project") return;
    setProjectChipOrder((current) => {
      const ordered = reconcileProjectChipOrder(current, bootstrap.projects);
      const currentIndex = ordered.indexOf(projectId);
      const nextIndex = direction === "left" ? currentIndex - 1 : currentIndex + 1;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= ordered.length) return ordered;
      const next = [...ordered];
      const [movedProjectId] = next.splice(currentIndex, 1);
      next.splice(nextIndex, 0, movedProjectId);
      return next;
    });
  }

  async function moveTaskInList(tasks: TaskManagerTask[], taskId: string, direction: "up" | "down", listId: string): Promise<void> {
    const currentIndex = tasks.findIndex((task) => task.id === taskId);
    const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= tasks.length) return;

    const reordered = [...tasks];
    const [movedTask] = reordered.splice(currentIndex, 1);
    reordered.splice(nextIndex, 0, movedTask);
    const updates = reordered.map((task, index) => ({ id: task.id, sortOrder: (index + 1) * 1000 }));
    const updateById = new Map(updates.map((update) => [update.id, update.sortOrder]));

    setTaskSortModes((current) => ({ ...current, [listId]: "manual" }));
    setBootstrap((current) => current
      ? {
          ...current,
          tasks: current.tasks.map((task) => updateById.has(task.id) ? { ...task, sortOrder: updateById.get(task.id) || task.sortOrder } : task),
        }
      : current);

    try {
      await Promise.all(
        updates
          .filter((update) => {
            const task = tasks.find((item) => item.id === update.id);
            return task && task.sortOrder !== update.sortOrder;
          })
          .map((update) => updateTaskManagerTask(update.id, { sortOrder: update.sortOrder })),
      );
      await refresh({ silent: true });
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "Unable to reorder tasks.");
      await refresh({ silent: true });
    }
  }

  async function removeTask(task: TaskManagerTask): Promise<void> {
    try {
      await deleteTaskManagerTask(task.id);
      if (selectedTaskId === task.id) setSelectedTaskId(null);
      await refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete task.");
    }
  }

  async function addComment(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedTask || !commentText.trim()) return;
    try {
      await createTaskManagerComment(selectedTask.id, commentText);
      setCommentText("");
      await refresh();
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : "Unable to add comment.");
    }
  }

  async function addProject(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!newProjectName.trim()) return;
    await createTaskManagerProject({ name: newProjectName, color: newProjectColor || randomPaletteColor(), userIds: [] });
    setNewProjectName("");
    setNewProjectColor("");
    await refresh();
  }

  async function editProject(project: TaskManagerProject, input: { name?: string; color?: string; archived?: boolean; userIds?: string[] }): Promise<void> {
    try {
      await updateTaskManagerProject(project.id, input);
      await refresh({ silent: true });
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : "Unable to update project.");
    }
  }

  async function removeProject(project: TaskManagerProject): Promise<void> {
    try {
      await deleteTaskManagerProject(project.id);
      if (projectFilter === project.id) setProjectFilter("all");
      await refresh({ silent: true });
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : "Unable to remove project.");
    }
  }

  async function addUser(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!newUser.username.trim() || !newUser.displayName.trim() || !newUser.password.trim()) return;
    await createTaskManagerUser(newUser);
    setNewUser({ username: "", displayName: "", password: "", role: "user" });
    await refresh();
  }

  async function saveSettings(timeZone: string): Promise<void> {
    try {
      setSaving(true);
      const result = await updateTaskManagerProfile({ timeZone });
      setBootstrap((current) => current
        ? {
            ...current,
            currentUser: result.user,
            users: current.users.map((user) => user.id === result.user.id ? result.user : user),
          }
        : current);
      await refresh({ silent: true });
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : "Unable to save settings.");
    } finally {
      setSaving(false);
    }
  }

  function openTask(task: TaskManagerTask): void {
    setCreatingTask(false);
    setSelectedTaskId(task.id);
    setTaskForm({
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      projectId: task.projectId || "",
      assigneeId: task.assigneeId || "",
      dueDate: dateInputValue(task.dueAt, currentTimeZone),
      includeDueTime: hasSpecificDueTime(task.dueAt, currentTimeZone),
      dueTime: timeInputValue(task.dueAt, currentTimeZone),
      isDeadline: task.isDeadline,
      labelIds: task.labelIds,
      checklistText: task.checklist.map((item) => item.text).join("\n"),
    });
  }

  function startNewTask(projectId = ""): void {
    setCreatingTask(true);
    setSelectedTaskId(null);
    const nextForm = emptyTaskForm(currentUser?.id || "");
    nextForm.projectId = projectId === "no-project" || projectId === "all" ? "" : projectId;
    setTaskForm(nextForm);
  }

  function selectView(nextView: TaskView): void {
    setView(nextView);
    setMobileMenuOpen(false);
    window.history.replaceState(null, "", taskViewPath(nextView));
  }

  function selectProject(projectId: string): void {
    setProjectFilter(projectId);
    setMobileProjectId(projectId);
    setMobileMenuOpen(false);
  }

  function openProjectManager(): void {
    setMobileMenuOpen(false);
    setProjectManagerOpen(true);
  }

  function closeTaskModal(): void {
    setCreatingTask(false);
    setSelectedTaskId(null);
    if (currentUser) setTaskForm(emptyTaskForm(currentUser.id));
  }

  function shouldIgnoreColumnDrag(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(target.closest("button, select, input, textarea, a"));
  }

  function startColumnDrag(event: ReactMouseEvent<HTMLDivElement>): void {
    if (shouldIgnoreColumnDrag(event.target)) return;
    const scroller = columnScrollerRef.current;
    if (!scroller) return;
    columnDragRef.current = {
      dragging: true,
      startX: event.clientX,
      scrollLeft: scroller.scrollLeft,
    };
  }

  function moveColumnDrag(event: ReactMouseEvent<HTMLDivElement>): void {
    const scroller = columnScrollerRef.current;
    const drag = columnDragRef.current;
    if (!scroller || !drag.dragging) return;
    event.preventDefault();
    scroller.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
  }

  function stopColumnDrag(): void {
    columnDragRef.current.dragging = false;
  }

  function mobileCreateProjectId(): string {
    if (mobileProjectId !== "all" && mobileProjectId !== "no-project") return mobileProjectId;
    return projectFilter !== "all" ? projectFilter : "";
  }

  if (!token || (!bootstrap && !loading)) {
    return <TaskManagerLogin username={loginUsername} password={loginPassword} error={error} saving={saving} theme={theme} onToggleTheme={toggleTheme} onUsername={setLoginUsername} onPassword={setLoginPassword} onSubmit={handleLogin} />;
  }

  if (loading || !bootstrap || !currentUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
        <div className="rounded-2xl border border-card-border bg-card px-5 py-4 shadow-soft">Loading task manager...</div>
      </div>
    );
  }

  const comments = bootstrap.comments.filter((comment) => comment.taskId === selectedTask?.id);
  const activity = bootstrap.activity.filter((item) => item.taskId === selectedTask?.id);
  const hasOpenOverlay = mobileMenuOpen || projectManagerOpen || creatingTask || Boolean(selectedTask);

  return (
    <div className="tm-app h-screen min-h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        {error ? <div className="tm-list-rise mx-3 mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">{error}</div> : null}

        {mobileMenuOpen ? (
          <div className="tm-fade-in fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
            <button className="absolute inset-0 bg-black/45" type="button" aria-label="dismiss task navigation" onClick={() => setMobileMenuOpen(false)} />
            <aside className="tm-drawer-in relative flex h-full w-[min(84vw,320px)] flex-col overflow-y-auto border-r border-card-border bg-surface-1 p-3 shadow-soft">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold">Luma Tasks</div>
                  <div className="text-xs text-[color:var(--text-soft)]">{currentUser.displayName} · {currentUser.role}</div>
                </div>
                <Button type="button" variant="ghost" size="sm" className="tm-control-motion" onClick={() => setMobileMenuOpen(false)} aria-label="close task navigation">
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <nav className="space-y-1">
                <ViewButton active={view === "mine"} icon={<ListTodo className="h-4 w-4" />} label="All the tasks" onClick={() => selectView("mine")} />
                <ViewButton active={view === "today"} icon={<Calendar className="h-4 w-4" />} label="Today" onClick={() => selectView("today")} />
                <ViewButton active={view === "upcoming"} icon={<ChevronRight className="h-4 w-4" />} label="Upcoming" onClick={() => selectView("upcoming")} />
                <ViewButton active={view === "completed"} icon={<CheckCircle2 className="h-4 w-4" />} label="Completed" onClick={() => selectView("completed")} />
                {currentUser.role === "admin" ? <ViewButton active={view === "admin"} icon={<Shield className="h-4 w-4" />} label="Admin" onClick={() => selectView("admin")} /> : null}
                <ViewButton active={view === "settings"} icon={<Settings className="h-4 w-4" />} label="Settings" onClick={() => selectView("settings")} />
              </nav>
              {currentUser.role === "admin" ? (
                <AdminTaskFilterControls
                  users={bootstrap.users}
                  currentUser={currentUser}
                  onlyMine={adminOwnTasksOnly}
                  userFilter={adminUserFilter}
                  onOnlyMine={setAdminOwnTasksOnly}
                  onUserFilter={setAdminUserFilter}
                />
              ) : null}

              <section className="mt-5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase text-[color:var(--text-soft)]">
                    <Tag className="h-3.5 w-3.5" /> Projects
                  </div>
                  <button type="button" className="tm-control-motion rounded-lg px-1.5 py-1 text-xs font-semibold text-brand" onClick={openProjectManager}>Manage</button>
                </div>
                <div className="space-y-1">
                  <ProjectFilterButton active={projectFilter === "all"} name="All projects" color="#94a3b8" onClick={() => selectProject("all")} />
                  {orderedProjects.map((project) => (
                    <ProjectFilterButton key={project.id} active={projectFilter === project.id} name={project.name} color={project.color} onClick={() => selectProject(project.id)} />
                  ))}
                </div>
              </section>

              <div className="mt-auto border-t border-card-border pt-3">
                <Button type="button" variant="ghost" size="sm" className="tm-control-motion mb-2 w-full justify-start" onClick={() => void refresh({ silent: true })}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Refresh
                </Button>
                <ThemeToggleButton theme={theme} onToggleTheme={toggleTheme} className="mb-2" />
                <Button type="button" variant="ghost" size="sm" className="tm-control-motion w-full justify-start" onClick={logout}>
                  <LogOut className="mr-2 h-4 w-4" /> Logout
                </Button>
              </div>
            </aside>
          </div>
        ) : null}

        <main className={cn("grid min-h-0 min-w-0 flex-1 overflow-hidden", desktopSidebarOpen ? "lg:grid-cols-[250px_minmax(0,1fr)]" : "lg:grid-cols-[72px_minmax(0,1fr)]")}>
          <aside className={cn("hidden border-r border-card-border bg-card p-3 backdrop-blur-xl lg:flex lg:flex-col", !desktopSidebarOpen && "items-center px-2")}>
            {desktopSidebarOpen ? (
              <>
                <div className="mb-4 rounded-xl border border-card-border bg-control px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-bold">Luma Tasks</div>
                      <div className="truncate text-xs text-[color:var(--text-soft)]">{currentUser.displayName} · {currentUser.role}</div>
                    </div>
                    <Button type="button" variant="ghost" size="sm" className="tm-control-motion h-8 w-8 shrink-0 p-0" onClick={() => setDesktopSidebarOpen(false)} aria-label="collapse task navigation">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <nav className="space-y-1">
                  <ViewButton active={view === "mine"} icon={<ListTodo className="h-4 w-4" />} label="All the tasks" onClick={() => selectView("mine")} />
                  <ViewButton active={view === "today"} icon={<Calendar className="h-4 w-4" />} label="Today" onClick={() => selectView("today")} />
                  <ViewButton active={view === "upcoming"} icon={<ChevronRight className="h-4 w-4" />} label="Upcoming" onClick={() => selectView("upcoming")} />
                  <ViewButton active={view === "completed"} icon={<CheckCircle2 className="h-4 w-4" />} label="Completed" onClick={() => selectView("completed")} />
                  {currentUser.role === "admin" ? <ViewButton active={view === "admin"} icon={<Shield className="h-4 w-4" />} label="Admin" onClick={() => selectView("admin")} /> : null}
                  <ViewButton active={view === "settings"} icon={<Settings className="h-4 w-4" />} label="Settings" onClick={() => selectView("settings")} />
                </nav>
                {currentUser.role === "admin" ? (
                  <AdminTaskFilterControls
                    users={bootstrap.users}
                    currentUser={currentUser}
                    onlyMine={adminOwnTasksOnly}
                    userFilter={adminUserFilter}
                    onOnlyMine={setAdminOwnTasksOnly}
                    onUserFilter={setAdminUserFilter}
                  />
                ) : null}

                <section className="mt-5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-bold uppercase text-[color:var(--text-soft)]">
                      <Tag className="h-3.5 w-3.5" /> Projects
                    </div>
                    <button type="button" className="tm-control-motion rounded-lg px-1.5 py-1 text-xs font-semibold text-brand" onClick={openProjectManager}>Manage</button>
                  </div>
                  <div className="space-y-1">
                    <ProjectFilterButton active={projectFilter === "all"} name="All projects" color="#94a3b8" onClick={() => selectProject("all")} />
                    {orderedProjects.map((project) => (
                      <ProjectFilterButton key={project.id} active={projectFilter === project.id} name={project.name} color={project.color} onClick={() => selectProject(project.id)} />
                    ))}
                  </div>
                </section>

                <div className="mt-5 border-t border-card-border pt-3">
                  <Button type="button" variant="ghost" size="sm" className="tm-control-motion mb-2 w-full justify-start" onClick={() => void refresh({ silent: true })}>
                    <RefreshCw className="mr-2 h-4 w-4" /> Refresh
                  </Button>
                  <ThemeToggleButton theme={theme} onToggleTheme={toggleTheme} className="mb-2" />
                  <Button type="button" variant="ghost" size="sm" className="tm-control-motion w-full justify-start" onClick={logout}>
                    <LogOut className="mr-2 h-4 w-4" /> Logout
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" size="sm" className="tm-control-motion mb-4 h-10 w-10 p-0" onClick={() => setDesktopSidebarOpen(true)} aria-label="expand task navigation" title="Expand navigation">
                  <Menu className="h-5 w-5" />
                </Button>
                <nav className="flex w-full flex-col items-center gap-1">
                  <RailButton active={view === "mine"} icon={<ListTodo className="h-4 w-4" />} label="All the tasks" onClick={() => selectView("mine")} />
                  <RailButton active={view === "today"} icon={<Calendar className="h-4 w-4" />} label="Today" onClick={() => selectView("today")} />
                  <RailButton active={view === "upcoming"} icon={<ChevronRight className="h-4 w-4" />} label="Upcoming" onClick={() => selectView("upcoming")} />
                  <RailButton active={view === "completed"} icon={<CheckCircle2 className="h-4 w-4" />} label="Completed" onClick={() => selectView("completed")} />
                  {currentUser.role === "admin" ? <RailButton active={view === "admin"} icon={<Shield className="h-4 w-4" />} label="Admin" onClick={() => selectView("admin")} /> : null}
                  <RailButton active={view === "settings"} icon={<Settings className="h-4 w-4" />} label="Settings" onClick={() => selectView("settings")} />
                </nav>
                <div className="my-4 h-px w-9 bg-card-border" />
                <div className="flex w-full flex-col items-center gap-2">
                  <ProjectRailButton active={projectFilter === "all"} name="All projects" color="#94a3b8" onClick={() => selectProject("all")} />
                  {orderedProjects.slice(0, 8).map((project) => (
                    <ProjectRailButton key={project.id} active={projectFilter === project.id} name={project.name} color={project.color} onClick={() => selectProject(project.id)} />
                  ))}
                  <RailButton active={projectManagerOpen} icon={<Tag className="h-4 w-4" />} label="Manage projects" onClick={openProjectManager} />
                </div>
                <div className="mt-auto flex w-full flex-col items-center gap-2 border-t border-card-border pt-3">
                  <RailButton active={false} icon={<RefreshCw className="h-4 w-4" />} label="Refresh" onClick={() => void refresh({ silent: true })} />
                  <ThemeToggleButton theme={theme} onToggleTheme={toggleTheme} compact />
                  <RailButton active={false} icon={<LogOut className="h-4 w-4" />} label="Logout" onClick={logout} />
                </div>
              </>
            )}
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card p-3 backdrop-blur-xl">
            {!hasOpenOverlay && (view === "settings" || view === "admin") ? (
              <div className="mb-3 shrink-0 lg:hidden">
                <Button
                  type="button"
                  variant="ghost"
                  className="tm-control-motion h-11 w-full justify-center lg:hidden"
                  onClick={() => setMobileMenuOpen(true)}
                  aria-label="open task navigation"
                >
                  <Menu className="h-4 w-4" />
                  Menu
                </Button>
              </div>
            ) : null}

            {view === "settings" ? (
              <TaskManagerSettingsPanel currentUser={currentUser} timeZone={currentTimeZone} saving={saving} onSave={saveSettings} />
            ) : view === "admin" ? (
              <AdminPanel users={bootstrap.users} newUser={newUser} onNewUser={setNewUser} onAddUser={addUser} onUpdateUser={async (user, patch) => { await updateTaskManagerUser(user.id, patch); await refresh(); }} />
            ) : (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <MobileProjectSwitcher tabs={mobileProjectTabs} activeId={mobileProjectId} onSelect={setMobileProjectId} onSort={toggleTaskSortMode} onMove={moveProjectChip} onOpenMenu={() => setMobileMenuOpen(true)} />
                {taskProjectColumns.length === 0 ? (
                  <div className="tm-list-rise grid min-h-0 flex-1 place-items-center rounded-xl border border-dashed border-card-border text-center text-sm text-[color:var(--text-soft)]">
                    <div>
                      <ClipboardCheck className="mx-auto mb-3 h-8 w-8" />
                      No tasks match this view.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto lg:hidden">
                      {mobileTasks.length ? (
                        mobileTasks.map((task, index) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            users={bootstrap.users}
                            labels={bootstrap.labels}
                            selected={selectedTaskId === task.id}
                            timeZone={currentTimeZone}
                            canMoveUp={index > 0}
                            canMoveDown={index < mobileTasks.length - 1}
                            onOpen={() => openTask(task)}
                            onStatus={(next) => patchTask(task, { status: next })}
                            onDueAt={(dueAt) => patchTask(task, { dueAt })}
                            onMoveUp={() => moveTaskInList(mobileTasks, task.id, "up", mobileProjectId)}
                            onMoveDown={() => moveTaskInList(mobileTasks, task.id, "down", mobileProjectId)}
                          />
                        ))
                      ) : (
                        <div className="tm-list-rise grid min-h-[260px] place-items-center rounded-xl border border-dashed border-card-border text-center text-sm text-[color:var(--text-soft)]">
                          <div>
                            <ClipboardCheck className="mx-auto mb-3 h-8 w-8" />
                            No tasks in this project.
                          </div>
                        </div>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        className="tm-control-motion mt-auto w-full justify-center border border-dashed border-card-border bg-control"
                        onClick={() => startNewTask(mobileCreateProjectId())}
                        aria-label="create task in selected project"
                      >
                        <Plus className="h-4 w-4" />
                        New task here
                      </Button>
                    </div>
                    <div
                      ref={columnScrollerRef}
                      className="scrollbar-none hidden h-full min-h-0 max-w-full flex-1 cursor-grab gap-3 overflow-x-auto overscroll-x-contain active:cursor-grabbing lg:flex"
                      onMouseDown={startColumnDrag}
                      onMouseMove={moveColumnDrag}
                      onMouseUp={stopColumnDrag}
                      onMouseLeave={stopColumnDrag}
                    >
                      {taskProjectColumns.map((column) => (
                        <section key={column.id} className="tm-column-motion flex h-full min-h-0 w-[min(88vw,390px)] shrink-0 flex-col rounded-xl border border-card-border bg-surface-2/55">
                          <div className="shrink-0 flex items-center justify-between border-b border-card-border bg-card/95 px-3 py-2 backdrop-blur-xl">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: column.color }} />
                              <h2 className="truncate text-sm font-bold">{column.name}</h2>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                title="Sort by priority and due date"
                                aria-label={`sort ${column.name} tasks by priority and due date`}
                                className={cn(
                                  "tm-control-motion grid h-8 w-8 place-items-center rounded-lg border border-card-border bg-control text-foreground hover:bg-control-hover",
                                  taskSortModes[column.id] === "priority_due" && "border-brand bg-brand-soft text-brand-dark",
                                )}
                                onClick={() => toggleTaskSortMode(column.id)}
                              >
                                <ArrowUpDown className="h-4 w-4" />
                              </button>
                              <Badge>{column.tasks.length}</Badge>
                            </div>
                          </div>
                          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 scrollbar-thin">
                            {column.tasks.map((task, index) => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                users={bootstrap.users}
                                labels={bootstrap.labels}
                                selected={selectedTaskId === task.id}
                                timeZone={currentTimeZone}
                                canMoveUp={index > 0}
                                canMoveDown={index < column.tasks.length - 1}
                                onOpen={() => openTask(task)}
                                onStatus={(next) => patchTask(task, { status: next })}
                                onDueAt={(dueAt) => patchTask(task, { dueAt })}
                                onMoveUp={() => moveTaskInList(column.tasks, task.id, "up", column.id)}
                                onMoveDown={() => moveTaskInList(column.tasks, task.id, "down", column.id)}
                              />
                            ))}
                          </div>
                          <div className="shrink-0 border-t border-card-border bg-card/80 p-2 backdrop-blur-xl">
                            <Button
                              type="button"
                              variant="ghost"
                              className="tm-control-motion w-full justify-center border border-dashed border-card-border bg-control"
                              onClick={() => startNewTask(column.id)}
                              aria-label={column.id === "no-project" ? "create task without project" : `create task in ${column.name}`}
                            >
                              <Plus className="h-4 w-4" />
                              New task
                            </Button>
                          </div>
                        </section>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

        </main>

        {projectManagerOpen ? (
          <ProjectManagerModal
            projects={orderedAllProjects}
            users={bootstrap.users}
            newProjectName={newProjectName}
            newProjectColor={newProjectColor}
            onNewProject={setNewProjectName}
            onNewProjectColor={setNewProjectColor}
            onAddProject={addProject}
            onUpdateProject={editProject}
            onRemoveProject={removeProject}
            onClose={() => setProjectManagerOpen(false)}
          />
        ) : null}

        {(creatingTask || selectedTask) ? (
          <div className="tm-fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-sm sm:items-center sm:px-3 sm:py-4" role="dialog" aria-modal="true">
            <button className="absolute inset-0 cursor-default" type="button" aria-label="dismiss task editor" onClick={closeTaskModal} />
            <section className="tm-sheet-in relative flex h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-card-border bg-card shadow-soft backdrop-blur-xl sm:h-auto sm:max-h-[92vh] sm:max-w-3xl sm:rounded-2xl">
              <div className="shrink-0 border-b border-card-border px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold">{creatingTask ? "New task" : "Task details"}</h2>
                    <p className="text-xs text-[color:var(--text-soft)]">Edit work, comments, and checklist items.</p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="tm-control-motion" onClick={closeTaskModal} aria-label="close task editor">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-0 scrollbar-thin">
                <TaskEditor
                  task={selectedTask}
                  creating={creatingTask}
                  form={taskForm}
                  users={bootstrap.users}
                  projects={bootstrap.projects}
                  saving={saving}
                  comments={comments}
                  activity={activity}
                  currentUser={currentUser}
                  timeZone={currentTimeZone}
                  commentText={commentText}
                  onForm={setTaskForm}
                  onSave={saveTask}
                  onComment={setCommentText}
                  onAddComment={addComment}
                />
              </div>
              <div className="shrink-0 border-t border-card-border bg-card/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-xl">
                <div className="flex items-center justify-between gap-2">
                  {selectedTask ? <Button type="button" variant="danger" size="sm" className="tm-control-motion" onClick={() => removeTask(selectedTask)}><Trash2 className="h-4 w-4" /> Delete</Button> : <span />}
                  <Button type="submit" form="task-editor-form" className="tm-control-motion" disabled={saving}>{saving ? "Saving..." : "Save task"}</Button>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThemeToggleButton({
  theme,
  onToggleTheme,
  compact = false,
  className,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  compact?: boolean;
  className?: string;
}): JSX.Element {
  const nextThemeLabel = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
  const icon = theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />;

  if (compact) {
    return (
      <Button type="button" variant="ghost" size="sm" className={cn("tm-control-motion h-10 w-10 p-0", className)} onClick={onToggleTheme} aria-label={nextThemeLabel} title={nextThemeLabel}>
        {icon}
      </Button>
    );
  }

  return (
    <Button type="button" variant="ghost" size="sm" className={cn("tm-control-motion w-full justify-start", className)} onClick={onToggleTheme}>
      <span className="mr-2">{icon}</span>
      {nextThemeLabel}
    </Button>
  );
}

function TaskManagerLogin(props: {
  username: string;
  password: string;
  error: string | null;
  saving: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}): JSX.Element {
  return (
    <div className="tm-app grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <form onSubmit={props.onSubmit} className="tm-sheet-in w-full max-w-md rounded-2xl border border-card-border bg-card p-5 shadow-soft backdrop-blur-xl">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand text-white">
              <ClipboardCheck className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold">Luma Tasks</h1>
              <p className="text-sm text-[color:var(--text-soft)]">Sign in to manage team work</p>
            </div>
          </div>
          <ThemeToggleButton theme={props.theme} onToggleTheme={props.onToggleTheme} compact className="shrink-0" />
        </div>
        {props.error ? <p className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">{props.error}</p> : null}
        <label className="mb-3 block text-sm font-semibold">
          Username
          <input value={props.username} onChange={(event) => props.onUsername(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-control px-3 outline-none focus-ring" autoComplete="username" />
        </label>
        <label className="mb-4 block text-sm font-semibold">
          Password
          <input value={props.password} onChange={(event) => props.onPassword(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-card-border bg-control px-3 outline-none focus-ring" type="password" autoComplete="current-password" />
        </label>
        <Button className="tm-control-motion w-full" type="submit" disabled={props.saving}>{props.saving ? "Signing in..." : "Sign in"}</Button>
      </form>
    </div>
  );
}

function ViewButton({ active, icon, label, onClick }: { active: boolean; icon: JSX.Element; label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className={cn("tm-control-motion flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-semibold transition hover:bg-control-hover", active ? "bg-brand text-white hover:bg-brand-dark" : "text-foreground")}>
      {icon}
      {label}
    </button>
  );
}

function AdminTaskFilterControls({
  users,
  currentUser,
  onlyMine,
  userFilter,
  onOnlyMine,
  onUserFilter,
}: {
  users: TaskManagerUser[];
  currentUser: TaskManagerUser;
  onlyMine: boolean;
  userFilter: string;
  onOnlyMine: (value: boolean) => void;
  onUserFilter: (value: string) => void;
}): JSX.Element {
  const orderedUsers = [...users].sort((a, b) => {
    if (a.id === currentUser.id) return -1;
    if (b.id === currentUser.id) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  return (
    <div className="mt-3 space-y-2">
      <label className="flex items-center gap-2 rounded-xl border border-card-border bg-control px-3 py-2 text-sm font-semibold">
        <input checked={onlyMine} onChange={(event) => onOnlyMine(event.target.checked)} type="checkbox" className="h-4 w-4 accent-brand" />
        Only my tasks
      </label>
      <label className="block rounded-xl border border-card-border bg-control px-3 py-2">
        <span className="mb-1.5 flex items-center gap-2 text-xs font-bold uppercase text-[color:var(--text-soft)]">
          <Users className="h-3.5 w-3.5" />
          User tasks
        </span>
        <select
          value={userFilter}
          onChange={(event) => onUserFilter(event.target.value)}
          className="h-9 w-full rounded-lg border border-card-border bg-surface-1 px-2 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
        >
          <option value="all">All users</option>
          {orderedUsers.map((user) => (
            <option key={user.id} value={user.id}>
              {user.id === currentUser.id ? `${user.displayName} (me)` : `${user.displayName}${user.active ? "" : " (disabled)"}`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function RailButton({ active, icon, label, onClick }: { active: boolean; icon: JSX.Element; label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "tm-control-motion grid h-10 w-10 place-items-center rounded-xl transition hover:bg-control-hover",
        active ? "bg-brand text-white hover:bg-brand-dark" : "text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

function ProjectFilterButton({ active, name, color, onClick }: { active: boolean; name: string; color: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className={cn("tm-control-motion flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-sm transition hover:bg-control-hover", active && "bg-control")}>
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{name}</span>
    </button>
  );
}

function ProjectRailButton({ active, name, color, onClick }: { active: boolean; name: string; color: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      onClick={onClick}
      className={cn(
        "tm-control-motion grid h-9 w-10 place-items-center rounded-xl transition hover:bg-control-hover",
        active && "bg-control",
      )}
    >
      <span className={cn("h-3 w-3 rounded-full", active && "ring-2 ring-brand ring-offset-2 ring-offset-card")} style={{ backgroundColor: color }} />
    </button>
  );
}

function MobileProjectSwitcher({
  tabs,
  activeId,
  onSelect,
  onSort,
  onMove,
  onOpenMenu,
}: {
  tabs: Array<{ id: string; name: string; color: string; count: number; sortMode: TaskSortMode }>;
  activeId: string;
  onSelect: (id: string) => void;
  onSort: (id: string) => void;
  onMove: (id: string, direction: "left" | "right") => void;
  onOpenMenu: () => void;
}): JSX.Element {
  const movableTabs = tabs.filter((tab) => tab.id !== "all" && tab.id !== "no-project");
  const movableIndexById = new Map(movableTabs.map((tab, index) => [tab.id, index]));

  return (
    <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-3 border-b border-card-border bg-card/95 px-3 py-2 backdrop-blur-xl lg:hidden">
      <div className="scrollbar-none flex gap-2 overflow-x-auto">
        <button
          type="button"
          className="tm-control-motion grid h-9 w-9 shrink-0 place-items-center rounded-full border border-card-border bg-control text-foreground transition hover:bg-control-hover"
          onClick={onOpenMenu}
          aria-label="open task navigation"
          title="Menu"
        >
          <Menu className="h-4 w-4" />
        </button>
        {tabs.map((tab) => {
          const active = activeId === tab.id;
          const movableIndex = movableIndexById.get(tab.id) ?? -1;
          const canMove = active && movableIndex >= 0;
          const canMoveLeft = canMove && movableIndex > 0;
          const canMoveRight = canMove && movableIndex < movableTabs.length - 1;
          return (
            <span
              key={tab.id}
              className={cn(
                "tm-chip-motion inline-flex h-9 shrink-0 items-center overflow-hidden rounded-full border text-sm font-semibold transition",
                active ? "border-transparent bg-brand text-white" : "border-card-border bg-control text-foreground hover:bg-control-hover",
              )}
            >
              <button type="button" onClick={() => onSelect(tab.id)} className="inline-flex h-full items-center gap-2 py-0 pl-3 pr-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: active ? "currentColor" : tab.color }} />
                <span>{tab.name}</span>
                <span className={cn("rounded-full px-1.5 text-[11px]", active ? "bg-white/20" : "bg-surface-2")}>{tab.count}</span>
              </button>
              <button
                type="button"
                title="Sort by priority and due date"
                aria-label={`sort ${tab.name} tasks by priority and due date`}
                className={cn(
                  "tm-control-motion grid h-full w-8 place-items-center border-l transition",
                  active ? "border-white/20 hover:bg-white/15" : "border-card-border hover:bg-control-hover",
                  tab.sortMode === "priority_due" && (active ? "bg-white/20" : "bg-brand-soft text-brand-dark"),
                )}
                onClick={() => onSort(tab.id)}
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
              </button>
              {canMove ? (
                <>
                  <button
                    type="button"
                    title={`Move ${tab.name} left`}
                    aria-label={`move ${tab.name} chip left`}
                    disabled={!canMoveLeft}
                    className={cn("tm-control-motion grid h-full w-8 place-items-center border-l border-white/20 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-35")}
                    onClick={() => onMove(tab.id, "left")}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title={`Move ${tab.name} right`}
                    aria-label={`move ${tab.name} chip right`}
                    disabled={!canMoveRight}
                    className={cn("tm-control-motion grid h-full w-8 place-items-center border-l border-white/20 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-35")}
                    onClick={() => onMove(tab.id, "right")}
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({ task, users, labels, selected, timeZone, compact = false, canMoveUp, canMoveDown, onOpen, onStatus, onDueAt, onMoveUp, onMoveDown }: {
  task: TaskManagerTask;
  users: TaskManagerUser[];
  labels: TaskManagerBootstrap["labels"];
  selected: boolean;
  timeZone: string;
  compact?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onOpen: () => void;
  onStatus: (status: TaskManagerStatus) => void;
  onDueAt: (dueAt: number | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}): JSX.Element {
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const assignee = users.find((user) => user.id === task.assigneeId);
  const taskLabels = labels.filter((label) => task.labelIds.includes(label.id));
  const dueBucket = taskDateBucket(task, timeZone);
  const dueLabel = formatTaskDueLabel(task, timeZone);

  function handleDateInput(value: string): void {
    const dueAt = endOfDateInput(value, timeZone);
    if (dueAt !== null) onDueAt(dueAt);
  }

  function openDatePicker(): void {
    if (dateInputRef.current?.showPicker) {
      dateInputRef.current.showPicker();
    } else {
      dateInputRef.current?.click();
    }
  }

  return (
    <article
      className={cn("tm-card-motion group relative rounded-xl border border-card-border bg-control p-3 transition hover:border-foreground/30", selected && "border-brand ring-2 ring-brand/20")}
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <button type="button" className="mt-0.5 text-brand" onClick={() => onStatus(task.status === "done" ? "todo" : "done")} aria-label="toggle task status">
            {task.status === "done" ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
          </button>
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={cn("truncate font-semibold", task.status === "done" && "text-[color:var(--text-soft)] line-through")}>{task.title}</h3>
              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase text-white" style={{ backgroundColor: priorityColors[task.priority] }}>
                <Flag className="h-3 w-3 fill-current" />
                {priorityLabels[task.priority]}
              </span>
              <Badge>{statusLabels[task.status]}</Badge>
            </div>
            {!compact && task.description ? (
              <p className="mt-1 hidden line-clamp-1 text-sm text-[color:var(--text-soft)] lg:block" title={task.description}>
                {task.description}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--text-soft)]">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 font-semibold",
                  dueBucket === "overdue" && "bg-red-50 text-red-600 dark:bg-red-950/35 dark:text-red-300",
                  dueBucket === "today" && "bg-amber-50 text-amber-700 dark:bg-amber-950/35 dark:text-amber-300",
                  dueBucket === "tomorrow" && "bg-blue-50 text-blue-700 dark:bg-blue-950/35 dark:text-blue-300",
                  dueBucket === "future" && "bg-surface-2 text-[color:var(--text-soft)]",
                  dueBucket === "none" && "bg-surface-2 text-[color:var(--text-soft)]",
                )}
              >
                {dueLabel}
              </span>
              {task.dueAt && task.isDeadline ? <span className="rounded-full bg-red-50 px-2 py-0.5 font-semibold text-red-600 dark:bg-red-950/35 dark:text-red-300">Deadline</span> : null}
              {assignee ? <span>· {assignee.displayName}</span> : null}
            </div>
            {taskLabels.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {taskLabels.map((label) => <span key={label.id} className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: label.color }}>{label.name}</span>)}
              </div>
            ) : null}
          </button>
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              title="Move task up"
              aria-label="move task up"
              className="tm-control-motion grid h-7 w-7 place-items-center rounded-lg border border-card-border bg-card text-foreground hover:bg-control-hover disabled:cursor-not-allowed disabled:opacity-35"
              onClick={onMoveUp}
              disabled={!canMoveUp}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Move task down"
              aria-label="move task down"
              className="tm-control-motion grid h-7 w-7 place-items-center rounded-lg border border-card-border bg-card text-foreground hover:bg-control-hover disabled:cursor-not-allowed disabled:opacity-35"
              onClick={onMoveDown}
              disabled={!canMoveDown}
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {!compact ? (
          <div className="hidden flex-wrap items-center gap-1 pl-8 opacity-65 transition group-focus-within:opacity-100 group-hover:opacity-100 lg:flex" onClick={(event) => event.stopPropagation()}>
            <button type="button" title="Move to today" aria-label="Move to today" className="tm-control-motion grid h-8 w-8 place-items-center rounded-lg border border-card-border bg-control text-foreground hover:bg-control-hover" onClick={() => onDueAt(endOfToday(timeZone))}>
              <Sun className="h-4 w-4" />
            </button>
            <button type="button" title="Move to tomorrow" aria-label="Move to tomorrow" className="tm-control-motion grid h-8 w-8 place-items-center rounded-lg border border-card-border bg-control text-foreground hover:bg-control-hover" onClick={() => onDueAt(endOfTomorrow(timeZone))}>
              <Sunrise className="h-4 w-4" />
            </button>
            <button type="button" title="Move to another date" aria-label="Move to another date" className="tm-control-motion grid h-8 w-8 place-items-center rounded-lg border border-card-border bg-control text-foreground hover:bg-control-hover" onClick={openDatePicker}>
              <CalendarPlus className="h-4 w-4" />
            </button>
            <button type="button" title="Remove date" aria-label="Remove date" className="tm-control-motion grid h-8 w-8 place-items-center rounded-lg border border-card-border bg-control text-foreground hover:bg-control-hover" onClick={() => onDueAt(null)}>
              <CalendarX className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={task.status === "in_progress" ? "Move to todo" : "Move to doing"}
              aria-label={task.status === "in_progress" ? "Move to todo" : "Move to doing"}
              className={cn(
                "tm-control-motion grid h-8 w-8 place-items-center rounded-lg border border-card-border bg-control text-foreground hover:bg-control-hover",
                task.status === "in_progress" && "border-brand/40 bg-brand-soft text-brand-dark",
              )}
              onClick={() => onStatus(task.status === "in_progress" ? "todo" : "in_progress")}
            >
              {task.status === "in_progress" ? <ListTodo className="h-4 w-4" /> : <ClipboardCheck className="h-4 w-4" />}
            </button>
          </div>
        ) : null}
      </div>
      <span className="absolute h-0 w-0 overflow-hidden">
        <input
          ref={dateInputRef}
          type="date"
          aria-hidden="true"
          className="h-0 w-0 opacity-0"
          tabIndex={-1}
          defaultValue={dateInputValue(task.dueAt, timeZone)}
          onChange={(event) => handleDateInput(event.target.value)}
        />
      </span>
    </article>
  );
}

function TaskEditor(props: {
  task: TaskManagerTask | null;
  creating: boolean;
  form: ReturnType<typeof emptyTaskForm>;
  users: TaskManagerUser[];
  projects: TaskManagerProject[];
  saving: boolean;
  comments: TaskManagerComment[];
  activity: TaskManagerActivity[];
  currentUser: TaskManagerUser;
  timeZone: string;
  commentText: string;
  onForm: (form: ReturnType<typeof emptyTaskForm>) => void;
  onSave: (event: FormEvent) => void;
  onComment: (value: string) => void;
  onAddComment: (event: FormEvent) => void;
}): JSX.Element {
  const active = props.creating || props.task;
  const updateForm = (patch: Partial<ReturnType<typeof emptyTaskForm>>) => props.onForm({ ...props.form, ...patch });
  if (!active) {
    return <div className="min-h-[120px]" />;
  }
  return (
    <div className="space-y-4">
      <form id="task-editor-form" onSubmit={props.onSave} className="space-y-4">
        <section className="rounded-xl border border-card-border bg-surface-2/55 p-3">
          <div className="mb-3 text-xs font-bold uppercase text-[color:var(--text-soft)]">Core info</div>
          <div className="space-y-3">
            <input value={props.form.title} onChange={(event) => updateForm({ title: event.target.value })} className="h-11 w-full rounded-xl border border-card-border bg-control px-3 text-sm font-semibold outline-none focus-ring" placeholder="Task title" />
            <textarea value={props.form.description} onChange={(event) => updateForm({ description: event.target.value })} className="min-h-24 w-full resize-y rounded-xl border border-card-border bg-control px-3 py-2 text-sm outline-none focus-ring" placeholder="Description" />
            <label className="block text-xs font-bold uppercase text-[color:var(--text-soft)]">
              Project
              <select
                value={props.form.projectId}
                onChange={(event) => updateForm({ projectId: event.target.value })}
                className="mt-1 h-11 w-full rounded-xl border bg-control px-3 text-sm font-semibold normal-case text-foreground"
                style={{ borderColor: props.projects.find((project) => project.id === props.form.projectId)?.color || undefined }}
              >
                <option value="">No project</option>
                {props.projects.filter((project) => !project.archived).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-card-border bg-surface-2/55 p-3">
          <div className="mb-3 text-xs font-bold uppercase text-[color:var(--text-soft)]">Status and ownership</div>
          <div className="grid gap-2 sm:grid-cols-3">
            <select value={props.form.status} onChange={(event) => updateForm({ status: event.target.value as TaskManagerStatus })} className="h-10 rounded-xl border border-card-border bg-control px-3 text-sm">
              {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select
              value={props.form.priority}
              onChange={(event) => updateForm({ priority: event.target.value as TaskManagerPriority })}
              className="h-10 rounded-xl border bg-control px-3 text-sm font-semibold"
              style={{ borderColor: priorityColors[props.form.priority], color: priorityColors[props.form.priority] }}
            >
              {Object.entries(priorityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select value={props.form.assigneeId} onChange={(event) => updateForm({ assigneeId: event.target.value })} className="h-10 rounded-xl border border-card-border bg-control px-3 text-sm">
              <option value="">Unassigned</option>
              {props.users.filter((user) => user.active).map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}
            </select>
          </div>
        </section>

        <section className="rounded-xl border border-card-border bg-surface-2/55 p-3">
          <div className="mb-3 text-xs font-bold uppercase text-[color:var(--text-soft)]">Date</div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <input value={props.form.dueDate} onChange={(event) => updateForm({ dueDate: event.target.value, isDeadline: event.target.value ? props.form.isDeadline : false })} type="date" className="h-10 w-full rounded-xl border border-card-border bg-control px-3 text-sm" />
            <label className="flex h-10 items-center gap-2 rounded-xl border border-card-border bg-control px-3 text-sm font-semibold">
              <input checked={props.form.isDeadline} onChange={(event) => updateForm({ isDeadline: event.target.checked })} type="checkbox" className="h-4 w-4 accent-brand" disabled={!props.form.dueDate} />
              Deadline
            </label>
            <label className="flex h-10 items-center gap-2 rounded-xl border border-card-border bg-control px-3 text-sm font-semibold">
              <input checked={props.form.includeDueTime} onChange={(event) => updateForm({ includeDueTime: event.target.checked })} type="checkbox" className="h-4 w-4 accent-brand" />
              Set time
            </label>
          </div>
          {props.form.includeDueTime ? (
            <input value={props.form.dueTime} onChange={(event) => updateForm({ dueTime: event.target.value })} type="time" className="mt-2 h-10 w-full rounded-xl border border-card-border bg-control px-3 text-sm" />
          ) : null}
        </section>

        <section className="rounded-xl border border-card-border bg-surface-2/55 p-3">
          <div className="mb-3 text-xs font-bold uppercase text-[color:var(--text-soft)]">Checklist</div>
          <textarea value={props.form.checklistText} onChange={(event) => updateForm({ checklistText: event.target.value })} className="min-h-20 w-full resize-y rounded-xl border border-card-border bg-control px-3 py-2 text-sm outline-none focus-ring" placeholder="Checklist, one item per line" />
        </section>
      </form>

      {props.task ? (
        <>
          <form onSubmit={props.onAddComment} className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-bold"><MessageSquare className="h-4 w-4" /> Comments</div>
            <textarea value={props.commentText} onChange={(event) => props.onComment(event.target.value)} className="min-h-16 w-full resize-y rounded-xl border border-card-border bg-control px-3 py-2 text-sm outline-none focus-ring" placeholder="Add a comment" />
            <Button size="sm" type="submit">Add comment</Button>
          </form>
          <div className="space-y-2">
            {props.comments.map((comment) => {
              const user = props.users.find((item) => item.id === comment.userId);
              return <div key={comment.id} className="rounded-xl border border-card-border bg-control p-2 text-sm"><strong>{user?.displayName || "User"}</strong><p className="text-[color:var(--text-soft)]">{comment.body}</p></div>;
            })}
          </div>
          <div>
            <div className="mb-2 text-sm font-bold">Activity</div>
            <div className="space-y-1">
              {props.activity.slice(0, 8).map((item) => <div key={item.id} className="text-xs text-[color:var(--text-soft)]">{formatDate(item.createdAt, props.timeZone)} · {item.detail}</div>)}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ProjectManagerModal(props: {
  projects: TaskManagerProject[];
  users: TaskManagerUser[];
  newProjectName: string;
  newProjectColor: string;
  onNewProject: (value: string) => void;
  onNewProjectColor: (value: string) => void;
  onAddProject: (event: FormEvent) => void;
  onUpdateProject: (project: TaskManagerProject, input: { name?: string; color?: string; archived?: boolean; userIds?: string[] }) => Promise<void>;
  onRemoveProject: (project: TaskManagerProject) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const assignableUsers = props.users.filter((user) => user.active && user.role !== "admin");
  const [drafts, setDrafts] = useState<Record<string, { name: string; color: string; userIds: string[] }>>(() => Object.fromEntries(
    props.projects.map((project) => [project.id, { name: project.name, color: project.color, userIds: project.userIds || [] }]),
  ));
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set(props.projects[0]?.id ? [props.projects[0].id] : []));

  useEffect(() => {
    setDrafts(Object.fromEntries(props.projects.map((project) => [project.id, { name: project.name, color: project.color, userIds: project.userIds || [] }])));
  }, [props.projects]);

  function updateDraft(project: TaskManagerProject, patch: Partial<{ name: string; color: string; userIds: string[] }>): void {
    setDrafts((current) => ({
      ...current,
      [project.id]: {
        name: current[project.id]?.name ?? project.name,
        color: current[project.id]?.color ?? project.color,
        userIds: current[project.id]?.userIds ?? project.userIds ?? [],
        ...patch,
      },
    }));
  }

  function toggleProject(projectId: string): void {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  return (
    <div className="tm-fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-sm sm:items-center sm:px-3 sm:py-4" role="dialog" aria-modal="true">
      <button className="absolute inset-0 cursor-default" type="button" aria-label="dismiss project manager" onClick={props.onClose} />
      <section className="tm-sheet-in relative flex h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-card-border bg-card shadow-soft backdrop-blur-xl sm:h-auto sm:max-h-[92vh] sm:max-w-3xl sm:rounded-2xl">
        <div className="shrink-0 border-b border-card-border px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold">Projects</h2>
              <p className="text-xs text-[color:var(--text-soft)]">Create, rename, color, archive, or remove projects.</p>
            </div>
            <Button type="button" variant="ghost" size="sm" className="tm-control-motion" onClick={props.onClose} aria-label="close project manager">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] scrollbar-thin">
          <form onSubmit={props.onAddProject} className="mb-4 rounded-xl border border-card-border bg-surface-2/60 p-3">
            <div className="mb-2 text-xs font-bold uppercase text-[color:var(--text-soft)]">Add project</div>
            <div className="mb-2 flex gap-2">
              <input value={props.newProjectName} onChange={(event) => props.onNewProject(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-card-border bg-control px-3 py-2 text-sm outline-none" placeholder="Project name" />
              <Button size="sm" type="submit" className="tm-control-motion"><Plus className="h-4 w-4" /></Button>
            </div>
            <ColorSwatches value={props.newProjectColor} onChange={props.onNewProjectColor} />
          </form>

          <div className="space-y-2">
            {props.projects.map((project) => {
              const draft = drafts[project.id] || { name: project.name, color: project.color, userIds: project.userIds || [] };
              const expanded = expandedProjectIds.has(project.id);
              return (
                <div key={project.id} className="tm-card-motion overflow-hidden rounded-xl border border-card-border bg-control">
                  <button type="button" className="tm-control-motion flex w-full items-center justify-between gap-3 px-3 py-3 text-left" onClick={() => toggleProject(project.id)}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: draft.color || project.color }} />
                      <span className="truncate text-sm font-bold">{draft.name || project.name}</span>
                      {project.archived ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-[color:var(--text-soft)]">Archived</span> : null}
                    </span>
                    <ChevronRight className={cn("h-4 w-4 shrink-0 transition", expanded && "rotate-90")} />
                  </button>

                  {expanded ? (
                    <div className="tm-list-rise border-t border-card-border p-3">
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                        <div className="min-w-0 space-y-3">
                          <input value={draft.name} onChange={(event) => updateDraft(project, { name: event.target.value })} className="h-10 w-full rounded-lg border border-card-border bg-card px-3 text-sm font-semibold outline-none" />
                          <ColorSwatches value={draft.color} onChange={(color) => updateDraft(project, { color })} />
                          <div className="rounded-xl border border-card-border bg-card p-2">
                            <div className="mb-2 text-xs font-bold uppercase text-[color:var(--text-soft)]">Access</div>
                            {assignableUsers.length ? (
                              <div className="flex flex-wrap gap-2">
                                {assignableUsers.map((user) => {
                                  const checked = draft.userIds.includes(user.id);
                                  return (
                                    <label key={user.id} className={cn("tm-chip-motion flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition", checked ? "border-brand bg-brand-soft text-brand-dark" : "border-card-border bg-control hover:bg-control-hover")}>
                                      <input
                                        checked={checked}
                                        onChange={(event) => updateDraft(project, { userIds: event.target.checked ? [...draft.userIds, user.id] : draft.userIds.filter((id) => id !== user.id) })}
                                        type="checkbox"
                                        className="h-4 w-4 accent-brand"
                                      />
                                      {user.displayName}
                                    </label>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="text-xs text-[color:var(--text-soft)]">Create users first to assign project access.</div>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 lg:justify-end">
                          <Button type="button" size="sm" className="tm-control-motion" onClick={() => props.onUpdateProject(project, { name: draft.name, color: draft.color || randomPaletteColor(), userIds: draft.userIds, archived: false })}>
                            Save
                          </Button>
                          <Button type="button" variant="ghost" size="sm" className="tm-control-motion" onClick={() => props.onUpdateProject(project, { archived: !project.archived })}>
                            {project.archived ? "Restore" : "Archive"}
                          </Button>
                          <Button type="button" variant="danger" size="sm" className="tm-control-motion" onClick={() => props.onRemoveProject(project)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function ColorSwatches({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {colorPalette.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`select color ${color}`}
          className={cn("tm-control-motion h-6 w-6 rounded-full border-2", value === color ? "border-foreground" : "border-transparent")}
          style={{ backgroundColor: color }}
          onClick={() => onChange(value === color ? "" : color)}
        />
      ))}
    </div>
  );
}

function TaskManagerSettingsPanel({ currentUser, timeZone, saving, onSave }: {
  currentUser: TaskManagerUser;
  timeZone: string;
  saving: boolean;
  onSave: (timeZone: string) => Promise<void>;
}): JSX.Element {
  const [draftTimeZone, setDraftTimeZone] = useState(timeZone);
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState<TimeZoneRegion>(() => timeZoneRegion(timeZone));
  const zones = useMemo(() => availableTimeZones(draftTimeZone), [draftTimeZone]);
  const browserZone = browserTimeZone();
  const selectedRegion = timeZoneRegion(draftTimeZone);
  const filteredZones = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return zones
      .filter((zone) => region === "All" || timeZoneRegion(zone) === region)
      .filter((zone) => {
        if (!normalizedQuery) return true;
        return `${zone} ${timeZoneDisplayName(zone)} ${timeZoneOffsetLabel(zone)}`.toLowerCase().includes(normalizedQuery);
      })
      .slice(0, 90);
  }, [query, region, zones]);
  const preview = useMemo(
    () => new Intl.DateTimeFormat(undefined, {
      timeZone: normalizeTimeZone(draftTimeZone),
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(Date.now()),
    [draftTimeZone],
  );

  useEffect(() => {
    setDraftTimeZone(timeZone);
    setRegion(timeZoneRegion(timeZone));
  }, [timeZone]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await onSave(draftTimeZone);
  }

  return (
    <div className="tm-list-rise mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-y-auto">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col rounded-xl border border-card-border bg-surface-2/60 p-3 sm:p-4">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-dark">
              <Settings className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold">Settings</h2>
              <p className="text-sm text-[color:var(--text-soft)]">Timezone controls task dates, Today, Tomorrow, overdue, and deadlines.</p>
            </div>
          </div>
          <Button type="submit" className="tm-control-motion w-full sm:w-auto" disabled={saving || normalizeTimeZone(draftTimeZone) === timeZone}>
            {saving ? "Saving..." : "Save settings"}
          </Button>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
          <section className="min-w-0 rounded-xl border border-card-border bg-card/75 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-bold uppercase text-[color:var(--text-soft)]">App timezone</div>
                <div className="mt-1 flex items-center gap-2 text-sm font-bold">
                  <Globe2 className="h-4 w-4 text-brand" />
                  <span>{draftTimeZone}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className="tm-control-motion rounded-lg border border-card-border bg-control px-2.5 py-1.5 text-xs font-semibold hover:bg-control-hover"
                  onClick={() => {
                    setDraftTimeZone(defaultTaskManagerTimeZone);
                    setRegion(timeZoneRegion(defaultTaskManagerTimeZone));
                  }}
                >
                  Tehran
                </button>
                <button
                  type="button"
                  className="tm-control-motion rounded-lg border border-card-border bg-control px-2.5 py-1.5 text-xs font-semibold hover:bg-control-hover"
                  onClick={() => {
                    setDraftTimeZone(browserZone);
                    setRegion(timeZoneRegion(browserZone));
                  }}
                >
                  Browser
                </button>
              </div>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-soft)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search city or timezone"
                className="h-11 w-full rounded-xl border border-card-border bg-control pl-9 pr-3 text-sm outline-none focus-ring"
              />
            </div>

            <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              {timeZoneRegionOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    "tm-control-motion shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold",
                    region === option ? "border-brand bg-brand text-white" : "border-card-border bg-control text-foreground hover:bg-control-hover",
                  )}
                  onClick={() => setRegion(option)}
                >
                  {option}
                </button>
              ))}
            </div>

            <div className="mt-3 max-h-[min(48vh,430px)] overflow-y-auto pr-1 scrollbar-thin">
              {filteredZones.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {filteredZones.map((zone) => {
                    const active = normalizeTimeZone(zone) === normalizeTimeZone(draftTimeZone);
                    return (
                      <button
                        key={zone}
                        type="button"
                        className={cn(
                          "tm-control-motion min-w-0 rounded-xl border p-3 text-left hover:bg-control-hover",
                          active ? "border-brand bg-brand-soft text-brand-dark" : "border-card-border bg-control text-foreground",
                        )}
                        onClick={() => {
                          setDraftTimeZone(zone);
                          setRegion(timeZoneRegion(zone));
                        }}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span className="truncate text-sm font-bold">{timeZoneDisplayName(zone)}</span>
                          <span className="shrink-0 rounded-full border border-card-border bg-card/70 px-2 py-0.5 text-xs font-semibold">{timeZoneOffsetLabel(zone)}</span>
                        </div>
                        <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-xs text-[color:var(--text-soft)]">
                          <span className="truncate">{zone}</span>
                          <span className="shrink-0">{timeZoneLocalTimeLabel(zone)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid min-h-[160px] place-items-center rounded-xl border border-dashed border-card-border text-center text-sm text-[color:var(--text-soft)]">
                  No timezone matches this search.
                </div>
              )}
            </div>
          </section>

          <aside className="grid gap-3">
            <div className="rounded-xl border border-card-border bg-control p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase text-[color:var(--text-soft)]">
                <Clock className="h-3.5 w-3.5" />
                Selected time
              </div>
              <div className="text-xl font-bold">{timeZoneLocalTimeLabel(draftTimeZone)}</div>
              <div className="mt-1 text-sm text-[color:var(--text-soft)]">{preview}</div>
              <div className="mt-3 inline-flex rounded-full border border-card-border bg-card/70 px-2.5 py-1 text-xs font-semibold">
                {selectedRegion} · {timeZoneOffsetLabel(draftTimeZone)}
              </div>
            </div>
            <div className="rounded-xl border border-card-border bg-control p-3">
              <div className="text-xs font-bold uppercase text-[color:var(--text-soft)]">Browser timezone</div>
              <div className="mt-1 text-sm font-semibold">{browserZone}</div>
              <div className="mt-1 text-xs text-[color:var(--text-soft)]">{timeZoneLocalTimeLabel(browserZone)} · {timeZoneOffsetLabel(browserZone)}</div>
            </div>
            <div className="rounded-xl border border-card-border bg-control p-3 text-xs text-[color:var(--text-soft)]">
              Signed in as {currentUser.displayName}. Stored timestamps stay unchanged.
            </div>
          </aside>
        </div>
      </form>
    </div>
  );
}

function AdminPanel({ users, newUser, onNewUser, onAddUser, onUpdateUser }: {
  users: TaskManagerUser[];
  newUser: { username: string; displayName: string; password: string; role: "admin" | "user" };
  onNewUser: (value: { username: string; displayName: string; password: string; role: "admin" | "user" }) => void;
  onAddUser: (event: FormEvent) => void;
  onUpdateUser: (user: TaskManagerUser, patch: Partial<TaskManagerUser> & { password?: string }) => Promise<void>;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <form onSubmit={onAddUser} className="tm-list-rise rounded-xl border border-card-border bg-surface-2/60 p-3">
        <div className="mb-3 flex items-center gap-2 font-bold"><UserPlus className="h-4 w-4" /> Create user</div>
        <div className="grid gap-2 md:grid-cols-4">
          <input value={newUser.username} onChange={(event) => onNewUser({ ...newUser, username: event.target.value })} className="h-10 rounded-xl border border-card-border bg-control px-3 text-sm" placeholder="username" />
          <input value={newUser.displayName} onChange={(event) => onNewUser({ ...newUser, displayName: event.target.value })} className="h-10 rounded-xl border border-card-border bg-control px-3 text-sm" placeholder="display name" />
          <input value={newUser.password} onChange={(event) => onNewUser({ ...newUser, password: event.target.value })} className="h-10 rounded-xl border border-card-border bg-control px-3 text-sm" placeholder="password" type="password" />
          <div className="flex gap-2">
            <select value={newUser.role} onChange={(event) => onNewUser({ ...newUser, role: event.target.value as "admin" | "user" })} className="h-10 min-w-0 flex-1 rounded-xl border border-card-border bg-control px-3 text-sm">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <Button type="submit" size="sm" className="tm-control-motion"><Plus className="h-4 w-4" /></Button>
          </div>
        </div>
      </form>
      <div className="grid gap-2">
        {users.map((user) => (
          <div key={user.id} className="tm-card-motion flex flex-col gap-2 rounded-xl border border-card-border bg-control p-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-soft text-brand-dark"><Users className="h-4 w-4" /></div>
              <div>
                <div className="font-semibold">{user.displayName}</div>
                <div className="text-xs text-[color:var(--text-soft)]">@{user.username} · {user.role} · {user.active ? "active" : "disabled"}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" size="sm" className="tm-control-motion" onClick={() => onUpdateUser(user, { active: !user.active })}>{user.active ? "Disable" : "Enable"}</Button>
              <Button type="button" variant="ghost" size="sm" className="tm-control-motion" onClick={() => onUpdateUser(user, { role: user.role === "admin" ? "user" : "admin" })}>{user.role === "admin" ? "Make user" : "Make admin"}</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
