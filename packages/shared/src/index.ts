import { z } from "zod";

export const runStatusSchema = z.enum(["queued", "running", "completed", "failed", "stopped"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const sandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type SandboxMode = z.infer<typeof sandboxSchema>;

export const approvalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const runSourceTagSchema = z.enum(["in-app", "vscode", "cli", "exec", "other"]);
export type RunSourceTag = z.infer<typeof runSourceTagSchema>;

export const runRunnerSchema = z.enum(["codex", "claude"]);
export type RunRunner = z.infer<typeof runRunnerSchema>;

export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

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
  storage: z.enum(["workspace", "luma"]).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  alt: z.string().optional(),
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

export const selectedAgentRefSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
});
export type SelectedAgentRef = z.infer<typeof selectedAgentRefSchema>;

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
    runner: runRunnerSchema.default("codex"),
    workspace: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: reasoningEffortSchema.default("high"),
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
  runner: runRunnerSchema.default("codex"),
  workspace: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.default("high"),
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
  runner: runRunnerSchema.default("codex"),
  workspace: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.default("high"),
  sandbox: sandboxSchema,
  approvalPolicy: approvalPolicySchema,
  planMode: z.boolean().default(false),
  sessionId: z.string().optional(),
  attachments: z.array(attachmentRefSchema).max(10).default([]),
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
  agents: z.array(selectedAgentRefSchema).max(10).default([]),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

export const startRunSchema = z.object({
  runner: runRunnerSchema.default("codex"),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.default("high"),
  sandbox: sandboxSchema.default("read-only"),
  approvalPolicy: approvalPolicySchema.default("on-request"),
  planMode: z.boolean().default(false),
  sessionId: z.string().optional(),
  attachments: z.array(attachmentRefSchema).max(10).default([]),
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
  agents: z.array(selectedAgentRefSchema).max(10).default([]),
});
export type StartRunInput = z.infer<typeof startRunSchema>;

export const sendMessageSchema = z.object({
  clientMessageId: z.string().min(1),
  sessionId: z.string().optional(),
  text: z.string().min(1),
  runner: runRunnerSchema.default("codex"),
  workspace: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.default("high"),
  sandbox: sandboxSchema.default("read-only"),
  approvalPolicy: approvalPolicySchema.default("on-request"),
  planMode: z.boolean().default(false),
  attachments: z.array(attachmentRefSchema).max(10).default([]),
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
  agents: z.array(selectedAgentRefSchema).max(10).default([]),
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

export type TokenUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};

export type SessionTokenUsageResponse = {
  usage: TokenUsageSummary | null;
};

export type ApprovalQueueItem = {
  id: string;
  runId: string;
  createdAt: number;
  kind?: "rerun" | "claude_permission";
  reason: string;
  suggestedSandbox: SandboxMode;
  suggestedApprovalPolicy: ApprovalPolicy;
  command: string | null;
  toolName?: string;
  toolUseId?: string;
  status: "pending" | "accepted" | "dismissed";
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
  runner: RunRunner;
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
  runner: RunRunner;
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
    runner: RunRunner;
    model: string;
    codexModel: string;
    claudeModel: string;
    reasoningEffort: ReasoningEffort;
    sandbox: SandboxMode;
  };
  activeWorkspace: string;
  workspaces: WorkspaceOption[];
  runs: RunRecord[];
  approvals: ApprovalQueueItem[];
};

export type AppBootstrapLite = {
  defaults: {
    runner: RunRunner;
    model: string;
    codexModel: string;
    claudeModel: string;
    reasoningEffort: ReasoningEffort;
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

export const taskManagerRoleSchema = z.enum(["admin", "user"]);
export type TaskManagerRole = z.infer<typeof taskManagerRoleSchema>;

export const taskManagerStatusSchema = z.enum(["todo", "in_progress", "blocked", "done"]);
export type TaskManagerStatus = z.infer<typeof taskManagerStatusSchema>;

export const taskManagerPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type TaskManagerPriority = z.infer<typeof taskManagerPrioritySchema>;

export const taskManagerUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(2),
  displayName: z.string().min(1),
  role: taskManagerRoleSchema,
  active: z.boolean(),
  timeZone: z.string().min(1).max(80).default("Asia/Tehran"),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastLoginAt: z.number().int().nonnegative().nullable(),
});
export type TaskManagerUser = z.infer<typeof taskManagerUserSchema>;

export const taskManagerProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  archived: z.boolean(),
  createdBy: z.string().min(1),
  userIds: z.array(z.string().min(1)).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type TaskManagerProject = z.infer<typeof taskManagerProjectSchema>;

export const taskManagerLabelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type TaskManagerLabel = z.infer<typeof taskManagerLabelSchema>;

export const taskManagerChecklistItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  done: z.boolean(),
});
export type TaskManagerChecklistItem = z.infer<typeof taskManagerChecklistItemSchema>;

export const taskManagerTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: taskManagerStatusSchema,
  priority: taskManagerPrioritySchema,
  projectId: z.string().min(1).nullable(),
  assigneeId: z.string().min(1).nullable(),
  createdBy: z.string().min(1),
  dueAt: z.number().int().nonnegative().nullable(),
  isDeadline: z.boolean().default(false),
  sortOrder: z.number().finite().default(0),
  labelIds: z.array(z.string().min(1)),
  checklist: z.array(taskManagerChecklistItemSchema),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
});
export type TaskManagerTask = z.infer<typeof taskManagerTaskSchema>;

export const taskManagerCommentSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  userId: z.string().min(1),
  body: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type TaskManagerComment = z.infer<typeof taskManagerCommentSchema>;

export const taskManagerActivitySchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  userId: z.string().min(1),
  action: z.string().min(1),
  detail: z.string(),
  createdAt: z.number().int().nonnegative(),
});
export type TaskManagerActivity = z.infer<typeof taskManagerActivitySchema>;

export type TaskManagerBootstrap = {
  currentUser: TaskManagerUser;
  users: TaskManagerUser[];
  projects: TaskManagerProject[];
  labels: TaskManagerLabel[];
  tasks: TaskManagerTask[];
  comments: TaskManagerComment[];
  activity: TaskManagerActivity[];
};

export const taskManagerLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type TaskManagerLoginInput = z.infer<typeof taskManagerLoginSchema>;

export const createTaskManagerUserSchema = z.object({
  username: z.string().min(2).max(48).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
  role: taskManagerRoleSchema.default("user"),
});
export type CreateTaskManagerUserInput = z.infer<typeof createTaskManagerUserSchema>;

export const updateTaskManagerUserSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  role: taskManagerRoleSchema.optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
  timeZone: z.string().min(1).max(80).optional(),
});
export type UpdateTaskManagerUserInput = z.infer<typeof updateTaskManagerUserSchema>;

export const updateTaskManagerProfileSchema = z.object({
  timeZone: z.string().min(1).max(80),
});
export type UpdateTaskManagerProfileInput = z.infer<typeof updateTaskManagerProfileSchema>;

export const createTaskManagerProjectSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().min(1).max(32).default("#12867d"),
  userIds: z.array(z.string().min(1)).max(200).default([]),
});
export type CreateTaskManagerProjectInput = z.infer<typeof createTaskManagerProjectSchema>;

export const updateTaskManagerProjectSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.string().min(1).max(32).optional(),
  archived: z.boolean().optional(),
  userIds: z.array(z.string().min(1)).max(200).optional(),
});
export type UpdateTaskManagerProjectInput = z.infer<typeof updateTaskManagerProjectSchema>;

export const createTaskManagerLabelSchema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().min(1).max(32).default("#64748b"),
});
export type CreateTaskManagerLabelInput = z.infer<typeof createTaskManagerLabelSchema>;

export const createTaskManagerTaskSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().max(4000).default(""),
  status: taskManagerStatusSchema.default("todo"),
  priority: taskManagerPrioritySchema.default("medium"),
  projectId: z.string().min(1).nullable().default(null),
  assigneeId: z.string().min(1).nullable().default(null),
  dueAt: z.number().int().nonnegative().nullable().default(null),
  isDeadline: z.boolean().default(false),
  sortOrder: z.number().finite().optional(),
  labelIds: z.array(z.string().min(1)).max(20).default([]),
  checklist: z.array(taskManagerChecklistItemSchema).max(50).default([]),
});
export type CreateTaskManagerTaskInput = z.infer<typeof createTaskManagerTaskSchema>;

export const updateTaskManagerTaskSchema = createTaskManagerTaskSchema.partial().extend({
  completedAt: z.number().int().nonnegative().nullable().optional(),
});
export type UpdateTaskManagerTaskInput = z.infer<typeof updateTaskManagerTaskSchema>;

export const createTaskManagerCommentSchema = z.object({
  body: z.string().min(1).max(2000),
});
export type CreateTaskManagerCommentInput = z.infer<typeof createTaskManagerCommentSchema>;

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
