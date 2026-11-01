import path from "node:path";
import { type PIMessage, type PIStatus } from "@luma/shared";
import { PIStore, id } from "./store.js";
import { CredentialVault } from "./credentials.js";
import { Workflow } from "./workflow.js";
import {
  GmailAdapter,
  FakeGmail,
  GmailError,
  type GmailClient,
} from "./gmail.js";
import { OutboxService } from "./outbox.js";
import { ApprovalService } from "./approval.js";
import { HandoffService } from "./handoff.js";
import {
  ClarificationAgentRuntime,
  DemoReasoner,
  FakeInvestigator,
  JsonInvestigator,
  JsonReasoner,
  AnthropicReasoner,
  type Reasoner,
  type Investigator,
} from "./runtime.js";
import { CaseOrchestrator } from "./orchestrator.js";
import { GmailSyncWorker } from "./sync.js";
import { requirePolicy, sanitizeBody } from "./policy.js";

export type ServiceOptions = {
  root: string;
  file?: string;
  demo?: boolean;
  now?: () => Date;
  gmail?: GmailClient;
  reasoner?: Reasoner;
  investigator?: Investigator;
  sendLocked?: boolean;
  enabled?: boolean;
};
export class PIService {
  readonly store: PIStore;
  readonly vault: CredentialVault;
  readonly workflow: Workflow;
  readonly gmail: GmailClient;
  readonly outbox: OutboxService;
  readonly approvals: ApprovalService;
  readonly handoff: HandoffService;
  readonly runtime: ClarificationAgentRuntime;
  readonly orchestrator: CaseOrchestrator;
  readonly sync: GmailSyncWorker;
  readonly demo: boolean;
  readonly sendLocked: boolean;
  readonly enabled: boolean;
  private owner = id("worker");
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopping = false;
  constructor(options: ServiceOptions) {
    this.demo = Boolean(options.demo);
    this.sendLocked =
      options.sendLocked ?? process.env.PI_CLARIFICATION_SEND_LOCK !== "false";
    this.enabled =
      options.enabled ?? process.env.PI_CLARIFICATION_ENABLED === "true";
    this.store = new PIStore(
      options.file ||
        path.join(
          options.root,
          "data",
          this.demo
            ? "pi-clarification-demo.sqlite"
            : "pi-clarification.sqlite",
        ),
      options.now,
    );
    if (
      this.demo &&
      (this.store.settings().mailbox !== "pi@demo.invalid" ||
        !this.store.settings().workflowRules.length)
    )
      this.store.saveSettings(
        {
          ...this.store.settings(),
          mailbox: "pi@demo.invalid",
          mode: "replay",
          workflowRules: [
            { workflow: "ar_display", subjectContains: "AR TYPE" },
            { workflow: "authorization", subjectContains: "PPO" },
          ],
          contacts: [
            {
              id: "demo-client",
              address: "client@demo.invalid",
              organization: "Demonstration",
              canClarify: true,
              canApproveScope: true,
              workflows: ["ar_display", "authorization"],
              active: true,
              verificationSource: "Synthetic fixture",
            },
          ],
          sandboxRecipients: ["client@demo.invalid"],
          allowedSenders: ["client@demo.invalid"],
          investigationEnabled: true,
          investigationRepositories: ["demo/pi"],
        },
        "demo-setup",
      );
    this.vault = new CredentialVault(this.store);
    if (
      !this.demo &&
      process.env.PI_GMAIL_REFRESH_TOKEN &&
      this.vault.configured() &&
      !this.store.mailbox()?.connected
    )
      this.vault.put(
        this.store.settings().mailbox,
        process.env.PI_GMAIL_REFRESH_TOKEN,
      );
    this.gmail =
      options.gmail ||
      (this.demo
        ? new FakeGmail()
        : new GmailAdapter(
            this.vault,
            this.store.settings().mailbox,
            this.sendLocked,
          ));
    this.workflow = new Workflow(this.store);
    this.outbox = new OutboxService(this.store, this.gmail, this.sendLocked);
    this.approvals = new ApprovalService(
      this.store,
      this.workflow,
      this.outbox,
    );
    this.handoff = new HandoffService(this.store, this.workflow);
    const reasoner: Reasoner =
      options.reasoner ||
      (this.demo
        ? {
            decide: async (input, signal) => {
              const context = input.context as { case: { id: string } };
              return new DemoReasoner(
                () => this.store.detail(context.case.id),
                () => this.store.settings(),
              ).decide();
            },
          }
        : process.env.PI_REASONER_PROVIDER === "anthropic"
          ? new AnthropicReasoner()
          : new JsonReasoner());
    this.runtime = new ClarificationAgentRuntime(
      this.store,
      path.join(options.root, "agents/pi-clarification/AGENT.md"),
      reasoner,
    );
    this.orchestrator = new CaseOrchestrator(
      this.store,
      this.workflow,
      this.runtime,
      this.approvals,
      this.handoff,
      this.outbox,
      options.investigator ||
        (this.demo ? new FakeInvestigator() : new JsonInvestigator()),
    );
    this.sync = new GmailSyncWorker(this.store, this.gmail, (m) =>
      this.orchestrator.ingest(m),
    );
  }
  status(): PIStatus {
    const s = this.store.settings(),
      mailbox = this.store.mailbox(),
      metrics: Record<string, number> = {};
    for (const c of this.store.cases())
      metrics[c.state] = (metrics[c.state] || 0) + 1;
    const jobs = Object.fromEntries(
      (
        this.store.db
          .prepare(
            "SELECT state,COUNT(*) AS n FROM pi_work_items GROUP BY state",
          )
          .all() as { state: string; n: number }[]
      ).map((r) => [r.state, r.n]),
    );
    return {
      enabled: this.enabled || this.demo,
      sendLocked: this.sendLocked || this.demo,
      paused: s.paused,
      mode: s.mode,
      metrics,
      jobs,
      gmail: {
        connected: Boolean(mailbox?.connected),
        mailbox: s.mailbox,
        lastSync: mailbox?.last_sync || null,
        lastError: mailbox?.last_error || null,
        cursor: mailbox?.cursor || null,
        watchExpiresAt: mailbox?.watch_expires_at || null,
      },
      promptVersion: this.runtime.prompt().version,
      providerConfigured:
        this.demo ||
        (process.env.PI_REASONER_PROVIDER === "anthropic"
          ? Boolean(
              process.env.PI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
            )
          : Boolean(process.env.PI_REASONER_URL)),
      investigatorConfigured:
        this.demo ||
        Boolean(
          process.env.PI_INVESTIGATOR_URL &&
            process.env.PI_INVESTIGATOR_READONLY_VERIFIED === "true",
        ),
      limitations: [
        ...(this.sendLocked
          ? ["Outbound email and Gmail draft writes are deployment-locked"]
          : []),
        ...(!(process.env.PI_REASONER_PROVIDER === "anthropic"
          ? process.env.PI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
          : process.env.PI_REASONER_URL) && !this.demo
          ? [
              "Configure an isolated JSON reasoning provider; coding CLI runners are prohibited",
            ]
          : []),
        ...(!process.env.PI_INVESTIGATOR_URL && !this.demo
          ? ["Read-only Investigator is not configured"]
          : []),
        "Automatic implementor execution and external Tasks publishing are disabled; approved briefs are queued internally",
        "High-risk work requires human escalation; no deployment is authorized",
      ],
    };
  }
  start() {
    if (this.demo || !this.enabled || this.timer) return;
    const tick = async () => {
      if (this.stopping) return;
      try {
        await this.tick();
      } catch {
        this.store.event(null, "WORKER_ERROR", "worker", {
          reason: "Worker pass failed; inspect failed work items",
        });
      } finally {
        if (!this.stopping) this.timer = setTimeout(tick, 2000);
      }
    };
    this.timer = setTimeout(tick, 500);
  }
  async tick() {
    if (this.busy || this.stopping) return;
    if (
      this.store.settings().paused ||
      (!this.demo &&
        (!this.enabled || this.store.settings().mode === "disabled"))
    )
      return;
    this.busy = true;
    try {
      if (!this.demo)
        this.store.enqueue(
          "maintenance",
          `maintenance:${Math.floor(this.store.now().getTime() / 3600000)}`,
          {},
        );
      if (
        !this.demo &&
        this.store.mailbox()?.connected &&
        this.store.settings().mode !== "replay"
      ) {
        const interval =
          Math.max(60, Number(process.env.PI_GMAIL_POLL_SECONDS || 120)) * 1000;
        this.store.enqueue(
          "sync",
          `sync:${Math.floor(this.store.now().getTime() / interval)}`,
          {},
        );
      }
      const job = this.store.claim(this.owner, 180000);
      if (!job) return;
      const heartbeat = setInterval(() => {
        this.store.db
          .prepare(
            "UPDATE pi_work_items SET lease_until=? WHERE id=? AND lease_owner=? AND state='running'",
          )
          .run(this.store.now().getTime() + 180000, job.id, this.owner);
      }, 30000);
      try {
        const payload = JSON.parse(job.payload) as {
          messageId?: string;
          outboxId?: string;
          requestId?: string;
        };
        if (
          this.store.db
            .prepare("SELECT 1 FROM pi_job_effects WHERE job_id=?")
            .get(job.id)
        ) {
          this.store.finish(job);
          return;
        }
        switch (job.kind) {
          case "maintenance":
            this.retain();
            for (const c of this.store.cases())
              if (
                c.slaAt < this.store.at() &&
                [
                  "NEEDS_CLIENT_DETAILS",
                  "AWAITING_SCOPE_APPROVAL",
                  "BLOCKED",
                ].includes(c.state)
              )
                this.workflow.transition(
                  c.id,
                  "ESCALATED",
                  "sla-policy",
                  "Configured SLA deadline exceeded",
                );
            break;
          case "sync":
            await this.sync.sync();
            break;
          case "message":
            this.store.tx(() => {
              this.orchestrator.receiveMessage(
                job.case_id!,
                payload.messageId!,
              );
              this.store.db
                .prepare("INSERT OR IGNORE INTO pi_job_effects VALUES(?,?)")
                .run(job.id, this.store.at());
            });
            break;
          case "reason":
            await this.orchestrator.runCase(job.case_id!, job.id);
            break;
          case "investigate":
            await this.orchestrator.investigate(
              job.case_id!,
              payload.requestId!,
            );
            break;
          case "outbox":
            await this.outbox.deliver(payload.outboxId!);
            break;
          case "handoff":
            this.handoff.publish(job.case_id!);
            break;
          default:
            throw new Error("Unsupported work item kind");
        }
        this.store.finish(job);
      } catch (error) {
        const message =
          error instanceof GmailError
            ? error.message
            : error instanceof Error
              ? sanitizeBody(error.message)
              : "Work item failed";
        this.store.finish(job, message);
        this.store.event(job.case_id, "JOB_FAILED", "worker", {
          jobId: job.id,
          kind: job.kind,
          attempt: job.attempts,
          reason: message,
        });
        if (error instanceof GmailError && error.retryAfterSeconds > 0)
          this.store.db
            .prepare(
              "UPDATE pi_work_items SET available_at=? WHERE id=? AND state='pending'",
            )
            .run(
              this.store.now().getTime() +
                Math.min(86400, error.retryAfterSeconds) * 1000,
              job.id,
            );
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.busy = false;
    }
  }
  async drain(max = 30) {
    for (let n = 0; n < max; n++) {
      const pending = this.store.db
        .prepare(
          "SELECT 1 FROM pi_work_items WHERE state='pending' AND available_at<=? LIMIT 1",
        )
        .get(this.store.now().getTime());
      if (!pending) break;
      await this.tick();
    }
  }
  async replay(scenario: "ar" | "ppo" = "ar") {
    requirePolicy(this.demo, "Replay only allowed in isolated demo database");
    requirePolicy(
      !this.store.settings().paused,
      "Resume the test agent before replaying",
    );
    const threadId = id("demo-thread");
    const source: PIMessage = {
      id: id("demo-message"),
      threadId,
      mailbox: "pi@demo.invalid",
      from: "client@demo.invalid",
      to: ["pi@demo.invalid"],
      cc: [],
      subject:
        scenario === "ar"
          ? "AR TYPE NOT POPULATED"
          : "PPO authorization handling",
      body: "The configured type is absent in one generic list. Please clarify the expected display.",
      rfcMessageId: `<${id("demo")}@demo.invalid>`,
      inReplyTo: "",
      references: "",
      date: this.store.at(),
      labels: ["INBOX"],
      attachments: [],
      autoGenerated: false,
      identityVerified: true,
      demo: true,
    };
    const caseId = this.orchestrator.ingest(source, true)!;
    await this.drain();
    this.orchestrator.ingest(
      {
        ...source,
        id: id("demo-reply"),
        date: this.store.at(),
        body: "The generic summary list should display the existing configured Standard label. Do not modify records or other workflows.",
        inReplyTo: source.rfcMessageId,
        rfcMessageId: `<${id("demo")}@demo.invalid>`,
      },
      true,
    );
    await this.drain();
    if (scenario === "ar") {
      const d = this.store.detail(caseId),
        request = d.outbox.find((o) => o.kind === "approval");
      requirePolicy(request, "Demo did not generate an approval request");
      this.orchestrator.ingest(
        {
          ...source,
          id: id("demo-approval"),
          date: this.store.at(),
          body: `APPROVE ${caseId} v${d.case.specVersion}`,
          inReplyTo: request.rfcMessageId,
          references: request.rfcMessageId,
          rfcMessageId: `<${id("demo")}@demo.invalid>`,
        },
        true,
      );
      await this.drain();
    }
    return this.store.detail(caseId);
  }
  erase(caseId: string) {
    this.store.tx(() => {
      const c = this.store.getCase(caseId);
      requirePolicy(
        ["CLOSED", "REJECTED", "SUSPENDED"].includes(c.state),
        "Suspend or close a case before erasure",
      );
      for (const m of this.store.detail(caseId).messages)
        this.store.db
          .prepare(
            "UPDATE pi_messages SET payload=? WHERE mailbox=? AND provider_id=?",
          )
          .run(
            JSON.stringify({
              ...m,
              body: "[erased]",
              subject: "[erased]",
              from: "erased@invalid.invalid",
              to: [],
              cc: [],
            }),
            m.mailbox,
            m.id,
          );
      for (const o of this.store.detail(caseId).outbox)
        this.store.db
          .prepare(
            "UPDATE pi_outbox SET state='cancelled',payload=? WHERE id=?",
          )
          .run(
            JSON.stringify({
              ...o,
              state: "cancelled",
              bodyText: "[erased]",
              recipients: [],
              subject: "[erased]",
            }),
            o.id,
          );
      this.store.db
        .prepare("DELETE FROM pi_agent_runs WHERE case_id=?")
        .run(caseId);
      this.store.db
        .prepare("DELETE FROM pi_investigation_requests WHERE case_id=?")
        .run(caseId);
      this.store.event(caseId, "CONTENT_ERASED", "admin", {
        immutableEvidenceRetained: true,
      });
    });
  }
  retain() {
    const cutoff = new Date(
      this.store.now().getTime() -
        this.store.settings().retentionDays * 86400000,
    ).toISOString();
    for (const c of this.store.cases())
      if (
        c.updatedAt < cutoff &&
        ["CLOSED", "REJECTED", "SUSPENDED"].includes(c.state) &&
        this.store.detail(c.id).messages.some((m) => m.body !== "[erased]")
      )
        this.erase(c.id);
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
    this.store.close();
  }
}
