import type { PISpecRecord, PIApprovalRecord } from "@luma/shared";
import { PIStore } from "./store.js";

// A knowledge result is a historically approved snapshot, never an inferred code finding.
export class ApprovedKnowledge {
  constructor(readonly store: PIStore) {}
  search(workflows: string[], query = "", limit = 5) {
    const approvals = this.store
      .payloads<PIApprovalRecord>("pi_approvals")
      .filter(
        (a) =>
          a.result === "approved" && a.authorized && a.explicitlyAffirmative,
      );
    return this.store
      .payloads<PISpecRecord>("pi_specs")
      .filter(
        (r) =>
          workflows.includes(r.spec.workflow) &&
          approvals.some(
            (a) => a.specId === r.id && a.specDigest === r.digest,
          ) &&
          (!query ||
            `${r.spec.problemStatement} ${r.spec.expectedBehavior}`
              .toLowerCase()
              .includes(query.toLowerCase())),
      )
      .slice(-Math.min(limit, 10))
      .map((r) => ({
        evidenceId: r.id,
        caseId: r.caseId,
        version: r.version,
        digest: r.digest,
        workflow: r.spec.workflow,
        approvedBehavior: r.spec.expectedBehavior,
        scope: r.spec.inScope,
        exclusions: r.spec.outOfScope,
        historical: true,
      }));
  }
}
