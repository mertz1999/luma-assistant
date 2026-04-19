import { z } from "zod";

export const allowedRpcMethods = [
  "initialize",
  "initialized",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "thread/start",
  "thread/resume",
  "thread/list",
  "thread/read",
  "thread/archive",
  "thread/unarchive",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "model/list",
  "app/list",
  "skills/list",
  "mcpServerStatus/list",
  "config/mcpServer/reload",
  "mcpServer/oauth/login",
] as const;

export type AllowedRpcMethod = (typeof allowedRpcMethods)[number];

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export const rpcRequestSchema = z.object({
  method: z.enum(allowedRpcMethods),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

export const loginRequestSchema = z.object({
  password: z.string().min(1),
});

export const serverRequestRespondSchema = z.object({
  requestId: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().optional(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export type ApiError = {
  message: string;
  code?: number | null;
  data?: unknown;
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

export type SseEvent =
  | NotificationEvent
  | ServerRequestEvent
  | BridgeStatusEvent
  | ConnectedEvent
  | HeartbeatEvent;

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
  threads: unknown;
  archivedThreads: unknown;
  models: unknown;
  mcpServers: unknown;
};
