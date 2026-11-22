import { z } from "zod";

const sessionId = z.string().min(1).max(250);
const cursor = z.string().max(120).nullable().optional();

export const remoteCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sessions"), cursor }),
  z.strictObject({ kind: z.literal("messages"), sessionId, before: cursor }),
  z.strictObject({
    kind: z.literal("send"),
    sessionId,
    clientMessageId: z.string().uuid(),
    text: z.string().trim().min(1).max(8000),
  }),
  z.strictObject({ kind: z.literal("stop"), sessionId, runId: sessionId }),
]);
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

const remoteSessionSchema = z.object({
  id: sessionId,
  title: z.string(),
  projectName: z.string().nullable(),
  runner: z.enum(["codex", "claude", "cursor"]),
  status: z.enum(["queued", "running", "completed", "failed", "stopped"]),
  latestRunId: sessionId.nullable(),
  canSend: z.boolean(),
});

const remoteMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "plan", "error", "system"]),
  text: z.string().max(12_000),
  deliveryStatus: z.enum(["pending", "sent", "failed", "streaming"]),
});

export const remoteResultSchemas = {
  sessions: z.object({ items: z.array(remoteSessionSchema).max(60), nextCursor: cursor }),
  messages: z.object({ messages: z.array(remoteMessageSchema), nextCursor: cursor }),
  send: z.object({ accepted: z.literal(true) }),
  stop: z.object({ stopped: z.literal(true) }),
};

export type RemoteSession = z.infer<typeof remoteSessionSchema>;
export type RemoteMessage = z.infer<typeof remoteMessageSchema>;
export type RemoteResult<T extends RemoteCommand["kind"]> = z.infer<(typeof remoteResultSchemas)[T]>;

export type RemoteDevice = {
  id: string;
  name: string;
  online: boolean;
  canControl: boolean;
};
