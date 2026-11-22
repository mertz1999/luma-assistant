import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { Router, type Response } from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { remoteCommandSchema, remoteResultSchemas, type RemoteCommand, type RemoteDevice } from "@luma/shared";

const pairingLifetime = 5 * 60_000;
const requestTimeout = 10_000;
const maxDevices = 25;
const maxFrameSize = 2 * 1024 * 1024;
const connectPath = "/api/remote/connect";
const deviceName = z.string().trim().min(1).max(80);
const redeemSchema = z.object({ code: z.string().regex(/^[\w-]{22}$/), name: deviceName });
const deviceFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), canControl: z.boolean() }),
  z.object({ kind: z.literal("result"), id: z.uuid(), ok: z.literal(true), data: z.unknown() }),
  z.object({ kind: z.literal("error"), id: z.uuid(), message: z.string().max(400) }),
]);
type Reply = { ok: true; data: unknown } | { ok: false; status: number; message: string };
type Pending = { command: RemoteCommand; finish(reply: Reply): void };
type Connection = {
  ws: WebSocket;
  alive: boolean;
  ready: boolean;
  canControl: boolean;
  pending: Map<string, Pending>;
};
type StoredDevice = { id: string; name: string };

const offline: Reply = { ok: false, status: 503, message: "This Mac is offline." };
const errorBody = (message: string) => ({ ok: false, error: { message } });
const okBody = <T>(data: T) => ({ ok: true, data });

export class RemoteRelay {
  private readonly db: Database.Database;
  private readonly sockets = new Map<string, Connection>();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: maxFrameSize, perMessageDeflate: false });
  readonly devices = Router();
  readonly pairing = Router();

  constructor(file: string, private readonly secret: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_pair_codes (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT UNIQUE NOT NULL);
    `);

    this.devices.use((_req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (!res.locals.cloudSessionToken) {
        res.status(401).json(errorBody("Sign in to Luma Cloud to manage paired Macs."));
        return;
      }
      next();
    });
    this.devices.post("/pair", (_req, res) => {
      const code = randomBytes(16).toString("base64url");
      const expiresAt = Date.now() + pairingLifetime;
      this.db.prepare("DELETE FROM remote_pair_codes WHERE expires_at <= ?").run(Date.now());
      const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM remote_pair_codes").get() as { count: number };
      if (count >= maxDevices) {
        res.status(429).json(errorBody("Too many active pairing codes. Wait for a code to expire."));
        return;
      }
      this.db.prepare("INSERT INTO remote_pair_codes VALUES (?, ?)").run(this.digest(code), expiresAt);
      res.json(okBody({ code, expiresAt }));
    });
    this.devices.get("/devices", (_req, res) => {
      const rows = this.db.prepare("SELECT id, name FROM remote_devices ORDER BY name, id").all() as StoredDevice[];
      const devices: RemoteDevice[] = rows.map(row => {
        const socket = this.sockets.get(row.id);
        return { ...row, online: Boolean(socket?.ready), canControl: Boolean(socket?.ready && socket.canControl) };
      });
      res.json(okBody({ devices }));
    });
    this.devices.delete("/devices/:deviceId", (req, res) => {
      this.remove(req.params.deviceId);
      res.json(okBody({ removed: true }));
    });
    this.devices.post("/devices/:deviceId/request", async (req, res) => {
      const command = remoteCommandSchema.safeParse(req.body);
      if (!command.success) {
        res.status(400).json(errorBody("Invalid remote session request."));
        return;
      }
      const reply = await this.request(req.params.deviceId, command.data, res);
      if (res.destroyed) return;
      if (reply.ok) res.json(okBody(reply.data));
      else res.status(reply.status).json(errorBody(reply.message));
    });

    this.pairing.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
    this.pairing.post("/redeem", (req, res) => {
      const input = redeemSchema.safeParse(req.body);
      if (!input.success) {
        res.status(400).json(errorBody("Enter the pairing code shown in Luma Cloud."));
        return;
      }
      const id = randomUUID();
      const token = `luma_device_${randomBytes(32).toString("base64url")}`;
      const save = this.db.transaction(() => {
        const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM remote_devices").get() as { count: number };
        if (count >= maxDevices) return "full";
        const code = this.db.prepare("DELETE FROM remote_pair_codes WHERE digest = ? AND expires_at > ?")
          .run(this.digest(input.data.code), Date.now());
        if (!code.changes) return "expired";
        this.db.prepare("INSERT INTO remote_devices VALUES (?, ?, ?)").run(id, input.data.name, this.digest(token));
        return "paired";
      });
      const result = save();
      if (result === "paired") res.json(okBody({ id, token }));
      else if (result === "full") res.status(409).json(errorBody("Remove a paired Mac before adding another."));
      else res.status(403).json(errorBody("Pairing code is invalid, used, or expired."));
    });
    this.pairing.delete("/self", (req, res) => {
      const device = this.authenticate(req.headers.authorization);
      if (!device) {
        res.status(401).json(errorBody("Device pairing has been revoked."));
        return;
      }
      this.remove(device.id);
      res.json(okBody({ removed: true }));
    });
  }

  attach(httpServer: Server): void {
    httpServer.on("upgrade", (req, socket, head) => {
      if (req.url !== connectPath) {
        socket.destroy();
        return;
      }
      const device = this.authenticate(req.headers.authorization);
      if (!device) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      this.server.handleUpgrade(req, socket, head, ws => this.connect(device.id, ws));
    });
    const heartbeat = setInterval(() => {
      for (const socket of this.sockets.values()) {
        if (!socket.alive) {
          socket.ws.terminate();
          continue;
        }
        socket.alive = false;
        socket.ws.ping();
      }
    }, 15_000);
    heartbeat.unref();
    httpServer.once("close", () => {
      clearInterval(heartbeat);
      for (const socket of this.sockets.values()) socket.ws.terminate();
      this.server.close();
      this.db.close();
    });
  }

  private digest(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }

  private authenticate(header?: string): StoredDevice | undefined {
    const token = /^Bearer (luma_device_[\w-]{43})$/.exec(header || "")?.[1];
    return token ? this.db.prepare("SELECT id, name FROM remote_devices WHERE digest = ?")
      .get(this.digest(token)) as StoredDevice | undefined : undefined;
  }

  private remove(id: string): void {
    this.db.prepare("DELETE FROM remote_devices WHERE id = ?").run(id);
    const connection = this.sockets.get(id);
    if (!connection) return;
    this.disconnect(id, connection);
    connection.ws.close(4003, "Pairing revoked");
  }

  private connect(id: string, ws: WebSocket): void {
    const previous = this.sockets.get(id);
    if (previous) {
      this.disconnect(id, previous);
      previous.ws.terminate();
    }
    const connection: Connection = { ws, alive: true, ready: false, canControl: false, pending: new Map() };
    this.sockets.set(id, connection);
    ws.on("pong", () => { connection.alive = true; });
    ws.on("error", () => ws.terminate());
    ws.on("close", () => this.disconnect(id, connection));
    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary || this.sockets.get(id) !== connection) return;
      let value: unknown;
      try { value = JSON.parse(raw.toString()); }
      catch { ws.close(1008, "Invalid response"); return; }
      const parsed = deviceFrame.safeParse(value);
      if (!parsed.success) {
        ws.close(1008, "Invalid response");
        return;
      }
      const frame = parsed.data;
      if (frame.kind === "ready") {
        connection.ready = true;
        connection.canControl = frame.canControl;
        return;
      }
      const pending = connection.pending.get(frame.id);
      if (!pending) return;
      if (frame.kind === "error") {
        pending.finish({ ok: false, status: 409, message: frame.message });
        return;
      }
      const result = remoteResultSchemas[pending.command.kind].safeParse(frame.data);
      pending.finish(result.success ? { ok: true, data: result.data }
        : { ok: false, status: 502, message: "This Mac returned an invalid session response." });
    });
  }

  private disconnect(id: string, connection: Connection): void {
    if (this.sockets.get(id) === connection) this.sockets.delete(id);
    for (const pending of connection.pending.values()) pending.finish(offline);
  }

  private request(id: string, command: RemoteCommand, response: Response): Promise<Reply> {
    const connection = this.sockets.get(id);
    if (!connection?.ready || connection.ws.readyState !== WebSocket.OPEN) return Promise.resolve(offline);
    if ((command.kind === "send" || command.kind === "stop") && !connection.canControl) {
      return Promise.resolve({ ok: false, status: 403, message: "This Mac allows viewing only." });
    }
    if (connection.pending.size >= 16) {
      return Promise.resolve({ ok: false, status: 429, message: "This Mac is handling too many requests. Try again." });
    }
    const requestId = randomUUID();
    return new Promise(resolve => {
      const finish = (reply: Reply) => {
        clearTimeout(timeout);
        response.off("close", disconnected);
        connection.pending.delete(requestId);
        resolve(reply);
      };
      const disconnected = () => finish(offline);
      const timeout = setTimeout(() => finish({
        ok: false, status: 504, message: "The Mac did not respond. Try again when it is online.",
      }), requestTimeout);
      response.once("close", disconnected);
      connection.pending.set(requestId, { command, finish });
      connection.ws.send(JSON.stringify({ id: requestId, command }), error => {
        if (error) finish(offline);
      });
    });
  }
}
