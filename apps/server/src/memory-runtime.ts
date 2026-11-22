import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ProjectError, ProjectStore } from "./project-store.js";
import { memoryToolSchemas, type MemoryActor } from "@luma/shared";

export type MemoryGrant = { runId: string; sessionId: string; projectId: string; writable: boolean; expiresAt: number };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class MemoryRuntime {
  private grants = new Map<string, MemoryGrant>();
  private tokens = new Map<string, string>();
  url = "";
  constructor(readonly store: ProjectStore) {}

  issue(input: Omit<MemoryGrant, "expiresAt">): string {
    this.revokeRun(input.runId);
    const token = randomBytes(32).toString("hex");
    this.grants.set(digest(token), { ...input, expiresAt: Date.now() + 24 * 60 * 60_000 });
    this.tokens.set(input.runId, token);
    return token;
  }
  revokeRun(runId: string): void { for (const [key, grant] of this.grants) if (grant.runId === runId) this.grants.delete(key); this.tokens.delete(runId); }
  environment(runId: string): NodeJS.ProcessEnv {
    const token = this.tokens.get(runId);
    return token ? { LUMA_MEMORY_TOKEN: token, LUMA_MEMORY_URL: this.url } : {};
  }
  authenticate(token: string): MemoryGrant {
    const grant = this.grants.get(digest(token));
    if (!grant || grant.expiresAt < Date.now()) throw new ProjectError("Memory access has expired or is invalid.", 401);
    if (this.store.session(grant.sessionId)?.projectId !== grant.projectId) throw new ProjectError("Session is no longer assigned to this project.", 403);
    return grant;
  }

  invoke(token: string, tool: string, input: Record<string, unknown>, operationId?: string): unknown {
    const grant = this.authenticate(token);
    const actor: MemoryActor = { kind: "session", runId: grant.runId, sessionId: grant.sessionId };
    // IDs supplied by the model are never used for selecting a project, run, or author.
    if (["projectId", "sessionId", "runId", "actor"].some(key => key in input)) throw new ProjectError("Memory scope and authorship are supplied by Luma.", 403);
    const id = typeof input.id === "string" ? input.id : "";
    if (tool === "memory_search") return { items: this.store.listMemory(grant.projectId, { query: String(input.query || ""), limit: 20 }) };
    if (tool === "memory_get") return { item: this.store.getMemory(grant.projectId, id) };
    if (tool === "memory_history") return { history: this.store.history(grant.projectId, id) };
    if (!grant.writable) throw new ProjectError("Memory editing is disabled in plan/ask mode.", 403);
    if (!this.store.getProject(grant.projectId).allowAgentMemory) throw new ProjectError("Agent memory editing is disabled for this project.", 403);
    const change = () => {
      if (tool === "memory_add") return { item: this.store.addMemory(grant.projectId, input, actor) };
      if (tool === "memory_update") return { item: this.store.updateMemory(grant.projectId, id, input, actor) };
      if (tool === "memory_remove") return { item: this.store.removeMemory(grant.projectId, id, input, actor) };
      if (tool === "memory_undo") return { item: this.store.undoMemory(grant.projectId, id, input, actor) };
      throw new ProjectError("Unknown project memory tool.", 404);
    };
    return operationId ? this.store.once(`${grant.runId}:${tool}:${operationId}`, digest(JSON.stringify(input)), change) : change();
  }

  async handle(req: Request, res: Response): Promise<void> {
    const token = req.header("authorization")?.replace(/^Bearer /, "") || "";
    try { this.authenticate(token); }
    catch (error) {
      res.status(error instanceof ProjectError ? error.status : 401).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32001, message: error instanceof Error ? error.message : "Unauthorized" } });
      return;
    }
    if (req.method !== "POST") { res.status(405).setHeader("Allow", "POST"); res.end(); return; }
    const server = new McpServer({ name: "luma-memory", version: "0.2.0" }, { instructions: "Manage reusable knowledge in this session's Luma project. Scope is enforced by the server. Search before adding; read current revisions before changes. Every change needs a reason and is undoable." });
    const definitions = [
      { name: "memory_search", description: "Search this project's active memories. An empty query lists recent items." },
      { name: "memory_get", description: "Read a memory and its current revision before editing it." },
      { name: "memory_add", description: "Save a supported project fact, decision, preference, or lesson. Duplicate identical items are reused." },
      { name: "memory_update", description: "Correct a memory using its latest expectedRevision. Conflicts require re-reading." },
      { name: "memory_remove", description: "Remove an obsolete or incorrect memory from future retrieval. The change can be undone." },
      { name: "memory_history", description: "Read this memory's immutable revision history and sources." },
      { name: "memory_undo", description: "Undo the latest change, or restore a specified historical revision as a new revision." },
    ] as const;
    for (const definition of definitions) {
      server.registerTool(definition.name, { description: definition.description, inputSchema: memoryToolSchemas[definition.name] }, async (args: Record<string, unknown>) => {
        try {
          const result = this.invoke(token, definition.name, args as Record<string, unknown>, String(req.body?.id ?? ""));
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Memory operation failed." }] };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32603, message: "Memory tool transport failed." } }); }
  }
}
