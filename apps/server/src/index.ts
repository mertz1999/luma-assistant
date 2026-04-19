import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  allowedRpcMethods,
  loginRequestSchema,
  rpcRequestSchema,
  serverRequestRespondSchema,
  type AllowedRpcMethod,
  type ApiError,
  type BridgeState,
  type SseEvent,
} from "@assistant/shared";
import { CodexBridge, type BridgeNotificationEvent, type BridgeServerRequestEvent, type BridgeStatusEvent } from "./codexBridge.js";
import { SessionStore } from "./sessionStore.js";

declare global {
  namespace Express {
    interface Request {
      sessionToken?: string;
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../..");

dotenv.config({ path: path.resolve(rootDir, ".env") });

type AppConfig = {
  port: number;
  host: string;
  webOrigins: string[];
  appPassword: string;
  codexPath: string;
  defaultCwd: string;
  defaultModel: string;
  defaultApprovalPolicy: string;
  defaultSandboxType: string;
  defaultNetworkAccess: boolean;
  loginRateLimitWindowMs: number;
  loginRateLimitMaxAttempts: number;
  cookieSecure: boolean;
};

const config: AppConfig = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  webOrigins: (process.env.WEB_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  appPassword: process.env.APP_PASSWORD || "",
  codexPath: process.env.CODEX_PATH || "codex",
  defaultCwd: process.env.DEFAULT_CWD || rootDir,
  defaultModel: process.env.DEFAULT_MODEL || "gpt-5.4",
  defaultApprovalPolicy: process.env.DEFAULT_APPROVAL_POLICY || "onRequest",
  defaultSandboxType: process.env.DEFAULT_SANDBOX_TYPE || "workspaceWrite",
  defaultNetworkAccess: String(process.env.DEFAULT_NETWORK_ACCESS || "true").toLowerCase() === "true",
  loginRateLimitWindowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 900000),
  loginRateLimitMaxAttempts: Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS || 12),
  cookieSecure: String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true",
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (config.webOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  }),
);

const sessionStore = new SessionStore({
  password: config.appPassword,
  rateWindowMs: config.loginRateLimitWindowMs,
  rateMaxAttempts: config.loginRateLimitMaxAttempts,
});

const bridge = new CodexBridge({
  codexPath: config.codexPath,
  cwd: rootDir,
});

const sseClients = new Set<{ id: string; res: Response }>();
const allowedMethods = new Set<AllowedRpcMethod>(allowedRpcMethods);

let bridgeState: BridgeState = {
  running: false,
  initialized: false,
  lastStatus: null,
};

function sanitizeError(error: unknown): ApiError {
  if (error instanceof Error) {
    const ext = error as Error & { code?: number; data?: unknown };
    return {
      message: ext.message,
      code: ext.code ?? null,
      data: ext.data ?? null,
    };
  }

  return {
    message: "Unknown error",
    code: null,
    data: null,
  };
}

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}

function extractSessionToken(req: Request): string | null {
  const cookieToken = req.cookies?.session_token as string | undefined;
  if (cookieToken) return cookieToken;

  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return null;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!sessionStore.isConfigured()) {
    res.status(500).json({
      ok: false,
      error: { message: "APP_PASSWORD is not configured" },
    });
    return;
  }

  const token = extractSessionToken(req);
  if (!sessionStore.isValidSession(token)) {
    res.status(401).json({
      ok: false,
      error: { message: "Unauthorized" },
    });
    return;
  }

  req.sessionToken = token || undefined;
  next();
}

function sendSse(client: { id: string; res: Response }, payload: SseEvent): void {
  client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(payload: SseEvent): void {
  for (const client of sseClients) {
    try {
      sendSse(client, payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function applyRpcDefaults(method: AllowedRpcMethod, params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };

  if (method === "thread/start") {
    if (!next.model) next.model = config.defaultModel;
    if (!next.cwd) next.cwd = config.defaultCwd;
    if (!next.approvalPolicy) next.approvalPolicy = config.defaultApprovalPolicy;
    if (!next.sandbox) next.sandbox = config.defaultSandboxType;
  }

  if (method === "turn/start") {
    if (!next.cwd) next.cwd = config.defaultCwd;
    if (!next.approvalPolicy) next.approvalPolicy = config.defaultApprovalPolicy;
    if (!next.sandboxPolicy) {
      next.sandboxPolicy = {
        type: config.defaultSandboxType,
        writableRoots: [config.defaultCwd],
        networkAccess: config.defaultNetworkAccess,
      };
    }
  }

  if (method === "account/login/start") {
    next.type = "chatgpt";
  }

  return next;
}

async function bootstrapData(): Promise<Record<string, unknown>> {
  const requests = {
    account: bridge.request("account/read", { refreshToken: false }),
    threads: bridge.request("thread/list", {
      cursor: null,
      limit: 50,
      sortKey: "updated_at",
      archived: false,
    }),
    archivedThreads: bridge.request("thread/list", {
      cursor: null,
      limit: 50,
      sortKey: "updated_at",
      archived: true,
    }),
    models: bridge.request("model/list", {
      limit: 20,
      includeHidden: false,
    }),
    mcpServers: bridge.request("mcpServerStatus/list", {
      cursor: null,
      limit: 100,
      detail: "toolsAndAuthOnly",
    }),
  };

  const settled = await Promise.allSettled(Object.values(requests));
  const keys = Object.keys(requests);
  const result: Record<string, unknown> = {};

  settled.forEach((entry, index) => {
    const key = keys[index];
    if (entry.status === "fulfilled") {
      result[key] = entry.value;
    } else {
      result[key] = {
        error: sanitizeError(entry.reason),
      };
    }
  });

  return result;
}

bridge.on("notification", (message: BridgeNotificationEvent) => {
  broadcast({ kind: "notification", ...message, at: Date.now() });
});

bridge.on("serverRequest", (request: BridgeServerRequestEvent) => {
  broadcast({ kind: "serverRequest", ...request, at: Date.now() });
});

bridge.on("status", (status: BridgeStatusEvent) => {
  bridgeState.lastStatus = status;

  if (status.type === "started") bridgeState.running = true;
  if (status.type === "initialized") bridgeState.initialized = true;
  if (status.type === "exit") {
    bridgeState.running = false;
    bridgeState.initialized = false;
  }

  broadcast({ kind: "bridgeStatus", ...status, at: Date.now() });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    bridgeState,
  });
});

app.post("/api/login", (req, res) => {
  const parsed = loginRequestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: { message: "Invalid login payload" },
    });
    return;
  }

  const ip = clientIp(req);
  if (!sessionStore.canAttemptLogin(ip)) {
    res.status(429).json({
      ok: false,
      error: { message: "Too many login attempts. Please wait and retry." },
    });
    return;
  }

  sessionStore.trackLoginAttempt(ip);

  if (!sessionStore.verifyPassword(parsed.data.password)) {
    res.status(401).json({
      ok: false,
      error: { message: "Invalid password" },
    });
    return;
  }

  const token = sessionStore.createSession(ip);

  res.cookie("session_token", token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({ ok: true, sessionToken: token });
});

app.post("/api/logout", requireAuth, (req, res) => {
  sessionStore.deleteSession(req.sessionToken || null);
  res.clearCookie("session_token");
  res.json({ ok: true });
});

app.get("/api/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const client = {
    id: Math.random().toString(16).slice(2),
    res,
  };

  sseClients.add(client);
  sendSse(client, {
    kind: "connected",
    bridgeState,
    at: Date.now(),
  });

  const keepAlive = setInterval(() => {
    if (!sseClients.has(client)) return;
    sendSse(client, {
      kind: "heartbeat",
      at: Date.now(),
    });
  }, 15_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
  });
});

app.use("/api", requireAuth);

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const data = await bootstrapData();
    res.json({
      ok: true,
      bridgeState,
      defaults: {
        cwd: config.defaultCwd,
        model: config.defaultModel,
        approvalPolicy: config.defaultApprovalPolicy,
        sandboxType: config.defaultSandboxType,
      },
      data,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: sanitizeError(error),
    });
  }
});

app.post("/api/rpc", async (req, res) => {
  const parsed = rpcRequestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: { message: "Invalid rpc payload" },
    });
    return;
  }

  const method = parsed.data.method;
  if (!allowedMethods.has(method)) {
    res.status(403).json({
      ok: false,
      error: { message: `Method is not allowed in MVP: ${method}` },
    });
    return;
  }

  if (method === "account/login/start" && parsed.data.params.type && parsed.data.params.type !== "chatgpt") {
    res.status(400).json({
      ok: false,
      error: { message: "Only ChatGPT login mode is enabled in this build" },
    });
    return;
  }

  try {
    const params = applyRpcDefaults(method, parsed.data.params);
    const result = await bridge.request(method, params);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: sanitizeError(error),
    });
  }
});

app.post("/api/server-request/respond", (req, res) => {
  const parsed = serverRequestRespondSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: { message: "Invalid server request response payload" },
    });
    return;
  }

  try {
    bridge.respondToServerRequest({
      requestId: parsed.data.requestId,
      result: parsed.data.result,
      error: parsed.data.error,
    });

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: sanitizeError(error),
    });
  }
});

const webDistDir = path.resolve(rootDir, "apps/web/dist");

if (fs.existsSync(webDistDir)) {
  app.use(express.static(webDistDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(webDistDir, "index.html"));
  });
}

async function start(): Promise<void> {
  if (!sessionStore.isConfigured()) {
    throw new Error("APP_PASSWORD must be set in .env before starting the server");
  }

  await bridge.start();
  await bridge.initialize({
    name: "personal_codex_assistant",
    title: "Personal Codex Assistant",
    version: "0.2.0",
  });

  app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`assistant-server listening on http://${config.host}:${config.port}`);
    // eslint-disable-next-line no-console
    console.log(`web origins for dev CORS: ${config.webOrigins.join(", ")}`);
    // eslint-disable-next-line no-console
    console.log("Warning: this service is intended for trusted LAN use only.");
  });
}

process.on("SIGINT", () => {
  bridge.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bridge.stop();
  process.exit(0);
});

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start assistant-server:", error);
  process.exit(1);
});
