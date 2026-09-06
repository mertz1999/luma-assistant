import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { WebSocketServer, type WebSocket } from "ws";

const MAX_SESSIONS = 3;
const IDLE_MS = 15 * 60 * 1000;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

type ClientMessage =
  | { type: "navigate"; url: string }
  | { type: "reload" }
  | { type: "back" }
  | { type: "forward" }
  | { type: "resize"; width: number; height: number }
  | {
      type: "pointer";
      event: "down" | "up" | "move" | "wheel";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
    }
  | {
      type: "key";
      event: "down" | "up";
      key: string;
      code?: string;
      text?: string;
      modifiers?: number;
    };

type PreviewSession = {
  id: string;
  page: Page;
  cdp: CDPSession;
  socket: WebSocket;
  width: number;
  height: number;
  lastActiveAt: number;
  screencastStarted: boolean;
};

export type PreviewBrowserAuth = {
  enabled: boolean;
  extractToken: (req: IncomingMessage) => string | null;
  verifyToken: (token: string) => boolean;
};

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function clampSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(320, Math.min(2400, Math.round(value)));
}

function parseMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as ClientMessage;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export class PreviewBrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly wss: WebSocketServer;
  private readonly idleTimer: NodeJS.Timeout;

  constructor(
    server: HttpServer,
    private readonly auth: PreviewBrowserAuth,
  ) {
    this.wss = new WebSocketServer({ server, path: "/api/preview-browser" });
    this.wss.on("connection", (socket, req) => {
      void this.onConnection(socket, req);
    });
    this.idleTimer = setInterval(() => {
      void this.reapIdleSessions();
    }, 30_000);
  }

  async dispose(): Promise<void> {
    clearInterval(this.idleTimer);
    for (const session of [...this.sessions.values()]) {
      await this.closeSession(session.id);
    }
    this.wss.close();
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }).then((browser) => {
      this.browser = browser;
      this.launching = null;
      browser.on("disconnected", () => {
        this.browser = null;
      });
      return browser;
    }).catch((error) => {
      this.launching = null;
      throw error;
    });

    return this.launching;
  }

  private async onConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    if (this.auth.enabled) {
      const token = this.auth.extractToken(req);
      if (!token || !this.auth.verifyToken(token)) {
        send(socket, { type: "error", message: "Unauthorized" });
        socket.close(4401, "Unauthorized");
        return;
      }
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      send(socket, { type: "error", message: `Preview browser limit reached (${MAX_SESSIONS}). Close another tab first.` });
      socket.close(4410, "Too many sessions");
      return;
    }

    let session: PreviewSession | null = null;
    try {
      const browser = await this.ensureBrowser();
      const page = await browser.newPage({
        viewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
      });
      const cdp = await page.context().newCDPSession(page);
      const id = randomUUID();
      session = {
        id,
        page,
        cdp,
        socket,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        lastActiveAt: Date.now(),
        screencastStarted: false,
      };
      this.sessions.set(id, session);

      cdp.on("Page.screencastFrame", (frame) => {
        const active = this.sessions.get(id);
        if (!active || active.socket.readyState !== active.socket.OPEN) return;
        active.lastActiveAt = Date.now();
        active.socket.send(JSON.stringify({
          type: "frame",
          data: frame.data,
          metadata: frame.metadata,
        }));
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      });

      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        send(socket, {
          type: "navigated",
          url: page.url(),
          title: "",
        });
        void page.title().then((title) => {
          send(socket, { type: "navigated", url: page.url(), title });
        }).catch(() => undefined);
      });

      send(socket, { type: "ready", sessionId: id, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
      await this.startScreencast(session);

      socket.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const message = parseMessage(text);
        if (!message) return;
        void this.handleMessage(id, message);
      });

      socket.on("close", () => {
        void this.closeSession(id);
      });
      socket.on("error", () => {
        void this.closeSession(id);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start preview browser";
      send(socket, { type: "error", message });
      socket.close(1011, "Preview browser failed");
      if (session) await this.closeSession(session.id);
    }
  }

  private async startScreencast(session: PreviewSession): Promise<void> {
    if (session.screencastStarted) {
      await session.cdp.send("Page.stopScreencast").catch(() => undefined);
    }
    await session.page.setViewportSize({ width: session.width, height: session.height });
    await session.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 55,
      maxWidth: session.width,
      maxHeight: session.height,
      everyNthFrame: 1,
    });
    session.screencastStarted = true;
  }

  private async handleMessage(sessionId: string, message: ClientMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActiveAt = Date.now();

    try {
      switch (message.type) {
        case "navigate": {
          const url = message.url.trim();
          if (!url) return;
          send(session.socket, { type: "status", loading: true });
          await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          send(session.socket, {
            type: "navigated",
            url: session.page.url(),
            title: await session.page.title().catch(() => ""),
          });
          send(session.socket, { type: "status", loading: false });
          break;
        }
        case "reload":
          send(session.socket, { type: "status", loading: true });
          await session.page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
          send(session.socket, { type: "status", loading: false });
          break;
        case "back":
          await session.page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
          break;
        case "forward":
          await session.page.goForward({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
          break;
        case "resize": {
          session.width = clampSize(message.width, session.width);
          session.height = clampSize(message.height, session.height);
          await this.startScreencast(session);
          break;
        }
        case "pointer": {
          const button = message.button || "left";
          if (message.event === "move") {
            await session.page.mouse.move(message.x, message.y);
          } else if (message.event === "down") {
            await session.page.mouse.move(message.x, message.y);
            await session.page.mouse.down({ button, clickCount: message.clickCount || 1 });
          } else if (message.event === "up") {
            await session.page.mouse.move(message.x, message.y);
            await session.page.mouse.up({ button, clickCount: message.clickCount || 1 });
          } else if (message.event === "wheel") {
            await session.page.mouse.move(message.x, message.y);
            await session.page.mouse.wheel(message.deltaX || 0, message.deltaY || 0);
          }
          break;
        }
        case "key": {
          if (message.event !== "down") return;
          const key = message.key;
          if (!key) return;
          if (key.length === 1 && !message.modifiers) {
            await session.page.keyboard.insertText(key);
          } else {
            await session.page.keyboard.press(key);
          }
          break;
        }
        default:
          break;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "Preview action failed";
      send(session.socket, { type: "error", message: text });
      send(session.socket, { type: "status", loading: false });
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try {
      if (session.screencastStarted) {
        await session.cdp.send("Page.stopScreencast").catch(() => undefined);
      }
      await session.cdp.detach().catch(() => undefined);
      await session.page.close({ runBeforeUnload: false }).catch(() => undefined);
    } catch {
      // ignore cleanup errors
    }
    if (session.socket.readyState === session.socket.OPEN) {
      session.socket.close();
    }

    if (this.sessions.size === 0 && this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => undefined);
    }
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastActiveAt > IDLE_MS) {
        send(session.socket, { type: "error", message: "Preview browser closed after idle timeout." });
        await this.closeSession(session.id);
      }
    }
  }
}

export function extractTokenFromUpgradeRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }

  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    const queryToken = url.searchParams.get("token");
    if (queryToken && queryToken.trim()) return queryToken.trim();
  } catch {
    // ignore
  }

  return null;
}
