import type { PIState, PICase, PISpec, PISpecRecord } from "@luma/shared";
import { PISpecSchema } from "@luma/shared";
import { PIStore, id, digest } from "./store.js";
import { requirePolicy, highRisk, redactTree } from "./policy.js";

const edges: Record<PIState, PIState[]> = {
  RECEIVED: ["TRIAGING"],
  TRIAGING: ["INVESTIGATING", "NEEDS_CLIENT_DETAILS", "DRAFT_SPEC", "CLOSED"],
  INVESTIGATING: ["TRIAGING", "NEEDS_CLIENT_DETAILS", "DRAFT_SPEC"],
  NEEDS_CLIENT_DETAILS: ["TRIAGING", "INVESTIGATING", "DRAFT_SPEC"],
  DRAFT_SPEC: [
    "INVESTIGATING",
    "NEEDS_CLIENT_DETAILS",
    "AWAITING_SCOPE_APPROVAL",
    "READY_FOR_IMPLEMENTATION",
    "TRIAGING",
  ],
  AWAITING_SCOPE_APPROVAL: [
    "READY_FOR_IMPLEMENTATION",
    "DRAFT_SPEC",
    "TRIAGING",
    "NEEDS_CLIENT_DETAILS",
    "REJECTED",
  ],
  READY_FOR_IMPLEMENTATION: ["HANDED_OFF", "DRAFT_SPEC", "TRIAGING"],
  HANDED_OFF: ["TRIAGING", "CLOSED"],
  BLOCKED: ["TRIAGING"],
  ESCALATED: ["TRIAGING"],
  REJECTED: ["TRIAGING"],
  DUPLICATE: ["TRIAGING"],
  CLOSED: ["TRIAGING"],
  SUSPENDED: ["TRIAGING"],
};
export class Workflow {
  constructor(readonly store: PIStore) {}
  transition(
    caseId: string,
    next: PIState,
    actor: string,
    reason: string,
    evidenceRefs: string[] = [],
    metadata: Record<string, unknown> = {},
  ): PICase {
    return this.store.tx(() => {
      const c = this.store.getCase(caseId);
      requirePolicy(c.state !== next, "Already in requested state");
      requirePolicy(
        edges[c.state].includes(next) ||
          ["BLOCKED", "ESCALATED", "SUSPENDED", "DUPLICATE"].includes(next),
        `Invalid state transition ${c.state} → ${next}`,
      );
      if (next === "READY_FOR_IMPLEMENTATION")
        requirePolicy(
          actor === "approval-service" || actor === "handoff-service",
          "Only backend authorization services can mark ready",
        );
      if (next === "HANDED_OFF")
        requirePolicy(
          actor === "handoff-service",
          "Only handoff service can mark handed off",
        );
      const updated = this.store.putCase({ ...c, state: next }, c.revision);
      const policies = this.store.settings();
      this.store.event(caseId, "STATE_TRANSITION", actor, {
        previous: c.state,
        next,
        reason,
        evidenceRefs,
        promptVersion: metadata.promptVersion || null,
        runId: metadata.runId || null,
        policyDecision: "allowed",
        policyDigest: digest(policies),
        ...metadata,
      });
      return updated;
    });
  }
  propose(caseId: string, input: PISpec, actor: string): PISpecRecord {
    return this.store.tx(() => {
      let spec = PISpecSchema.parse(redactTree(input));
      let c = this.store.getCase(caseId);
      requirePolicy(
        c.workflow === "unclassified" || c.workflow === spec.workflow,
        "Specification changes the configured case workflow; escalate scope routing for human review",
      );
      const sourceContact = this.store
        .settings()
        .contacts.find(
          (x) =>
            x.address === this.store.detail(caseId).messages[0]?.from &&
            x.active,
        );
      requirePolicy(
        !sourceContact || sourceContact.workflows.includes(spec.workflow),
        "Specification workflow is outside source contact authorization",
      );
      if (["high", "critical"].includes(c.riskLevel))
        spec = { ...spec, riskLevel: c.riskLevel };
      if (
        [
          "HANDED_OFF",
          "READY_FOR_IMPLEMENTATION",
          "AWAITING_SCOPE_APPROVAL",
          "CLOSED",
          "REJECTED",
        ].includes(c.state)
      )
        c = this.transition(
          caseId,
          "TRIAGING",
          actor,
          "Scope revision invalidates prior authorization",
        );
      requirePolicy(
        [
          "TRIAGING",
          "DRAFT_SPEC",
          "NEEDS_CLIENT_DETAILS",
          "INVESTIGATING",
        ].includes(c.state),
        "Case cannot accept a specification",
      );
      const record: PISpecRecord = {
        id: id("spec"),
        caseId,
        version: c.specVersion + 1,
        digest: digest(spec),
        spec,
        createdAt: this.store.at(),
        author: actor,
        sourceMessageIds: this.store.detail(caseId).messages.map((m) => m.id),
      };
      this.store.db
        .prepare("INSERT INTO pi_specs VALUES(?,?,?,?,?)")
        .run(
          record.id,
          caseId,
          record.version,
          record.digest,
          JSON.stringify(record),
        );
      this.store.db
        .prepare("UPDATE pi_approval_requests SET active=0 WHERE case_id=?")
        .run(caseId);
      for (const row of this.store
        .payloads<{
          taskId: string;
          handoffStatus: string;
        }>("pi_task_handoffs", caseId)
        .filter((t) => t.handoffStatus === "queued")) {
        this.store.db
          .prepare("UPDATE pi_task_handoffs SET payload=? WHERE id=?")
          .run(
            JSON.stringify({ ...row, handoffStatus: "cancelled" }),
            row.taskId,
          );
      }
      for (const row of this.store
        .detail(caseId)
        .outbox.filter((r) =>
          ["prepared", "draft", "blocked"].includes(r.state),
        ))
        this.store.db
          .prepare(
            "UPDATE pi_outbox SET state='cancelled',payload=? WHERE id=?",
          )
          .run(JSON.stringify({ ...row, state: "cancelled" }), row.id);
      c = this.store.getCase(caseId);
      this.store.putCase(
        {
          ...c,
          specVersion: record.version,
          workflow: spec.workflow,
          classification: spec.type,
          riskLevel: highRisk(spec, this.store.settings())
            ? "high"
            : spec.riskLevel,
        },
        c.revision,
      );
      if (this.store.getCase(caseId).state !== "DRAFT_SPEC")
        this.transition(
          caseId,
          "DRAFT_SPEC",
          actor,
          "Versioned specification proposed",
          [record.id],
        );
      this.store.event(caseId, "SPEC_PROPOSED", actor, {
        specId: record.id,
        version: record.version,
        digest: record.digest,
      });
      if (highRisk(spec, this.store.settings()))
        this.transition(
          caseId,
          "ESCALATED",
          "policy",
          "High-impact workflow requires human review; autonomous handoff prohibited",
          [record.id],
        );
      return record;
    });
  }
  currentSpec(caseId: string) {
    const c = this.store.getCase(caseId);
    const r = this.store
      .payloads<PISpecRecord>("pi_specs", caseId)
      .find((s) => s.version === c.specVersion);
    requirePolicy(r, "No current specification");
    return r;
  }
  reopen(
    caseId: string,
    questions: string[],
    actor: string,
    materiallyChanged = true,
  ) {
    return this.store.tx(() => {
      if (materiallyChanged)
        this.store.db
          .prepare("UPDATE pi_approval_requests SET active=0 WHERE case_id=?")
          .run(caseId);
      for (const t of this.store.detail(caseId).handoffs)
        this.store.db
          .prepare("UPDATE pi_task_handoffs SET payload=? WHERE id=?")
          .run(JSON.stringify({ ...t, handoffStatus: "returned" }), t.taskId);
      const c = this.store.getCase(caseId);
      if (c.state !== "TRIAGING")
        this.transition(caseId, "TRIAGING", actor, "RETURN_FOR_CLARIFICATION");
      this.store.event(caseId, "RETURN_FOR_CLARIFICATION", actor, {
        questions,
        materiallyChanged,
      });
      if (materiallyChanged && c.specVersion) {
        const current = this.currentSpec(caseId);
        this.propose(
          caseId,
          { ...current.spec, openQuestions: questions },
          actor,
        );
      }
    });
  }
}
