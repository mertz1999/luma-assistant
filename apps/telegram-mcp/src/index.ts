import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const execFileAsync = promisify(execFile);

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = findWorkspaceRoot(process.cwd()) || findWorkspaceRoot(packageDir) || path.resolve(packageDir, "..", "..");
dotenv.config({ path: path.join(rootDir, ".env") });

const MCP_NAME = process.env.TELEGRAM_MCP_NAME || "luma-tel";
const MCP_PORT = Number(process.env.TELEGRAM_MCP_PORT || 9013);
const MCP_HOST = process.env.TELEGRAM_MCP_HOST || "127.0.0.1";
const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_FILE_BYTES = Number(process.env.TELEGRAM_MAX_FILE_BYTES || 50 * 1024 * 1024);
const FILE_THREAD_ENV = "TELEGRAM_MESSAGE_FILE_THREAD_ID";
const TEXT_THREAD_ENV = "TELEGRAM_MESSAGE_TEXT_THREAD_ID";
const LEGACY_THREAD_ENV = "TELEGRAM_MESSAGE_THREAD_ID";

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
};

type TelegramSendDocumentResult = {
  message_id: number;
  chat?: {
    id: number | string;
    title?: string;
    type?: string;
  };
  message_thread_id?: number;
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
};

type TelegramSendMessageResult = {
  message_id: number;
  chat?: {
    id: number | string;
    title?: string;
    type?: string;
  };
  message_thread_id?: number;
  text?: string;
};

type SendFileResult = {
  ok: boolean;
  message_id: number;
  chat_id: string;
  message_thread_id: string | null;
  file_path: string;
  file_name: string;
  file_size: number;
};

type SendMessageResult = {
  ok: boolean;
  message_id: number;
  chat_id: string;
  message_thread_id: string | null;
  text: string;
};

type TestConnectionResult = {
  ok: boolean;
  bot_id: number;
  bot_username: string | null;
  chat_id: string;
  message_thread_id: string | null;
};

function findWorkspaceRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return current;
      } catch {
        // Ignore invalid package.json while walking upward.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME || value;
  if (!value.startsWith("~/")) return value;
  return path.join(process.env.HOME || "", value.slice(2));
}

function readConfiguredWorkspaceRoots(): string[] {
  const configPath = path.join(rootDir, "config.yaml");
  if (!fs.existsSync(configPath)) return [];

  const roots: string[] = [];
  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  let inRepos = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("default_workspace:")) {
      const value = line.split(":").slice(1).join(":").trim().replace(/^['"]|['"]$/g, "");
      if (value) roots.push(expandHome(value));
      continue;
    }
    if (line.trim() === "repos:") {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    const match = line.match(/^\s{2}[^:]+:\s*(.+)$/);
    if (match?.[1]) roots.push(expandHome(match[1].trim().replace(/^['"]|['"]$/g, "")));
  }
  return roots;
}

function parseAllowedRoots(): string[] {
  const configured = (process.env.TELEGRAM_ALLOWED_ROOTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(expandHome(item)));
  const roots = configured.length > 0 ? configured : [rootDir, ...readConfiguredWorkspaceRoots()];
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

const allowedRoots = parseAllowedRoots();

function ensureInsideAllowedRoots(candidate: string): void {
  const resolved = path.resolve(candidate);
  const inside = allowedRoots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!inside) {
    throw new Error(`File is outside TELEGRAM_ALLOWED_ROOTS. Allowed roots: ${allowedRoots.join(", ")}`);
  }
}

async function resolveSafeFile(filePath: string, cwd?: string): Promise<{ absolutePath: string; stat: fs.Stats }> {
  const base = cwd ? path.resolve(expandHome(cwd)) : rootDir;
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(expandHome(filePath))
    : path.resolve(base, filePath);

  ensureInsideAllowedRoots(absolutePath);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolutePath);
  } catch {
    throw new Error(`File does not exist: ${absolutePath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${absolutePath}`);
  }
  if (stat.size > TELEGRAM_MAX_FILE_BYTES) {
    throw new Error(`File is too large for Telegram upload policy: ${stat.size} bytes > ${TELEGRAM_MAX_FILE_BYTES} bytes`);
  }
  return { absolutePath, stat };
}

function requireTelegramToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  return token;
}

function resolveChatId(input?: string | number): string {
  const chatId = String(input ?? process.env.TELEGRAM_CHAT_ID ?? "").trim();
  if (!chatId) throw new Error("Telegram chat id is missing. Set TELEGRAM_CHAT_ID or pass chat_id.");
  return chatId;
}

function resolveThreadId(input?: string | number | null, primaryEnv = FILE_THREAD_ENV): string | null {
  const raw = input ?? process.env[primaryEnv] ?? process.env[FILE_THREAD_ENV] ?? process.env[LEGACY_THREAD_ENV] ?? "";
  const value = String(raw).trim();
  return value ? value : null;
}

async function callTelegram<T>(method: string, init: RequestInit = {}): Promise<T> {
  const token = requireTelegramToken();
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, init);
  } catch (error) {
    const curlResult = await callTelegramWithCurl<T>(method, init, token);
    if (curlResult.ok) return curlResult.result;
    if (curlResult.error) {
      throw new Error(curlResult.error);
    }
    throw new Error(`Telegram API ${method} network request failed: ${formatErrorMessage(error)}`);
  }

  let payload: TelegramApiResponse<T>;
  try {
    payload = (await response.json()) as TelegramApiResponse<T>;
  } catch (error) {
    throw new Error(`Telegram API ${method} returned non-JSON response with HTTP ${response.status}: ${formatErrorMessage(error)}`);
  }

  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description || `Telegram API ${method} failed with HTTP ${response.status}`);
  }
  return payload.result;
}

async function callTelegramWithCurl<T>(
  method: string,
  init: RequestInit,
  token: string,
): Promise<{ ok: true; result: T } | { ok: false; error?: string }> {
  const args = ["-sS", "--connect-timeout", "10", "--max-time", "30"];
  const body = init.body;

  if (body instanceof URLSearchParams) {
    args.push("-X", String(init.method || "POST"));
    for (const [key, value] of body.entries()) {
      args.push("--data-urlencode", `${key}=${value}`);
    }
  } else if (body === undefined || body === null) {
    if (init.method && init.method !== "GET") args.push("-X", String(init.method));
  } else {
    return { ok: false };
  }

  args.push(`${TELEGRAM_API_BASE}/bot${token}/${method}`);

  try {
    const { stdout } = await execFileAsync("curl", args, {
      timeout: 35_000,
      maxBuffer: 1024 * 1024,
    });
    const payload = JSON.parse(stdout) as TelegramApiResponse<T>;
    if (!payload.ok || payload.result === undefined) {
      return {
        ok: false,
        error: payload.description || `Telegram API ${method} failed through curl fallback`,
      };
    }
    return { ok: true, result: payload.result };
  } catch {
    return { ok: false };
  }
}

async function testTelegramConnection(chatIdInput?: string | number, threadIdInput?: string | number | null): Promise<TestConnectionResult> {
  const chatId = resolveChatId(chatIdInput);
  const threadId = resolveThreadId(threadIdInput);
  const bot = await callTelegram<TelegramUser>("getMe");

  const body = new URLSearchParams({
    chat_id: chatId,
    action: "upload_document",
  });
  if (threadId) body.set("message_thread_id", threadId);

  await callTelegram<boolean>("sendChatAction", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  return {
    ok: true,
    bot_id: bot.id,
    bot_username: bot.username || null,
    chat_id: chatId,
    message_thread_id: threadId,
  };
}

async function sendTelegramFile(args: {
  path: string;
  cwd?: string;
  caption?: string;
  chat_id?: string | number;
  message_thread_id?: string | number | null;
  disable_notification?: boolean;
}): Promise<SendFileResult> {
  const chatId = resolveChatId(args.chat_id);
  const threadId = resolveThreadId(args.message_thread_id);
  const { absolutePath, stat } = await resolveSafeFile(args.path, args.cwd);
  const fileName = path.basename(absolutePath);
  const fileBytes = await fs.promises.readFile(absolutePath);

  const form = new FormData();
  form.set("chat_id", chatId);
  if (threadId) form.set("message_thread_id", threadId);
  if (args.caption?.trim()) form.set("caption", args.caption.trim().slice(0, 1024));
  if (args.disable_notification !== undefined) form.set("disable_notification", String(Boolean(args.disable_notification)));
  form.set("document", new Blob([fileBytes]), fileName);

  const result = await callTelegram<TelegramSendDocumentResult>("sendDocument", {
    method: "POST",
    body: form,
  });

  return {
    ok: true,
    message_id: result.message_id,
    chat_id: String(result.chat?.id ?? chatId),
    message_thread_id: String(result.message_thread_id ?? threadId ?? "") || null,
    file_path: absolutePath,
    file_name: result.document?.file_name || fileName,
    file_size: result.document?.file_size || stat.size,
  };
}

async function sendTelegramMessage(args: {
  text: string;
  chat_id?: string | number;
  message_thread_id?: string | number | null;
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  disable_notification?: boolean;
}): Promise<SendMessageResult> {
  const text = args.text.trim();
  if (!text) throw new Error("Telegram message text is empty.");

  const chatId = resolveChatId(args.chat_id);
  const threadId = resolveThreadId(args.message_thread_id, TEXT_THREAD_ENV);

  const body = new URLSearchParams({
    chat_id: chatId,
    text: text.slice(0, 4096),
  });
  if (threadId) body.set("message_thread_id", threadId);
  if (args.parse_mode) body.set("parse_mode", args.parse_mode);
  if (args.disable_notification !== undefined) body.set("disable_notification", String(Boolean(args.disable_notification)));

  const result = await callTelegram<TelegramSendMessageResult>("sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  return {
    ok: true,
    message_id: result.message_id,
    chat_id: String(result.chat?.id ?? chatId),
    message_thread_id: String(result.message_thread_id ?? threadId ?? "") || null,
    text: result.text || text.slice(0, 4096),
  };
}

function toolSuccess<T extends Record<string, unknown>>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function toolFailure(error: unknown) {
  const message = formatErrorMessage(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function formatErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts = [error.message || error.name];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    parts.push(`cause: ${cause.message || cause.name}`);
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string" && code) parts.push(`code: ${code}`);
  } else if (typeof cause === "string" && cause) {
    parts.push(`cause: ${cause}`);
  }
  return parts.join("; ");
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: MCP_NAME, version: "0.1.0" },
    {
      instructions:
        "Use send_file to upload a local generated file to the configured Telegram group topic, and send_message to post text. Never ask for or expose TELEGRAM_BOT_TOKEN.",
    },
  );

  server.registerTool(
    "test_connection",
    {
      title: "Test Telegram Connection",
      description: "Verify the Telegram bot token and target chat/thread by sending a chat action without posting a message.",
      inputSchema: {
        chat_id: z.union([z.string(), z.number()]).optional().describe("Telegram chat id. Defaults to TELEGRAM_CHAT_ID."),
        message_thread_id: z.union([z.string(), z.number()]).nullable().optional().describe("Telegram topic/thread id. Defaults to TELEGRAM_MESSAGE_FILE_THREAD_ID."),
      },
    },
    async ({ chat_id, message_thread_id }) => {
      try {
        return toolSuccess({ ...(await testTelegramConnection(chat_id, message_thread_id)) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send Message To Telegram",
      description: "Post a plain text message to the configured Telegram group topic using Telegram sendMessage.",
      inputSchema: {
        text: z.string().min(1).max(4096).describe("Telegram message text. Telegram limits messages to 4096 characters."),
        chat_id: z.union([z.string(), z.number()]).optional().describe("Telegram chat id. Defaults to TELEGRAM_CHAT_ID."),
        message_thread_id: z.union([z.string(), z.number()]).nullable().optional().describe("Telegram topic/thread id. Defaults to TELEGRAM_MESSAGE_TEXT_THREAD_ID, then TELEGRAM_MESSAGE_FILE_THREAD_ID."),
        parse_mode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional().describe("Optional Telegram parse mode."),
        disable_notification: z.boolean().optional().describe("Whether Telegram should send the message silently."),
      },
    },
    async (args) => {
      try {
        return toolSuccess({ ...(await sendTelegramMessage(args)) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "send_file",
    {
      title: "Send File To Telegram",
      description: "Upload a local file to the configured Telegram group topic using Telegram sendDocument.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute file path, or path relative to cwd/the app root."),
        cwd: z.string().optional().describe("Base directory for relative path. The resolved file must remain under TELEGRAM_ALLOWED_ROOTS."),
        caption: z.string().max(1024).optional().describe("Optional Telegram document caption."),
        chat_id: z.union([z.string(), z.number()]).optional().describe("Telegram chat id. Defaults to TELEGRAM_CHAT_ID."),
        message_thread_id: z.union([z.string(), z.number()]).nullable().optional().describe("Telegram topic/thread id. Defaults to TELEGRAM_MESSAGE_FILE_THREAD_ID."),
        disable_notification: z.boolean().optional().describe("Whether Telegram should send the document silently."),
      },
    },
    async (args) => {
      try {
        return toolSuccess({ ...(await sendTelegramFile(args)) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}

const app = createMcpExpressApp({ host: MCP_HOST });

app.get("/health", (_req, res) => {
  const required = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
  ];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (!process.env[FILE_THREAD_ENV]?.trim() && !process.env[LEGACY_THREAD_ENV]?.trim()) {
    missing.push(FILE_THREAD_ENV);
  }

  res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    name: MCP_NAME,
    port: MCP_PORT,
    mcpUrl: `http://127.0.0.1:${MCP_PORT}/mcp`,
    allowedRoots,
    missingEnv: missing,
  });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[telegram-mcp] request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.listen(MCP_PORT, MCP_HOST, (error?: Error) => {
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[telegram-mcp] failed to start", error);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[telegram-mcp] listening on http://${MCP_HOST}:${MCP_PORT}/mcp`);
});
