import type { PIOutboxRecord } from "@luma/shared";
import { PIStore, id, digest } from "./store.js";
import {
  checkSend,
  requirePolicy,
  recipientsFor,
  sanitizeBody,
} from "./policy.js";
import type { GmailClient } from "./gmail.js";

export class OutboxService {
  constructor(
    readonly store: PIStore,
    readonly gmail: GmailClient,
    readonly locked: boolean,
  ) {}
  prepare(
    caseId: string,
    kind: PIOutboxRecord["kind"],
    contactIds: string[],
    body: string,
    key: string,
  ): PIOutboxRecord {
    return this.store.tx(() => {
      const c = this.store.getCase(caseId),
        s = this.store.settings();
      const recipients = recipientsFor(
        contactIds,
        c.workflow,
        s,
        kind === "approval",
      );
      const existing = this.store.db
        .prepare("SELECT payload FROM pi_outbox WHERE idempotency_key=?")
        .get(key) as { payload: string } | undefined;
      if (existing) return JSON.parse(existing.payload);
      const original = this.store.detail(caseId).messages.at(-1);
      requirePolicy(original, "No source message");
      const outId = id("outbox");
      const row: PIOutboxRecord = {
        id: outId,
        caseId,
        kind,
        recipients,
        subject: original.subject.replace(/^(Re:\s*)+/i, "Re: "),
        bodyText: `${sanitizeBody(body)}\n\nPI AI Support Assistant · disclosed AI assistant\nScope approval does not authorize production deployment.`,
        state: "prepared",
        providerId: null,
        rfcMessageId: `<${digest(outId)}@${s.mailbox.split("@")[1]}>`,
        specVersion: c.specVersion,
        createdAt: this.store.at(),
        updatedAt: this.store.at(),
        error: null,
      };
      this.store.db
        .prepare("INSERT INTO pi_outbox VALUES(?,?,?,?,?,?,?)")
        .run(
          row.id,
          caseId,
          key,
          row.state,
          null,
          JSON.stringify(row),
          row.updatedAt,
        );
      this.store.event(caseId, "OUTBOUND_PREPARED", "policy-gateway", {
        outboxId: row.id,
        recipients,
        kind,
        policyDigest: digest(s),
      });
      this.store.enqueue(
        "outbox",
        `outbox:${row.id}`,
        { outboxId: row.id },
        caseId,
      );
      return row;
    });
  }
  get(outboxId: string): PIOutboxRecord {
    const row = this.store.db
      .prepare("SELECT payload FROM pi_outbox WHERE id=?")
      .get(outboxId) as { payload: string } | undefined;
    requirePolicy(row, "Outbox record not found");
    return JSON.parse(row.payload);
  }
  update(
    row: PIOutboxRecord,
    state: string,
    providerId: string | null = row.providerId,
    error: string | null = null,
  ) {
    const next = {
      ...row,
      state,
      providerId,
      error,
      updatedAt: this.store.at(),
    };
    this.store.db
      .prepare(
        "UPDATE pi_outbox SET state=?,provider_id=?,payload=?,updated_at=? WHERE id=?",
      )
      .run(state, providerId, JSON.stringify(next), next.updatedAt, row.id);
    this.store.event(row.caseId, `OUTBOUND_${state.toUpperCase()}`, "outbox", {
      outboxId: row.id,
      providerId,
      error,
    });
    return next;
  }
  confirm(row: PIOutboxRecord, providerId: string) {
    this.store.tx(() => {
      this.update(row, "sent", providerId);
      this.store.db
        .prepare(
          "UPDATE pi_approval_requests SET request_message_id=? WHERE outbox_id=? AND active=1",
        )
        .run(providerId, row.id);
    });
  }
  async deliver(outboxId: string) {
    let row = this.get(outboxId);
    if (["sent", "cancelled", "simulated"].includes(row.state)) return;
    const c = this.store.getCase(row.caseId),
      settings = this.store.settings();
    if (c.demo) {
      this.simulate(outboxId);
      return;
    }
    if (["sending", "uncertain"].includes(row.state)) {
      // Never resend after an ambiguous transport result. A zero-result search is not proof of absence.
      const found = await this.gmail.findSent(row.rfcMessageId);
      if (found) this.confirm(row, found);
      else
        this.update(
          row,
          "uncertain",
          null,
          "Provider acceptance uncertain; manual reconciliation required",
        );
      return;
    }
    try {
      checkSend(
        c,
        row,
        settings,
        this.locked,
        this.store.payloads<PIOutboxRecord>("pi_outbox"),
        this.store.now(),
      );
    } catch (error) {
      this.update(
        row,
        settings.mode === "draft_only" || this.locked ? "draft" : "blocked",
        null,
        error instanceof Error ? error.message : "Send blocked",
      );
      return;
    }
    // Claim transition and daily quota/cooldown check occur atomically before provider I/O.
    row = this.store.tx(() => {
      const current = this.get(outboxId);
      requirePolicy(
        !["sending", "sent", "uncertain"].includes(current.state),
        "Outbox already claimed",
      );
      checkSend(
        c,
        current,
        this.store.settings(),
        this.locked,
        this.store.payloads<PIOutboxRecord>("pi_outbox"),
        this.store.now(),
      );
      return this.update(current, "sending");
    });
    const message = this.store.detail(row.caseId).messages.at(-1)!;
    try {
      const result = await this.gmail.sendReply(row, message);
      this.confirm(row, result);
    } catch {
      this.update(
        row,
        "uncertain",
        null,
        "Provider result unknown; no automatic resend",
      );
    }
  }
  simulate(outboxId: string) {
    const row = this.get(outboxId),
      c = this.store.getCase(row.caseId);
    requirePolicy(
      c.demo && c.mailbox.endsWith("@demo.invalid"),
      "Simulation only allowed for isolated demo cases",
    );
    if (row.state === "simulated") return;
    this.store.tx(() => {
      this.update(row, "simulated", `demo-${row.id}`);
      this.store.db
        .prepare(
          "UPDATE pi_approval_requests SET request_message_id=? WHERE outbox_id=? AND active=1",
        )
        .run(`demo-${row.id}`, row.id);
    });
  }
}
