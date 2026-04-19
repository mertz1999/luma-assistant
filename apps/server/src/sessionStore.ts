import crypto from "node:crypto";

type Session = {
  ip: string;
  createdAt: number;
  lastSeenAt: number;
};

export class SessionStore {
  private password: string;
  private rateWindowMs: number;
  private rateMaxAttempts: number;
  private sessions = new Map<string, Session>();
  private loginAttemptsByIp = new Map<string, number[]>();
  private sessionTtlMs: number;

  constructor(options: {
    password?: string;
    rateWindowMs?: number;
    rateMaxAttempts?: number;
    sessionTtlMs?: number;
  } = {}) {
    this.password = options.password || "";
    this.rateWindowMs = Number(options.rateWindowMs || 15 * 60 * 1000);
    this.rateMaxAttempts = Number(options.rateMaxAttempts || 12);
    this.sessionTtlMs = Number(options.sessionTtlMs || 24 * 60 * 60 * 1000);
  }

  isConfigured(): boolean {
    return this.password.length > 0;
  }

  canAttemptLogin(ip: string): boolean {
    const now = Date.now();
    const history = this.loginAttemptsByIp.get(ip) || [];
    const filtered = history.filter((timestamp) => now - timestamp < this.rateWindowMs);
    this.loginAttemptsByIp.set(ip, filtered);
    return filtered.length < this.rateMaxAttempts;
  }

  trackLoginAttempt(ip: string): void {
    const now = Date.now();
    const history = this.loginAttemptsByIp.get(ip) || [];
    history.push(now);
    this.loginAttemptsByIp.set(ip, history);
  }

  verifyPassword(inputPassword: string): boolean {
    const expected = Buffer.from(this.password, "utf8");
    const provided = Buffer.from(inputPassword || "", "utf8");

    if (expected.length !== provided.length) return false;
    return crypto.timingSafeEqual(expected, provided);
  }

  createSession(ip: string): string {
    this.cleanupExpiredSessions();

    const token = crypto.randomBytes(32).toString("hex");
    this.sessions.set(token, {
      ip,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    return token;
  }

  isValidSession(token: string | null): boolean {
    if (!token) return false;

    const session = this.sessions.get(token);
    if (!session) return false;

    if (Date.now() - session.createdAt > this.sessionTtlMs) {
      this.sessions.delete(token);
      return false;
    }

    session.lastSeenAt = Date.now();
    return true;
  }

  deleteSession(token: string | null): void {
    if (!token) return;
    this.sessions.delete(token);
  }

  cleanupExpiredSessions(): void {
    const now = Date.now();

    for (const [token, session] of this.sessions.entries()) {
      if (now - session.createdAt > this.sessionTtlMs) {
        this.sessions.delete(token);
      }
    }
  }
}
