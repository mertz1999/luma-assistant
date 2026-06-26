import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = findWorkspaceRoot(process.cwd()) || findWorkspaceRoot(packageDir) || path.resolve(packageDir, "..", "..");
dotenv.config({ path: path.join(rootDir, ".env") });

const MCP_NAME = process.env.IMAGE_MCP_NAME || "luma-images";
const MCP_PORT = Number(process.env.IMAGE_MCP_PORT || 9015);
const MCP_HOST = process.env.IMAGE_MCP_HOST || "127.0.0.1";
const API_PORT = process.env.API_PORT || "9001";
const LUMA_API_BASE = normalizeBaseUrl(process.env.LUMA_IMAGE_API_BASE || `http://127.0.0.1:${API_PORT}`);
const LUMA_PASSWORD = process.env.LUMA_IMAGE_PASSWORD || process.env.PASSWORD || process.env.APP_PASSWORD || "";
const MAX_BYTES = Number(process.env.IMAGE_MCP_MAX_BYTES || 3 * 1024 * 1024);
const MAX_HEIGHT = Number(process.env.IMAGE_MCP_MAX_HEIGHT || 1200);
const FETCH_TIMEOUT_MS = Number(process.env.IMAGE_MCP_FETCH_TIMEOUT_MS || 12000);

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: { message: string } };
type TokenState = { token: string; expiresAt: number };
type PublishResult = {
  sessionId: string;
  attachment: {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
  };
};

let tokenState: TokenState | null = null;

function findWorkspaceRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return current;
      } catch {
        // Keep walking.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function nowPlus(seconds: number): number {
  return Date.now() + seconds * 1000;
}

async function readApiPayload<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(text.slice(0, 500) || `HTTP ${response.status}`);
    }
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: { message?: string } }).error?.message || `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  const apiPayload = payload as ApiResponse<T>;
  if (!apiPayload?.ok) throw new Error(apiPayload?.error?.message || "Luma API request failed.");
  return apiPayload.data;
}

async function apiRequest<T>(pathName: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (auth) headers.set("Authorization", `Bearer ${await getToken()}`);
  const response = await fetch(`${LUMA_API_BASE}${pathName}`, { ...init, headers });
  return readApiPayload<T>(response);
}

async function getToken(): Promise<string> {
  if (tokenState && tokenState.expiresAt > nowPlus(30)) return tokenState.token;
  if (!LUMA_PASSWORD.trim()) throw new Error("Set LUMA_IMAGE_PASSWORD or PASSWORD for Image MCP authentication.");
  const login = await apiRequest<{ token: string; expiresAt: number }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ password: LUMA_PASSWORD }) },
    false,
  );
  tokenState = { token: login.token, expiresAt: login.expiresAt };
  return login.token;
}

function sanitizeFileName(input: string): string {
  const base = path.basename(input || "").trim();
  return base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || "image";
}

function imageMimeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function imageDimensionsFromBuffer(buffer: Buffer): { width: number; height: number } | null {
  const mime = imageMimeFromBuffer(buffer);
  if (mime === "image/png" && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (mime === "image/gif" && buffer.length >= 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      if (
        (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  if (mime === "image/webp" && buffer.length >= 30) {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function validateImage(buffer: Buffer): { mimeType: string; width: number; height: number } {
  if (buffer.byteLength > MAX_BYTES) throw new Error(`Image is too large. Maximum size is ${MAX_BYTES} bytes.`);
  const mimeType = imageMimeFromBuffer(buffer);
  if (!mimeType) throw new Error("Unsupported image type. Use PNG, JPEG, WebP, or GIF.");
  const dimensions = imageDimensionsFromBuffer(buffer);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw new Error("Could not read image dimensions.");
  if (dimensions.height > MAX_HEIGHT) throw new Error(`Image is too tall. Maximum height is ${MAX_HEIGHT}px.`);
  return { mimeType, ...dimensions };
}

function isPrivateIp(address: string): boolean {
  if (address === "localhost") return true;
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  return false;
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) image URLs are supported.");
  if (isPrivateIp(url.hostname.toLowerCase())) throw new Error("Private, localhost, and link-local image URLs are blocked.");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.some((entry) => isPrivateIp(entry.address))) throw new Error("Private, localhost, and link-local image URLs are blocked.");
}

async function fetchPublicImageUrl(initialUrl: URL): Promise<Buffer> {
  let url = initialUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await assertPublicHttpUrl(url);
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Image URL returned HTTP ${response.status} without a redirect location.`);
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`Image URL returned HTTP ${response.status}.`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().startsWith("image/")) throw new Error("URL did not return an image content type.");
      const contentLength = Number(response.headers.get("content-length") || "0");
      if (contentLength > MAX_BYTES) throw new Error(`Image is too large. Maximum size is ${MAX_BYTES} bytes.`);
      return Buffer.from(await response.arrayBuffer());
    }
    throw new Error("Image URL redirected too many times.");
  } finally {
    clearTimeout(timer);
  }
}

async function readSource(source: string, cwd?: string): Promise<{ buffer: Buffer; name: string; sourceType: "file" | "url" }> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("source is required.");
  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }
  if (url) {
    const buffer = await fetchPublicImageUrl(url);
    return { buffer, name: sanitizeFileName(path.basename(url.pathname) || "image"), sourceType: "url" };
  }

  const base = cwd?.trim() ? path.resolve(cwd) : rootDir;
  const absolutePath = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(base, trimmed);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`Path is not a file: ${absolutePath}`);
  if (stat.size > MAX_BYTES) throw new Error(`Image is too large. Maximum size is ${MAX_BYTES} bytes.`);
  return { buffer: fs.readFileSync(absolutePath), name: sanitizeFileName(path.basename(absolutePath)), sourceType: "file" };
}

async function showImage(input: { session_id: string; source: string; caption?: string; alt?: string; cwd?: string }) {
  const sessionId = input.session_id.trim();
  if (!sessionId) throw new Error("session_id is required.");
  const { buffer, name, sourceType } = await readSource(input.source, input.cwd);
  const metadata = validateImage(buffer);
  const result = await apiRequest<PublishResult>("/api/session-images", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      name,
      mimeType: metadata.mimeType,
      dataBase64: buffer.toString("base64"),
      caption: input.caption || "",
      alt: input.alt || "",
    }),
  });
  return {
    ok: true,
    sourceType,
    sessionId: result.sessionId,
    attachment: result.attachment,
  };
}

function toolSuccess<T extends Record<string, unknown>>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function toolFailure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: MCP_NAME, version: "0.1.0" },
    {
      instructions:
        "Use show_image when the user asks to see an image or when you create an image file that should appear inside the current Luma chat. Always pass the session_id provided in the Luma image render context.",
    },
  );

  server.registerTool(
    "show_image",
    {
      title: "Show Image In Luma Chat",
      description: "Validate a local image path or HTTP(S) image URL, then render it inline in the target Luma Assistant session.",
      inputSchema: {
        session_id: z.string().min(1).describe("The current Luma session id from the prompt context."),
        source: z.string().min(1).describe("Absolute/relative local image path or HTTP(S) image URL."),
        caption: z.string().max(4000).optional().describe("Optional caption/message text to show with the image."),
        alt: z.string().max(500).optional().describe("Optional accessibility alt text for the image."),
        cwd: z.string().optional().describe("Base directory for resolving relative local paths. Defaults to the repo root."),
      },
    },
    async (args) => {
      try {
        return toolSuccess(await showImage(args));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}

const app = createMcpExpressApp({ host: MCP_HOST });

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: MCP_NAME,
    port: MCP_PORT,
    mcpUrl: `http://127.0.0.1:${MCP_PORT}/mcp`,
    apiBase: LUMA_API_BASE,
    maxBytes: MAX_BYTES,
    maxHeight: MAX_HEIGHT,
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
    console.error("[image-mcp] request failed", error);
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
  res.status(405).json({ error: "Use POST /mcp for MCP Streamable HTTP requests." });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Stateless MCP transport does not keep sessions." });
});

app.listen(MCP_PORT, MCP_HOST, (error?: Error) => {
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[image-mcp] failed to start", error);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[image-mcp] listening on http://${MCP_HOST}:${MCP_PORT}/mcp`);
});
