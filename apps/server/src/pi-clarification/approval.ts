import {
  PIApprovalRecordSchema,
  type PIApprovalRecord,
  type PIMessage,
} from "@luma/shared";
import { PIStore, id, digest } from "./store.js";
import { Workflow } from "./workflow.js";
import { OutboxService } from "./outbox.js";
import { highRisk, requirePolicy, sanitizeBody } from "./policy.js";

type RequestRow = {
  id: string;
  case_id: string;
  spec_id: string;
  outbox_id: string;
  request_message_id: string | null;
  digest: string;
  active: number;
};
export class ApprovalService {
  constructor(
    readonly store: PIStore,
    readonly workflow: Workflow,
    readonly outbox: OutboxService,
  ) {}
  request(caseId: string, contactIds: string[]) {
    return this.store.tx(() => {
      const c = this.store.getCase(caseId),
        spec = this.workflow.currentSpec(caseId);
      requirePolicy(
        c.state === "DRAFT_SPEC" || c.state === "AWAITING_SCOPE_APPROVAL",
        "Case not awaiting a proposal",
      );
      requirePolicy(
        !highRisk(spec.spec, this.store.settings()),
        "High-risk scope requires human escalation",
      );
      requirePolicy(
        !spec.spec.openQuestions.length,
        "Resolve blocking questions before approval",
      );
      const body = `Proposed scope for ${c.id} v${spec.version}\nDigest: ${spec.digest}\n\nProblem: ${spec.spec.problemStatement}\nCurrent behavior: ${spec.spec.observedBehavior}\nExpected behavior: ${spec.spec.expectedBehavior}\n\nIn scope:\n${spec.spec.inScope.map((x) => `- ${x}`).join("\n")}\n\nExcluded:\n${spec.spec.outOfScope.map((x) => `- ${x}`).join("\n")}\n\nAcceptance criteria:\n${spec.spec.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}\n\nReply on this thread with exactly APPROVE ${c.id} v${spec.version} or REJECT ${c.id} v${spec.version}. Otherwise describe the requested changes. This approves scope only; no production deployment is authorized.`;
      const row = this.outbox.prepare(
        caseId,
        "approval",
        contactIds,
        body,
        `approval:${caseId}:${spec.version}`,
      );
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO pi_approval_requests(id,case_id,spec_id,outbox_id,digest) VALUES(?,?,?,?,?)",
        )
        .run(id("approval-request"), caseId, spec.id, row.id, spec.digest);
      if (c.state !== "AWAITING_SCOPE_APPROVAL")
        this.workflow.transition(
          caseId,
          "AWAITING_SCOPE_APPROVAL",
          "approval-service",
          "Exact version approval requested",
          [row.id, spec.id],
        );
      return row;
    });
  }
  receive(caseId: string, message: PIMessage): PIApprovalRecord | null {
    return this.store.tx(() => {
      const c = this.store.getCase(caseId);
      if (!c.specVersion) return null;
      const existing = this.store
        .detail(caseId)
        .approvals.find((a) => a.approvalReplyGmailMessageId === message.id);
      if (existing) return existing;
      const spec = this.workflow.currentSpec(caseId);
      const request = this.store.db
        .prepare(
          "SELECT * FROM pi_approval_requests WHERE case_id=? AND spec_id=? AND active=1",
        )
        .get(caseId, spec.id) as RequestRow | undefined;
      if (!request) return null;
      const s = this.store.settings(),
        contact = s.contacts.find(
          (x) => x.address === message.from.toLowerCase(),
        );
      const reasons: string[] = [];
      const stored = this.store
        .detail(caseId)
        .messages.find((m) => m.id === message.id);
      if (!stored || digest(stored) !== digest(message))
        reasons.push(
          "Reply is not durably ingested as matching transport evidence for this case",
        );
      const out = this.outbox.get(request.outbox_id);
      const authorized = Boolean(
        contact?.active &&
          contact.canApproveScope &&
          contact.canClarify &&
          contact.workflows.includes(spec.spec.workflow) &&
          out.recipients.includes(message.from.toLowerCase()),
      );
      if (!authorized)
        reasons.push(
          "Sender lacks a current authorized approver role/scope or was not a proposal recipient",
        );
      if (!message.identityVerified)
        reasons.push("Gmail transport sender authentication not verified");
      if (message.threadId !== c.threadId || message.mailbox !== c.mailbox)
        reasons.push("Reply thread/mailbox mismatch");
      if (
        !request.request_message_id ||
        !["sent", "simulated"].includes(out.state)
      )
        reasons.push("Proposal was not confirmed delivered");
      const replyRefs = `${message.inReplyTo} ${message.references}`.split(
        /\s+/,
      );
      if (!replyRefs.includes(out.rfcMessageId))
        reasons.push(
          "Reply is not linked to the approval request RFC Message-ID",
        );
      if (
        request.digest !== spec.digest ||
        digest(spec.spec) !== spec.digest ||
        out.specVersion !== spec.version
      )
        reasons.push("Specification digest/version mismatch");
      if (Date.parse(message.date) < Date.parse(out.createdAt))
        reasons.push("Reply predates proposal");
      if (
        /\b(?:forwarded message|begin forwarded|fwd:|original message)\b/i.test(
          `${message.subject}\n${message.body}`,
        )
      )
        reasons.push("Forwarded approval is not valid evidence");
      const body = sanitizeBody(message.body).trim();
      const approval = `APPROVE ${c.id} v${spec.version}`,
        rejection = `REJECT ${c.id} v${spec.version}`;
      const explicitlyAffirmative = body === approval;
      const rejected = body === rejection;
      if (!explicitlyAffirmative && !rejected)
        reasons.push(
          "Reply is ambiguous or does not explicitly approve the current version",
        );
      const result: PIApprovalRecord["result"] = reasons.length
        ? authorized
          ? "ambiguous"
          : "invalid"
        : rejected
          ? "rejected"
          : "approved";
      const record = PIApprovalRecordSchema.parse({
        approvalId: id("approval"),
        caseId,
        specId: spec.id,
        specVersion: spec.version,
        specDigest: spec.digest,
        approvalRequestGmailMessageId:
          request.request_message_id || "not-delivered",
        approvalReplyGmailMessageId: message.id,
        approverContactId: contact?.id || "unknown",
        approverAddress: message.from,
        authorizationPolicyId: `policy:${digest(s)}`,
        authorized,
        explicitlyAffirmative,
        timestamp: this.store.at(),
        result,
        verificationReasons: reasons.length
          ? reasons
          : [
              "Authenticated authorized recipient explicitly replied to exact delivered specification",
            ],
      });
      this.store.db
        .prepare("INSERT INTO pi_approvals VALUES(?,?,?,?,?)")
        .run(
          record.approvalId,
          caseId,
          spec.id,
          message.id,
          JSON.stringify(record),
        );
      this.store.event(caseId, "APPROVAL_EVALUATED", "approval-service", {
        approvalId: record.approvalId,
        result,
        verificationReasons: record.verificationReasons,
      });
      if (result === "approved") {
        const conflicting = this.store
          .detail(caseId)
          .approvals.some(
            (a) => a.specId === spec.id && a.result === "rejected",
          );
        if (conflicting || highRisk(spec.spec, s))
          this.workflow.transition(
            caseId,
            "ESCALATED",
            "approval-service",
            "Conflicting approval or consequential workflow requires review",
            [record.approvalId],
          );
        else {
          requirePolicy(
            c.state === "AWAITING_SCOPE_APPROVAL",
            "Case cannot currently accept approval",
          );
          this.workflow.transition(
            caseId,
            "READY_FOR_IMPLEMENTATION",
            "approval-service",
            "Verified explicit scope approval",
            [record.approvalId],
          );
          this.store.enqueue(
            "handoff",
            `handoff:${caseId}:${spec.version}`,
            {},
            caseId,
          );
        }
      } else if (
        result === "rejected" &&
        this.store
          .detail(caseId)
          .approvals.some(
            (a) => a.specId === spec.id && a.result === "approved",
          )
      ) {
        for (const task of this.store
          .detail(caseId)
          .handoffs.filter((t) => t.handoffStatus === "queued"))
          this.store.db
            .prepare("UPDATE pi_task_handoffs SET payload=? WHERE id=?")
            .run(
              JSON.stringify({ ...task, handoffStatus: "cancelled" }),
              task.taskId,
            );
        if (c.state !== "ESCALATED")
          this.workflow.transition(
            caseId,
            "ESCALATED",
            "approval-service",
            "Conflicting explicit scope decisions require human review",
            [record.approvalId],
          );
      } else if (result === "rejected" && c.state === "AWAITING_SCOPE_APPROVAL")
        this.workflow.transition(
          caseId,
          "REJECTED",
          "approval-service",
          "Authorized stakeholder rejected current scope",
          [record.approvalId],
        );
      else if (
        (!authorized || !message.identityVerified) &&
        c.state !== "ESCALATED"
      )
        this.workflow.transition(
          caseId,
          "ESCALATED",
          "approval-service",
          "Suspicious or unauthorized approval attempt",
          [record.approvalId],
        );
      return record;
    });
  }
}
