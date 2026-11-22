import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectStore, ProjectError } from "../src/project-store.js";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { createProjectRouter } from "../src/project-api.js";
import { codexMemoryArgs, claudeMemoryConfig, scopedRunnerEnvironment } from "../src/runner-memory.js";

const memory = (content = "Build native dependencies outside the monorepo.") => ({ title: "Desktop builds", content, category: "lesson" as const, reason: "Verified by a successful isolated build." });
const create = (store: ProjectStore, name = "Luma App") => store.createProject({ name, instructions: "Use npm workspaces.", allowAgentMemory: true });
const status = (code: number) => (error: unknown) => error instanceof ProjectError && error.status === code;

test("projects validate names, preserve instructions, reject duplicates and concurrent edits", () => {
  const store = new ProjectStore(":memory:");
  try {
    const project = create(store);
    assert.equal(project.revision, 1);
    assert.throws(() => create(store, "luma app"), status(409));
    assert.throws(() => create(store, "   "));
    const renamed = store.updateProject(project.id, { name: "Luma", instructions: "Keep local files local.", allowAgentMemory: false, expectedRevision: 1 });
    assert.equal(renamed.name, "Luma"); assert.equal(renamed.revision, 2);
    assert.equal(renamed.allowAgentMemory, false);
    assert.throws(() => store.updateProject(project.id, { ...renamed, expectedRevision: 1 }), status(409));
    assert.equal(store.getProject(project.id).instructions, "Keep local files local.");
  } finally { store.close(); }
});

test("memory changes have immutable history, reversible removal, restore, and creation undo", () => {
  const store = new ProjectStore(":memory:");
  try {
    const project = create(store);
    const first = store.addMemory(project.id, memory());
    assert.equal(store.addMemory(project.id, memory()).id, first.id);
    assert.equal(store.history(project.id, first.id).length, 1);
    const updated = store.updateMemory(project.id, first.id, { ...memory("Use the isolated desktop staging directory."), expectedRevision: 1 });
    assert.equal(updated.revision, 2);
    const removed = store.removeMemory(project.id, first.id, { expectedRevision: 2, reason: "No longer applicable." });
    assert.equal(store.listMemory(project.id).length, 0);
    assert.equal(store.listMemory(project.id, { includeDeleted: true }).length, 1);
    const restored = store.undoMemory(project.id, first.id, { expectedRevision: removed.revision, reason: "Accidental removal." });
    assert.equal(restored.content, updated.content); assert.equal(restored.deletedAt, null); assert.equal(restored.revision, 4);
    const oldVersion = store.undoMemory(project.id, first.id, { expectedRevision: 4, restoreRevision: 1, reason: "Restore original lesson." });
    assert.equal(oldVersion.content, first.content); assert.equal(oldVersion.revision, 5);
    const history = store.history(project.id, first.id);
    assert.deepEqual(history.map(item => item.action), ["restore", "undo", "remove", "update", "add"]);
    assert.equal(history[3].before?.content, first.content);
    assert.equal(history[3].after.content, updated.content);
    const second = store.addMemory(project.id, { ...memory(), title: "Another memory" });
    const undoneCreation = store.undoMemory(project.id, second.id, { expectedRevision: 1, reason: "Undo creation." });
    assert.notEqual(undoneCreation.deletedAt, null);
    assert.equal(store.undoMemory(project.id, second.id, { expectedRevision: 2, reason: "Reinstate." }).deletedAt, null);
  } finally { store.close(); }
});

test("stale and cross-project changes fail without writing history", () => {
  const store = new ProjectStore(":memory:");
  try {
    const a = create(store), b = create(store, "Other project");
    const first = store.addMemory(a.id, memory());
    store.updateMemory(a.id, first.id, { ...memory("Current content"), expectedRevision: 1 });
    assert.throws(() => store.removeMemory(a.id, first.id, { expectedRevision: 1, reason: "Stale request" }), status(409));
    assert.throws(() => store.undoMemory(a.id, first.id, { expectedRevision: 1, reason: "Stale undo" }), status(409));
    assert.throws(() => store.getMemory(b.id, first.id), status(404));
    assert.throws(() => store.updateMemory(b.id, first.id, { ...memory(), expectedRevision: 2 }), status(404));
    assert.equal(store.history(a.id, first.id).length, 2); assert.equal(store.history(b.id).length, 0);
  } finally { store.close(); }
});

test("stable session bindings survive runner IDs, persist across restart, and keep legacy sessions in Inbox", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "luma-project-store-"));
  const file = path.join(directory, "projects.sqlite");
  let store = new ProjectStore(file);
  try {
    assert.equal(store.projectForSession("old-cli-session"), null);
    const project = create(store);
    const binding = store.ensureSession("provisional-session", project.id);
    store.attachAlias(binding.id, "provider-thread-123");
    assert.equal(store.session("provider-thread-123")?.id, binding.id);
    assert.throws(() => store.ensureSession("provider-thread-123", null), status(409));
    const item = store.addMemory(project.id, memory());
    store.close(); store = new ProjectStore(file);
    assert.equal(store.projectForSession("provider-thread-123"), project.id);
    assert.equal(store.getMemory(project.id, item.id).content, item.content);
    assert.equal(store.listProjects()[0].sessionCount, 1);
    const second = store.ensureSession("different-session", project.id);
    assert.throws(() => store.attachAlias(second.id, "provider-thread-123"), status(409));
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("agent capability scopes tools to its project, records provenance, and is revoked on move or completion", () => {
  const store = new ProjectStore(":memory:");
  try {
    const project = create(store), other = create(store, "Private project");
    const foreign = store.addMemory(other.id, memory("Other project private context"));
    const binding = store.ensureSession("session-a", project.id);
    const runtime = new MemoryRuntime(store);
    const token = runtime.issue({ runId: "run-a", sessionId: binding.id, projectId: project.id, writable: true });
    const result = runtime.invoke(token, "memory_add", memory(), "call-1") as { item: { id: string; revision: number } };
    assert.deepEqual(runtime.invoke(token, "memory_add", memory(), "call-1"), result);
    assert.equal(store.history(project.id, result.item.id).length, 1);
    assert.deepEqual(store.history(project.id, result.item.id)[0].actor, { kind: "session", runId: "run-a", sessionId: binding.id });
    assert.throws(() => runtime.invoke(token, "memory_get", { id: foreign.id }), status(404));
    assert.throws(() => runtime.invoke(token, "memory_add", { ...memory(), projectId: other.id }), status(403));
    assert.throws(() => runtime.invoke("invalid", "memory_search", {}), status(401));
    store.moveSession("session-a", other.id);
    assert.throws(() => runtime.invoke(token, "memory_search", {}), status(403));
    const newToken = runtime.issue({ runId: "run-b", sessionId: binding.id, projectId: other.id, writable: true });
    runtime.revokeRun("run-b");
    assert.throws(() => runtime.invoke(newToken, "memory_search", {}), status(401));
  } finally { store.close(); }
});

test("plan and project read-only policies enforce memory permissions on the server", () => {
  const store = new ProjectStore(":memory:");
  try {
    const project = create(store), session = store.ensureSession("s", project.id);
    const runtime = new MemoryRuntime(store);
    const readOnly = runtime.issue({ runId: "plan", sessionId: session.id, projectId: project.id, writable: false });
    assert.deepEqual(runtime.invoke(readOnly, "memory_search", {}), { items: [] });
    assert.throws(() => runtime.invoke(readOnly, "memory_add", memory()), status(403));
    const writable = runtime.issue({ runId: "normal", sessionId: session.id, projectId: project.id, writable: true });
    store.updateProject(project.id, { ...project, allowAgentMemory: false, expectedRevision: 1 });
    assert.throws(() => runtime.invoke(writable, "memory_add", memory()), status(403));
    assert.ok(store.addMemory(project.id, memory()));
  } finally { store.close(); }
});

test("context includes relevant current memories within a budget and records their revisions", () => {
  const store = new ProjectStore(":memory:");
  try {
    const project = create(store), session = store.ensureSession("s", project.id);
    const selected = store.addMemory(project.id, memory());
    const unrelated = store.addMemory(project.id, { ...memory("The unrelated billing service uses integer cents."), title: "Billing" });
    const context = store.context("run-1", session.id, project.id, "desktop dependencies");
    assert.ok(context.prompt.includes(selected.content)); assert.ok(!context.prompt.includes(unrelated.content));
    assert.deepEqual(context.record.memories, [{ id: selected.id, revision: 1 }]);
    store.removeMemory(project.id, selected.id, { expectedRevision: 1, reason: "Remove old fact" });
    const later = store.context("run-2", session.id, project.id, "desktop dependencies");
    assert.ok(!later.prompt.includes(selected.content));
    assert.deepEqual(store.runContext("run-1")?.memories, [{ id: selected.id, revision: 1 }]);
    for (let i = 0; i < 12; i++) store.addMemory(project.id, { ...memory("x".repeat(8000)), title: `Large item ${i}` });
    assert.ok(store.context("budget", session.id, project.id, "").prompt.length < 14000);
  } finally { store.close(); }
});

test("idempotent operations publish after commit and discard changes on rollback", () => {
  const store = new ProjectStore(":memory:");
  try {
    const project = create(store);
    let events = 0;
    store.onChange = change => { events++; assert.equal(store.db.inTransaction, false); };
    assert.throws(() => store.once("failed", "hash", () => { store.addMemory(project.id, memory()); throw new Error("Rollback"); }));
    assert.equal(store.listMemory(project.id).length, 0); assert.equal(events, 0);
    const saved = store.once("success", "hash", () => store.addMemory(project.id, memory()));
    assert.equal(events, 1);
    assert.deepEqual(store.once("success", "hash", () => { throw new Error("Should not run"); }), saved);
    assert.equal(events, 1);
    assert.throws(() => store.once("success", "other", () => saved), status(409));
  } finally { store.close(); }
});

test("memory and history pagination stay within the requested project", () => {
  const store = new ProjectStore(":memory:");
  try {
    const project = create(store), other = create(store, "Other");
    for (let i = 0; i < 65; i++) store.addMemory(project.id, { ...memory(), title: `Lesson ${i}` });
    store.addMemory(other.id, memory());
    const first = store.listMemory(project.id, { limit: 50 }), next = store.listMemory(project.id, { limit: 50, offset: 50 });
    assert.equal(first.length, 50); assert.equal(next.length, 15);
    assert.equal(new Set([...first, ...next].map(item => item.id)).size, 65);
    assert.equal(store.history(project.id, undefined, 50).length, 50);
    assert.equal(store.history(project.id, undefined, 50, 50).length, 15);
    assert.equal(store.listMemory(project.id, { limit: Infinity }).length, 65);
  } finally { store.close(); }
});

test("real MCP transport discovers tools, mutates memory, and keeps its token out of ordinary API access", async () => {
  const store = new ProjectStore(":memory:");
  const project = create(store), session = store.ensureSession("mcp-session", project.id);
  const runtime = new MemoryRuntime(store);
  const token = runtime.issue({ runId: "mcp-run", sessionId: session.id, projectId: project.id, writable: true });
  const app = express(); app.use(express.json());
  app.all("/api/mcp/memory", (req, res) => { void runtime.handle(req, res); });
  app.use((req, res, next) => { if (req.header("authorization") === "Bearer ui-token") next(); else res.status(401).json({ ok: false }); });
  app.use("/api", createProjectRouter(store, { sessionExists: id => Boolean(store.session(id)), sessionBusy: () => false }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({ name: "luma-memory-test", version: "1.0.0" });
  try {
    assert.equal((await fetch(`${url}/api/projects`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/api/mcp/memory`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.length, 7); assert.ok(names.includes("memory_undo"));
    const added = await client.callTool({ name: "memory_add", arguments: memory() });
    assert.equal(added.isError, undefined);
    const item = (added.structuredContent as { item: { id: string } }).item;
    const updated = await client.callTool({ name: "memory_update", arguments: { id: item.id, ...memory("Corrected lesson"), expectedRevision: 1 } });
    assert.equal((updated.structuredContent as { item: { revision: number } }).item.revision, 2);
    const removed = await client.callTool({ name: "memory_remove", arguments: { id: item.id, expectedRevision: 2, reason: "Wrong lesson" } });
    assert.equal((removed.structuredContent as { item: { revision: number } }).item.revision, 3);
    const undone = await client.callTool({ name: "memory_undo", arguments: { id: item.id, expectedRevision: 3, reason: "Restore lesson" } });
    assert.equal((undone.structuredContent as { item: { deletedAt: number | null } }).item.deletedAt, null);
    assert.equal(store.history(project.id, item.id).length, 4);
    const escaped = await client.callTool({ name: "memory_add", arguments: { ...memory(), projectId: "another-project" } });
    assert.equal(escaped.isError, true);
    runtime.revokeRun("mcp-run");
    await assert.rejects(() => client.callTool({ name: "memory_search", arguments: {} }));
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test("runner configuration uses scoped credentials without embedding them in Codex arguments", () => {
  const args = codexMemoryArgs("http://127.0.0.1:1234/api/mcp/memory");
  assert.ok(args.includes('mcp_servers.luma-memory.bearer_token_env_var="LUMA_MEMORY_TOKEN"'));
  const env = scopedRunnerEnvironment({ PASSWORD: "app-password", JWT_SECRET: "app-secret", OPENAI_API_KEY: "provider-fixture", LUMA_MEMORY_TOKEN: "old-capability" }, { LUMA_MEMORY_TOKEN: "current-capability" });
  assert.equal(env.PASSWORD, undefined); assert.equal(env.JWT_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, "provider-fixture"); assert.equal(env.LUMA_MEMORY_TOKEN, "current-capability");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-mcp-config-"));
  try {
    const file = claudeMemoryConfig(temporary, "test-run", "http://127.0.0.1:1234/api/mcp/memory", "scoped-run-token");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["luma-memory"].headers.Authorization, "Bearer scoped-run-token");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
