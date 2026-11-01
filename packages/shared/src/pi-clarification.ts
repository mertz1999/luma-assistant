import { z } from "zod";

const text = z.string().trim().min(1).max(12000);
const short = z.string().trim().min(1).max(240);
const refs = z.array(short).max(100);
export const PIStateSchema = z.enum([
  "RECEIVED",
  "TRIAGING",
  "INVESTIGATING",
  "NEEDS_CLIENT_DETAILS",
  "DRAFT_SPEC",
  "AWAITING_SCOPE_APPROVAL",
  "READY_FOR_IMPLEMENTATION",
  "HANDED_OFF",
  "BLOCKED",
  "ESCALATED",
  "REJECTED",
  "DUPLICATE",
  "CLOSED",
  "SUSPENDED",
]);
export type PIState = z.infer<typeof PIStateSchema>;
export const PIClassificationSchema = z.enum([
  "bug_regression",
  "new_feature",
  "behavior_change",
  "data_correction",
  "usage_question",
  "incident",
  "unclear",
]);
export const PIRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export const PIContactSchema = z
  .object({
    id: short,
    address: z
      .string()
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    organization: short,
    canClarify: z.boolean(),
    canApproveScope: z.boolean(),
    workflows: refs.min(1),
    active: z.boolean(),
    verificationSource: short,
  })
  .strict();
export type PIContact = z.infer<typeof PIContactSchema>;
export const PIStandingAuthorizationSchema = z
  .object({
    id: short,
    historicalSpecDigest: z.string().regex(/^[a-f0-9]{64}$/),
    workflow: short,
    allowedScope: refs.min(1),
    approverContactId: short,
    evidenceRef: short,
    expiresAt: z.string().datetime(),
    maxRisk: z.literal("low"),
  })
  .strict();
export const PISettingsSchema = z
  .object({
    mailbox: z.string().email().default("admin@proimagetx.ai"),
    mode: z
      .enum(["disabled", "replay", "draft_only", "autonomous"])
      .default("draft_only"),
    paused: z.boolean().default(false),
    killSwitch: z.boolean().default(true),
    sendDryRun: z.boolean().default(true),
    allowedSenders: z.array(z.string().email()).max(100).default([]),
    allowedDomains: refs.default([]),
    ignoredSenders: z.array(z.string().email()).default([]),
    sandboxRecipients: z.array(z.string().email()).default([]),
    contacts: z.array(PIContactSchema).max(200).default([]),
    workflowRules: z
      .array(z.object({ workflow: short, subjectContains: short }).strict())
      .max(100)
      .default([]),
    gmailQuery: z.string().max(1000).default("in:inbox newer_than:30d"),
    gmailLabels: refs.default(["INBOX"]),
    dailyOutboundLimit: z.number().int().min(0).max(100).default(10),
    maxFollowUps: z.number().int().min(0).max(10).default(3),
    cooldownMinutes: z.number().int().min(1).max(10080).default(60),
    timezone: z
      .string()
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      })
      .default("UTC"),
    businessHours: z
      .object({
        start: z.number().int().min(0).max(23),
        end: z.number().int().min(1).max(24),
      })
      .strict()
      .default({ start: 8, end: 18 }),
    slaHours: z.number().int().min(1).max(720).default(24),
    escalationContactIds: refs.default([]),
    privacyReviewed: z.boolean().default(false),
    providerAgreementsConfirmed: z.boolean().default(false),
    dataPolicyReference: z.string().max(500).default(""),
    retentionDays: z.number().int().min(1).max(365).default(30),
    model: short.default("configured-json-provider"),
    investigationEnabled: z.boolean().default(false),
    investigationRepositories: refs.default([]),
    highRiskWorkflows: refs.default([
      "ehr",
      "patient",
      "authorization",
      "insurance",
      "linkage",
      "billing",
      "access_control",
      "database_migration",
      "bulk_data",
    ]),
    standingAuthorizations: z
      .array(PIStandingAuthorizationSchema)
      .max(50)
      .default([]),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.businessHours.start >= v.businessHours.end)
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Business hours must end after start",
      });
    if (
      new Set(v.contacts.map((x) => x.id)).size !== v.contacts.length ||
      new Set(v.contacts.map((x) => x.address)).size !== v.contacts.length
    )
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Contact IDs and addresses must be unique",
      });
  });
export type PISettings = z.infer<typeof PISettingsSchema>;
export const PISpecSchema = z
  .object({
    title: short,
    type: PIClassificationSchema,
    workflow: short,
    problemStatement: text,
    observedBehavior: text,
    expectedBehavior: text,
    affectedApplications: refs.min(1),
    repositoryCandidates: refs,
    inScope: refs.min(1),
    outOfScope: refs.min(1),
    acceptanceCriteria: refs.min(1),
    negativeTests: refs.min(1),
    edgeCases: refs.min(1),
    investigationEvidenceRefs: refs,
    dataMigrationImpact: short,
    riskLevel: PIRiskSchema,
    openQuestions: refs,
    dependencies: refs,
    risks: refs,
  })
  .strict();
export type PISpec = z.infer<typeof PISpecSchema>;
export const PIInvestigationRequestSchema = z
  .object({
    correlationId: short,
    question: text,
    repositories: refs.min(1),
    evidenceRefs: refs,
    outputRequest: short,
    permissions: z.literal("read_only"),
    timeoutSeconds: z.number().int().min(1).max(120),
    state: z.enum(["pending", "running", "completed", "unavailable", "failed"]),
  })
  .strict();
export const PIInvestigationResultSchema = z
  .object({
    correlationId: short,
    confirmedFacts: z
      .array(z.object({ fact: text, evidenceRefs: refs.min(1) }).strict())
      .max(50),
    hypotheses: refs,
    confidence: z.number().min(0).max(1),
    limitations: refs,
    fileRefs: refs,
    commitRefs: refs,
    prRefs: refs,
    recommendedClarifications: refs,
    likelyBlastRadius: refs,
    testCases: refs,
  })
  .strict();
export type PIInvestigationRequest = z.infer<
  typeof PIInvestigationRequestSchema
>;
export type PIInvestigationResult = z.infer<typeof PIInvestigationResultSchema>;
export const PIDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: short,
    observedSpecVersion: z.number().int().nonnegative(),
    caseState: PIStateSchema,
    classification: PIClassificationSchema,
    priority: z.enum(["low", "normal", "urgent"]),
    riskLevel: PIRiskSchema,
    decision: z.enum([
      "REQUEST_INVESTIGATION",
      "SEND_CLARIFICATION",
      "PROPOSE_SPEC",
      "REQUEST_SCOPE_APPROVAL",
      "RECORD_CLIENT_CHANGE_REQUEST",
      "PUBLISH_APPROVED_TASK",
      "ANSWER_USAGE_QUESTION",
      "ESCALATE",
      "WAIT",
      "CLOSE_CASE",
    ]),
    rationale: text,
    factEvidenceIds: refs,
    uncertainties: refs,
    requiredActions: z
      .array(
        z.enum([
          "investigate",
          "clarify",
          "specify",
          "request_approval",
          "handoff",
          "escalate",
          "wait",
          "close",
        ]),
      )
      .max(10),
    requestedInvestigation: PIInvestigationRequestSchema.optional(),
    emailDraft: z
      .object({
        kind: z.enum(["clarification", "approval", "answer"]),
        subject: short,
        bodyText: text,
        contactIds: refs.min(1),
      })
      .strict()
      .optional(),
    proposedSpec: PISpecSchema.optional(),
    blockingQuestions: refs,
    escalation: z
      .object({ reason: text, contactIds: refs })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      ["SEND_CLARIFICATION", "ANSWER_USAGE_QUESTION"].includes(v.decision) &&
      !v.emailDraft
    )
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Email draft required",
      });
    if (v.decision === "REQUEST_INVESTIGATION" && !v.requestedInvestigation)
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Investigation required",
      });
    if (
      ["PROPOSE_SPEC", "RECORD_CLIENT_CHANGE_REQUEST"].includes(v.decision) &&
      !v.proposedSpec
    )
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Specification required",
      });
  });
export type PIDecision = z.infer<typeof PIDecisionSchema>;
export const PIApprovalRecordSchema = z
  .object({
    approvalId: short,
    caseId: short,
    specId: short,
    specVersion: z.number().int().positive(),
    specDigest: z.string().regex(/^[a-f0-9]{64}$/),
    approvalRequestGmailMessageId: short,
    approvalReplyGmailMessageId: short,
    approverContactId: short,
    approverAddress: z.string().email(),
    authorizationPolicyId: short,
    authorized: z.boolean(),
    explicitlyAffirmative: z.boolean(),
    timestamp: z.string().datetime(),
    result: z.enum(["approved", "rejected", "ambiguous", "invalid"]),
    verificationReasons: refs.min(1),
  })
  .strict();
export type PIApprovalRecord = z.infer<typeof PIApprovalRecordSchema>;
export const PIImplementationTaskSchema = PISpecSchema.extend({
  taskId: short,
  caseId: short,
  specVersion: z.number().int().positive(),
  specDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvalRecordId: short.optional(),
  standingAuthorizationId: short.optional(),
  sourceGmailThreadId: short,
  createdAt: z.string().datetime(),
  handoffStatus: z.enum(["queued", "returned", "cancelled"]),
})
  .strict()
  .superRefine((v, c) => {
    if (v.openQuestions.length)
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Open questions prohibit handoff",
      });
    if (Boolean(v.approvalRecordId) === Boolean(v.standingAuthorizationId))
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one authorization required",
      });
  });
export type PIImplementationTask = z.infer<typeof PIImplementationTaskSchema>;
export const PIMessageSchema = z
  .object({
    id: short,
    threadId: short,
    mailbox: z.string().email(),
    from: z.string().email(),
    to: z.array(z.string().email()).max(50),
    cc: z.array(z.string().email()).max(50),
    subject: z.string().max(500),
    body: z.string().max(30000),
    rfcMessageId: short,
    inReplyTo: z.string().max(500),
    references: z.string().max(2000),
    date: z.string().datetime(),
    labels: refs,
    attachments: z
      .array(
        z
          .object({
            id: short,
            mimeType: short,
            size: z.number().int().nonnegative(),
            label: short,
          })
          .strict(),
      )
      .max(30)
      .default([]),
    autoGenerated: z.boolean(),
    identityVerified: z.boolean(),
    demo: z.boolean(),
  })
  .strict();
export type PIMessage = z.infer<typeof PIMessageSchema>;
export type PICase = {
  id: string;
  mailbox: string;
  threadId: string;
  title: string;
  summary: string;
  workflow: string;
  state: PIState;
  classification: PIDecision["classification"];
  priority: PIDecision["priority"];
  riskLevel: PIDecision["riskLevel"];
  owner: string;
  revision: number;
  specVersion: number;
  demo: boolean;
  createdAt: string;
  updatedAt: string;
  slaAt: string;
};
export type PIEvent = {
  id: string;
  caseId: string | null;
  kind: string;
  actor: string;
  at: string;
  data: Record<string, unknown>;
};
export type PISpecRecord = {
  id: string;
  caseId: string;
  version: number;
  digest: string;
  spec: PISpec;
  createdAt: string;
  author: string;
  sourceMessageIds?: string[];
};
export type PIOutboxRecord = {
  id: string;
  caseId: string;
  kind: "clarification" | "approval" | "answer";
  recipients: string[];
  subject: string;
  bodyText: string;
  state: string;
  providerId: string | null;
  rfcMessageId: string;
  specVersion: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
};
export type PICaseDetail = {
  case: PICase;
  messages: PIMessage[];
  events: PIEvent[];
  specs: PISpecRecord[];
  approvals: PIApprovalRecord[];
  outbox: PIOutboxRecord[];
  runs: Record<string, unknown>[];
  investigations: Record<string, unknown>[];
  handoffs: PIImplementationTask[];
};
export type PIStatus = {
  enabled: boolean;
  sendLocked: boolean;
  paused: boolean;
  mode: PISettings["mode"];
  metrics: Record<string, number>;
  gmail: {
    connected: boolean;
    mailbox: string;
    lastSync: string | null;
    lastError: string | null;
    cursor: string | null;
    watchExpiresAt: string | null;
  };
  jobs: Record<string, number>;
  promptVersion: string;
  providerConfigured: boolean;
  investigatorConfigured: boolean;
  limitations: string[];
};
