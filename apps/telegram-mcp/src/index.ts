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
const TELEGRAM_MAX_TEXT_READ_BYTES = Number(process.env.TELEGRAM_MAX_TEXT_READ_BYTES || 256 * 1024);
const TELEGRAM_RECEIVE_MAX_PAGES = Number(process.env.TELEGRAM_RECEIVE_MAX_PAGES || 100);
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

type TelegramDocument = {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramInboundMessage = {
  message_id: number;
  date: number;
  message_thread_id?: number;
  chat: {
    id: number | string;
    title?: string;
    type?: string;
  };
  from?: TelegramUser;
  caption?: string;
  document?: TelegramDocument;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramInboundMessage;
  channel_post?: TelegramInboundMessage;
};

type TelegramFile = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
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

type InboundFileCandidate = {
  update_id: number;
  message_id: number;
  chat_id: string;
  message_thread_id: string | null;
  sent_at: string;
  sender_id: string | null;
  sender_username: string | null;
  caption: string | null;
  file_id: string;
  file_unique_id: string | null;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
};

type SavedInboundFile = InboundFileCandidate & {
  saved_path: string;
  saved_at: string;
};

type TelegramReceiveState = {
  version: 1;
  next_update_offset?: number;
  last_candidates: Record<string, InboundFileCandidate>;
  last_saved_files: Record<string, SavedInboundFile>;
};

type GetLastUploadedFileResult = SavedInboundFile & {
  ok: true;
  from_cache: boolean;
  is_text: boolean;
  text_content: string | null;
  text_content_bytes: number;
  text_content_truncated: boolean;
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
const telegramDownloadDir = path.resolve(expandHome(
  process.env.TELEGRAM_DOWNLOAD_DIR || path.join(allowedRoots[0] || rootDir, ".luma", "telegram-uploads"),
));
const telegramReceiveStatePath = path.resolve(expandHome(
  process.env.TELEGRAM_RECEIVE_STATE_PATH || path.join(rootDir, "data", "telegram-mcp", "receive-state.json"),
));
let receiveFileLock: Promise<void> = Promise.resolve();

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

async function withReceiveFileLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = receiveFileLock;
  let release = () => {};
  receiveFileLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function emptyReceiveState(): TelegramReceiveState {
  return {
    version: 1,
    last_candidates: {},
    last_saved_files: {},
  };
}

async function readReceiveState(): Promise<TelegramReceiveState> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(telegramReceiveStatePath, "utf8")) as Partial<TelegramReceiveState>;
    if (parsed.version !== 1) return emptyReceiveState();
    return {
      version: 1,
      next_update_offset: Number.isSafeInteger(parsed.next_update_offset) ? parsed.next_update_offset : undefined,
      last_candidates: parsed.last_candidates && typeof parsed.last_candidates === "object" ? parsed.last_candidates : {},
      last_saved_files: parsed.last_saved_files && typeof parsed.last_saved_files === "object" ? parsed.last_saved_files : {},
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return emptyReceiveState();
    throw error;
  }
}

async function writeReceiveState(state: TelegramReceiveState): Promise<void> {
  const stateDir = path.dirname(telegramReceiveStatePath);
  await fs.promises.mkdir(stateDir, { recursive: true });
  const temporaryPath = `${telegramReceiveStatePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(temporaryPath, telegramReceiveStatePath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
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

async function resolveSafeDownloadDirectory(directory?: string, cwd?: string): Promise<string> {
  const base = cwd ? path.resolve(expandHome(cwd)) : rootDir;
  const requested = directory?.trim() || telegramDownloadDir;
  const absolutePath = path.isAbsolute(requested)
    ? path.resolve(expandHome(requested))
    : path.resolve(base, expandHome(requested));

  ensureInsideAllowedRoots(absolutePath);
  await fs.promises.mkdir(absolutePath, { recursive: true });
  const realPath = await fs.promises.realpath(absolutePath);
  ensureInsideAllowedRoots(realPath);
  return realPath;
}

function sanitizeDownloadedFileName(name: string): string {
  const baseName = path.basename(name).normalize("NFKC");
  const safeName = baseName
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[^\p{L}\p{N}._()\[\] -]+/gu, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return safeName || "telegram-file";
}

function receiveStateKey(chatId: string, threadId: string | null): string {
  return JSON.stringify([chatId, threadId ?? "*"]);
}

function resolveReceiveThreadId(input?: string | number | null): string | null {
  if (input === null) return null;
  return resolveThreadId(input);
}

function inboundMessageFromUpdate(update: TelegramUpdate): TelegramInboundMessage | undefined {
  return update.message || update.channel_post;
}

function candidateFromUpdate(update: TelegramUpdate): InboundFileCandidate | null {
  const message = inboundMessageFromUpdate(update);
  const document = message?.document;
  if (!message || !document?.file_id || message.from?.is_bot) return null;

  return {
    update_id: update.update_id,
    message_id: message.message_id,
    chat_id: String(message.chat.id),
    message_thread_id: message.message_thread_id === undefined ? null : String(message.message_thread_id),
    sent_at: new Date(message.date * 1000).toISOString(),
    sender_id: message.from ? String(message.from.id) : null,
    sender_username: message.from?.username || null,
    caption: message.caption?.trim() || null,
    file_id: document.file_id,
    file_unique_id: document.file_unique_id || null,
    file_name: sanitizeDownloadedFileName(document.file_name || `telegram-file-${message.message_id}`),
    mime_type: document.mime_type || null,
    file_size: Number.isSafeInteger(document.file_size) ? document.file_size ?? null : null,
  };
}

function rememberCandidate(state: TelegramReceiveState, candidate: InboundFileCandidate): void {
  const keys = [
    receiveStateKey(candidate.chat_id, candidate.message_thread_id),
    receiveStateKey(candidate.chat_id, null),
  ];
  for (const key of keys) {
    const existing = state.last_candidates[key];
    if (!existing || candidate.update_id > existing.update_id) {
      state.last_candidates[key] = candidate;
    }
  }
}

async function pollTelegramFileUpdates(state: TelegramReceiveState): Promise<void> {
  let offset = state.next_update_offset ?? -100;
  const maxPages = Number.isSafeInteger(TELEGRAM_RECEIVE_MAX_PAGES) && TELEGRAM_RECEIVE_MAX_PAGES > 0
    ? TELEGRAM_RECEIVE_MAX_PAGES
    : 100;

  for (let page = 0; page < maxPages; page += 1) {
    const body = new URLSearchParams({
      offset: String(offset),
      limit: "100",
      timeout: "0",
    });
    const updates = await callTelegram<TelegramUpdate[]>("getUpdates", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (updates.length === 0) return;
    for (const update of updates) {
      const candidate = candidateFromUpdate(update);
      if (candidate) rememberCandidate(state, candidate);
    }

    const highestUpdateId = Math.max(...updates.map((update) => update.update_id));
    state.next_update_offset = highestUpdateId + 1;
    await writeReceiveState(state);
    offset = state.next_update_offset;
    if (updates.length < 100) return;
  }

  throw new Error(
    `Telegram has more than ${maxPages * 100} pending updates. Run get_last_uploaded_file again to continue scanning safely.`,
  );
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

async function downloadTelegramFile(candidate: InboundFileCandidate, destinationDirectory: string): Promise<SavedInboundFile> {
  if (candidate.file_size !== null && candidate.file_size > TELEGRAM_MAX_FILE_BYTES) {
    throw new Error(
      `Telegram file is too large for the configured download policy: ${candidate.file_size} bytes > ${TELEGRAM_MAX_FILE_BYTES} bytes`,
    );
  }

  const body = new URLSearchParams({ file_id: candidate.file_id });
  const telegramFile = await callTelegram<TelegramFile>("getFile", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!telegramFile.file_path) throw new Error("Telegram getFile did not return a downloadable file path.");
  if (telegramFile.file_size !== undefined && telegramFile.file_size > TELEGRAM_MAX_FILE_BYTES) {
    throw new Error(
      `Telegram file is too large for the configured download policy: ${telegramFile.file_size} bytes > ${TELEGRAM_MAX_FILE_BYTES} bytes`,
    );
  }

  const stableName = `${candidate.update_id}_${candidate.message_id}_${candidate.file_name}`;
  const destinationPath = path.join(destinationDirectory, stableName);
  ensureInsideAllowedRoots(destinationPath);

  const existingStat = await fs.promises.stat(destinationPath).catch(() => null);
  const expectedSize = telegramFile.file_size ?? candidate.file_size;
  if (existingStat?.isFile() && (expectedSize === null || existingStat.size === expectedSize)) {
    return {
      ...candidate,
      file_size: existingStat.size,
      saved_path: destinationPath,
      saved_at: existingStat.mtime.toISOString(),
    };
  }

  const token = requireTelegramToken();
  const sourceUrl = `${TELEGRAM_API_BASE}/file/bot${token}/${telegramFile.file_path}`;
  const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    let response: Response | null = null;
    try {
      response = await fetch(sourceUrl);
    } catch (error) {
      try {
        await execFileAsync("curl", [
          "-fLsS",
          "--connect-timeout", "10",
          "--max-time", "120",
          "--max-filesize", String(TELEGRAM_MAX_FILE_BYTES),
          "--output", temporaryPath,
          sourceUrl,
        ], { timeout: 125_000, maxBuffer: 1024 * 1024 });
      } catch (curlError) {
        throw new Error(
          `Telegram file download failed: ${formatErrorMessage(error)}; curl fallback: ${formatErrorMessage(curlError)}`,
        );
      }
    }

    if (response) {
      if (!response.ok) throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
      const contentLength = Number(response.headers.get("content-length") || "0");
      if (contentLength > TELEGRAM_MAX_FILE_BYTES) {
        throw new Error(
          `Telegram file is too large for the configured download policy: ${contentLength} bytes > ${TELEGRAM_MAX_FILE_BYTES} bytes`,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > TELEGRAM_MAX_FILE_BYTES) {
        throw new Error(
          `Telegram file is too large for the configured download policy: ${bytes.length} bytes > ${TELEGRAM_MAX_FILE_BYTES} bytes`,
        );
      }
      await fs.promises.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    }

    const stat = await fs.promises.stat(temporaryPath);
    if (!stat.isFile() || stat.size > TELEGRAM_MAX_FILE_BYTES) {
      throw new Error(`Downloaded Telegram file failed the local file-size policy (${stat.size} bytes).`);
    }
    await fs.promises.rename(temporaryPath, destinationPath);
    return {
      ...candidate,
      file_size: stat.size,
      saved_path: destinationPath,
      saved_at: new Date().toISOString(),
    };
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}

const readableTextExtensions = new Set([
  ".txt", ".md", ".mdx", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml",
  ".html", ".htm", ".css", ".scss", ".less", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".py", ".rb", ".php", ".java", ".kt", ".kts", ".go", ".rs", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".swift", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".sql", ".graphql", ".gql", ".toml",
  ".ini", ".conf", ".cfg", ".env", ".log", ".tex", ".rst",
]);

function isReadableTextFile(fileName: string, mimeType: string | null): boolean {
  const normalizedMime = mimeType?.toLowerCase().split(";", 1)[0]?.trim() || "";
  if (normalizedMime.startsWith("text/")) return true;
  if ([
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/x-yaml",
    "application/yaml",
    "application/sql",
  ].includes(normalizedMime)) return true;
  return readableTextExtensions.has(path.extname(fileName).toLowerCase());
}

async function readDownloadedText(
  savedFile: SavedInboundFile,
  includeText: boolean,
  requestedMaxBytes?: number,
): Promise<Pick<GetLastUploadedFileResult, "is_text" | "text_content" | "text_content_bytes" | "text_content_truncated">> {
  const isText = isReadableTextFile(savedFile.file_name, savedFile.mime_type);
  if (!includeText || !isText) {
    return {
      is_text: isText,
      text_content: null,
      text_content_bytes: 0,
      text_content_truncated: false,
    };
  }

  const configuredLimit = Number.isSafeInteger(TELEGRAM_MAX_TEXT_READ_BYTES) && TELEGRAM_MAX_TEXT_READ_BYTES > 0
    ? TELEGRAM_MAX_TEXT_READ_BYTES
    : 256 * 1024;
  const limit = requestedMaxBytes === undefined ? configuredLimit : Math.min(requestedMaxBytes, configuredLimit);
  const stat = await fs.promises.stat(savedFile.saved_path);
  const bytesToRead = Math.min(stat.size, limit);
  const handle = await fs.promises.open(savedFile.saved_path, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
    return {
      is_text: true,
      text_content: content,
      text_content_bytes: bytesRead,
      text_content_truncated: stat.size > bytesRead,
    };
  } finally {
    await handle.close();
  }
}

async function getLastUploadedFile(args: {
  chat_id?: string | number;
  message_thread_id?: string | number | null;
  save_dir?: string;
  cwd?: string;
  include_text?: boolean;
  max_text_bytes?: number;
}): Promise<GetLastUploadedFileResult> {
  return withReceiveFileLock(async () => {
    const chatId = resolveChatId(args.chat_id);
    const threadId = resolveReceiveThreadId(args.message_thread_id);
    const stateKey = receiveStateKey(chatId, threadId);
    const state = await readReceiveState();
    await pollTelegramFileUpdates(state);

    const candidate = state.last_candidates[stateKey];
    if (!candidate) {
      const location = threadId ? `chat ${chatId}, topic ${threadId}` : `chat ${chatId}`;
      throw new Error(
        `No uploaded Telegram document was found for ${location}. Upload a document, then try again.`,
      );
    }

    const destinationDirectory = await resolveSafeDownloadDirectory(args.save_dir, args.cwd);
    const cached = state.last_saved_files[stateKey];
    const cachedStat = cached && cached.update_id === candidate.update_id
      ? await fs.promises.stat(cached.saved_path).catch(() => null)
      : null;
    const requestedDestination = path.join(
      destinationDirectory,
      `${candidate.update_id}_${candidate.message_id}_${candidate.file_name}`,
    );
    const useCached = Boolean(cachedStat?.isFile() && cached?.saved_path === requestedDestination);
    const savedFile = useCached && cached ? cached : await downloadTelegramFile(candidate, destinationDirectory);

    state.last_saved_files[stateKey] = savedFile;
    await writeReceiveState(state);
    const textResult = await readDownloadedText(savedFile, args.include_text !== false, args.max_text_bytes);
    return {
      ok: true,
      ...savedFile,
      from_cache: useCached,
      ...textResult,
    };
  });
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
        "Use send_file to upload a local generated file, send_message to post text, and get_last_uploaded_file when the user asks for the latest document uploaded to the configured Telegram chat/topic. The receive tool saves the document locally and includes supported text-file content. Never ask for or expose TELEGRAM_BOT_TOKEN.",
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

  server.registerTool(
    "get_last_uploaded_file",
    {
      title: "Get Last Uploaded Telegram File",
      description:
        "Find the latest document uploaded by a user in the configured Telegram chat/topic, save it locally, and optionally return readable text content. Reuses the saved copy when there is no newer upload.",
      inputSchema: {
        chat_id: z.union([z.string(), z.number()]).optional().describe("Telegram chat id. Defaults to TELEGRAM_CHAT_ID."),
        message_thread_id: z.union([z.string(), z.number()]).nullable().optional().describe(
          "Telegram topic/thread id. Defaults to TELEGRAM_MESSAGE_FILE_THREAD_ID. Pass null to search all topics in the chat.",
        ),
        save_dir: z.string().optional().describe(
          "Directory where the document should be saved. Defaults to TELEGRAM_DOWNLOAD_DIR or .luma/telegram-uploads under the first allowed root.",
        ),
        cwd: z.string().optional().describe(
          "Base directory for a relative save_dir. The resolved directory must remain under TELEGRAM_ALLOWED_ROOTS.",
        ),
        include_text: z.boolean().optional().describe(
          "Include UTF-8 content for recognized text/code files. Defaults to true; binary files are still saved and return a path.",
        ),
        max_text_bytes: z.number().int().positive().optional().describe(
          "Maximum leading text bytes to return, capped by TELEGRAM_MAX_TEXT_READ_BYTES (default 262144).",
        ),
      },
    },
    async (args) => {
      try {
        return toolSuccess({ ...(await getLastUploadedFile(args)) });
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
