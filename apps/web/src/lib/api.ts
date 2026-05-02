import type {
  ApprovalQueueItem,
  AppBootstrap,
  CodexAccountStatusResponse,
  CodexMcpStatusResponse,
  CodexSystemStatusResponse,
  DiffSnapshot,
  FileTreeNode,
  RunRecord,
  SseEvent,
  StartRunInput,
  TerminalSessionSnapshot,
} from "@agentic/shared";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

let authToken: string | null = null;

export function setApiAuthToken(token: string | null): void {
  authToken = token && token.trim() ? token.trim() : null;
}

function emitUnauthorized(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("agentic:unauthorized"));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  const response = await fetch(url, { ...init, headers });
  if (response.status === 401) {
    emitUnauthorized();
    throw new Error("Unauthorized");
  }

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.error.message || "Request failed");
  }
  return payload.data;
}

export function loginWithPassword(password: string): Promise<{ token: string; expiresAt: number; expiresInSeconds: number }> {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function getBootstrap(): Promise<AppBootstrap> {
  return request<AppBootstrap>("/api/bootstrap");
}

export function getRuns(): Promise<{ runs: RunRecord[]; approvals: ApprovalQueueItem[] }> {
  return request("/api/runs");
}

export function getMcpStatus(): Promise<CodexMcpStatusResponse> {
  return request("/api/system/mcp-status");
}

export function getAccountStatus(): Promise<CodexAccountStatusResponse> {
  return request("/api/system/account-status");
}

export function getSystemStatus(): Promise<CodexSystemStatusResponse> {
  return request("/api/system/status");
}

export function startRun(input: StartRunInput): Promise<{ run: RunRecord }> {
  return request("/api/runs/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function stopRun(runId: string): Promise<{ stopped: boolean }> {
  return request(`/api/runs/${runId}/stop`, { method: "POST", body: JSON.stringify({}) });
}

export function rerun(runId: string, payload: { sandbox?: string; approvalPolicy?: string; approvalId?: string }): Promise<{ run: RunRecord }> {
  return request(`/api/runs/${runId}/rerun`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getRun(runId: string): Promise<{ run: RunRecord; approvals: ApprovalQueueItem[] }> {
  return request(`/api/runs/${runId}`);
}

export function getDiff(runId: string): Promise<DiffSnapshot> {
  return request(`/api/runs/${runId}/diff`);
}

export function getFileTree(relPath = ".", depth = 2): Promise<{ root: string; nodes: FileTreeNode[] }> {
  const params = new URLSearchParams({ path: relPath, depth: String(depth) });
  return request(`/api/files/tree?${params.toString()}`);
}

export function setActiveWorkspace(workspace: string): Promise<{ activeWorkspace: string }> {
  return request("/api/workspaces/active", {
    method: "POST",
    body: JSON.stringify({ workspace, persist: true }),
  });
}

export function archiveSession(sessionId: string): Promise<{ sessionId: string; archivedRuns: number }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function deleteSession(sessionId: string): Promise<{ sessionId: string; removedRuns: number; removedApprovals: number }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export function getTerminal(sessionId: string): Promise<{ terminal: TerminalSessionSnapshot | null }> {
  return request(`/api/terminals/${encodeURIComponent(sessionId)}`);
}

export function startTerminal(sessionId: string, workspace: string): Promise<{ terminal: TerminalSessionSnapshot }> {
  return request(`/api/terminals/${encodeURIComponent(sessionId)}/start`, {
    method: "POST",
    body: JSON.stringify({ workspace }),
  });
}

export function stopTerminal(sessionId: string): Promise<{ terminal: TerminalSessionSnapshot }> {
  return request(`/api/terminals/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function interruptTerminal(sessionId: string): Promise<{ terminal: TerminalSessionSnapshot }> {
  return request(`/api/terminals/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function sendTerminalInput(sessionId: string, input: string): Promise<{ accepted: boolean }> {
  return request(`/api/terminals/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
}

export function connectEvents(onEvent: (evt: SseEvent) => void): EventSource {
  const query = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  const es = new EventSource(`/api/events${query}`);
  const names = [
    "run.started",
    "run.stdout",
    "run.stderr",
    "run.item",
    "run.approvalQueued",
    "run.diffUpdated",
    "run.completed",
    "run.failed",
    "run.stopped",
    "terminal.started",
    "terminal.output",
    "terminal.stopped",
    "heartbeat",
  ];

  for (const name of names) {
    es.addEventListener(name, (raw) => {
      try {
        const evt = JSON.parse((raw as MessageEvent).data) as SseEvent;
        onEvent(evt);
      } catch {
        // ignore parse failures
      }
    });
  }

  return es;
}
