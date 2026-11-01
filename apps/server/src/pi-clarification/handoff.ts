import { threadAuthorized } from "./thread-policy.js";
import {
  PIImplementationTaskSchema,
  type PIImplementationTask,
  type PISpecRecord,
  type PIApprovalRecord,
} from "@luma/shared";
import { PIStore, id, digest } from "./store.js";
import { Workflow } from "./workflow.js";
import { highRisk, requirePolicy } from "./policy.js";

export class HandoffService {
  constructor(
    readonly store: PIStore,
    readonly workflow: Workflow,
  ) {}
  publish(caseId: string, standingId?: string): PIImplementationTask {
    return this.store.tx(() => {
      let c = this.store.getCase(caseId);
      requirePolicy(
        c.demo || threadAuthorized(this.store, c.mailbox, c.threadId),
        "Thread no longer meets the required sender policy",
      );
      const r = this.workflow.currentSpec(caseId),
        s = this.store.settings();
      const detail = this.store.detail(caseId);
      const existing = detail.handoffs.find((x) => x.specVersion === r.version);
      if (existing) {
        requirePolicy(
          existing.handoffStatus === "queued",
          "Previous handoff returned/cancelled; create a new version",
        );
      }
      requirePolicy(
        ![
          "ESCALATED",
          "SUSPENDED",
          "REJECTED",
          "BLOCKED",
          "DUPLICATE",
          "CLOSED",
        ].includes(c.state),
        "Case blocked from handoff",
      );
      requirePolicy(
        !highRisk(r.spec, s) && !["high", "critical"].includes(c.riskLevel),
        "High-impact work requires human review; no autonomous implementation authorization",
      );
      requirePolicy(
        !r.spec.openQuestions.length,
        "Open questions prohibit handoff",
      );
      requirePolicy(
        digest(r.spec) === r.digest,
        "Specification digest invalid",
      );
      standingId = standingId || existing?.standingAuthorizationId;
      let approvalId: string | undefined;
      if (standingId) {
        const standing = s.standingAuthorizations.find(
          (x) => x.id === standingId,
        );
        requirePolicy(
          standing &&
            Date.parse(standing.expiresAt) > this.store.now().getTime(),
          "Standing authorization missing or expired",
        );
        const historical = this.store
          .payloads<PISpecRecord>("pi_specs")
          .find((x) => x.digest === standing.historicalSpecDigest);
        const approver = s.contacts.find(
          (x) => x.id === standing.approverContactId,
        );
        const historicalApproval = this.store
          .payloads<PIApprovalRecord>("pi_approvals")
          .some(
            (x) =>
              x.approvalId === standing.evidenceRef &&
              x.authorized &&
              x.explicitlyAffirmative &&
              x.specId === historical?.id &&
              x.result === "approved" &&
              x.approverContactId === standing.approverContactId,
          );
        requirePolicy(
          approver?.active &&
            approver.canApproveScope &&
            approver.workflows.includes(r.spec.workflow) &&
            historicalApproval,
          "Standing authorization lacks historical approval evidence",
        );
        requirePolicy(
          r.spec.type === "bug_regression" &&
            r.spec.riskLevel === "low" &&
            r.spec.workflow === standing.workflow &&
            r.spec.inScope.every((x) => standing.allowedScope.includes(x)),
          "Regression outside standing policy",
        );
        const behavior = (spec: PISpecRecord["spec"]) => ({
          workflow: spec.workflow,
          expectedBehavior: spec.expectedBehavior,
          affectedApplications: spec.affectedApplications,
          inScope: spec.inScope,
          outOfScope: spec.outOfScope,
          acceptanceCriteria: spec.acceptanceCriteria,
          negativeTests: spec.negativeTests,
          edgeCases: spec.edgeCases,
          dataMigrationImpact: spec.dataMigrationImpact,
        });
        requirePolicy(
          historical &&
            digest(behavior(r.spec)) === digest(behavior(historical.spec)),
          "Regression must restore the exact historical approved behavior and test boundaries",
        );
        requirePolicy(
          detail.messages
            .filter((m) => m.direction !== "outgoing")
            .every((m) => (r.sourceMessageIds || []).includes(m.id)),
          "New client messages require specification review before standing authorization",
        );
        const evidenceIds = detail.investigations.flatMap((x) =>
          (
            (x.result as { confirmedFacts?: { evidenceRefs: string[] }[] })
              ?.confirmedFacts || []
          ).flatMap((f) => f.evidenceRefs),
        );
        requirePolicy(
          r.spec.investigationEvidenceRefs.length > 0 &&
            r.spec.investigationEvidenceRefs.every((e) =>
              evidenceIds.includes(e),
            ),
          "Regression reproduction evidence has not been verified",
        );
        requirePolicy(
          (existing && c.state === "HANDED_OFF") || c.state === "DRAFT_SPEC",
          "Standing authorization only applies to a reviewed draft",
        );
        if (!existing)
          this.workflow.transition(
            caseId,
            "READY_FOR_IMPLEMENTATION",
            "handoff-service",
            "Verified narrow standing regression authorization",
            [standing.id, historical!.id],
          );
        c = this.store.getCase(caseId);
      } else {
        const approval = detail.approvals.find(
          (x) =>
            x.specId === r.id &&
            x.result === "approved" &&
            x.specDigest === r.digest &&
            x.authorized &&
            x.explicitlyAffirmative,
        );
        requirePolicy(approval, "No valid exact-version approval");
        const contact = s.contacts.find(
          (x) => x.id === approval.approverContactId,
        );
        requirePolicy(
          contact?.active &&
            contact.canApproveScope &&
            contact.workflows.includes(r.spec.workflow),
          "Approver authorization revoked",
        );
        const active = this.store.db
          .prepare(
            "SELECT 1 FROM pi_approval_requests WHERE spec_id=? AND active=1 AND request_message_id=? AND digest=?",
          )
          .get(r.id, approval.approvalRequestGmailMessageId, r.digest);
        requirePolicy(active, "Approval invalidated by scope changes");
        requirePolicy(
          !detail.approvals.some(
            (x) => x.specId === r.id && x.result === "rejected",
          ),
          "Conflicting approval/rejection requires escalation",
        );
        requirePolicy(
          detail.messages
            .filter((m) => m.direction !== "outgoing")
            .every(
              (m) =>
                (r.sourceMessageIds || []).includes(m.id) ||
                m.id === approval.approvalReplyGmailMessageId,
            ),
          "New client messages require specification review before handoff",
        );
        requirePolicy(
          detail.messages.some(
            (m) => m.id === approval.approvalReplyGmailMessageId,
          ),
          "Approval transport evidence is not retained",
        );
        approvalId = approval.approvalId;
      }
      if (existing) return existing;
      requirePolicy(
        c.state === "READY_FOR_IMPLEMENTATION",
        "Case is not ready for implementation",
      );
      const task = PIImplementationTaskSchema.parse({
        ...r.spec,
        taskId: id("task"),
        caseId,
        title: `PI ${r.spec.type} · ${caseId}`,
        specVersion: r.version,
        specDigest: r.digest,
        approvalRecordId: approvalId,
        standingAuthorizationId: standingId,
        sourceGmailThreadId: c.threadId,
        createdAt: this.store.at(),
        handoffStatus: "queued",
      });
      this.store.db
        .prepare("INSERT INTO pi_task_handoffs VALUES(?,?,?,?)")
        .run(task.taskId, caseId, r.version, JSON.stringify(task));
      this.store.event(caseId, "TASK_READY", "handoff-service", {
        taskId: task.taskId,
        specVersion: r.version,
        specDigest: r.digest,
        approvalRecordId: approvalId || null,
        standingAuthorizationId: standingId || null,
        deploymentAuthorized: false,
        correlationId: caseId,
      });
      this.workflow.transition(
        caseId,
        "HANDED_OFF",
        "handoff-service",
        "Immutable task published to internal durable queue",
        [task.taskId],
      );
      return task;
    });
  }
}
