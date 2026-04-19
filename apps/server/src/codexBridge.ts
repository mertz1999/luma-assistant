import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 120_000;

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type PendingServerRequest = {
  method: string;
  params: Record<string, unknown>;
  at: number;
};

export type BridgeStatusEvent = {
  type: string;
  at: number;
  [key: string]: unknown;
};

export type BridgeNotificationEvent = {
  method: string;
  params: Record<string, unknown>;
};

export type BridgeServerRequestEvent = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
};

export class CodexBridge extends EventEmitter {
  private codexPath: string;
  private cwd: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private ready = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private pendingServerRequests = new Map<string | number, PendingServerRequest>();

  constructor(options: { codexPath?: string; cwd?: string } = {}) {
    super();
    this.codexPath = options.codexPath || "codex";
    this.cwd = options.cwd || process.cwd();
  }

  async start(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      return;
    }

    this.proc = spawn(this.codexPath, ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      this.emit("status", { type: "stderr", message: text, at: Date.now() } satisfies BridgeStatusEvent);
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(id);
      }

      this.ready = false;
      this.proc = null;
      this.rl = null;
      this.emit("status", {
        type: "exit",
        code: code ?? null,
        signal: signal ?? null,
        at: Date.now(),
      } satisfies BridgeStatusEvent);
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    this.emit("status", { type: "started", at: Date.now() } satisfies BridgeStatusEvent);
  }

  async initialize(clientInfo: { name: string; title: string; version: string }): Promise<void> {
    if (this.ready) return;

    const initResult = (await this.request("initialize", {
      clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    })) as Record<string, unknown>;

    this.sendNotification("initialized", {});
    this.ready = true;

    this.emit("status", {
      type: "initialized",
      at: Date.now(),
      platformFamily: initResult?.platformFamily ?? null,
      platformOs: initResult?.platformOs ?? null,
    } satisfies BridgeStatusEvent);
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Failed to send RPC request"));
      }
    });
  }

  sendNotification(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params });
  }

  respondToServerRequest(input: {
    requestId: string | number;
    result?: unknown;
    error?: { code?: number; message: string; data?: unknown };
  }): void {
    const { requestId, result, error } = input;

    if (requestId === null || requestId === undefined) {
      throw new Error("requestId is required");
    }

    if (!this.pendingServerRequests.has(requestId)) {
      throw new Error(`Unknown server request id: ${requestId}`);
    }

    this.pendingServerRequests.delete(requestId);

    this.write({
      id: requestId,
      ...(error ? { error } : { result }),
    });
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this.ready = false;
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;

    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.emit("status", {
        type: "parseError",
        at: Date.now(),
        line,
        error: error instanceof Error ? error.message : "Unknown JSON parse error",
      } satisfies BridgeStatusEvent);
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    const hasMethod = Object.prototype.hasOwnProperty.call(message, "method");

    if (hasId && (hasResult || hasError)) {
      const id = message.id as number;
      const pending = this.pending.get(id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(id);

      if (hasError) {
        const rpcError = message.error as { code?: number; message?: string; data?: unknown };
        const err = new Error(rpcError?.message || "JSON-RPC error");
        (err as Error & { code?: number; data?: unknown }).code = rpcError?.code;
        (err as Error & { code?: number; data?: unknown }).data = rpcError?.data;
        pending.reject(err);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (hasMethod && hasId) {
      const requestId = message.id as string | number;
      const serverRequest: PendingServerRequest = {
        method: String(message.method),
        params: (message.params as Record<string, unknown>) || {},
        at: Date.now(),
      };
      this.pendingServerRequests.set(requestId, serverRequest);

      this.emit("serverRequest", {
        id: requestId,
        method: serverRequest.method,
        params: serverRequest.params,
      } satisfies BridgeServerRequestEvent);
      return;
    }

    if (hasMethod) {
      this.emit("notification", {
        method: String(message.method),
        params: (message.params as Record<string, unknown>) || {},
      } satisfies BridgeNotificationEvent);
      return;
    }

    this.emit("status", {
      type: "unhandledMessage",
      at: Date.now(),
      message,
    } satisfies BridgeStatusEvent);
  }

  private write(message: Record<string, unknown>): void {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      throw new Error("Cannot write to codex app-server");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
