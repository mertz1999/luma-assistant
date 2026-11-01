import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  PISettingsSchema,
  type PISettings,
  type PICase,
  type PIEvent,
  type PICaseDetail,
  type PIMessage,
  type PISpecRecord,
  type PIOutboxRecord,
  type PIApprovalRecord,
  type PIImplementationTask,
} from "@luma/shared";

export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export type WorkItem = {
  id: string;
  case_id: string | null;
  kind: string;
  payload: string;
  attempts: number;
  lease_owner: string;
};
export class PIStore {
  readonly db: Database.Database;
  constructor(
    file: string,
    readonly now: () => Date = () => new Date(),
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    if (file !== ":memory:") fs.chmodSync(file, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db
      .transaction(() => {
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS pi_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_policies(id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_contacts(id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_mailboxes(address TEXT PRIMARY KEY, credential TEXT, cursor TEXT, last_sync TEXT, last_error TEXT, watch_expires_at TEXT);
        CREATE TABLE IF NOT EXISTS pi_cases(id TEXT PRIMARY KEY, mailbox TEXT NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(mailbox,thread_id));
        CREATE TABLE IF NOT EXISTS pi_messages(mailbox TEXT NOT NULL, provider_id TEXT NOT NULL, case_id TEXT NOT NULL REFERENCES pi_cases(id), payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(mailbox,provider_id));
        CREATE INDEX IF NOT EXISTS pi_messages_case ON pi_messages(case_id,created_at);
        CREATE TABLE IF NOT EXISTS pi_events(id TEXT PRIMARY KEY, case_id TEXT REFERENCES pi_cases(id), kind TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS pi_events_case ON pi_events(case_id,at);
        CREATE TRIGGER IF NOT EXISTS pi_events_no_update BEFORE UPDATE ON pi_events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS pi_events_no_delete BEFORE DELETE ON pi_events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;
        CREATE TABLE IF NOT EXISTS pi_specs(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES pi_cases(id),version INTEGER NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL, UNIQUE(case_id,version));
        CREATE TRIGGER IF NOT EXISTS pi_specs_no_update BEFORE UPDATE ON pi_specs BEGIN SELECT RAISE(ABORT,'spec snapshots are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS pi_specs_no_delete BEFORE DELETE ON pi_specs BEGIN SELECT RAISE(ABORT,'spec snapshots are immutable'); END;
        CREATE TABLE IF NOT EXISTS pi_approval_requests(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES pi_cases(id),spec_id TEXT NOT NULL REFERENCES pi_specs(id),outbox_id TEXT NOT NULL,request_message_id TEXT, digest TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1, UNIQUE(case_id,spec_id));
        CREATE TABLE IF NOT EXISTS pi_approvals(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES pi_cases(id),spec_id TEXT NOT NULL REFERENCES pi_specs(id),reply_id TEXT NOT NULL,payload TEXT NOT NULL, UNIQUE(case_id,reply_id));
        CREATE TRIGGER IF NOT EXISTS pi_approvals_no_update BEFORE UPDATE ON pi_approvals BEGIN SELECT RAISE(ABORT,'approval evidence is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS pi_approvals_no_delete BEFORE DELETE ON pi_approvals BEGIN SELECT RAISE(ABORT,'approval evidence is immutable'); END;
        CREATE TABLE IF NOT EXISTS pi_outbox(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES pi_cases(id),idempotency_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,provider_id TEXT,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS pi_outbox_state ON pi_outbox(state,updated_at);
        CREATE TABLE IF NOT EXISTS pi_task_handoffs(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES pi_cases(id),spec_version INTEGER NOT NULL,payload TEXT NOT NULL, UNIQUE(case_id,spec_version));
        CREATE TABLE IF NOT EXISTS pi_agent_runs(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES pi_cases(id),payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_investigation_requests(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES pi_cases(id),payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_agent_versions(digest TEXT PRIMARY KEY,content TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_prompt_releases(id TEXT PRIMARY KEY,digest TEXT NOT NULL REFERENCES pi_agent_versions(digest),created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_work_items(id TEXT PRIMARY KEY,case_id TEXT REFERENCES pi_cases(id),kind TEXT NOT NULL,dedupe_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_until INTEGER,lease_owner TEXT,last_error TEXT);
        CREATE INDEX IF NOT EXISTS pi_work_ready ON pi_work_items(state,available_at,lease_until);
        CREATE TABLE IF NOT EXISTS pi_oauth_states(hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
        INSERT OR IGNORE INTO pi_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        INSERT OR IGNORE INTO pi_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        CREATE TABLE IF NOT EXISTS pi_thread_eligibility(mailbox TEXT NOT NULL,thread_id TEXT NOT NULL,required_sender TEXT NOT NULL,anchor_id TEXT NOT NULL,verified_at TEXT NOT NULL,PRIMARY KEY(mailbox,thread_id));
        INSERT OR IGNORE INTO pi_migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        CREATE TABLE IF NOT EXISTS pi_job_effects(job_id TEXT PRIMARY KEY,completed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_reviewed_inputs(case_id TEXT PRIMARY KEY REFERENCES pi_cases(id),source_digest TEXT NOT NULL,body TEXT NOT NULL,reviewed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pi_implementations(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES pi_cases(id),payload TEXT NOT NULL);
        INSERT OR IGNORE INTO pi_migrations VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      `);
      })
      .immediate();
    if (!this.db.prepare("SELECT 1 FROM pi_policies LIMIT 1").get())
      this.saveSettings(
        PISettingsSchema.parse({
          mailbox: process.env.PI_GMAIL_MAILBOX || "admin@proimagetx.ai",
          mode: process.env.PI_CLARIFICATION_MODE || "draft_only",
        }),
        "system",
      );
  }
  at() {
    return this.now().toISOString();
  }
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  settings(): PISettings {
    return PISettingsSchema.parse(
      JSON.parse(
        (
          this.db
            .prepare(
              "SELECT payload FROM pi_policies ORDER BY rowid DESC LIMIT 1",
            )
            .get() as { payload: string }
        ).payload,
      ),
    );
  }
  saveSettings(value: PISettings, actor: string) {
    const settings = PISettingsSchema.parse(value);
    this.tx(() => {
      this.db
        .prepare("INSERT INTO pi_policies VALUES(?,?,?)")
        .run(id("policy"), JSON.stringify(settings), this.at());
      this.db.prepare("DELETE FROM pi_contacts").run();
      const insert = this.db.prepare("INSERT INTO pi_contacts VALUES(?,?,?)");
      for (const contact of settings.contacts)
        insert.run(contact.id, contact.address, JSON.stringify(contact));
      this.db
        .prepare("INSERT OR IGNORE INTO pi_mailboxes(address) VALUES(?)")
        .run(settings.mailbox);
      this.event(null, "SETTINGS_CHANGED", actor, { digest: digest(settings) });
    });
    return settings;
  }
  event(
    caseId: string | null,
    kind: string,
    actor: string,
    data: Record<string, unknown>,
  ): PIEvent {
    const e = { id: id("event"), caseId, kind, actor, at: this.at(), data };
    this.db
      .prepare("INSERT INTO pi_events VALUES(?,?,?,?,?,?)")
      .run(e.id, caseId, kind, actor, e.at, JSON.stringify(data));
    return e;
  }
  events(caseId?: string): PIEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pi_events ${caseId ? "WHERE case_id=?" : ""} ORDER BY rowid DESC LIMIT 1000`,
      )
      .all(...(caseId ? [caseId] : [])) as {
      id: string;
      case_id: string | null;
      kind: string;
      actor: string;
      at: string;
      data: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      caseId: r.case_id,
      kind: r.kind,
      actor: r.actor,
      at: r.at,
      data: JSON.parse(r.data),
    }));
  }
  getCase(caseId: string): PICase {
    const row = this.db
      .prepare("SELECT payload FROM pi_cases WHERE id=?")
      .get(caseId) as { payload: string } | undefined;
    if (!row) throw new Error("Case not found");
    return JSON.parse(row.payload);
  }
  cases(): PICase[] {
    return this.payloads<PICase>("pi_cases").sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  putCase(c: PICase, expectedRevision: number) {
    const next = { ...c, revision: expectedRevision + 1, updatedAt: this.at() };
    const result = this.db
      .prepare(
        "UPDATE pi_cases SET state=?,revision=?,payload=? WHERE id=? AND revision=?",
      )
      .run(
        next.state,
        next.revision,
        JSON.stringify(next),
        c.id,
        expectedRevision,
      );
    if (!result.changes) throw new Error("Stale case revision");
    return next;
  }
  payloads<T>(table: string, caseId?: string): T[] {
    if (
      ![
        "pi_cases",
        "pi_messages",
        "pi_specs",
        "pi_approvals",
        "pi_outbox",
        "pi_agent_runs",
        "pi_investigation_requests",
        "pi_task_handoffs",
      ].includes(table)
    )
      throw new Error("Invalid table");
    return (
      this.db
        .prepare(
          `SELECT payload FROM ${table} ${caseId ? "WHERE case_id=?" : ""} ORDER BY rowid`,
        )
        .all(...(caseId ? [caseId] : [])) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  detail(caseId: string): PICaseDetail {
    return {
      case: this.getCase(caseId),
      messages: this.payloads<PIMessage>("pi_messages", caseId).sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      events: this.events(caseId).reverse(),
      specs: this.payloads<PISpecRecord>("pi_specs", caseId),
      approvals: this.payloads<PIApprovalRecord>("pi_approvals", caseId),
      outbox: this.payloads<PIOutboxRecord>("pi_outbox", caseId),
      runs: this.payloads("pi_agent_runs", caseId),
      investigations: this.payloads("pi_investigation_requests", caseId),
      handoffs: this.payloads<PIImplementationTask>("pi_task_handoffs", caseId),
    };
  }
  enqueue(
    kind: string,
    key: string,
    payload: unknown,
    caseId: string | null = null,
  ) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pi_work_items(id,case_id,kind,dedupe_key,payload,available_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id("job"),
        caseId,
        kind,
        key,
        JSON.stringify(payload),
        this.now().getTime(),
      );
  }
  claim(owner: string, leaseMs = 120000): WorkItem | undefined {
    return this.tx(() => {
      const now = this.now().getTime();
      // Same-case jobs cannot be leased concurrently, including across replicas.
      const row = this.db
        .prepare(
          `SELECT w.* FROM pi_work_items w WHERE ((w.state='pending' AND w.available_at<=?) OR (w.state='running' AND w.lease_until<=?)) AND NOT EXISTS (SELECT 1 FROM pi_work_items x WHERE x.id<>w.id AND x.state='running' AND x.lease_until>? AND (x.case_id=w.case_id OR (x.case_id IS NULL AND w.case_id IS NULL))) ORDER BY w.available_at,w.rowid LIMIT 1`,
        )
        .get(now, now, now) as WorkItem | undefined;
      if (!row) return;
      this.db
        .prepare(
          "UPDATE pi_work_items SET state='running',lease_until=?,lease_owner=?,attempts=attempts+1 WHERE id=?",
        )
        .run(now + leaseMs, owner, row.id);
      return { ...row, attempts: row.attempts + 1, lease_owner: owner };
    });
  }
  finish(job: WorkItem, error?: string) {
    this.db
      .prepare(
        "UPDATE pi_work_items SET state=?,lease_until=NULL,last_error=?,available_at=? WHERE id=? AND lease_owner=? AND state='running'",
      )
      .run(
        error ? (job.attempts >= 4 ? "failed" : "pending") : "done",
        error || null,
        this.now().getTime() + Math.min(3600000, 15000 * 2 ** job.attempts),
        job.id,
        job.lease_owner,
      );
  }
  retry(jobId: string) {
    const row = this.db
      .prepare("SELECT state FROM pi_work_items WHERE id=?")
      .get(jobId) as { state: string } | undefined;
    if (!row || row.state !== "failed")
      throw new Error("Only failed jobs can be retried");
    this.db
      .prepare(
        "UPDATE pi_work_items SET state='pending',attempts=0,available_at=?,last_error=NULL WHERE id=?",
      )
      .run(this.now().getTime(), jobId);
    this.event(null, "JOB_RETRIED", "admin", { jobId });
  }
  mailbox(address = this.settings().mailbox) {
    return this.db
      .prepare(
        "SELECT address,cursor,last_sync,last_error,watch_expires_at,credential IS NOT NULL AS connected FROM pi_mailboxes WHERE address=?",
      )
      .get(address) as {
      address: string;
      cursor: string | null;
      last_sync: string | null;
      last_error: string | null;
      watch_expires_at: string | null;
      connected: number;
    };
  }
  close() {
    this.db.close();
  }
}
