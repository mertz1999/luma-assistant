import { z } from "zod";

export const runStatusSchema = z.enum(["queued", "running", "completed", "failed", "stopped"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const sandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type SandboxMode = z.infer<typeof sandboxSchema>;

export const approvalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const runSourceTagSchema = z.enum(["in-app", "vscode", "cli", "exec", "other"]);
export type RunSourceTag = z.infer<typeof runSourceTagSchema>;

export const attachmentKindSchema = z.enum(["image", "text"]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const attachmentRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  kind: attachmentKindSchema,
  relativePath: z.string().min(1),
  uploadedAt: z.number().int().nonnegative(),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export const skillListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1),
  source: z.string().min(1),
  scope: z.string().min(1),
});
export type SkillListItem = z.infer<typeof skillListItemSchema>;

export const selectedSkillRefSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
});
export type SelectedSkillRef = z.infer<typeof selectedSkillRefSchema>;

export type SkillListResponse = {
  skills: SkillListItem[];
};

export const agentListItemSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1),
  promptPreview: z.string(),
  updatedAt: z.number().int().nonnegative(),
});
export type AgentListItem = z.infer<typeof agentListItemSchema>;

export const agentScheduleTimeSchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timezone: z.literal("Asia/Tehran").default("Asia/Tehran"),
});
export type AgentScheduleTime = z.infer<typeof agentScheduleTimeSchema>;

export const agentScheduleStatusSchema = z.enum(["active", "paused"]);
export type AgentScheduleStatus = z.infer<typeof agentScheduleStatusSchema>;

export const agentScheduleExecutionStatusSchema = z.enum(["queued", "running", "completed", "failed", "stopped", "skipped"]);
export type AgentScheduleExecutionStatus = z.infer<typeof agentScheduleExecutionStatusSchema>;

export const agentScheduleSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  agentPath: z.string().min(1),
  agentName: z.string().min(1),
  status: agentScheduleStatusSchema,
  time: agentScheduleTimeSchema,
  nextRunAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastRunAt: z.number().int().nonnegative().nullable(),
  runConfig: z.object({
    workspace: z.string().min(1),
    model: z.string().min(1),
    sandbox: sandboxSchema,
    approvalPolicy: approvalPolicySchema,
    skills: z.array(selectedSkillRefSchema).max(20).default([]),
  }),
});
export type AgentSchedule = z.infer<typeof agentScheduleSchema>;

export const agentScheduleExecutionSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  status: agentScheduleExecutionStatusSchema,
  scheduledFor: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  completedAt: z.number().int().nonnegative().nullable(),
  sessionId: z.string().nullable(),
  runId: z.string().nullable(),
  error: z.string().nullable(),
});
export type AgentScheduleExecution = z.infer<typeof agentScheduleExecutionSchema>;

export const createAgentScheduleSchema = z.object({
  agentId: z.string().min(1),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  workspace: z.string().min(1),
  model: z.string().min(1),
  sandbox: sandboxSchema,
  approvalPolicy: approvalPolicySchema,
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
});
export type CreateAgentScheduleInput = z.infer<typeof createAgentScheduleSchema>;

export const updateAgentScheduleSchema = z.object({
  status: agentScheduleStatusSchema,
});
export type UpdateAgentScheduleInput = z.infer<typeof updateAgentScheduleSchema>;

export type SkillSyncResult = {
  copied: string[];
  updated: string[];
  conflicts: Array<{ slug: string; sourcePath: string; targetPath: string; reason: string }>;
  errors: Array<{ slug: string; sourcePath: string; message: string }>;
};

export type AgentScheduleListResponse = {
  agents: AgentListItem[];
  schedules: AgentSchedule[];
  upcoming: AgentSchedule[];
  executions: AgentScheduleExecution[];
  skillSync: SkillSyncResult;
};

export type AgentListResponse = {
  agents: AgentListItem[];
  skillSync: SkillSyncResult;
};

export const runConfigSchema = z.object({
  workspace: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  sandbox: sandboxSchema,
  approvalPolicy: approvalPolicySchema,
  planMode: z.boolean().default(false),
  sessionId: z.string().optional(),
  attachments: z.array(attachmentRefSchema).max(10).default([]),
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

export const startRunSchema = z.object({
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  model: z.string().min(1),
  sandbox: sandboxSchema.default("read-only"),
  approvalPolicy: approvalPolicySchema.default("on-request"),
  planMode: z.boolean().default(false),
  sessionId: z.string().optional(),
  attachments: z.array(attachmentRefSchema).max(10).default([]),
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
});
export type StartRunInput = z.infer<typeof startRunSchema>;

export const sendMessageSchema = z.object({
  clientMessageId: z.string().min(1),
  sessionId: z.string().optional(),
  text: z.string().min(1),
  workspace: z.string().min(1),
  model: z.string().min(1),
  sandbox: sandboxSchema.default("read-only"),
  approvalPolicy: approvalPolicySchema.default("on-request"),
  planMode: z.boolean().default(false),
  attachments: z.array(attachmentRefSchema).max(10).default([]),
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const rerunSchema = z.object({
  sandbox: sandboxSchema.optional(),
  approvalPolicy: approvalPolicySchema.optional(),
});
export type RerunInput = z.infer<typeof rerunSchema>;

export const setWorkspaceSchema = z.object({
  workspace: z.string().min(1),
  persist: z.boolean().optional().default(true),
});
export type SetWorkspaceInput = z.infer<typeof setWorkspaceSchema>;

export type RunEventEntry = {
  id: string;
  at: number;
  source: "stdout" | "stderr" | "system";
  text?: string;
  payload?: Record<string, unknown>;
};

export type RunRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: RunStatus;
  config: RunConfig;
  sessionId: string | null;
  threadId: string | null;
  summary: string;
  events: RunEventEntry[];
  lastError: string | null;
  changedFiles: string[];
  archivedAt: number | null;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  } | null;
};

export type ApprovalQueueItem = {
  id: string;
  runId: string;
  createdAt: number;
  reason: string;
  suggestedSandbox: SandboxMode;
  suggestedApprovalPolicy: ApprovalPolicy;
  command: string | null;
  status: "pending" | "accepted" | "dismissed";
};

export type DiffSnapshot = {
  runId: string;
  at: number;
  isGitRepo: boolean;
  diffText: string;
  changedFiles: string[];
  fallbackMessage: string | null;
};

export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};

export type WorkspaceOption = {
  id: string;
  name: string;
  path: string;
  source: "config-default" | "config-repo" | "manual";
};

export type SessionHistoryEntry = {
  id: string;
  timestamp: string;
  cwd: string;
  source: string;
  model?: string;
  cliVersion?: string;
  summary: string;
};

export type SessionTranscriptEntry = {
  key: string;
  role: "user" | "assistant";
  text: string;
  at: number;
};

export type SessionTranscriptResponse = {
  session: SessionHistoryEntry;
  entries: SessionTranscriptEntry[];
};

export type RunListItem = {
  id: string;
  name: string;
  status: RunStatus;
  updatedAt: number;
  sourceTag: RunSourceTag;
  sourceRaw: string;
  sessionId: string;
  latestRunId: string | null;
  runCount: number;
  workspace: string;
  historyOnly: boolean;
};

export type RunMessageFileChange = {
  kind: string;
  path: string;
  diff?: string;
  added: number;
  removed: number;
};

export type RunMessageEntry = {
  key: string;
  role: "user" | "assistant" | "tool" | "plan" | "system" | "error";
  title?: string;
  text: string;
  pending: boolean;
  at: number;
  attachments?: AttachmentRef[];
  meta?: {
    type?: "commandexecution" | "filechange" | "mcptoolcall" | "websearch";
    runId?: string;
    status?: string;
    command?: string;
    output?: string;
    exitCode?: number | null;
    server?: string;
    tool?: string;
    query?: string;
    fileChanges?: RunMessageFileChange[];
    errorMessage?: string;
    path?: string;
    durationMs?: number;
  };
};

export type RunListResponse = {
  items: RunListItem[];
  nextCursor: string | null;
  approvals: ApprovalQueueItem[];
};

export type RunMessagesResponse = {
  runId: string;
  entries: RunMessageEntry[];
  nextCursor: string | null;
};

export type SessionListItem = {
  id: string;
  title: string;
  status: RunStatus;
  updatedAt: number;
  sourceTag: RunSourceTag;
  sourceRaw: string;
  workspace: string;
  latestRunId: string | null;
  lastMessagePreview: string;
  messageCount: number;
  historyOnly: boolean;
  scheduled?: boolean;
};

export type ChatMessage = {
  id: string;
  clientMessageId: string | null;
  sessionId: string;
  runId: string | null;
  role: "user" | "assistant" | "tool" | "plan" | "system" | "error";
  kind: "message" | "tool" | "plan" | "system" | "error";
  title?: string;
  text: string;
  createdAt: number;
  sequence: number;
  deliveryStatus: "pending" | "sent" | "failed" | "streaming";
  attachments: AttachmentRef[];
  meta?: {
    type?: "commandexecution" | "filechange" | "mcptoolcall" | "websearch";
    runId?: string;
    status?: string;
    command?: string;
    output?: string;
    exitCode?: number | null;
    server?: string;
    tool?: string;
    query?: string;
    fileChanges?: RunMessageFileChange[];
    errorMessage?: string;
    path?: string;
    durationMs?: number;
  };
};

export type SessionListResponse = {
  items: SessionListItem[];
  nextCursor: string | null;
  approvals: ApprovalQueueItem[];
};

export type SessionMessagesResponse = {
  sessionId: string;
  messages: ChatMessage[];
  nextCursor: string | null;
  latestRunId: string | null;
};

export type SendMessageAccepted = {
  sessionId: string;
  message: ChatMessage;
  queueStatus: "accepted" | "queued" | "retrying" | "failed";
  latestRunId: string | null;
};

export type TerminalSessionStatus = "running" | "stopped";

export type TerminalSessionSnapshot = {
  sessionId: string;
  status: TerminalSessionStatus;
  workspace: string;
  shell: string;
  pid: number | null;
  createdAt: number;
  updatedAt: number;
  output: string;
};

export type AppBootstrap = {
  defaults: {
    model: string;
    sandbox: SandboxMode;
  };
  activeWorkspace: string;
  workspaces: WorkspaceOption[];
  runs: RunRecord[];
  approvals: ApprovalQueueItem[];
};

export type AppBootstrapLite = {
  defaults: {
    model: string;
    sandbox: SandboxMode;
  };
  activeWorkspace: string;
  workspaces: WorkspaceOption[];
  approvals: ApprovalQueueItem[];
};

export type CodexCommandStatus = {
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CodexTokenStatus = {
  source: "codex-login-status";
  remainingTokens: number | null;
  note: string | null;
};

export type CodexMcpStatusResponse = {
  at: number;
  mcp: CodexCommandStatus;
};

export type CodexAccountStatusResponse = {
  at: number;
  account: CodexCommandStatus;
  tokenStatus: CodexTokenStatus;
};

export type CodexSystemStatusResponse = {
  at: number;
  account: CodexCommandStatus;
  mcp: CodexCommandStatus;
  tokenStatus: CodexTokenStatus;
};

export type ApiError = {
  message: string;
};

export type ApiResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: ApiError;
    };

export const sseEventKinds = [
  "run.started",
  "run.stdout",
  "run.stderr",
  "run.item",
  "run.approvalQueued",
  "run.diffUpdated",
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
] as const;

export type SseEventKind = (typeof sseEventKinds)[number];

export type SseEvent = {
  kind: SseEventKind;
  at: number;
  runId?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
};
