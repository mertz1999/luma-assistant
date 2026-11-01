import {
  PIMessageSchema,
  PIInvestigationResultSchema,
  type PIMessage,
  type PICase,
  type PIDecision,
} from "@luma/shared";
import { PIStore, id, digest } from "./store.js";
import { Workflow } from "./workflow.js";
import { ApprovalService } from "./approval.js";
import { HandoffService } from "./handoff.js";
import { OutboxService } from "./outbox.js";
import { ClarificationAgentRuntime, type Investigator } from "./runtime.js";
import {
  allowedInbound,
  requirePolicy,
  requirePrivacy,
  sanitizeBody,
  safeTitle,
  redactTree,
} from "./policy.js";

export class CaseOrchestrator {
  constructor(
    readonly store: PIStore,
    readonly workflow: Workflow,
    readonly runtime: ClarificationAgentRuntime,
    readonly approvals: ApprovalService,
    readonly handoff: HandoffService,
    readonly outbox: OutboxService,
    readonly investigator: Investigator,
  ) {}
  ingest(input: PIMessage, demo = false): string | null {
    const m = PIMessageSchema.parse(input),
      s = this.store.settings();
    requirePolicy(m.demo === demo, "Demo transport marker mismatch");
    if (!demo) {
      requirePrivacy(s);
      requirePolicy(m.mailbox === s.mailbox, "Unexpected mailbox");
    }
    if (!allowedInbound(m, s)) return null;
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare(
          "SELECT case_id FROM pi_messages WHERE mailbox=? AND provider_id=?",
        )
        .get(m.mailbox, m.id) as { case_id: string } | undefined;
      if (existing) return existing.case_id;
      const row = this.store.db
        .prepare("SELECT id FROM pi_cases WHERE mailbox=? AND thread_id=?")
        .get(m.mailbox, m.threadId) as { id: string } | undefined;
      let c: PICase;
      if (row) c = this.store.getCase(row.id);
      else {
        const caseId = `PI-${this.store.now().getUTCFullYear()}-${String((this.store.db.prepare("SELECT COUNT(*) AS n FROM pi_cases").get() as { n: number }).n + 1).padStart(4, "0")}`;
        c = {
          id: caseId,
          mailbox: m.mailbox,
          threadId: m.threadId,
          title: demo ? m.subject : safeTitle(m.subject),
          summary: "",
          workflow: (() => {
            const scopes =
              s.contacts.find(
                (x) => x.address === m.from && x.active && x.canClarify,
              )?.workflows || [];
            const matches = [
              ...new Set(
                s.workflowRules
                  .filter(
                    (r) =>
                      m.subject
                        .toLowerCase()
                        .includes(r.subjectContains.toLowerCase()) &&
                      (!scopes.length || scopes.includes(r.workflow)),
                  )
                  .map((r) => r.workflow),
              ),
            ];
            return matches.length === 1
              ? matches[0]
              : scopes.length === 1
                ? scopes[0]
                : "unclassified";
          })(),
          state: "RECEIVED",
          classification: "unclear",
          priority: "normal",
          riskLevel:
            /\b(?:ehr|patient|authorization|insurance|billing|linkage|phi|bulk data|migration|access control)\b/i.test(
              `${m.subject} ${m.body}`,
            )
              ? "high"
              : "medium",
          owner: "PI Clarification Agent",
          revision: 0,
          specVersion: 0,
          demo,
          createdAt: this.store.at(),
          updatedAt: this.store.at(),
          slaAt: new Date(
            this.store.now().getTime() + s.slaHours * 3600000,
          ).toISOString(),
        };
        this.store.db
          .prepare("INSERT INTO pi_cases VALUES(?,?,?,?,?,?)")
          .run(
            c.id,
            c.mailbox,
            c.threadId,
            c.state,
            c.revision,
            JSON.stringify(c),
          );
        this.store.event(c.id, "CASE_RECEIVED", "gmail", {
          messageId: m.id,
          threadId: m.threadId,
          demo,
        });
      }
      const sanitized = {
        ...m,
        body: sanitizeBody(m.body),
        subject: sanitizeBody(m.subject),
      };
      this.store.db
        .prepare("INSERT INTO pi_messages VALUES(?,?,?,?,?)")
        .run(m.mailbox, m.id, c.id, JSON.stringify(sanitized), m.date);
      c = this.store.putCase(c, c.revision);
      this.store.event(c.id, "MESSAGE_RECEIVED", "gmail", {
        messageId: m.id,
        identityVerified: m.identityVerified,
        demo,
      });
      // Approval replies are processed by the leased per-case worker, never concurrently in webhooks.
      this.store.enqueue(
        "message",
        `message:${m.mailbox}:${m.id}`,
        { messageId: m.id },
        c.id,
      );
      return c.id;
    });
  }
  receiveMessage(caseId: string, messageId: string) {
    return this.store.tx(() => {
      const d = this.store.detail(caseId),
        m = d.messages.find((x) => x.id === messageId);
      requirePolicy(m, "Message not found");
      const approval = this.approvals.receive(caseId, m);
      if (
        approval?.result === "approved" ||
        approval?.result === "rejected" ||
        this.store.getCase(caseId).state === "ESCALATED"
      )
        return;
      const c = this.store.getCase(caseId);
      if (c.state === "SUSPENDED") return;
      if (
        c.specVersion &&
        (!approval || approval.result === "ambiguous") &&
        !["RECEIVED", "TRIAGING"].includes(c.state)
      ) {
        // Any fresh request after authorization invalidates it conservatively until reviewed.
        this.workflow.reopen(
          caseId,
          ["Review the client's latest reply for material scope changes"],
          "gmail",
          true,
        );
      } else if (
        !["RECEIVED", "TRIAGING", "AWAITING_SCOPE_APPROVAL"].includes(c.state)
      )
        this.workflow.transition(
          caseId,
          "TRIAGING",
          "gmail",
          "Client replied",
          [m.id],
        );
      if (!approval || approval.result === "ambiguous")
        this.store.enqueue("reason", `reason:message:${m.id}`, {}, caseId);
    });
  }
  async runCase(caseId: string, jobId?: string) {
    if (
      jobId &&
      this.store.db
        .prepare("SELECT 1 FROM pi_job_effects WHERE job_id=?")
        .get(jobId)
    )
      return;
    const c = this.store.getCase(caseId),
      s = this.store.settings();
    if (jobId) {
      const state = c.state;
      if (
        [
          "SUSPENDED",
          "CLOSED",
          "ESCALATED",
          "REJECTED",
          "DUPLICATE",
          "HANDED_OFF",
          "BLOCKED",
          "AWAITING_SCOPE_APPROVAL",
        ].includes(state)
      )
        return;
      const detail = this.store.detail(caseId);
      if (
        state === "INVESTIGATING" &&
        detail.investigations.some(
          (i) => i.state === "pending" || i.state === "running",
        )
      )
        return;
      const lastQuestion = detail.outbox
        .filter((o) => o.kind === "clarification")
        .at(-1);
      if (
        state === "NEEDS_CLIENT_DETAILS" &&
        lastQuestion &&
        Date.parse(detail.messages.at(-1)!.date) <=
          Date.parse(lastQuestion.createdAt)
      )
        return;
    }
    requirePolicy(
      c.demo || (!s.paused && s.mode !== "disabled" && s.mode !== "replay"),
      "Agent paused or disabled",
    );
    requirePolicy(
      ![
        "SUSPENDED",
        "CLOSED",
        "ESCALATED",
        "REJECTED",
        "DUPLICATE",
        "HANDED_OFF",
      ].includes(c.state),
      "Case is not runnable",
    );
    if (c.state === "RECEIVED")
      this.workflow.transition(
        caseId,
        "TRIAGING",
        "orchestrator",
        "Begin case triage",
      );
    const detail = this.store.detail(caseId),
      result = await this.runtime.run(detail, c.demo);
    this.store.tx(() => {
      requirePolicy(
        this.store.getCase(caseId).revision === detail.case.revision,
        "Case changed during reasoning; stale proposal rejected",
      );
      this.execute(caseId, result.decision, result.runId, result.promptVersion);
      if (jobId)
        this.store.db
          .prepare("INSERT OR IGNORE INTO pi_job_effects VALUES(?,?)")
          .run(jobId, this.store.at());
    });
  }
  execute(caseId: string, d: PIDecision, runId: string, promptVersion: string) {
    let c = this.store.getCase(caseId);
    requirePolicy(
      d.caseId === caseId &&
        d.observedSpecVersion === c.specVersion &&
        d.caseState === c.state,
      "Stale decision rejected",
    );
    const risk =
      ["low", "medium", "high", "critical"].indexOf(c.riskLevel) >
      ["low", "medium", "high", "critical"].indexOf(d.riskLevel)
        ? c.riskLevel
        : d.riskLevel;
    c = this.store.putCase(
      {
        ...c,
        classification: d.classification,
        priority: d.priority,
        riskLevel: risk,
      },
      c.revision,
    );
    this.store.event(caseId, "DECISION_PROPOSED", "runtime", {
      runId,
      promptVersion,
      decision: d.decision,
      rationale: sanitizeBody(d.rationale),
      evidenceRefs: d.factEvidenceIds,
      policyDecision: "server-validation-required",
    });
    if (
      ["high", "critical"].includes(risk) &&
      !["PROPOSE_SPEC", "ESCALATE", "WAIT", "REQUEST_INVESTIGATION"].includes(
        d.decision,
      )
    ) {
      this.workflow.transition(
        caseId,
        "ESCALATED",
        "policy",
        "High risk decision requires human review",
        d.factEvidenceIds,
        { runId, promptVersion },
      );
      return;
    }
    switch (d.decision) {
      case "WAIT":
        return;
      case "REQUEST_INVESTIGATION": {
        const request = d.requestedInvestigation!;
        const settings = this.store.settings();
        if (
          !c.demo &&
          (!settings.investigationEnabled ||
            !process.env.PI_INVESTIGATOR_URL ||
            process.env.PI_INVESTIGATOR_READONLY_VERIFIED !== "true")
        ) {
          const requestId = id("investigation");
          this.store.db
            .prepare("INSERT INTO pi_investigation_requests VALUES(?,?,?)")
            .run(
              requestId,
              caseId,
              JSON.stringify({
                id: requestId,
                state: "unavailable",
                request,
                error: "No verified read-only Investigator configured",
              }),
            );
          this.store.event(caseId, "INVESTIGATION_UNAVAILABLE", "policy", {
            requestId,
            reason: "Read-only isolation is not configured/verified",
          });
          this.workflow.transition(
            caseId,
            "BLOCKED",
            "policy",
            "Investigator unavailable; review known evidence or configure isolated service",
            [requestId],
          );
          return;
        }
        requirePolicy(
          c.demo ||
            request.repositories.every((r) =>
              settings.investigationRepositories.includes(r),
            ),
          "Investigator repository outside configured scope",
        );
        requirePolicy(
          request.correlationId === caseId &&
            request.permissions === "read_only",
          "Investigation scope mismatch",
        );
        const requestId = id("investigation");
        this.store.db
          .prepare("INSERT INTO pi_investigation_requests VALUES(?,?,?)")
          .run(
            requestId,
            caseId,
            JSON.stringify({
              id: requestId,
              request,
              state: "pending",
              createdAt: this.store.at(),
            }),
          );
        this.workflow.transition(
          caseId,
          "INVESTIGATING",
          "orchestrator",
          "Read-only evidence requested",
          [requestId],
          { runId, promptVersion },
        );
        this.store.enqueue("investigate", requestId, { requestId }, caseId);
        return;
      }
      case "SEND_CLARIFICATION":
      case "ANSWER_USAGE_QUESTION": {
        requirePolicy(
          d.emailDraft?.kind ===
            (d.decision === "SEND_CLARIFICATION" ? "clarification" : "answer"),
          "Email kind does not match decision",
        );
        requirePolicy(
          d.decision !== "ANSWER_USAGE_QUESTION" ||
            (d.classification === "usage_question" &&
              d.factEvidenceIds.length > 0 &&
              !d.uncertainties.length &&
              !d.blockingQuestions.length),
          "Usage answer requires confirmed evidence and no uncertainty",
        );
        // The source contact and configured routing determine scope, never model-selected recipients.
        if (c.workflow === "unclassified") {
          const source = this.store.detail(caseId).messages[0];
          const sourceContact = this.store
            .settings()
            .contacts.find(
              (x) => x.active && x.canClarify && x.address === source.from,
            );
          const targetContacts = this.store
            .settings()
            .contacts.filter((x) => d.emailDraft!.contactIds.includes(x.id));
          const scopes =
            sourceContact?.workflows.filter(
              (w) =>
                targetContacts.length === d.emailDraft!.contactIds.length &&
                targetContacts.every(
                  (x) => x.active && x.workflows.includes(w),
                ),
            ) || [];
          requirePolicy(
            scopes.length === 1,
            "Workflow scope is ambiguous; configure subject routing or assign a workflow as an administrator",
          );
          c = this.store.putCase({ ...c, workflow: scopes[0] }, c.revision);
        }
        requirePolicy(
          !/\b(?:fixed|deployed|resolved|tested|completed)\b/i.test(
            d.emailDraft!.bodyText,
          ),
          "No verified completion/release evidence exists; completion claims prohibited",
        );
        this.outbox.prepare(
          caseId,
          d.emailDraft!.kind,
          d.emailDraft!.contactIds,
          d.emailDraft!.bodyText,
          `decision:${runId}`,
        );
        if (d.decision === "SEND_CLARIFICATION")
          this.workflow.transition(
            caseId,
            "NEEDS_CLIENT_DETAILS",
            "orchestrator",
            "Focused clarification prepared",
            d.factEvidenceIds,
            { runId, promptVersion },
          );
        return;
      }
      case "PROPOSE_SPEC":
      case "RECORD_CLIENT_CHANGE_REQUEST": {
        requirePolicy(d.proposedSpec, "No proposed specification");
        requirePolicy(
          d.blockingQuestions.every((q) =>
            d.proposedSpec!.openQuestions.includes(q),
          ),
          "Blocking questions must be retained in proposed specification",
        );
        const confirmed = this.store
          .detail(caseId)
          .investigations.flatMap((i) =>
            (
              (i.result as { confirmedFacts?: { evidenceRefs: string[] }[] })
                ?.confirmedFacts || []
            ).flatMap((f) => f.evidenceRefs),
          );
        requirePolicy(
          d.proposedSpec.investigationEvidenceRefs.every((e) =>
            confirmed.includes(e),
          ),
          "Specification cites unverified investigation findings",
        );
        this.workflow.propose(
          caseId,
          {
            ...d.proposedSpec,
            riskLevel: ["high", "critical"].includes(c.riskLevel)
              ? c.riskLevel
              : d.proposedSpec.riskLevel,
          },
          runId,
        );
        if (this.store.getCase(caseId).state === "DRAFT_SPEC")
          this.store.enqueue(
            "reason",
            `reason:spec:${caseId}:${this.store.getCase(caseId).specVersion}`,
            {},
            caseId,
          );
        return;
      }
      case "REQUEST_SCOPE_APPROVAL":
        this.approvals.request(caseId, d.emailDraft?.contactIds || []);
        return;
      case "PUBLISH_APPROVED_TASK":
        this.handoff.publish(caseId);
        return;
      case "ESCALATE":
        this.workflow.transition(
          caseId,
          "ESCALATED",
          "orchestrator",
          sanitizeBody(d.escalation?.reason || d.rationale),
          d.factEvidenceIds,
          { runId, promptVersion },
        );
        return;
      case "CLOSE_CASE":
        requirePolicy(
          d.classification === "usage_question" &&
            d.factEvidenceIds.length > 0 &&
            !d.blockingQuestions.length,
          "Only evidenced product questions can close automatically",
        );
        this.workflow.transition(
          caseId,
          "CLOSED",
          "orchestrator",
          "Evidenced usage question completed",
          d.factEvidenceIds,
          { runId, promptVersion },
        );
        return;
    }
  }
  async investigate(caseId: string, requestId: string) {
    const row = this.store
      .detail(caseId)
      .investigations.find((x) => x.id === requestId);
    requirePolicy(row, "Investigation not found");
    if (["completed", "unavailable"].includes(String(row.state))) return;
    const request =
      row.request as import("@luma/shared").PIInvestigationRequest;
    let result: import("@luma/shared").PIInvestigationResult | undefined;
    try {
      result = PIInvestigationResultSchema.parse(
        redactTree(
          await this.investigator.investigate(
            request,
            AbortSignal.timeout(request.timeoutSeconds * 1000),
          ),
        ),
      );
      requirePolicy(
        result.correlationId === caseId,
        "Investigator result correlation mismatch",
      );
    } catch {
      result = undefined;
    }
    this.store.tx(() => {
      const next = result
        ? { ...row, state: "completed", result }
        : {
            ...row,
            state: "unavailable",
            error:
              "Investigator unavailable or invalid; no technical conclusions confirmed",
          };
      this.store.db
        .prepare("UPDATE pi_investigation_requests SET payload=? WHERE id=?")
        .run(JSON.stringify(next), requestId);
      this.store.event(
        caseId,
        result ? "INVESTIGATION_COMPLETED" : "INVESTIGATION_UNAVAILABLE",
        "investigator",
        {
          requestId,
          evidenceRefs:
            result?.confirmedFacts.flatMap((f) => f.evidenceRefs) || [],
        },
      );
      if (this.store.getCase(caseId).state === "INVESTIGATING")
        this.workflow.transition(
          caseId,
          "TRIAGING",
          "investigator",
          "Investigation finished; use only available confirmed evidence",
          [requestId],
        );
      this.store.enqueue(
        "reason",
        `reason:investigation:${requestId}`,
        {},
        caseId,
      );
    });
  }
}
