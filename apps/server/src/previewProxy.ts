import http from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { Express, Request, Response } from "express";

const PREVIEW_AUTH_COOKIE = "luma_assistant_preview_auth";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);
const MAX_REWRITE_BYTES = 5 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);

export type PreviewProxyAuth = {
  enabled: boolean;
  extractToken: (req: Request) => string | null;
  verifyToken: (token: string) => boolean;
};

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host.toLowerCase());
}

function isAllowedPort(portRaw: string): boolean {
  if (!/^\d{1,5}$/.test(portRaw)) return false;
  const port = Number.parseInt(portRaw, 10);
  return port >= 1 && port <= 65535;
}

function requestIsSecure(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0]?.trim().toLowerCase();
  return proto === "https";
}

function stripTokenFromQuery(url: string): string {
  const question = url.indexOf("?");
  if (question < 0) return url;
  const pathPart = url.slice(0, question);
  const params = new URLSearchParams(url.slice(question + 1));
  params.delete("token");
  const query = params.toString();
  return query ? `${pathPart}?${query}` : pathPart;
}

function proxyPrefix(host: string, port: string): string {
  return `/api/preview-proxy/${encodeURIComponent(host)}/${port}`;
}

function rewriteLocation(value: string, host: string, port: string): string {
  try {
    const absolute = new URL(value, `http://${host}:${port}/`);
    const isLoopback = absolute.hostname === "localhost" || absolute.hostname === "127.0.0.1";
    if (!isLoopback) return value;
    const pathWithQuery = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    return `${proxyPrefix(host, port)}${pathWithQuery}`;
  } catch {
    if (value.startsWith("/")) return `${proxyPrefix(host, port)}${value}`;
    return value;
  }
}

function shouldRewriteBody(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return (
    type.includes("text/html")
    || type.includes("text/css")
    || type.includes("javascript")
    || type.includes("json")
    || type.includes("text/plain")
    || type.includes("application/xhtml")
  );
}

function rewriteBody(raw: string, host: string, port: string, contentType: string): string {
  const prefix = proxyPrefix(host, port);
  let next = raw;

  const absolutePatterns = [
    new RegExp(`https?://${host.replace(/\./g, "\\.")}:${port}`, "gi"),
    new RegExp(`https?://127\\.0\\.0\\.1:${port}`, "gi"),
    new RegExp(`https?://localhost:${port}`, "gi"),
  ];
  for (const pattern of absolutePatterns) {
    next = next.replace(pattern, prefix);
  }

  // Root-absolute URLs in HTML/CSS/JS so assets stay inside the proxy.
  next = next.replace(
    /(\b(?:href|src|action|poster|data-src|content)\s*=\s*["'])\/(?!\/|api\/preview-proxy\/)/gi,
    `$1${prefix}/`,
  );
  next = next.replace(
    /(\burl\(\s*['"]?)\/(?!\/|api\/preview-proxy\/)/gi,
    `$1${prefix}/`,
  );
  next = next.replace(
    /(import\s*\(\s*["'])\/(?!\/|api\/preview-proxy\/)/g,
    `$1${prefix}/`,
  );
  next = next.replace(
    /(\bfrom\s+["'])\/(?!\/|api\/preview-proxy\/)/g,
    `$1${prefix}/`,
  );
  next = next.replace(
    /(new\s+URL\(\s*["'])\/(?!\/|api\/preview-proxy\/)/g,
    `$1${prefix}/`,
  );

  if (contentType.toLowerCase().includes("text/html") && !/<base\s/i.test(next)) {
    next = next.replace(
      /<head([^>]*)>/i,
      `<head$1><base href="${prefix}/">`,
    );
  }

  return next;
}

function collectBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("Response too large to rewrite"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function maybeSetPreviewAuthCookie(req: Request, res: Response, auth: PreviewProxyAuth): void {
  if (!auth.enabled) return;
  const queryToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (!queryToken || !auth.verifyToken(queryToken)) return;

  const maxAge = 60 * 60 * 12;
  const secure = requestIsSecure(req) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${PREVIEW_AUTH_COOKIE}=${encodeURIComponent(queryToken)}; Path=/api/preview-proxy; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

export function readPreviewAuthCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== PREVIEW_AUTH_COOKIE) continue;
    const value = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function handlePreviewProxy(req: Request, res: Response, auth: PreviewProxyAuth): void {
  const host = String(req.params.host || "");
  const port = String(req.params.port || "");
  if (!isAllowedHost(host) || !isAllowedPort(port)) {
    res.status(400).json({ ok: false, error: { message: "Preview proxy only allows localhost / 127.0.0.1 ports." } });
    return;
  }

  maybeSetPreviewAuthCookie(req, res, auth);

  const remainder = stripTokenFromQuery(req.url || "/");
  const upstreamPath = remainder.startsWith("/") ? remainder : `/${remainder}`;
  const target = `http://127.0.0.1:${port}${upstreamPath}`;

  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  delete headers["host"];
  delete headers["connection"];
  delete headers["content-length"];
  delete headers["cookie"];
  delete headers["authorization"];
  delete headers["Authorization"];
  headers.host = `127.0.0.1:${port}`;
  headers["x-forwarded-host"] = req.headers.host || headers.host;
  headers["x-forwarded-proto"] = requestIsSecure(req) ? "https" : "http";
  headers["accept-encoding"] = "identity";

  const options: RequestOptions = {
    protocol: "http:",
    hostname: "127.0.0.1",
    port: Number(port),
    method: req.method,
    path: upstreamPath,
    headers,
    timeout: 30000,
  };

  const upstream = http.request(options, (upstreamRes) => {
    const contentType = String(upstreamRes.headers["content-type"] || "");
    const contentLength = Number(upstreamRes.headers["content-length"] || 0);
    const canRewrite = shouldRewriteBody(contentType)
      && (!contentLength || contentLength <= MAX_REWRITE_BYTES);

    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (!value) continue;
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === "location") {
        const locations = Array.isArray(value) ? value : [value];
        res.setHeader(key, locations.map((item) => rewriteLocation(String(item), host, port)));
        continue;
      }
      if (canRewrite && (key.toLowerCase() === "content-length" || key.toLowerCase() === "content-encoding")) {
        continue;
      }
      res.setHeader(key, value);
    }

    res.status(upstreamRes.statusCode || 502);

    if (!canRewrite) {
      upstreamRes.pipe(res);
      return;
    }

    void collectBody(upstreamRes, MAX_REWRITE_BYTES)
      .then((buffer) => {
        const rewritten = rewriteBody(buffer.toString("utf8"), host, port, contentType);
        const out = Buffer.from(rewritten, "utf8");
        res.setHeader("content-length", String(out.length));
        res.end(out);
      })
      .catch(() => {
        // Fall back to raw stream is impossible after buffering failure mid-way; return error.
        if (!res.headersSent) {
          res.status(502).json({ ok: false, error: { message: "Preview proxy failed while rewriting response." } });
        } else {
          res.end();
        }
      });
  });

  upstream.on("timeout", () => {
    upstream.destroy();
    if (!res.headersSent) {
      res.status(504).json({ ok: false, error: { message: "Preview proxy upstream timed out." } });
    }
  });

  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const message = error instanceof Error ? error.message : "Upstream connection failed";
    res.status(502).json({
      ok: false,
      error: {
        message: `Preview proxy could not reach 127.0.0.1:${port} (${message}). Is the app listening on the server?`,
      },
    });
  });

  req.pipe(upstream);
}

export function mountPreviewProxy(app: Express, auth: PreviewProxyAuth): void {
  app.use("/api/preview-proxy/:host/:port", (req: Request, res: Response) => {
    handlePreviewProxy(req, res, auth);
  });
}
