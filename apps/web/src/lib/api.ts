import type {
  ApprovalQueueItem,
  AgentListResponse,
  AgentScheduleListResponse,
  AppBootstrap,
  AppBootstrapLite,
  AttachmentRef,
  CodexAccountStatusResponse,
  CodexMcpStatusResponse,
  CodexSystemStatusResponse,
  RunRecord,
  RunListResponse,
  RunMessagesResponse,
  SendMessageAccepted,
  SendMessageInput,
  SessionHistoryEntry,
  SessionListResponse,
  SessionMessagesResponse,
  SessionTokenUsageResponse,
  SessionTranscriptResponse,
  SkillListResponse,
  SseEvent,
  StartRunInput,
  CreateAgentScheduleInput,
  UpdateAgentScheduleInput,
  TerminalSessionSnapshot,
  RunnerModelCatalogs,
} from "@luma/shared";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

let authToken: string | null = null;

export function setApiAuthToken(token: string | null): void {
  authToken = token && token.trim() ? token.trim() : null;
}

function emitUnauthorized(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("luma:unauthorized"));
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const sentToken = authToken;
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (sentToken && url !== "/api/auth/login") {
    headers.set("Authorization", `Bearer ${sentToken}`);
  }

  const response = await fetch(url, { ...init, headers });
  if (response.status === 401 && sentToken && sentToken === authToken && url !== "/api/auth/login") emitUnauthorized();

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.error.message || "Request failed");
  }
  return payload.data;
}

export async function fetchAttachmentBlob(attachment: AttachmentRef, workspace: string, download = false): Promise<Blob> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  const response = await fetch("/api/attachments/content", {
    method: "POST",
    headers,
    body: JSON.stringify({ attachment, workspace, download }),
  });
  if (response.status === 401) {
    emitUnauthorized();
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as ApiResponse<unknown>;
      if (!payload.ok) message = payload.error.message || message;
    } catch {
      // Non-JSON errors are reported with their HTTP status.
    }
    throw new Error(message);
  }
  return response.blob();
}

export function loginWithPassword(password: string): Promise<{ token: string; expiresAt: number; expiresInSeconds: number; idleTimeoutMs?: number }> {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function recordCloudActivity(signal: AbortSignal): Promise<{ expiresAt: number }> {
  return request("/api/auth/activity", { method: "POST", signal });
}

export function revokeCloudSession(): Promise<{ signedOut: boolean }> {
  return request("/api/auth/logout", { method: "POST", keepalive: true });
}

export function getBootstrap(): Promise<AppBootstrap> {
  return request<AppBootstrap>("/api/bootstrap");
}

export function getBootstrapLite(): Promise<AppBootstrapLite> {
  return request<AppBootstrapLite>("/api/bootstrap-lite");
}

export function getModelCatalogs(refreshRunner?: "codex" | "claude"): Promise<RunnerModelCatalogs> {
  return refreshRunner
    ? request("/api/models/refresh", { method: "POST", body: JSON.stringify({ runner: refreshRunner }) })
    : request("/api/models");
}

export function getCursorModels(): Promise<{
  available: boolean;
  executable: string;
  defaultModel: string;
  models: import("@luma/shared").CursorModelInfo[];
}> {
  return request("/api/cursor/models");
}

export function getRuns(): Promise<{ runs: RunRecord[]; approvals: ApprovalQueueItem[] }> {
  return request("/api/runs");
}

export function getRunList(limit = 60, cursor?: string | null, includeHistory = false): Promise<RunListResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (includeHistory) params.set("includeHistory", "1");
  return request(`/api/runs/list?${params.toString()}`);
}

export function getSessionList(limit = 60, cursor?: string | null, includeHistory = false): Promise<SessionListResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (includeHistory) params.set("includeHistory", "1");
  return request(`/api/sessions/list?${params.toString()}`);
}

export function getRunMessages(runId: string, before?: string | null): Promise<RunMessagesResponse> {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/api/runs/${encodeURIComponent(runId)}/messages${suffix}`);
}

export function getSessionMessages(sessionId: string, before?: string | null): Promise<SessionMessagesResponse> {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`);
}

export function getSessionTokenUsage(sessionId: string): Promise<SessionTokenUsageResponse> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/token-usage`);
}

export function getSessionHistory(): Promise<{ entries: SessionHistoryEntry[] }> {
  return request("/api/sessions/history");
}

export function getSessionTranscript(sessionId: string): Promise<SessionTranscriptResponse> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/history`);
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

export function getSkills(workspace?: string): Promise<SkillListResponse> {
  const suffix = workspace ? `?${new URLSearchParams({ workspace }).toString()}` : "";
  return request(`/api/skills${suffix}`);
}

export function getAgents(): Promise<AgentListResponse> {
  return request("/api/agents");
}

export function reloadAgentsAndSkills(): Promise<AgentScheduleListResponse> {
  return request("/api/agents/reload", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getAgentSchedules(): Promise<AgentScheduleListResponse> {
  return request("/api/agent-schedules");
}

export function createAgentSchedule(input: CreateAgentScheduleInput): Promise<{ schedule: AgentScheduleListResponse["schedules"][number] }> {
  return request("/api/agent-schedules", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAgentSchedule(
  scheduleId: string,
  input: UpdateAgentScheduleInput,
): Promise<{ schedule: AgentScheduleListResponse["schedules"][number] }> {
  return request(`/api/agent-schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteAgentSchedule(scheduleId: string): Promise<{ deleted: boolean }> {
  return request(`/api/agent-schedules/${encodeURIComponent(scheduleId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export function runAgentScheduleNow(scheduleId: string): Promise<{ execution: AgentScheduleListResponse["executions"][number] }> {
  return request(`/api/agent-schedules/${encodeURIComponent(scheduleId)}/run-now`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function startRun(input: StartRunInput): Promise<{ run: RunRecord }> {
  return request("/api/runs/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function sendMessage(input: SendMessageInput): Promise<SendMessageAccepted> {
  return request("/api/messages/send", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function retryMessage(messageId: string): Promise<{ messageId: string; sessionId: string; queued: boolean }> {
  return request(`/api/messages/${encodeURIComponent(messageId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function uploadAttachment(file: File, workspace: string): Promise<{ attachment: AttachmentRef }> {
  return request(`/api/attachments?workspace=${encodeURIComponent(workspace)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-attachment-name": encodeURIComponent(file.name),
      "x-attachment-content-type": file.type || "application/octet-stream",
    },
    body: file,
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
    "project.updated",
    "memory.updated",
    "run.started",
    "run.stdout",
    "run.stderr",
    "run.item",
    "run.approvalQueued",
    "run.completed",
    "run.failed",
    "run.stopped",
    "session.upsert",
    "message.upsert",
    "message.failed",
    "message.ack",
    "outbox.updated",
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
