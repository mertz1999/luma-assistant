import { z } from "zod";

export const runStatusSchema = z.enum(["queued", "running", "completed", "failed", "stopped"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const sandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type SandboxMode = z.infer<typeof sandboxSchema>;

export const approvalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

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

export const runConfigSchema = z.object({
  workspace: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  sandbox: sandboxSchema,
  approvalPolicy: approvalPolicySchema,
  planMode: z.boolean().default(false),
  sessionId: z.string().optional(),
  attachments: z.array(attachmentRefSchema).max(10).default([]),
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
});
export type StartRunInput = z.infer<typeof startRunSchema>;

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
