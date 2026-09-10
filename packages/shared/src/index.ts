import { z } from "zod";

export { sanitizeExternalText, fenceExternalText, type FenceOptions } from "./fencing.js";

export const runStatusSchema = z.enum(["queued", "running", "completed", "failed", "stopped"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const sandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type SandboxMode = z.infer<typeof sandboxSchema>;

export const approvalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const runSourceTagSchema = z.enum(["in-app", "vscode", "cli", "exec", "other"]);
export type RunSourceTag = z.infer<typeof runSourceTagSchema>;

/**
 * "qwythos" is a local-only runner (no cloud API, ever) that spawns the
 * `openclaude` CLI -- a CLI-compatible fork of Claude Code -- pointed at a
 * separately-managed local llama-server endpoint (127.0.0.1:8080/v1,
 * frozen baseline QWYTHOS-LUMA-BASELINE-v1, see
 * C:\Users\it hp\qwythos-stack\luma\). Luma does not own that server's
 * lifecycle; it only connects to it. See docs/qwythos-cli.md.
 */
export const runRunnerSchema = z.enum(["codex", "claude", "qwythos"]);
export type RunRunner = z.infer<typeof runRunnerSchema>;

export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const attachmentKindSchema = z.enum(["image", "text", "document"]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/**
 * Present only on kind: "document" attachments (apps/server/src/ingestion/).
 * Describes the local MarkItDown conversion Luma ran on upload -- deliberately
 * generic field names (no "markitdown" in the shape itself) so a future
 * conversion backend could populate the same shape.
 */
export const attachmentConversionSchema = z.object({
  backend: z.string().min(1),
  markdownRelativePath: z.string().min(1),
  contentHash: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  title: z.string().nullable().optional(),
  warnings: z.array(z.string()).default([]),
  markdownChars: z.number().int().nonnegative(),
  truncatedForPrompt: z.boolean().default(false),
});
export type AttachmentConversion = z.infer<typeof attachmentConversionSchema>;

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
  conversion: attachmentConversionSchema.optional(),
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

/**
 * SKIP (default, matches the product's pre-existing behavior exactly --
 * a schedule that was overdue while Luma was offline previously just had
 * its next occurrence silently recomputed forward with no record of what
 * was missed): an occurrence that became due while offline is not
 * replayed; the schedule just resumes normally.
 * RUN_ONCE: exactly one catch-up run for the missed occurrence(s) --
 * never one per missed day/occurrence.
 */
export const missedRunPolicySchema = z.enum(["skip", "run_once"]);
export type MissedRunPolicy = z.infer<typeof missedRunPolicySchema>;

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
  missedRunPolicy: missedRunPolicySchema.default("skip"),
  runConfig: z.object({
    runner: runRunnerSchema.default("codex"),
    workspace: z.string().min(1),
    /** See runConfigSchema.project -- schedules should declare this so dispatch-time admission is bound, not just workspace-only. */
    project: z.string().trim().min(1).optional(),
    model: z.string().min(1),
    reasoningEffort: reasoningEffortSchema.default("high"),
    sandbox: sandboxSchema,
    approvalPolicy: approvalPolicySchema,
    skills: z.array(selectedSkillRefSchema).max(20).default([]),
    /** Same meaning as RunConfig.requestedCredentials -- explicit, resolved against this schedule's own project (derived from workspace) at EXECUTION time, never at creation time. */
    requestedCredentials: z.array(z.string()).max(20).default([]),
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
  /** See runConfigSchema.project. */
  project: z.string().trim().min(1).optional(),
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.default("high"),
  sandbox: sandboxSchema,
  approvalPolicy: approvalPolicySchema,
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
  missedRunPolicy: missedRunPolicySchema.default("skip"),
  requestedCredentials: z.array(z.string()).max(20).default([]),
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
  /**
   * Optional declared project identity (a `config.yaml` `repos:` key, e.g.
   * "botolaiq"/"dalilfinance"), independent of and never trusted from
   * `workspace` alone. When set, `RunManager.startRun` mechanically
   * verifies `workspace` resolves to this project's own registered
   * workspace (or a subfolder of it) before spawning -- see
   * policy/policy-engine.ts:evaluateProjectWorkspaceBinding. Omitted
   * entirely, this is the pre-existing (legacy) admission path: only the
   * workspace-only denylist in evaluateRunStartPolicy applies. Additive by
   * design so no existing caller (ad-hoc workspaces, test fixtures) breaks.
   */
  project: z.string().trim().min(1).optional(),
  /** Manual-only escalation flag. See RunManager.startRun / permission-mapping.ts for enforcement. Absent from schedule/outbox schemas by design. */
  permissionProfile: z.enum(["FULL_MACHINE"]).optional(),
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
  /**
   * Explicit, by-id credential requests for this run's own project
   * (derived from `workspace`). Deliberately explicit, never inferred from
   * prompt/command text -- a task with no declared requirement receives no
   * project credential, only the safe base environment. Empty by default
   * so every existing caller that doesn't know about this field keeps
   * getting exactly the safe-base-only environment from the previous phase.
   */
  requestedCredentials: z.array(z.string()).max(20).default([]),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

export const startRunSchema = z.object({
  runner: runRunnerSchema.default("codex"),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  /** See runConfigSchema.project -- same optional, mechanically-checked declared project identity. */
  project: z.string().trim().min(1).optional(),
  /** See runConfigSchema.permissionProfile. */
  permissionProfile: z.enum(["FULL_MACHINE"]).optional(),
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.default("high"),
  sandbox: sandboxSchema.default("read-only"),
  approvalPolicy: approvalPolicySchema.default("on-request"),
  planMode: z.boolean().default(false),
  sessionId: z.string().optional(),
  attachments: z.array(attachmentRefSchema).max(10).default([]),
  skills: z.array(selectedSkillRefSchema).max(20).default([]),
  agents: z.array(selectedAgentRefSchema).max(10).default([]),
  requestedCredentials: z.array(z.string()).max(20).default([]),
});
export type StartRunInput = z.infer<typeof startRunSchema>;

export const sendMessageSchema = z.object({
  clientMessageId: z.string().min(1),
  sessionId: z.string().optional(),
  text: z.string().min(1),
  runner: runRunnerSchema.default("codex"),
  workspace: z.string().min(1),
  /** See runConfigSchema.project. */
  project: z.string().trim().min(1).optional(),
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
  /**
   * PID of the currently (or most recently) spawned Codex/Claude process
   * for this run, if any is known. Persisted so a server restart can check
   * whether a run left "running" actually still has a live process behind
   * it (crash recovery) rather than assuming every restart means the
   * process died. Cleared (null) once the run reaches a terminal status.
   */
  pid: number | null;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  } | null;
  /**
   * Which controller-process "generation" currently owns this run, i.e. is
   * allowed to apply the asynchronous, ownership-defining mutations that
   * follow from spawning it (process exit/error, timeout escalation --
   * see RunManager.updateRunIfCurrentGeneration in index.ts). Set once at
   * spawn time to that process's own generation counter and never changed
   * by the run's own lifecycle; only restart-time reconciliation
   * (RunManager.loadPersisted -- the moment a NEW controller process
   * actually claims an orphaned/stale run) legitimately advances it.
   * Optional so pre-existing persisted runs (created before this field
   * existed) load without a migration; RunManager normalizes a missing
   * value to 0 at load time, which every real process's own generation
   * (>= 1) is guaranteed to be strictly newer than.
   */
  ownerGeneration?: number;
};

/**
 * A persistent, multi-step objective that owns a set of sessions/runs
 * (first slice -- no task graph/dependencies/checkpoints yet, see
 * apps/server/src/missions/mission-state.ts for the status state machine
 * and the reasoning behind what this phase deliberately does not include).
 */
export const missionStatusSchema = z.enum(["PENDING", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED"]);
export type MissionStatus = z.infer<typeof missionStatusSchema>;

export type Mission = {
  id: string;
  workspace: string;
  /**
   * Optional declared project identity (see runConfigSchema.project). When
   * set, any run attached to this mission (POST /api/missions/:id/runs)
   * must resolve its own workspace to this project's registered workspace
   * (or a subfolder of it) -- enforced mechanically, not by trusting the
   * mission's own `workspace` field, which the caller supplies. Null for
   * missions created before this field existed (legacy/unbound).
   */
  project: string | null;
  objective: string;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
  /**
   * Run IDs this mission owns, in the order they were attached. Run id
   * (RunRecord.id) rather than sessionId deliberately: sessionId is only
   * ever set on a run that was explicitly resumed (--resume), so most
   * first-time runs have sessionId=null and couldn't be tracked by it.
   * Run id always exists. The actual run data lives in the existing runs
   * store -- a mission just tracks which ones belong to it.
   */
  runIds: string[];
  /** Set only on a terminal status (COMPLETED/FAILED/CANCELLED); null otherwise. */
  closedAt: number | null;
  /** Free-text note explaining a FAILED/CANCELLED outcome, or a completion summary for COMPLETED. */
  statusNote: string | null;
};

export const createMissionSchema = z.object({
  workspace: z.string().min(1),
  /** See Mission.project. */
  project: z.string().trim().min(1).optional(),
  objective: z.string().min(1),
});
export type CreateMissionInput = z.infer<typeof createMissionSchema>;

export const setMissionStatusSchema = z.object({
  status: missionStatusSchema,
  note: z.string().optional(),
});

/**
 * A project is identified by its workspace path, the same way a mission
 * is -- never a raw project id round-tripped from the client. The server
 * derives the actual (opaque, filesystem-safe) project id from this path;
 * see apps/server/src/credentials/credential-store.ts:deriveProjectId.
 */
export const createCredentialSchema = z.object({
  workspace: z.string().min(1),
  name: z.string().min(1),
  allowedAdapters: z.array(runRunnerSchema).min(1),
  value: z.string().min(1),
});
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;

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
  model?: string;
  reasoningEffort?: ReasoningEffort;
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
    description?: string;
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
  model?: string;
  reasoningEffort?: ReasoningEffort;
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
    description?: string;
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
    claudeEffortFlagSupported: boolean;
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
    claudeEffortFlagSupported: boolean;
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
  /** Stable machine-readable error code, when the failure has one (e.g. document-ingestion's DocumentRejectCode values). Optional so existing callers that only ever read `message` are unaffected. */
  code?: string;
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
