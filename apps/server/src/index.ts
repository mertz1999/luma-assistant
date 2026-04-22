import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  allowedRpcMethods,
  loginRequestSchema,
  methodGroups,
  rpcRequestSchema,
  serverRequestRespondSchema,
  type AllowedRpcMethod,
  type ApiError,
  type BootstrapCapabilities,
  type BridgeState,
  type GuardRequirement,
  type MethodGroup,
  type RiskTier,
  type SseEvent,
} from "@assistant/shared";
import { CodexBridge, type BridgeNotificationEvent, type BridgeServerRequestEvent, type BridgeStatusEvent } from "./codexBridge.js";
import { getCapabilityDescriptors, getMethodPolicy, type MethodPolicy } from "./methodPolicy.js";
import { AuditLogger, UiStateStore, type PersistedUiState } from "./persistence.js";
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
  allowLanOrigins: boolean;
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
  riskAcceptTtlMs: number;
  groupEnabled: Record<MethodGroup, boolean>;
  debugLogs: boolean;
};

function parseBool(input: string | undefined, fallback: boolean): boolean {
  if (typeof input !== "string") return fallback;
  return input.trim().toLowerCase() === "true";
}

function normalizeApprovalPolicy(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "on-request";
  }

  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");

  if (normalized === "onrequest") return "on-request";
  if (normalized === "on-request") return "on-request";
  if (normalized === "onfailure") return "on-failure";
  if (normalized === "on-failure") return "on-failure";
  if (normalized === "untrusted") return "untrusted";
  if (normalized === "never") return "never";

  return normalized;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveConfigPath(baseDir: string): string {
  const homeDir = process.env.HOME || "";
  const fixedPath = homeDir ? path.join(homeDir, "config", "agentic-assistant", "config.yaml") : "";
  if (fixedPath && fs.existsSync(fixedPath)) return fixedPath;
  return path.resolve(baseDir, "config.yaml");
}

function readDefaultWorkspaceFromConfig(baseDir: string): string | null {
  const cfgPath = resolveConfigPath(baseDir);
  if (!fs.existsSync(cfgPath)) return null;

  try {
    const text = fs.readFileSync(cfgPath, "utf8");
    const line = text
      .split(/\r?\n/)
      .find((row) => row.trim().startsWith("default_workspace:"));
    if (!line) return null;

    const raw = line
      .split(":")
      .slice(1)
      .join(":")
      .trim();
    if (!raw) return null;

    let workspace = stripOuterQuotes(raw);
    if (workspace.startsWith("~")) {
      const home = process.env.HOME || "";
      workspace = home ? path.join(home, workspace.slice(1)) : workspace;
    }

    const resolved = path.resolve(workspace);
    if (!fs.existsSync(resolved)) {
      // eslint-disable-next-line no-console
      console.warn(`[server] ${cfgPath} default_workspace does not exist: ${resolved}. Falling back to DEFAULT_CWD/env.`);
      return null;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      // eslint-disable-next-line no-console
      console.warn(`[server] ${cfgPath} default_workspace is not a directory: ${resolved}. Falling back to DEFAULT_CWD/env.`);
      return null;
    }
    return resolved;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[server] Failed to read ${cfgPath} default_workspace. Falling back to DEFAULT_CWD/env.`, error);
    return null;
  }
}

function normalizeThreadSandbox(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "workspace-write";
  }

  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "workspacewrite" || normalized === "workspace-write") return "workspace-write";
  if (normalized === "readonly" || normalized === "read-only") return "read-only";
  if (normalized === "dangerfullaccess" || normalized === "danger-full-access") return "danger-full-access";
  return normalized;
}

function normalizeTurnSandboxType(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "workspaceWrite";
  }

  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "workspacewrite" || normalized === "workspace-write") return "workspaceWrite";
  if (normalized === "readonly" || normalized === "read-only") return "readOnly";
  if (normalized === "dangerfullaccess" || normalized === "danger-full-access") return "dangerFullAccess";
  if (normalized === "externalsandbox" || normalized === "external-sandbox") return "externalSandbox";
  return value;
}

const groupEnabled: Record<MethodGroup, boolean> = {
  read: parseBool(process.env.ENABLE_GROUP_READ, true),
  thread_control: parseBool(process.env.ENABLE_GROUP_THREAD_CONTROL, true),
  ops: parseBool(process.env.ENABLE_GROUP_OPS, true),
  config_write: parseBool(process.env.ENABLE_GROUP_CONFIG_WRITE, true),
  filesystem: parseBool(process.env.ENABLE_GROUP_FILESYSTEM, true),
  experimental: parseBool(process.env.ENABLE_GROUP_EXPERIMENTAL, false),
};

const defaultWorkspaceFromConfig = readDefaultWorkspaceFromConfig(rootDir);

const config: AppConfig = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  webOrigins: (process.env.WEB_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  allowLanOrigins: String(process.env.ALLOW_LAN_ORIGINS || "true").toLowerCase() === "true",
  appPassword: process.env.APP_PASSWORD || "",
  codexPath: process.env.CODEX_PATH || "codex",
  defaultCwd: defaultWorkspaceFromConfig || process.env.DEFAULT_CWD || rootDir,
  defaultModel: process.env.DEFAULT_MODEL || "gpt-5.4",
  defaultApprovalPolicy: normalizeApprovalPolicy(process.env.DEFAULT_APPROVAL_POLICY || "on-request"),
  defaultSandboxType: process.env.DEFAULT_SANDBOX_TYPE || "workspaceWrite",
  defaultNetworkAccess: String(process.env.DEFAULT_NETWORK_ACCESS || "true").toLowerCase() === "true",
  loginRateLimitWindowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 900000),
  loginRateLimitMaxAttempts: Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS || 12),
  cookieSecure: String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true",
  riskAcceptTtlMs: Number(process.env.RISK_ACCEPT_TTL_MS || 15 * 60 * 1000),
  groupEnabled,
  debugLogs: parseBool(process.env.DEBUG_LOGS, false),
};

function debugLog(event: string, payload: Record<string, unknown> = {}): void {
  if (!config.debugLogs) return;
  // eslint-disable-next-line no-console
  console.log(`[debug] ${event}`, payload);
}

const corsPorts = new Set(
  config.webOrigins
    .map((origin) => {
      try {
        const url = new URL(origin);
        if (url.port) return url.port;
        return url.protocol === "https:" ? "443" : "80";
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value)),
);

function isPrivateLanHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (host === "127.0.0.1") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const match172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

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

      if (config.allowLanOrigins) {
        try {
          const url = new URL(origin);
          const port = url.port || (url.protocol === "https:" ? "443" : "80");
          if (isPrivateLanHost(url.hostname) && (corsPorts.size === 0 || corsPorts.has(port))) {
            callback(null, true);
            return;
          }
        } catch {
          // ignore invalid origin format
        }
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

const uiStateStore = new UiStateStore(rootDir);
const auditLogger = new AuditLogger(rootDir);
const sseClients = new Set<{ id: string; res: Response }>();
const allowedMethods = new Set<AllowedRpcMethod>(allowedRpcMethods);

let bridgeState: BridgeState = {
  running: false,
  initialized: false,
  lastStatus: null,
};
let selectedWorkspaceRoot = path.resolve(config.defaultCwd);

const uiStatePatchSchema = z.object({
  lastActiveThreadId: z.string().nullable().optional(),
  pinnedThreadIds: z.array(z.string()).optional(),
  panelLayout: z
    .object({
      contextTab: z.enum(["context", "ops", "admin"]).optional(),
    })
    .optional(),
  filters: z
    .object({
      showArchived: z.boolean().optional(),
    })
    .optional(),
  composer: z
    .object({
      draftByThread: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

const workspaceSelectSchema = z.object({
  root: z.string().min(1, "Workspace path is required"),
});

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("thread not found");
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

  const queryToken = typeof req.query.sessionToken === "string" ? req.query.sessionToken : null;
  if (queryToken && queryToken.trim().length > 0) {
    return queryToken.trim();
  }

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
    debugLog("auth.unauthorized", {
      path: req.path,
      method: req.method,
      hasCookieToken: Boolean(req.cookies?.session_token),
      hasQueryToken: typeof req.query.sessionToken === "string",
      hasBearer: typeof req.headers.authorization === "string" && req.headers.authorization.toLowerCase().startsWith("bearer "),
      ip: clientIp(req),
    });
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

function getWorkspaceRoot(): string {
  return selectedWorkspaceRoot;
}

function applyRpcDefaults(method: AllowedRpcMethod, params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  const workspaceRoot = getWorkspaceRoot();

  if (method === "thread/start") {
    if (!next.model) next.model = config.defaultModel;
    if (!next.cwd) next.cwd = workspaceRoot;
    if (!next.approvalPolicy) next.approvalPolicy = config.defaultApprovalPolicy;
    else next.approvalPolicy = normalizeApprovalPolicy(next.approvalPolicy);
    if (!next.sandbox) next.sandbox = normalizeThreadSandbox(config.defaultSandboxType);
    else next.sandbox = normalizeThreadSandbox(next.sandbox);
  }

  if (method === "turn/start") {
    if (!next.cwd) next.cwd = workspaceRoot;
    if (!next.approvalPolicy) next.approvalPolicy = config.defaultApprovalPolicy;
    else next.approvalPolicy = normalizeApprovalPolicy(next.approvalPolicy);
    if (!next.sandboxPolicy) {
      next.sandboxPolicy = {
        type: normalizeTurnSandboxType(config.defaultSandboxType),
        writableRoots: [workspaceRoot],
        networkAccess: config.defaultNetworkAccess,
      };
    } else if (isObject(next.sandboxPolicy)) {
      next.sandboxPolicy = {
        ...next.sandboxPolicy,
        type: normalizeTurnSandboxType((next.sandboxPolicy as Record<string, unknown>).type),
      };
    }
  }

  if (method === "command/exec") {
    if (!next.cwd) next.cwd = workspaceRoot;
  }

  if (method === "account/login/start") {
    next.type = "chatgpt";
  }

  return next;
}

function normalizePathLike(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function isPathWithinWorkspace(candidate: string): boolean {
  const workspace = getWorkspaceRoot();
  const target = path.resolve(candidate);
  return target === workspace || target.startsWith(`${workspace}${path.sep}`);
}

function collectWorkspacePaths(params: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  for (const key of ["path", "source", "sourcePath", "from", "destination", "to", "targetPath", "cwd"]) {
    const normalized = normalizePathLike(params[key]);
    if (normalized) candidates.push(normalized);
  }
  return Array.from(new Set(candidates));
}

function getCapabilities(): BootstrapCapabilities {
  return {
    methods: getCapabilityDescriptors(config.groupEnabled),
    groups: config.groupEnabled,
  };
}

function guardRequirement(policy: MethodPolicy, reason: string, expiresInMs?: number): GuardRequirement {
  return {
    required: true,
    tier: policy.riskTier,
    group: policy.group,
    reason,
    allowAcceptForSession: true,
    requiresReauthPassword: policy.riskTier >= 3,
    ...(typeof expiresInMs === "number" ? { expiresInMs } : {}),
  };
}

function enforceGuards(input: {
  policy: MethodPolicy;
  method: AllowedRpcMethod;
  params: Record<string, unknown>;
  sessionToken: string;
  guard?: {
    acceptRisk?: boolean;
    acceptForSession?: boolean;
    reauthPassword?: string;
  };
}): { ok: true; expiresAt: number | null } | { ok: false; guard: GuardRequirement; status: number } {
  const { policy, params, sessionToken, guard } = input;

  if (!config.groupEnabled[policy.group]) {
    return {
      ok: false,
      status: 403,
      guard: guardRequirement(policy, `Method group disabled: ${policy.group}`),
    };
  }

  if (policy.group === "filesystem") {
    const touchedPaths = collectWorkspacePaths(params);
    const outside = touchedPaths.find((entry) => !isPathWithinWorkspace(entry));
    if (outside) {
      return {
        ok: false,
        status: 403,
        guard: guardRequirement(policy, `Path is outside selected workspace root: ${outside}`),
      };
    }
  }

  if (policy.riskTier <= 1) {
    return { ok: true, expiresAt: null };
  }

  if (sessionStore.hasActiveRiskAcceptance(sessionToken, policy.group)) {
    const expiresAt = sessionStore.getRiskAcceptanceExpiry(sessionToken, policy.group);
    return { ok: true, expiresAt };
  }

  if (!guard?.acceptRisk) {
    return {
      ok: false,
      status: 409,
      guard: guardRequirement(policy, `Risk acknowledgement required for ${policy.group} operations`, config.riskAcceptTtlMs),
    };
  }

  if (policy.riskTier >= 3) {
    const password = guard.reauthPassword || "";
    if (!sessionStore.verifyPassword(password)) {
      return {
        ok: false,
        status: 401,
        guard: guardRequirement(policy, "Password re-authentication required", config.riskAcceptTtlMs),
      };
    }
  }

  if (guard.acceptForSession) {
    const expiresAt = sessionStore.grantRiskAcceptance(sessionToken, policy.group, config.riskAcceptTtlMs);
    return { ok: true, expiresAt };
  }

  return { ok: true, expiresAt: null };
}

async function bootstrapData(): Promise<Record<string, unknown>> {
  const requests = {
    account: bridge.request("account/read", { refreshToken: false }),
    rateLimits: bridge.request("account/rateLimits/read", {}),
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
    loadedThreads: bridge.request("thread/loaded/list", {}),
    models: bridge.request("model/list", {
      limit: 20,
      includeHidden: false,
    }),
    mcpServers: bridge.request("mcpServerStatus/list", {
      cursor: null,
      limit: 100,
      detail: "toolsAndAuthOnly",
    }),
    featureFlags: bridge.request("experimentalFeature/list", {
      limit: 100,
    }),
    collaborationModes: bridge.request("collaborationMode/list", {}),
  };

  const settled = await Promise.allSettled(Object.values(requests));
  const keys = Object.keys(requests);
  const result: Record<string, unknown> = {
    uiState: uiStateStore.read(),
    capabilities: getCapabilities(),
  };

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
  if (
    message.method.startsWith("turn/") ||
    message.method.startsWith("item/") ||
    message.method === "serverRequest/resolved"
  ) {
    debugLog("bridge.notification", {
      method: message.method,
      threadId: message.params.threadId ?? null,
      turnId: message.params.turnId ?? null,
      itemId: message.params.itemId ?? null,
    });
  }
  broadcast({ kind: "notification", ...message, at: Date.now() });
});

bridge.on("serverRequest", (request: BridgeServerRequestEvent) => {
  debugLog("bridge.serverRequest", {
    id: request.id,
    method: request.method,
    threadId: request.params.threadId ?? null,
    turnId: request.params.turnId ?? null,
    itemId: request.params.itemId ?? null,
  });
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

  auditLogger.log("bridge.status", status);
  broadcast({ kind: "bridgeStatus", ...status, at: Date.now() });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    bridgeState,
  });
});

app.get("/api/session", (req, res) => {
  const token = extractSessionToken(req);
  const authenticated = sessionStore.isValidSession(token);
  res.json({
    ok: true,
    result: {
      authenticated,
    },
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
    auditLogger.log("auth.login.rate_limited", { ip });
    res.status(429).json({
      ok: false,
      error: { message: "Too many login attempts. Please wait and retry." },
    });
    return;
  }

  sessionStore.trackLoginAttempt(ip);

  if (!sessionStore.verifyPassword(parsed.data.password)) {
    auditLogger.log("auth.login.failed", { ip });
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

  auditLogger.log("auth.login.success", { ip });
  res.json({ ok: true, sessionToken: token });
});

app.post("/api/logout", requireAuth, (req, res) => {
  sessionStore.deleteSession(req.sessionToken || null);
  res.clearCookie("session_token");
  auditLogger.log("auth.logout", { ip: clientIp(req) });
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
  debugLog("sse.connected", {
    clientId: client.id,
    totalClients: sseClients.size,
    ip: clientIp(req),
  });
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
    debugLog("sse.disconnected", {
      clientId: client.id,
      totalClients: sseClients.size,
      ip: clientIp(req),
    });
  });
});

app.use("/api", requireAuth);

app.get("/api/capabilities", (_req, res) => {
  res.json({
    ok: true,
    result: getCapabilities(),
  });
});

app.get("/api/ui-state", (_req, res) => {
  res.json({
    ok: true,
    result: uiStateStore.read(),
  });
});

app.post("/api/ui-state", (req, res) => {
  const parsed = uiStatePatchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: { message: "Invalid ui-state payload" },
    });
    return;
  }

  const next = uiStateStore.patch(parsed.data as Partial<PersistedUiState>);
  res.json({
    ok: true,
    result: next,
  });
});

app.get("/api/workspace", (_req, res) => {
  res.json({
    ok: true,
    result: {
      root: getWorkspaceRoot(),
    },
  });
});

app.post("/api/workspace", (req, res) => {
  const parsed = workspaceSelectSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: { message: "Invalid workspace payload" },
    });
    return;
  }

  const root = path.resolve(parsed.data.root.trim());
  if (!path.isAbsolute(root)) {
    res.status(400).json({
      ok: false,
      error: { message: "Workspace root must be an absolute path" },
    });
    return;
  }

  if (!fs.existsSync(root)) {
    res.status(400).json({
      ok: false,
      error: { message: `Workspace path does not exist: ${root}` },
    });
    return;
  }

  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) {
      res.status(400).json({
        ok: false,
        error: { message: `Workspace path is not a directory: ${root}` },
      });
      return;
    }
  } catch {
    res.status(400).json({
      ok: false,
      error: { message: `Workspace path is not accessible: ${root}` },
    });
    return;
  }

  selectedWorkspaceRoot = root;
  auditLogger.log("workspace.updated", {
    root,
    ip: clientIp(req),
  });

  res.json({
    ok: true,
    result: {
      root,
    },
  });
});

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const data = await bootstrapData();
    const workspaceRoot = getWorkspaceRoot();
    res.json({
      ok: true,
      bridgeState,
      defaults: {
        cwd: workspaceRoot,
        model: config.defaultModel,
        approvalPolicy: config.defaultApprovalPolicy,
        sandboxType: config.defaultSandboxType,
      },
      data,
    });
  } catch (error) {
    auditLogger.log("bootstrap.error", { error: sanitizeError(error) });
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
      error: { message: `Method is not allowed: ${method}` },
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

  const sessionToken = req.sessionToken;
  if (!sessionToken) {
    res.status(401).json({
      ok: false,
      error: { message: "Unauthorized" },
    });
    return;
  }

  const policy = getMethodPolicy(method);
  const guardResult = enforceGuards({
    policy,
    method,
    params: parsed.data.params,
    sessionToken,
    guard: parsed.data.guard,
  });

  if (!guardResult.ok) {
    auditLogger.log("rpc.guard_required", {
      method,
      group: policy.group,
      tier: policy.riskTier,
      reason: guardResult.guard.reason,
      ip: clientIp(req),
    });
    res.status(guardResult.status).json({
      ok: false,
      error: { message: guardResult.guard.reason, code: guardResult.status },
      guard: guardResult.guard,
    });
    return;
  }

  try {
    const params = applyRpcDefaults(method, parsed.data.params);
    debugLog("rpc.request", {
      method,
      hasGuard: Boolean(parsed.data.guard),
      threadId: typeof params.threadId === "string" ? params.threadId : null,
    });

    if (method === "turn/start") {
      debugLog("rpc.turn.start.request", {
        threadId: params.threadId ?? null,
        inputCount: Array.isArray(params.input) ? params.input.length : 0,
      });
    }

    if (policy.riskTier >= 2) {
      auditLogger.log("rpc.risky", {
        method,
        group: policy.group,
        tier: policy.riskTier,
        sessionAcceptedUntil: guardResult.expiresAt,
      });
    }

    let result: unknown;

    if (method === "turn/start" && typeof params.threadId === "string") {
      try {
        result = await bridge.request(method, params);
      } catch (error) {
        if (!isThreadNotFoundError(error)) {
          throw error;
        }

        await bridge.request("thread/resume", { threadId: params.threadId });
        result = await bridge.request(method, params);
      }
    } else {
      result = await bridge.request(method, params);
    }

    if (method === "turn/start") {
      const response = result as Record<string, unknown>;
      const turn = isObject(response.turn) ? response.turn : null;
      debugLog("rpc.turn.start.response", {
        threadId: params.threadId ?? null,
        turnId: turn ? turn.id ?? null : null,
        status: turn ? turn.status ?? null : null,
      });
    }

    res.json({ ok: true, result });
  } catch (error) {
    auditLogger.log("rpc.error", {
      method,
      group: policy.group,
      tier: policy.riskTier,
      error: sanitizeError(error),
    });

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

    auditLogger.log("server_request.responded", {
      requestId: parsed.data.requestId,
      hasError: Boolean(parsed.data.error),
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
    version: "0.3.0",
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
