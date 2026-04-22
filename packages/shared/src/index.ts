import { z } from "zod";

export const allowedRpcMethods = [
  "initialize",
  "initialized",
  "account/read",
  "account/rateLimits/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/name/set",
  "thread/list",
  "thread/read",
  "thread/loaded/list",
  "thread/archive",
  "thread/unarchive",
  "thread/unsubscribe",
  "thread/compact/start",
  "thread/rollback",
  "thread/shellCommand",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
  "command/exec",
  "command/exec/write",
  "command/exec/resize",
  "command/exec/terminate",
  "model/list",
  "experimentalFeature/list",
  "collaborationMode/list",
  "app/list",
  "skills/list",
  "plugin/list",
  "plugin/read",
  "plugin/install",
  "plugin/uninstall",
  "skills/config/write",
  "mcpServerStatus/list",
  "mcpServer/resource/read",
  "config/mcpServer/reload",
  "mcpServer/oauth/login",
  "config/read",
  "config/value/write",
  "config/batchWrite",
  "configRequirements/read",
  "externalAgentConfig/detect",
  "externalAgentConfig/import",
  "feedback/upload",
  "tool/requestUserInput",
  "thread/backgroundTerminals/clean",
  "fs/readFile",
  "fs/writeFile",
  "fs/createDirectory",
  "fs/getMetadata",
  "fs/readDirectory",
  "fs/remove",
  "fs/copy",
] as const;

export type AllowedRpcMethod = (typeof allowedRpcMethods)[number];

export const methodGroups = ["read", "thread_control", "ops", "config_write", "filesystem", "experimental"] as const;

export type MethodGroup = (typeof methodGroups)[number];

export const riskTiers = [0, 1, 2, 3] as const;
export type RiskTier = (typeof riskTiers)[number];

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export const rpcGuardSchema = z
  .object({
    acceptRisk: z.boolean().optional(),
    acceptForSession: z.boolean().optional(),
    reauthPassword: z.string().min(1).optional(),
  })
  .optional();

export const rpcRequestSchema = z.object({
  method: z.enum(allowedRpcMethods),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  guard: rpcGuardSchema,
});

export const loginRequestSchema = z.object({
  password: z.string().min(1),
});

export const serverRequestRespondSchema = z
  .object({
    requestId: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().optional(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .refine((data) => data.result !== undefined || data.error !== undefined, {
    message: "Either result or error must be provided",
    path: ["result"],
  });

export type ApiError = {
  message: string;
  code?: number | null;
  data?: unknown;
};

export type GuardRequirement = {
  required: boolean;
  tier: RiskTier;
  group: MethodGroup;
  reason: string;
  allowAcceptForSession: boolean;
  requiresReauthPassword: boolean;
  expiresInMs?: number;
};

export type ApiResponse<T = unknown> =
  | {
      ok: true;
      result?: T;
      data?: T;
      defaults?: Record<string, unknown>;
      bridgeState?: BridgeState;
      sessionToken?: string;
    }
  | {
      ok: false;
      error: ApiError;
      guard?: GuardRequirement;
    };

export type CapabilityDescriptor = {
  method: AllowedRpcMethod;
  group: MethodGroup;
  riskTier: RiskTier;
  enabled: boolean;
  reason: string | null;
  requiresExperimentalApi: boolean;
};

export type BootstrapCapabilities = {
  methods: CapabilityDescriptor[];
  groups: Record<MethodGroup, boolean>;
};

export type NotificationEvent = {
  kind: "notification";
  method: string;
  params: Record<string, unknown>;
  at: number;
};

export type ServerRequestEvent = {
  kind: "serverRequest";
  id: string | number;
  method: string;
  params: Record<string, unknown>;
  at: number;
};

export type BridgeStatus = {
  type: string;
  at: number;
  [key: string]: unknown;
};

export type BridgeStatusEvent = BridgeStatus & {
  kind: "bridgeStatus";
};

export type ConnectedEvent = {
  kind: "connected";
  bridgeState: BridgeState;
  at: number;
};

export type HeartbeatEvent = {
  kind: "heartbeat";
  at: number;
};

export type SseEvent = NotificationEvent | ServerRequestEvent | BridgeStatusEvent | ConnectedEvent | HeartbeatEvent;

export type BridgeState = {
  running: boolean;
  initialized: boolean;
  lastStatus: BridgeStatus | null;
};

export type AppDefaults = {
  cwd: string;
  model: string;
  approvalPolicy: string;
  sandboxType: string;
};

export type BootstrapData = {
  account: unknown;
  rateLimits: unknown;
  threads: unknown;
  archivedThreads: unknown;
  loadedThreads: unknown;
  models: unknown;
  mcpServers: unknown;
  featureFlags: unknown;
  collaborationModes: unknown;
  uiState: unknown;
};
