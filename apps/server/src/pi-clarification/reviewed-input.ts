import { z } from "zod";
import { PIStore, digest } from "./store.js";
import { requirePolicy, sanitizeBody } from "./policy.js";

export const ReviewedInputSchema = z
  .object({
    summary: z.string().trim().min(20).max(12000),
    deidentifiedConfirmed: z.literal(true),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export class ReviewedInputService {
  constructor(readonly store: PIStore) {}
  sourceDigest(caseId: string) {
    const detail = this.store.detail(caseId);
    return digest({
      messages: detail.messages
        .map((m) => ({
          id: m.id,
          body: m.body,
          subject: m.subject,
          direction: m.direction,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      specs: detail.specs.map((s) => s.digest),
    });
  }
  get(caseId: string): {
    summary: string;
    sourceDigest: string;
    reviewedAt: string;
    current: boolean;
  } | null {
    const row = this.store.db
      .prepare("SELECT * FROM pi_reviewed_inputs WHERE case_id=?")
      .get(caseId) as
      { body: string; source_digest: string; reviewed_at: string } | undefined;
    return row
      ? {
          summary: row.body,
          sourceDigest: row.source_digest,
          reviewedAt: row.reviewed_at,
          current: row.source_digest === this.sourceDigest(caseId),
        }
      : null;
  }
  save(caseId: string, input: unknown) {
    const parsed = ReviewedInputSchema.parse(input);
    return this.store.tx(() => {
      this.store.getCase(caseId);
      requirePolicy(
        parsed.sourceDigest === this.sourceDigest(caseId),
        "Thread/specification changed while you were reviewing; reload and review the latest input",
      );
      // A human review is mandatory: regular expressions cannot prove free text has no PHI.
      requirePolicy(
        !/\b(?:patient\s*(?:name)?|DOB|DOS|date of (?:birth|service)|MRN|SSN|member\s*id)\s*[:=#-]\s*(?!\[|redacted|removed)\S+/i.test(
          parsed.summary,
        ),
        "Remove patient identifiers and service dates from the summary",
      );
      const body = sanitizeBody(parsed.summary);
      requirePolicy(
        body.length >= 20,
        "Reviewed summary is too short after sanitization",
      );
      this.store.db
        .prepare(
          "INSERT INTO pi_reviewed_inputs VALUES(?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET source_digest=excluded.source_digest,body=excluded.body,reviewed_at=excluded.reviewed_at",
        )
        .run(caseId, this.sourceDigest(caseId), body, this.store.at());
      const currentCase = this.store.getCase(caseId);
      this.store.putCase(currentCase, currentCase.revision);
      this.store.event(caseId, "DEIDENTIFIED_INPUT_REVIEWED", "admin", {
        summaryDigest: digest(body),
        sourceDigest: this.sourceDigest(caseId),
        rawEmailProvidedToModel: false,
      });
      return this.get(caseId)!;
    });
  }
  requireCurrent(caseId: string) {
    const input = this.get(caseId);
    requirePolicy(
      input?.current,
      "Review a de-identified summary of the latest thread before running AI",
    );
    return input;
  }
}
