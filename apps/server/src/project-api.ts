import { Router, type Request, type Response } from "express";
import { ProjectStore, ProjectError } from "./project-store.js";

export function projectApiError(error: unknown, res: Response): void {
  const issues = (error as { issues?: Array<{ message: string }> })?.issues;
  const status = error instanceof ProjectError ? error.status : issues ? 400 : 500;
  res.status(status).json({ ok: false, error: { message: error instanceof ProjectError ? error.message : issues?.[0]?.message || "Project operation failed." } });
}

export function createProjectRouter(store: ProjectStore, callbacks: { sessionExists: (id: string) => boolean; sessionBusy: (id: string) => boolean }): Router {
  const router = Router();
  const route = (fn: (req: Request) => unknown) => (req: Request, res: Response) => {
    try { res.json({ ok: true, data: fn(req) }); } catch (error) { projectApiError(error, res); }
  };
  router.get("/projects", route(() => ({ projects: store.listProjects() })));
  router.post("/projects", route(req => ({ project: store.createProject(req.body) })));
  router.get("/projects/:projectId", route(req => ({ project: store.getProject(req.params.projectId) })));
  router.patch("/projects/:projectId", route(req => ({ project: store.updateProject(req.params.projectId, req.body) })));
  router.put("/sessions/:sessionId/project", route(req => {
    const id = req.params.sessionId;
    if (!callbacks.sessionExists(id)) throw new ProjectError("Session not found.", 404);
    if (callbacks.sessionBusy(id)) throw new ProjectError("Stop this session and finish queued messages before moving it.", 409);
    const projectId: unknown = req.body?.projectId;
    if (projectId !== null && (typeof projectId !== "string" || !projectId)) throw new ProjectError("Choose a project or leave the session unassigned.");
    const binding = store.moveSession(id, projectId as string | null);
    return { sessionId: id, projectId: binding.projectId };
  }));
  router.get("/projects/:projectId/memory", route(req => ({ items: store.listMemory(req.params.projectId, {
    query: typeof req.query.q === "string" ? req.query.q : "", includeDeleted: req.query.includeDeleted === "1",
    limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0,
  }) })));
  router.get("/projects/:projectId/memory-history", route(req => ({ history: store.history(req.params.projectId, undefined, Number(req.query.limit) || 100, Number(req.query.offset) || 0) })));
  router.post("/projects/:projectId/memory", route(req => ({ item: store.addMemory(req.params.projectId, req.body) })));
  router.get("/projects/:projectId/memory/:memoryId", route(req => ({ item: store.getMemory(req.params.projectId, req.params.memoryId) })));
  router.patch("/projects/:projectId/memory/:memoryId", route(req => ({ item: store.updateMemory(req.params.projectId, req.params.memoryId, req.body) })));
  router.delete("/projects/:projectId/memory/:memoryId", route(req => ({ item: store.removeMemory(req.params.projectId, req.params.memoryId, req.body) })));
  router.get("/projects/:projectId/memory/:memoryId/history", route(req => ({ history: store.history(req.params.projectId, req.params.memoryId, Number(req.query.limit) || 100, Number(req.query.offset) || 0) })));
  router.post("/projects/:projectId/memory/:memoryId/undo", route(req => ({ item: store.undoMemory(req.params.projectId, req.params.memoryId, req.body) })));
  router.get("/runs/:runId/project-context", route(req => ({ context: store.runContext(req.params.runId) })));
  return router;
}
