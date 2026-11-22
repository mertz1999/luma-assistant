import { createHmac, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

export const cloudIdleTimeoutMs = 48 * 60 * 60 * 1_000;

export class CloudSessions {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;
  private readonly lookup: Database.Statement;
  private readonly renew: Database.Statement;
  private readonly remove: Database.Statement;
  private readonly prune: Database.Statement;

  constructor(file: string, private readonly secret: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_sessions (
        digest TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cloud_sessions_by_expiry ON cloud_sessions(expires_at);
    `);
    this.insert = this.db.prepare("INSERT INTO cloud_sessions (digest, expires_at) VALUES (?, ?)");
    this.lookup = this.db.prepare("SELECT expires_at AS expiresAt FROM cloud_sessions WHERE digest = ? AND expires_at > ?");
    this.renew = this.db.prepare("UPDATE cloud_sessions SET expires_at = MAX(expires_at, ?) WHERE digest = ? AND expires_at > ? RETURNING expires_at AS expiresAt");
    this.remove = this.db.prepare("DELETE FROM cloud_sessions WHERE digest = ?");
    this.prune = this.db.prepare("DELETE FROM cloud_sessions WHERE expires_at <= ?");
  }

  private digest(token: string): string {
    return createHmac("sha256", this.secret).update(token).digest("hex");
  }

  issue(now = Date.now()) {
    const token = `luma_cloud_${randomBytes(32).toString("base64url")}`;
    const expiresAt = now + cloudIdleTimeoutMs;
    this.prune.run(now);
    this.insert.run(this.digest(token), expiresAt);
    return { token, expiresAt, expiresInSeconds: cloudIdleTimeoutMs / 1_000, idleTimeoutMs: cloudIdleTimeoutMs };
  }

  expiresAt(token: string, now = Date.now()): number | null {
    const row = this.lookup.get(this.digest(token), now) as { expiresAt: number } | undefined;
    return row?.expiresAt ?? null;
  }

  recordActivity(token: string, now = Date.now()): number | null {
    const row = this.renew.get(now + cloudIdleTimeoutMs, this.digest(token), now) as { expiresAt: number } | undefined;
    return row?.expiresAt ?? null;
  }

  revoke(token: string): void {
    this.remove.run(this.digest(token));
  }

  close(): void {
    this.db.close();
  }
}
