import { ApprovedKnowledge } from "./knowledge.js";
import fs from "node:fs";
import { ReviewedInputService } from "./reviewed-input.js";
import {
  PIExternalSchemas,
  PIDecisionSchema,
  PIInvestigationResultSchema,
  type PIDecision,
  type PICaseDetail,
  type PISettings,
  type PIInvestigationRequest,
  type PIInvestigationResult,
} from "@luma/shared";
import { PIStore, id, digest } from "./store.js";
import {
  requirePolicy,
  requirePrivacy,
  sanitizeBody,
  redactTree,
} from "./policy.js";

export interface Reasoner {
  decide(
    input: {
      prompt: string;
      promptVersion: string;
      model: string;
      context: unknown;
      repair: string | null;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface Investigator {
  readonly isolated?: boolean;
  investigate(
    request: PIInvestigationRequest,
    signal: AbortSignal,
  ): Promise<PIInvestigationResult>;
}
export function trustedEndpoint(value: string) {
  const url = new URL(value);
  requirePolicy(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    "Provider endpoint requires HTTPS or loopback",
  );
  requirePolicy(
    !url.username && !url.password && !url.hash && !url.search,
    "Provider endpoint must not contain credentials, fragment or query",
  );
  return url;
}
export class JsonReasoner implements Reasoner {
  constructor(
    readonly endpoint = process.env.PI_REASONER_URL || "",
    readonly key = process.env.PI_REASONER_API_KEY || "",
  ) {}
  async decide(input: Parameters<Reasoner["decide"]>[0], signal: AbortSignal) {
    requirePolicy(
      this.endpoint,
      "Reasoning provider not configured; configure PI_REASONER_URL",
    );
    const response = await fetch(trustedEndpoint(this.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      },
      body: JSON.stringify({
        ...input,
        responseSchema: PIExternalSchemas.ClarificationDecision,
      }),
      signal,
      redirect: "error",
    });
    requirePolicy(
      response.ok,
      `Reasoning provider failed (${response.status})`,
    );
    const raw = await response.text();
    requirePolicy(
      raw.length <= 100000,
      "Reasoning response exceeds size limit",
    );
    return JSON.parse(raw);
  }
}
export class AnthropicReasoner implements Reasoner {
  constructor(
    readonly key = process.env.PI_ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      "",
    readonly fetcher: typeof fetch = fetch,
  ) {}
  async decide(input: Parameters<Reasoner["decide"]>[0], signal: AbortSignal) {
    requirePolicy(
      this.key,
      "Configure PI_ANTHROPIC_API_KEY or an existing server ANTHROPIC_API_KEY",
    );
    const model =
      input.model === "configured-json-provider"
        ? process.env.PI_REASONER_MODEL
        : input.model;
    requirePolicy(
      model,
      "Configure a PI_REASONER_MODEL or choose an API model in Cowork settings",
    );
    const schema = PIExternalSchemas.ClarificationDecision as {
      definitions?: Record<string, unknown>;
    };
    const response = await this.fetcher(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 6000,
          system: input.prompt,
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                promptVersion: input.promptVersion,
                untrustedCaseEvidence: input.context,
                repair: input.repair,
              }),
            },
          ],
          tools: [
            {
              name: "submit_decision",
              description:
                "Return a structured proposal. This function provides no execution capability.",
              input_schema: {
                ...(schema.definitions?.ClarificationDecision as object),
                definitions: schema.definitions,
              },
            },
          ],
          tool_choice: {
            type: "tool",
            name: "submit_decision",
            disable_parallel_tool_use: true,
          },
        }),
        signal,
        redirect: "error",
      },
    );
    requirePolicy(
      response.ok,
      `Anthropic reasoning failed (${response.status})`,
    );
    const raw = await response.text();
    requirePolicy(raw.length <= 100000, "Reasoning response exceeds limit");
    const result = JSON.parse(raw) as {
      stop_reason?: string;
      content?: { type: string; name?: string; input?: unknown }[];
    };
    const proposals =
      result.content?.filter((x) => x.type === "tool_use") || [];
    requirePolicy(
      result.stop_reason === "tool_use" &&
        proposals.length === 1 &&
        proposals[0].name === "submit_decision",
      "Provider did not return one complete decision proposal",
    );
    // Deliberately do not execute tool blocks or instantiate any provider tool runner.
    return proposals[0].input;
  }
}
export class JsonInvestigator implements Investigator {
  constructor(
    readonly endpoint = process.env.PI_INVESTIGATOR_URL || "",
    readonly key = process.env.PI_INVESTIGATOR_API_KEY || "",
  ) {}
  async investigate(request: PIInvestigationRequest, signal: AbortSignal) {
    requirePolicy(this.endpoint, "Read-only Investigator is not configured");
    requirePolicy(
      process.env.PI_INVESTIGATOR_READONLY_VERIFIED === "true",
      "Investigator isolation has not been verified by the deployment administrator",
    );
    const response = await fetch(trustedEndpoint(this.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      },
      body: JSON.stringify(request),
      signal,
      redirect: "error",
    });
    requirePolicy(response.ok, `Investigator failed (${response.status})`);
    const raw = await response.text();
    requirePolicy(raw.length <= 100000, "Investigation result exceeds limit");
    return PIInvestigationResultSchema.parse(redactTree(JSON.parse(raw)));
  }
}
export class ClarificationAgentRuntime {
  constructor(
    readonly store: PIStore,
    readonly promptPath: string,
    readonly reasoner: Reasoner,
  ) {}
  prompt() {
    const row = this.store.db
      .prepare(
        "SELECT v.digest,v.content FROM pi_prompt_releases r JOIN pi_agent_versions v ON r.digest=v.digest ORDER BY r.rowid DESC LIMIT 1",
      )
      .get() as { digest: string; content: string } | undefined;
    if (row) return { version: row.digest, content: row.content };
    const content = fs.readFileSync(this.promptPath, "utf8"),
      version = digest(content);
    this.store.db
      .prepare("INSERT OR IGNORE INTO pi_agent_versions VALUES(?,?,?)")
      .run(version, content, this.store.at());
    this.store.db
      .prepare("INSERT INTO pi_prompt_releases VALUES(?,?,?)")
      .run(id("prompt-release"), version, this.store.at());
    return { version, content };
  }
  release(content: string) {
    requirePolicy(
      content.length >= 500 && content.length <= 30000,
      "Prompt must contain 500–30000 characters",
    );
    const version = digest(content);
    this.store.db
      .prepare("INSERT OR IGNORE INTO pi_agent_versions VALUES(?,?,?)")
      .run(version, content, this.store.at());
    this.store.db
      .prepare("INSERT INTO pi_prompt_releases VALUES(?,?,?)")
      .run(id("prompt-release"), version, this.store.at());
    this.store.event(null, "PROMPT_RELEASED", "admin", { version });
    return version;
  }
  context(detail: PICaseDetail) {
    // Addresses, attachments, credentials, raw source and raw MIME never enter reasoning context.
    const settings = this.store.settings();
    const reviewed =
      !detail.case.demo && settings.modelInputMode === "reviewed_summary"
        ? new ReviewedInputService(this.store).requireCurrent(detail.case.id)
        : null;
    const {
      mailbox: _mailbox,
      threadId: _threadId,
      owner: _owner,
      ...safeCase
    } = detail.case;
    return redactTree({
      case: safeCase,
      thread: reviewed
        ? [
            {
              evidenceId: `reviewed:${reviewed.sourceDigest}`,
              body: reviewed.summary,
              direction: "incoming",
            },
          ]
        : detail.messages
            .map((m) => ({
              evidenceId: m.id,
              direction: m.direction || "incoming",
              body: sanitizeBody(m.body),
              at: m.date,
            }))
            .slice(-30),
      specs: reviewed
        ? detail.specs
            .slice(-2)
            .map(({ id, version, digest }) => ({ id, version, digest }))
        : detail.specs.slice(-2),
      questions: reviewed
        ? []
        : detail.outbox.map((o) => ({
            kind: o.kind,
            body: o.bodyText,
            status: o.state,
          })),
      investigations: detail.investigations,
      contactRoles: settings.contacts
        .filter((c) => c.active)
        .map((c) => ({
          id: c.id,
          canApproveScope: c.canApproveScope,
          canClarify: c.canClarify,
          workflows: c.workflows,
        })),
      policy: {
        highRiskWorkflows: settings.highRiskWorkflows,
        deploymentAuthorized: false,
        availableRepositories: settings.investigationRepositories,
        localDraftsOnly: settings.mode === "draft_only",
        modelInputMode: settings.modelInputMode,
      },
      approvedKnowledge: new ApprovedKnowledge(this.store).search(
        detail.case.workflow === "unclassified"
          ? settings.contacts
              .filter((c) => c.active)
              .flatMap((c) => c.workflows)
          : [detail.case.workflow],
      ),
      untrustedEvidence: true,
    });
  }
  async run(
    detail: PICaseDetail,
    demo = false,
  ): Promise<{ decision: PIDecision; runId: string; promptVersion: string }> {
    if (!demo) {
      if (this.store.settings().modelInputMode === "reviewed_summary")
        new ReviewedInputService(this.store).requireCurrent(detail.case.id);
      else requirePrivacy(this.store.settings());
    }
    const prompt = this.prompt(),
      runId = id("run");
    let repair: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await this.reasoner.decide(
          {
            prompt: prompt.content,
            promptVersion: prompt.version,
            model: this.store.settings().model,
            context: this.context(detail),
            repair,
          },
          AbortSignal.timeout(
            process.env.PI_REASONER_PROVIDER === "local_cli" ? 150000 : 30000,
          ),
        );
        const decision = PIDecisionSchema.parse(raw);
        requirePolicy(
          decision.caseId === detail.case.id &&
            decision.caseState === detail.case.state &&
            decision.observedSpecVersion === detail.case.specVersion,
          "Decision references stale/different case",
        );
        const known = new Set([
          ...(!detail.case.demo &&
          this.store.settings().modelInputMode === "reviewed_summary"
            ? [
                `reviewed:${new ReviewedInputService(this.store).requireCurrent(detail.case.id).sourceDigest}`,
              ]
            : []),
          ...detail.messages.map((x) => x.id),
          ...detail.events.map((x) => x.id),
          ...detail.specs.map((x) => x.id),
          ...detail.investigations.flatMap((entry) =>
            (
              (
                entry.result as {
                  confirmedFacts?: { evidenceRefs: string[] }[];
                }
              )?.confirmedFacts || []
            ).flatMap((fact) => fact.evidenceRefs),
          ),
          ...new ApprovedKnowledge(this.store)
            .search(
              detail.case.workflow === "unclassified"
                ? this.store
                    .settings()
                    .contacts.filter((c) => c.active)
                    .flatMap((c) => c.workflows)
                : [detail.case.workflow],
            )
            .map((x) => x.evidenceId),
        ]);
        requirePolicy(
          decision.factEvidenceIds.every((e) => known.has(e)),
          "Decision cites unknown evidence",
        );
        this.record(runId, detail.case.id, {
          status: "completed",
          attempts: attempt,
          promptVersion: prompt.version,
          decision: redactTree(decision),
        });
        return { decision, runId, promptVersion: prompt.version };
      } catch (error) {
        repair =
          "Return only a valid ClarificationDecision JSON object matching the schema and the current case/version. No extra fields or tool privileges.";
        if (attempt === 2) {
          this.record(runId, detail.case.id, {
            status: "failed",
            attempts: attempt,
            promptVersion: prompt.version,
            error:
              "Invalid model response, policy precondition, or provider unavailable/timeout",
          });
          throw new Error(
            "Reasoning failed after two bounded attempts; review agent run",
          );
        }
      }
    }
    throw new Error("Unreachable reasoning state");
  }
  private record(
    runId: string,
    caseId: string,
    payload: Record<string, unknown>,
  ) {
    this.store.db
      .prepare("INSERT INTO pi_agent_runs VALUES(?,?,?)")
      .run(
        runId,
        caseId,
        JSON.stringify({ runId, createdAt: this.store.at(), ...payload }),
      );
    this.store.event(caseId, "AGENT_RUN", "runtime", {
      runId,
      status: payload.status,
      promptVersion: payload.promptVersion,
    });
  }
}
export class FakeInvestigator implements Investigator {
  async investigate(
    request: PIInvestigationRequest,
  ): Promise<PIInvestigationResult> {
    return {
      correlationId: request.correlationId,
      confirmedFacts: [
        {
          fact: "Demo fixture confirms that an existing configured display value is absent in one generic list; no patient records accessed.",
          evidenceRefs: ["demo:reproduction:ar-list"],
        },
      ],
      hypotheses: [],
      confidence: 1,
      limitations: ["Synthetic evidence only; no live repository inspected"],
      fileRefs: ["demo:read-only-report"],
      commitRefs: [],
      prRefs: [],
      recommendedClarifications: [
        "Confirm the affected list and expected label",
      ],
      likelyBlastRadius: ["One display list"],
      testCases: ["Configured type appears in the list"],
    };
  }
}
// Deterministic reasoning is only used for explicit demo cases. Live cases never fall back to fixtures.
export class DemoReasoner implements Reasoner {
  constructor(
    readonly detail: () => PICaseDetail,
    readonly settings: () => PISettings,
  ) {}
  async decide(): Promise<PIDecision> {
    const d = this.detail(),
      c = d.case,
      s = this.settings();
    const base: PIDecision = {
      schemaVersion: 1,
      caseId: c.id,
      observedSpecVersion: c.specVersion,
      caseState: c.state,
      classification: "bug_regression",
      priority: "normal",
      riskLevel: "low",
      decision: "WAIT",
      rationale: "Deterministic de-identified demo",
      factEvidenceIds: d.messages.map((m) => m.id),
      uncertainties: [],
      requiredActions: [],
      blockingQuestions: [],
    };
    const contact = s.contacts.find((x) => x.id === "demo-client")!;
    if (c.state === "READY_FOR_IMPLEMENTATION")
      return { ...base, decision: "PUBLISH_APPROVED_TASK" };
    if (c.state === "DRAFT_SPEC")
      return {
        ...base,
        decision: "REQUEST_SCOPE_APPROVAL",
        emailDraft: {
          kind: "approval",
          subject: "Scope review",
          bodyText: "Server generates exact version approval request",
          contactIds: [contact.id],
        },
      };
    if (!d.investigations.some((i) => i.state === "completed"))
      return {
        ...base,
        decision: "REQUEST_INVESTIGATION",
        requestedInvestigation: {
          correlationId: c.id,
          question:
            "Verify generic display behavior without changing code or records",
          repositories: ["demo/pi"],
          evidenceRefs: d.messages.map((m) => m.id),
          outputRequest: "Facts and reproduction evidence only",
          permissions: "read_only",
          timeoutSeconds: 15,
          state: "pending",
        },
      };
    if (!d.outbox.some((o) => o.kind === "clarification"))
      return {
        ...base,
        decision: "SEND_CLARIFICATION",
        emailDraft: {
          kind: "clarification",
          subject: "Clarify affected list",
          bodyText:
            "I am PI's AI support assistant. Which list is affected, and which configured label should appear? Please use generic examples without patient identifiers.",
          contactIds: [contact.id],
        },
      };
    if (d.messages.length < 2) return base;
    const ppo = d.messages[0].subject.includes("PPO");
    return {
      ...base,
      decision: "PROPOSE_SPEC",
      classification: ppo ? "behavior_change" : "bug_regression",
      proposedSpec: {
        title: ppo ? "PPO authorization handling" : "AR TYPE NOT POPULATED",
        type: ppo ? "behavior_change" : "bug_regression",
        workflow: ppo ? "authorization" : "ar_display",
        problemStatement: "A configured label is absent in a generic list.",
        observedBehavior: "The fixture row has an empty type display.",
        expectedBehavior:
          "Display the existing configured type without changing the stored record.",
        affectedApplications: ["PI generic demo list"],
        repositoryCandidates: ["demo/pi"],
        inScope: ["Display existing configured type in the named list"],
        outOfScope: [
          "Changing stored records",
          "Changing workflow or billing rules",
        ],
        acceptanceCriteria: [
          "A generic row with type Standard displays Standard",
        ],
        negativeTests: [
          "A row without a configured type displays an empty indicator without inventing a type",
        ],
        edgeCases: ["Missing configuration uses an empty indicator"],
        investigationEvidenceRefs: ["demo:reproduction:ar-list"],
        dataMigrationImpact: "None",
        riskLevel: ppo ? "high" : "low",
        openQuestions: [],
        dependencies: [],
        risks: ["Verify the behavior against the approved generic examples"],
      },
    };
  }
}
