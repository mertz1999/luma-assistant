import crypto from "node:crypto";
import type { MethodGroup } from "@assistant/shared";

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
  private riskAcceptances = new Map<string, Map<MethodGroup, number>>();

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
      this.deleteSession(token);
      return false;
    }

    session.lastSeenAt = Date.now();
    return true;
  }

  deleteSession(token: string | null): void {
    if (!token) return;
    this.sessions.delete(token);
    this.riskAcceptances.delete(token);
  }

  cleanupExpiredSessions(): void {
    const now = Date.now();

    for (const [token, session] of this.sessions.entries()) {
      if (now - session.createdAt > this.sessionTtlMs) {
        this.deleteSession(token);
      }
    }

    for (const [token, groups] of this.riskAcceptances.entries()) {
      if (!this.sessions.has(token)) {
        this.riskAcceptances.delete(token);
        continue;
      }

      for (const [group, expiresAt] of groups.entries()) {
        if (now > expiresAt) groups.delete(group);
      }

      if (groups.size === 0) this.riskAcceptances.delete(token);
    }
  }

  grantRiskAcceptance(sessionToken: string, group: MethodGroup, ttlMs: number): number {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const scoped = this.riskAcceptances.get(sessionToken) || new Map<MethodGroup, number>();
    scoped.set(group, expiresAt);
    this.riskAcceptances.set(sessionToken, scoped);

    return expiresAt;
  }

  hasActiveRiskAcceptance(sessionToken: string, group: MethodGroup): boolean {
    const scoped = this.riskAcceptances.get(sessionToken);
    if (!scoped) return false;

    const expiresAt = scoped.get(group);
    if (!expiresAt) return false;

    if (Date.now() > expiresAt) {
      scoped.delete(group);
      if (scoped.size === 0) this.riskAcceptances.delete(sessionToken);
      return false;
    }

    return true;
  }

  getRiskAcceptanceExpiry(sessionToken: string, group: MethodGroup): number | null {
    const scoped = this.riskAcceptances.get(sessionToken);
    if (!scoped) return null;
    const expiresAt = scoped.get(group);
    if (!expiresAt) return null;
    if (Date.now() > expiresAt) return null;
    return expiresAt;
  }
}
