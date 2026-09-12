import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ChatMessage } from "@luma/shared";

export const MESSAGE_DB_SCHEMA_VERSION = 1;

type MessageRow = {
  session_id: string;
  id: string;
  sequence: number;
  created_at: number;
  role: string;
  kind: string;
  counts_toward_page: number;
  payload: string;
};

export type MessagePageQuery = {
  sessionId: string;
  beforeId?: string | null;
  limit: number;
};

export type MessagePageResult = {
  messages: ChatMessage[];
  nextBeforeId: string | null;
  totalCount: number;
};

function countsTowardPage(message: ChatMessage): boolean {
  return message.kind !== "tool" && message.role !== "tool";
}

function parsePayload(raw: string): ChatMessage | null {
  try {
    const row = JSON.parse(raw) as ChatMessage;
    if (!row || typeof row.id !== "string" || typeof row.sessionId !== "string") return null;
    return row;
  } catch {
    return null;
  }
}

export class MessageDatabase {
  readonly db: Database.Database;

  private readonly upsertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly deleteSessionStmt: Database.Statement;
  private readonly countSessionStmt: Database.Statement;
  private readonly maxSequenceStmt: Database.Statement;
  private readonly listAllSessionIdsStmt: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("foreign_keys = ON");
    this.migrate();

    this.upsertStmt = this.db.prepare(`
      INSERT INTO messages (
        session_id, id, sequence, created_at, role, kind, counts_toward_page, payload
      ) VALUES (
        @session_id, @id, @sequence, @created_at, @role, @kind, @counts_toward_page, @payload
      )
      ON CONFLICT(session_id, id) DO UPDATE SET
        sequence = excluded.sequence,
        created_at = excluded.created_at,
        role = excluded.role,
        kind = excluded.kind,
        counts_toward_page = excluded.counts_toward_page,
        payload = excluded.payload
    `);

    this.getByIdStmt = this.db.prepare(`
      SELECT payload FROM messages WHERE session_id = ? AND id = ?
    `);
    this.deleteSessionStmt = this.db.prepare(`DELETE FROM messages WHERE session_id = ?`);
    this.countSessionStmt = this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE session_id = ?`);
    this.maxSequenceStmt = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM messages WHERE session_id = ?
    `);
    this.listAllSessionIdsStmt = this.db.prepare(`SELECT DISTINCT session_id AS session_id FROM messages`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        counts_toward_page INTEGER NOT NULL DEFAULT 1,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_seq
        ON messages(session_id, sequence ASC, created_at ASC, id ASC);

      CREATE INDEX IF NOT EXISTS idx_messages_session_counted_seq
        ON messages(session_id, counts_toward_page, sequence DESC, created_at DESC, id DESC);
    `);

    const version = this.getMeta("schema_version");
    if (!version) this.setMeta("schema_version", String(MESSAGE_DB_SCHEMA_VERSION));
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  close(): void {
    this.db.close();
  }

  hasSession(sessionId: string): boolean {
    const row = this.countSessionStmt.get(sessionId) as { count: number };
    return Number(row.count) > 0;
  }

  countMessages(sessionId: string): number {
    const row = this.countSessionStmt.get(sessionId) as { count: number };
    return Number(row.count) || 0;
  }

  nextSequence(sessionId: string): number {
    const row = this.maxSequenceStmt.get(sessionId) as { max_sequence: number };
    return Number(row.max_sequence || 0) + 1;
  }

  listSessionIds(): string[] {
    const rows = this.listAllSessionIdsStmt.all() as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  getMessage(sessionId: string, messageId: string): ChatMessage | null {
    const row = this.getByIdStmt.get(sessionId, messageId) as { payload: string } | undefined;
    if (!row) return null;
    return parsePayload(row.payload);
  }

  upsertMessage(message: ChatMessage): void {
    this.upsertStmt.run({
      session_id: message.sessionId,
      id: message.id,
      sequence: Number(message.sequence) || 0,
      created_at: Number(message.createdAt) || 0,
      role: message.role,
      kind: message.kind,
      counts_toward_page: countsTowardPage(message) ? 1 : 0,
      payload: JSON.stringify(message),
    });
  }

  replaceSessionMessages(sessionId: string, messages: ChatMessage[]): void {
    const tx = this.db.transaction((rows: ChatMessage[]) => {
      this.deleteSessionStmt.run(sessionId);
      for (const message of rows) {
        this.upsertMessage({ ...message, sessionId });
      }
    });
    tx(messages);
  }

  deleteSession(sessionId: string): void {
    this.deleteSessionStmt.run(sessionId);
  }

  renameSession(previousSessionId: string, nextSessionId: string, messages: ChatMessage[]): void {
    const tx = this.db.transaction(() => {
      this.deleteSessionStmt.run(previousSessionId);
      this.deleteSessionStmt.run(nextSessionId);
      for (const message of messages) {
        this.upsertMessage({ ...message, sessionId: nextSessionId });
      }
    });
    tx();
  }

  loadSessionMessages(sessionId: string): ChatMessage[] {
    const rows = this.db.prepare(`
      SELECT payload
      FROM messages
      WHERE session_id = ?
      ORDER BY sequence ASC, created_at ASC, id ASC
    `).all(sessionId) as Array<{ payload: string }>;

    const messages: ChatMessage[] = [];
    for (const row of rows) {
      const message = parsePayload(row.payload);
      if (message) messages.push({ ...message, sessionId });
    }
    return messages;
  }

  /**
   * True disk paging: fetch only the requested window.
   * Non-tool messages count toward `limit`; intervening tool rows are included.
   */
  getMessagesPage(query: MessagePageQuery): MessagePageResult {
    const { sessionId, limit } = query;
    const beforeId = query.beforeId || null;
    const totalCount = this.countMessages(sessionId);
    if (totalCount === 0) {
      return { messages: [], nextBeforeId: null, totalCount: 0 };
    }

    type SortKey = { sequence: number; created_at: number; id: string };

    let upper: SortKey | null = null;
    if (beforeId) {
      const anchor = this.db.prepare(`
        SELECT sequence, created_at, id
        FROM messages
        WHERE session_id = ? AND id = ?
      `).get(sessionId, beforeId) as SortKey | undefined;
      if (!anchor) return { messages: [], nextBeforeId: null, totalCount };
      upper = {
        sequence: Number(anchor.sequence),
        created_at: Number(anchor.created_at),
        id: anchor.id,
      };
    }

    const counted = (upper
      ? this.db.prepare(`
          SELECT sequence, created_at, id
          FROM messages
          WHERE session_id = ?
            AND counts_toward_page = 1
            AND (
              sequence < ?
              OR (sequence = ? AND created_at < ?)
              OR (sequence = ? AND created_at = ? AND id < ?)
            )
          ORDER BY sequence DESC, created_at DESC, id DESC
          LIMIT ?
        `).all(
          sessionId,
          upper.sequence,
          upper.sequence,
          upper.created_at,
          upper.sequence,
          upper.created_at,
          upper.id,
          limit,
        )
      : this.db.prepare(`
          SELECT sequence, created_at, id
          FROM messages
          WHERE session_id = ?
            AND counts_toward_page = 1
          ORDER BY sequence DESC, created_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, limit)) as SortKey[];

    if (counted.length === 0) {
      return { messages: [], nextBeforeId: null, totalCount };
    }

    const oldest = counted[counted.length - 1];
    const rows = (upper
      ? this.db.prepare(`
          SELECT payload
          FROM messages
          WHERE session_id = ?
            AND (
              sequence > ?
              OR (sequence = ? AND created_at > ?)
              OR (sequence = ? AND created_at = ? AND id >= ?)
            )
            AND (
              sequence < ?
              OR (sequence = ? AND created_at < ?)
              OR (sequence = ? AND created_at = ? AND id < ?)
            )
          ORDER BY sequence ASC, created_at ASC, id ASC
        `).all(
          sessionId,
          oldest.sequence,
          oldest.sequence,
          oldest.created_at,
          oldest.sequence,
          oldest.created_at,
          oldest.id,
          upper.sequence,
          upper.sequence,
          upper.created_at,
          upper.sequence,
          upper.created_at,
          upper.id,
        )
      : this.db.prepare(`
          SELECT payload
          FROM messages
          WHERE session_id = ?
            AND (
              sequence > ?
              OR (sequence = ? AND created_at > ?)
              OR (sequence = ? AND created_at = ? AND id >= ?)
            )
          ORDER BY sequence ASC, created_at ASC, id ASC
        `).all(
          sessionId,
          oldest.sequence,
          oldest.sequence,
          oldest.created_at,
          oldest.sequence,
          oldest.created_at,
          oldest.id,
        )) as Array<{ payload: string }>;

    const messages: ChatMessage[] = [];
    for (const row of rows) {
      const message = parsePayload(row.payload);
      if (message) messages.push({ ...message, sessionId });
    }

    const olderExists = this.db.prepare(`
      SELECT 1 AS ok
      FROM messages
      WHERE session_id = ?
        AND (
          sequence < ?
          OR (sequence = ? AND created_at < ?)
          OR (sequence = ? AND created_at = ? AND id < ?)
        )
      LIMIT 1
    `).get(
      sessionId,
      oldest.sequence,
      oldest.sequence,
      oldest.created_at,
      oldest.sequence,
      oldest.created_at,
      oldest.id,
    ) as { ok: number } | undefined;

    return {
      messages,
      nextBeforeId: olderExists && messages[0] ? messages[0].id : null,
      totalCount,
    };
  }

  importJsonlFile(sessionId: string, filePath: string): number {
    if (!fs.existsSync(filePath)) return 0;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const byId = new Map<string, ChatMessage>();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = parsePayload(line);
      if (!message) continue;
      byId.set(message.id, { ...message, sessionId });
    }
    const messages = [...byId.values()].sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt);
    this.replaceSessionMessages(sessionId, messages.map((message, index) => ({
      ...message,
      sequence: message.sequence || index + 1,
    })));
    return messages.length;
  }
}

export function openMessageDatabase(dbPath: string): MessageDatabase {
  return new MessageDatabase(dbPath);
}
