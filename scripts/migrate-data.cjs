#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const dataDir = path.resolve(rootDir, "data");
const taskManagerStatePath = path.resolve(dataDir, "taskmanager/state.json");
const migrationMetaPath = path.resolve(dataDir, "migrations.json");
const migrationId = "2026-06-07-taskmanager-json-v1";

function readEnvFile() {
  const envPath = path.resolve(rootDir, ".env");
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function safeReadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${path.relative(rootDir, filePath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupDir = path.resolve(dataDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.resolve(backupDir, `${path.basename(filePath, ".json")}-${stamp}.json`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function normalizeTimeZone(value, fallback) {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(Date.now());
    return candidate;
  } catch {
    return fallback;
  }
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function migrateTaskManagerState() {
  if (!fs.existsSync(taskManagerStatePath)) {
    return { changed: false, skipped: true, detail: "taskmanager state not found" };
  }

  const env = readEnvFile();
  const defaultTimeZone = normalizeTimeZone(env.TASK_MANAGER_DEFAULT_TIME_ZONE || process.env.TASK_MANAGER_DEFAULT_TIME_ZONE || "Asia/Tehran", "Asia/Tehran");
  const before = safeReadJson(taskManagerStatePath, {});
  const state = before && typeof before === "object" && !Array.isArray(before) ? { ...before } : {};
  const now = Date.now();

  state.users = Array.isArray(state.users)
    ? state.users.map((user) => ({
        ...user,
        active: typeof user.active === "boolean" ? user.active : true,
        timeZone: normalizeTimeZone(user.timeZone, defaultTimeZone),
        lastLoginAt: typeof user.lastLoginAt === "number" ? user.lastLoginAt : null,
      }))
    : [];

  state.projects = Array.isArray(state.projects)
    ? state.projects.map((project) => ({
        ...project,
        archived: typeof project.archived === "boolean" ? project.archived : false,
        userIds: Array.isArray(project.userIds) ? project.userIds.filter((id) => typeof id === "string" && id.trim()) : [],
      }))
    : [];

  state.labels = Array.isArray(state.labels) ? state.labels : [];

  state.tasks = Array.isArray(state.tasks)
    ? state.tasks.map((task) => ({
        ...task,
        description: typeof task.description === "string" ? task.description : "",
        projectId: typeof task.projectId === "string" ? task.projectId : null,
        assigneeId: typeof task.assigneeId === "string" ? task.assigneeId : null,
        dueAt: typeof task.dueAt === "number" ? task.dueAt : null,
        isDeadline: typeof task.isDeadline === "boolean" ? task.isDeadline : false,
        sortOrder: typeof task.sortOrder === "number" && Number.isFinite(task.sortOrder)
          ? task.sortOrder
          : (typeof task.createdAt === "number" ? task.createdAt : typeof task.updatedAt === "number" ? task.updatedAt : now),
        labelIds: Array.isArray(task.labelIds) ? task.labelIds.filter((id) => typeof id === "string" && id.trim()) : [],
        checklist: Array.isArray(task.checklist) ? task.checklist : [],
        completedAt: typeof task.completedAt === "number" ? task.completedAt : null,
      }))
    : [];

  state.comments = Array.isArray(state.comments) ? state.comments : [];
  state.activity = Array.isArray(state.activity) ? state.activity : [];

  if (sameJson(before, state)) {
    return { changed: false, skipped: false, detail: "taskmanager state already up to date" };
  }

  const backupPath = backupFile(taskManagerStatePath);
  writeJsonAtomic(taskManagerStatePath, state);
  return {
    changed: true,
    skipped: false,
    detail: `taskmanager state migrated${backupPath ? `; backup ${path.relative(rootDir, backupPath)}` : ""}`,
  };
}

function updateMigrationMeta(results) {
  const meta = safeReadJson(migrationMetaPath, { schemaVersion: 1, applied: [] });
  const next = {
    schemaVersion: 1,
    applied: Array.isArray(meta.applied) ? meta.applied.filter((item) => item && item.id !== migrationId) : [],
    lastRunAt: new Date().toISOString(),
  };
  next.applied.push({
    id: migrationId,
    appliedAt: new Date().toISOString(),
    changed: results.some((result) => result.changed),
    details: results.map((result) => result.detail),
  });
  writeJsonAtomic(migrationMetaPath, next);
}

function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  const results = [migrateTaskManagerState()];
  updateMigrationMeta(results);
  for (const result of results) {
    const status = result.skipped ? "skipped" : result.changed ? "migrated" : "ok";
    console.log(`[migrate-data] ${status}: ${result.detail}`);
  }
  console.log("[migrate-data] complete");
}

try {
  main();
} catch (error) {
  console.error(`[migrate-data] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
