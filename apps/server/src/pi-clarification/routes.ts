import { ApprovedKnowledge } from "./knowledge.js";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import jwt from "jsonwebtoken";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import {
  PISettingsSchema,
  PISpecSchema,
  PIExternalSchemas,
} from "@luma/shared";
import { PIService } from "./service.js";
import { requirePolicy, requirePrivacy, sanitizeBody } from "./policy.js";
import { digest, id } from "./store.js";
import {
  deploymentThreadSenders,
  configuredThreadSenders,
} from "./thread-policy.js";

const ok = (res: Response, data: unknown) => res.json({ ok: true, data });
const wrap =
  (fn: (req: Request, res: Response) => unknown): express.RequestHandler =>
  (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((error) => {
        const isValidation =
          error && typeof error === "object" && "issues" in error;
        res.status(isValidation ? 400 : 409).json({
          ok: false,
          error: {
            message: isValidation
              ? "Invalid input: check required fields and limits"
              : error instanceof Error
                ? sanitizeBody(error.message)
                : "PI operation failed",
          },
        });
      });
  };
export function ownerAuth(
  secret: string,
  configured: boolean,
): express.RequestHandler {
  return (req, res, next) => {
    if (!configured) {
      res.status(503).json({
        ok: false,
        error: {
          message:
            "Configure Luma APP_PASSWORD/PASSWORD before accessing PI Cowork",
        },
      });
      return;
    }
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    try {
      requirePolicy(token, "Owner login required");
      const claims = jwt.verify(token, secret, { algorithms: ["HS256"] });
      requirePolicy(
        typeof claims !== "string" && claims.sub === "luma-assistant-user",
        "Luma owner role required",
      );
      next();
    } catch {
      res
        .status(401)
        .json({ ok: false, error: { message: "Luma owner login required" } });
    }
  };
}
let keyCache: {
  expires: number;
  keys: { kid: string; kty: string; n: string; e: string }[];
} | null = null;
export async function verifyPubSub(
  token: string,
  audience: string,
  email: string,
) {
  requirePolicy(
    audience && email,
    "Pub/Sub OIDC audience and service account are not configured",
  );
  requirePolicy(
    token.length > 0 && token.length <= 12000,
    "Invalid Pub/Sub token size",
  );
  const decoded = jwt.decode(token, { complete: true });
  requirePolicy(
    decoded && decoded.header.alg === "RS256" && decoded.header.kid,
    "Invalid Pub/Sub token",
  );
  if (!keyCache || keyCache.expires < Date.now()) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
      signal: AbortSignal.timeout(10000),
    });
    requirePolicy(response.ok, "Unable to verify Pub/Sub signing keys");
    const body = (await response.json()) as {
      keys: { kid: string; kty: string; n: string; e: string }[];
    };
    keyCache = { expires: Date.now() + 3600000, keys: body.keys };
  }
  const key = keyCache.keys.find((k) => k.kid === decoded.header.kid);
  requirePolicy(key, "Unknown Google signing key");
  const claims = jwt.verify(token, createPublicKey({ key, format: "jwk" }), {
    algorithms: ["RS256"],
    audience,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });
  requirePolicy(
    typeof claims !== "string" &&
      claims.email === email &&
      claims.email_verified === true,
    "Unexpected Pub/Sub service identity",
  );
}
export function registerPI(
  app: express.Express,
  options: { root: string; secret: string; authConfigured: boolean },
) {
  const demoEnabled = process.env.PI_CLARIFICATION_DEMO_ENABLED !== "false";
  const live = new PIService({ root: options.root });
  const demo = demoEnabled
    ? new PIService({ root: options.root, demo: true })
    : null;
  const base = "/api/cowork/pi-clarification";
  // Public delivery is authenticated independently; never exempt the dashboard from owner auth.
  app.post(
    "/api/webhooks/gmail-pubsub",
    express.json({ limit: "32kb" }),
    wrap(async (req, res) => {
      requirePolicy(live.enabled, "PI Clarification is disabled");
      requirePolicy(
        Buffer.byteLength(JSON.stringify(req.body || {})) <= 32768,
        "Pub/Sub body exceeds 32 KB",
      );
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
      try {
        await verifyPubSub(
          token,
          process.env.PI_GMAIL_PUBSUB_AUDIENCE || "",
          process.env.PI_GMAIL_PUBSUB_SERVICE_ACCOUNT || "",
        );
      } catch {
        res.status(401).json({
          ok: false,
          error: { message: "Invalid Pub/Sub delivery identity" },
        });
        return;
      }
      const push = z
        .object({
          message: z
            .object({
              data: z.string().max(16000),
              messageId: z.string().min(1).max(200),
            })
            .passthrough(),
          subscription: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      const data = z
        .object({
          emailAddress: z.string().email(),
          historyId: z.string().regex(/^\d+$/),
        })
        .strict()
        .parse(
          JSON.parse(Buffer.from(push.message.data, "base64").toString("utf8")),
        );
      requirePolicy(
        data.emailAddress.toLowerCase() === live.store.settings().mailbox,
        "Webhook mailbox mismatch",
      );
      // Notification history is a hint, never a replacement cursor. Work is durable before acknowledgment.
      live.store.enqueue("sync", `push:${push.message.messageId}`, {
        historyHint: data.historyId,
      });
      res.status(204).end();
    }),
  );
  app.get(
    `${base}/gmail/oauth/callback`,
    wrap(async (req, res) => {
      const state = z.string().min(20).max(200).parse(req.query.state);
      live.vault.consumeState(state);
      requirePolicy(!req.query.error, "Google OAuth consent was not granted");
      const code = z.string().min(1).max(2000).parse(req.query.code);
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: process.env.PI_GMAIL_CLIENT_ID || "",
          client_secret: process.env.PI_GMAIL_CLIENT_SECRET || "",
          redirect_uri: process.env.PI_GMAIL_REDIRECT_URI || "",
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(15000),
      });
      requirePolicy(response.ok, "Gmail OAuth exchange failed");
      const credentials = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
      };
      requirePolicy(
        credentials.refresh_token,
        "No refresh token returned; re-consent with offline access",
      );
      const profileResponse = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        {
          headers: { Authorization: `Bearer ${credentials.access_token}` },
          signal: AbortSignal.timeout(15000),
        },
      );
      requirePolicy(
        profileResponse.ok,
        "Unable to verify connected Gmail account",
      );
      const profile = (await profileResponse.json()) as {
        emailAddress: string;
      };
      requirePolicy(
        profile.emailAddress.toLowerCase() === live.store.settings().mailbox,
        "Connect the configured admin@proimagetx.ai mailbox",
      );
      live.vault.put(live.store.settings().mailbox, credentials.refresh_token);
      res.redirect("/?pi_oauth=connected");
    }),
  );
  const router = express.Router();
  router.use(ownerAuth(options.secret, options.authConfigured));
  router.use(express.json({ limit: "128kb" }));
  router.use((req, res, next) => {
    if (req.body && Buffer.byteLength(JSON.stringify(req.body)) > 128 * 1024) {
      res
        .status(413)
        .json({ ok: false, error: { message: "PI request exceeds 128 KB" } });
      return;
    }
    next();
  });
  // The current app has one authenticated owner. All PI mutations are owner/admin-only.
  const budget = new Map<string, { window: number; count: number }>();
  router.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      const key = req.ip || "owner",
        now = Date.now(),
        entry = budget.get(key);
      const b =
        entry && entry.window > now - 60000 ? entry : { window: now, count: 0 };
      budget.set(key, b);
      if (++b.count > 60) {
        res.status(429).json({
          ok: false,
          error: { message: "Too many PI mutations; retry in one minute" },
        });
        return;
      }
    }
    next();
  });
  const service = (req: Request): PIService => {
    if (req.query.demo === "1") {
      requirePolicy(
        demo,
        "Demo workspace is disabled on this production-mail instance",
      );
      return demo;
    }
    return live;
  };
  router.get(
    "/schemas",
    wrap((_req, res) => ok(res, PIExternalSchemas)),
  );
  router.get(
    "/status",
    wrap((req, res) => ok(res, service(req).status())),
  );
  router.get(
    "/settings",
    wrap((req, res) => ok(res, service(req).store.settings())),
  );
  router.put(
    "/settings",
    wrap((req, res) => {
      const svc = service(req),
        settings = PISettingsSchema.parse(req.body);
      requirePolicy(
        settings.mailbox === svc.store.settings().mailbox,
        "Mailbox changes require a separate connection and server restart; change PI_GMAIL_MAILBOX only before initial setup",
      );
      requirePolicy(
        !svc.sendLocked ||
          (settings.mode !== "autonomous" &&
            settings.killSwitch &&
            settings.sendDryRun),
        "Deployment send lock prevents autonomous mode or disabling safety switches",
      );
      requirePolicy(
        !deploymentThreadSenders() ||
          configuredThreadSenders(settings).join(",") ===
            deploymentThreadSenders()!.join(","),
        "The required thread sender is locked by deployment configuration",
      );
      requirePolicy(
        process.env.PI_CLARIFICATION_RECEIVE_ONLY !== "true" ||
          settings.receiveOnly,
        "Receive-only operation is locked by deployment configuration",
      );
      requirePolicy(!svc.demo, "Demo settings are managed by fixtures");
      requirePolicy(
        !["reviewed_summary", "automatic"].includes(
          process.env.PI_MODEL_INPUT_MODE || "",
        ) || settings.modelInputMode === process.env.PI_MODEL_INPUT_MODE,
        "AI input mode is locked by deployment configuration",
      );
      ok(res, svc.store.saveSettings(settings, "admin"));
    }),
  );
  router.get(
    "/cases",
    wrap((req, res) => {
      const query = z
        .object({
          demo: z.string().optional(),
          q: z.string().max(200).optional(),
          state: z.string().max(40).optional(),
          priority: z.string().optional(),
          sender: z.string().max(254).optional(),
          approved: z.enum(["yes", "no"]).optional(),
          since: z.string().datetime().optional(),
          sort: z.enum(["newest", "oldest"]).optional(),
        })
        .strict()
        .parse(req.query);
      const store = service(req).store;
      let cases = store
        .cases()
        .filter(
          (c) =>
            (!query.q ||
              `${c.id} ${c.title}`
                .toLowerCase()
                .includes(query.q.toLowerCase())) &&
            (!query.state || c.state === query.state) &&
            (!query.priority || c.priority === query.priority) &&
            (!query.since || c.createdAt >= query.since),
        );
      if (query.sender)
        cases = cases.filter((c) =>
          store.detail(c.id).messages.some((m) => m.from === query.sender),
        );
      if (query.approved)
        cases = cases.filter(
          (c) =>
            store
              .detail(c.id)
              .approvals.some(
                (a) =>
                  a.result === "approved" && a.specVersion === c.specVersion,
              ) ===
            (query.approved === "yes"),
        );
      if (query.sort === "oldest") cases.reverse();
      ok(res, cases.slice(0, 500));
    }),
  );
  router.get(
    "/cases/:id",
    wrap((req, res) => ok(res, service(req).store.detail(req.params.id))),
  );
  router.get(
    "/specs/:id",
    wrap((req, res) => {
      const svc = service(req),
        r = svc.store
          .payloads<{ id: string }>("pi_specs")
          .find((x) => x.id === req.params.id);
      requirePolicy(r, "Specification not found");
      ok(res, r);
    }),
  );
  router.get(
    "/knowledge",
    wrap((req, res) => {
      const svc = service(req);
      const query = z
        .object({
          demo: z.string().optional(),
          workflow: z.string().min(1).max(240),
          q: z.string().max(200).optional(),
        })
        .strict()
        .parse(req.query);
      ok(
        res,
        new ApprovedKnowledge(svc.store).search([query.workflow], query.q),
      );
    }),
  );
  router.get(
    "/audit",
    wrap((req, res) => ok(res, service(req).store.events())),
  );
  router.get(
    "/jobs",
    wrap((req, res) =>
      ok(
        res,
        service(req)
          .store.db.prepare(
            "SELECT id,case_id,kind,state,attempts,available_at,lease_until,last_error FROM pi_work_items ORDER BY rowid DESC LIMIT 200",
          )
          .all(),
      ),
    ),
  );
  router.post(
    "/jobs/:id/retry",
    wrap((req, res) => {
      service(req).store.retry(req.params.id);
      ok(res, { retried: true });
    }),
  );
  for (const command of ["pause", "resume"] as const)
    router.post(
      `/${command}`,
      wrap((req, res) => {
        const svc = service(req),
          s = svc.store.settings();
        ok(
          res,
          svc.store.saveSettings(
            { ...s, paused: command === "pause" },
            "admin",
          ),
        );
      }),
    );
  router.post(
    "/cases/:id/run",
    wrap((req, res) => {
      const svc = service(req);
      svc.store.getCase(req.params.id);
      requirePolicy(
        !svc.store.settings().receiveOnly || svc.demo,
        "AI processing is disabled in receive-only mode",
      );
      requirePolicy(
        svc.demo || svc.status().providerConfigured,
        "Configure/login to the selected AI runner first",
      );
      if (
        !svc.demo &&
        svc.store.settings().modelInputMode === "reviewed_summary"
      )
        svc.reviewedInput.requireCurrent(req.params.id);
      svc.store.enqueue("reason", `manual:${id("request")}`, {}, req.params.id);
      ok(res, { queued: true });
    }),
  );
  router.get(
    "/repositories",
    wrap((req, res) => ok(res, service(req).repositories.publicEntries())),
  );
  router.get(
    "/cases/:id/model-input",
    wrap((req, res) => {
      const svc = service(req);
      svc.store.getCase(req.params.id);
      ok(res, {
        sourceDigest: svc.reviewedInput.sourceDigest(req.params.id),
        reviewed: svc.reviewedInput.get(req.params.id),
      });
    }),
  );
  router.put(
    "/cases/:id/model-input",
    wrap((req, res) => {
      const svc = service(req);
      ok(res, svc.reviewedInput.save(req.params.id, req.body));
    }),
  );
  router.get(
    "/cases/:id/implementations",
    wrap((req, res) => {
      const svc = service(req);
      svc.store.getCase(req.params.id);
      ok(
        res,
        svc.implementation
          .list(req.params.id)
          .map(({ workspace: _workspace, ...record }) => record),
      );
    }),
  );
  router.post(
    "/cases/:id/implementations",
    wrap((req, res) => {
      const svc = service(req);
      const { repository } = z
        .object({ repository: z.string().min(1).max(240) })
        .strict()
        .parse(req.body);
      svc.implementation.authorize(req.params.id, repository);
      svc.store.enqueue(
        "implement",
        `implement:${req.params.id}:${svc.store.getCase(req.params.id).specVersion}:${repository}`,
        { repository },
        req.params.id,
      );
      ok(res, { queued: true });
    }),
  );
  router.post(
    "/implementations/:id/publish",
    wrap((req, res) => {
      const { codeReviewed } = z
        .object({ codeReviewed: z.literal(true) })
        .strict()
        .parse(req.body);
      const { workspace: _workspace, ...result } = service(
        req,
      ).implementation.publish(req.params.id, codeReviewed);
      ok(res, result);
    }),
  );
  router.get(
    "/implementations/:id/diff",
    wrap((req, res) => {
      const svc = service(req);
      ok(res, svc.implementation.diff(req.params.id));
    }),
  );
  router.post(
    "/cases/:id/specs",
    wrap((req, res) =>
      ok(
        res,
        service(req).workflow.propose(
          req.params.id,
          PISpecSchema.parse(req.body),
          "admin",
        ),
      ),
    ),
  );
  router.post(
    "/cases/:id/approval-request",
    wrap((req, res) => {
      const body = z
        .object({ contactIds: z.array(z.string().min(1)).min(1).max(20) })
        .strict()
        .parse(req.body);
      ok(res, service(req).approvals.request(req.params.id, body.contactIds));
    }),
  );
  router.post(
    "/cases/:id/handoff",
    wrap((req, res) => {
      const body = z
        .object({ standingAuthorizationId: z.string().optional() })
        .strict()
        .parse(req.body || {});
      ok(
        res,
        service(req).handoff.publish(
          req.params.id,
          body.standingAuthorizationId,
        ),
      );
    }),
  );
  router.post(
    "/cases/:id/action",
    wrap((req, res) => {
      const svc = service(req),
        caseId = req.params.id;
      const body = z
        .object({
          action: z.enum([
            "suspend",
            "reopen",
            "escalate",
            "reject",
            "close",
            "reassign",
            "return_for_clarification",
            "merge",
            "set_workflow",
          ]),
          reason: z.string().trim().min(1).max(2000),
          contactId: z.string().optional(),
          targetCaseId: z.string().optional(),
          workflow: z.string().min(1).max(240).optional(),
          questions: z.array(z.string().min(1).max(500)).max(20).optional(),
        })
        .strict()
        .parse(req.body);
      if (body.action === "set_workflow") {
        const c = svc.store.getCase(caseId);
        requirePolicy(
          c.specVersion === 0 && body.workflow,
          "Only cases without a specification can be routed",
        );
        requirePolicy(
          svc.store
            .settings()
            .contacts.some(
              (x) => x.active && x.workflows.includes(body.workflow!),
            ),
          "Workflow must be scoped to an active configured contact",
        );
        svc.store.putCase({ ...c, workflow: body.workflow }, c.revision);
        svc.store.event(caseId, "WORKFLOW_ASSIGNED", "admin", {
          workflow: body.workflow,
          reason: sanitizeBody(body.reason),
        });
      } else if (body.action === "reassign") {
        const contact = svc.store
          .settings()
          .contacts.find((x) => x.id === body.contactId);
        requirePolicy(
          contact?.active,
          "Choose an active authorized human contact",
        );
        const c = svc.store.getCase(caseId);
        svc.store.putCase({ ...c, owner: contact.id }, c.revision);
        svc.store.event(caseId, "REASSIGNED", "admin", {
          contactId: contact.id,
          reason: sanitizeBody(body.reason),
        });
      } else if (body.action === "return_for_clarification")
        svc.workflow.reopen(
          caseId,
          body.questions || [sanitizeBody(body.reason)],
          "admin",
          true,
        );
      else if (body.action === "merge") {
        requirePolicy(
          body.targetCaseId && body.targetCaseId !== caseId,
          "Choose a different existing case",
        );
        svc.store.getCase(body.targetCaseId);
        svc.workflow.transition(
          caseId,
          "DUPLICATE",
          "admin",
          sanitizeBody(body.reason),
          [body.targetCaseId],
        );
        svc.store.event(body.targetCaseId, "INCIDENT_LINKED", "admin", {
          duplicateCaseId: caseId,
        });
      } else
        svc.workflow.transition(
          caseId,
          (
            {
              suspend: "SUSPENDED",
              reopen: "TRIAGING",
              escalate: "ESCALATED",
              reject: "REJECTED",
              close: "CLOSED",
            } as const
          )[body.action],
          "admin",
          sanitizeBody(body.reason),
        );
      ok(res, svc.store.detail(caseId));
    }),
  );
  router.post(
    "/cases/:id/erase",
    wrap((req, res) => {
      service(req).erase(req.params.id);
      ok(res, { erased: true, immutableEvidenceRetained: true });
    }),
  );
  router.get(
    "/prompt",
    wrap((req, res) => ok(res, service(req).runtime.prompt())),
  );
  router.put(
    "/prompt",
    wrap((req, res) => {
      const input = z.object({ content: z.string() }).strict().parse(req.body);
      ok(res, { version: service(req).runtime.release(input.content) });
    }),
  );
  router.post(
    "/replay",
    wrap(async (_req, res) => {
      const body = z
        .object({ scenario: z.enum(["ar", "ppo"]) })
        .strict()
        .parse(_req.body);
      requirePolicy(
        demo,
        "Demo replay is disabled on this production-mail instance",
      );
      ok(res, await demo.replay(body.scenario));
    }),
  );
  router.post(
    "/simulate-reply",
    wrap(async (req, res) => {
      requirePolicy(
        demo,
        "Demo simulation is disabled on this production-mail instance",
      );
      requirePolicy(
        service(req) === demo,
        "Simulated replies require demo mode",
      );
      const body = z
        .object({
          caseId: z.string(),
          body: z.string().min(1).max(4000),
          replyToOutboxId: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      const d = demo.store.detail(body.caseId),
        source = d.messages[0],
        out = body.replyToOutboxId
          ? d.outbox.find((x) => x.id === body.replyToOutboxId)
          : d.outbox.at(-1);
      demo.orchestrator.ingest(
        {
          ...source,
          id: id("demo-reply"),
          body: body.body,
          inReplyTo: out?.rfcMessageId || source.rfcMessageId,
          references: out?.rfcMessageId || "",
          rfcMessageId: `<${id("demo")}@demo.invalid>`,
          date: demo.store.at(),
        },
        true,
      );
      await demo.drain();
      ok(res, demo.store.detail(body.caseId));
    }),
  );
  router.get(
    "/cases/:id/messages/:messageId/attachment/:attachmentId",
    wrap(async (req, res) => {
      const svc = service(req);
      const detail = svc.store.detail(req.params.id);
      requirePolicy(
        detail.messages.some((m) => m.id === req.params.messageId),
        "Attachment message is outside this case",
      );
      requirePolicy(
        !svc.demo &&
          svc.store.settings().privacyReviewed &&
          svc.store.settings().providerAgreementsConfirmed,
        "Live attachment access requires configured data policy",
      );
      requirePrivacy(svc.store.settings());
      const bytes = await svc.gmail.attachment(
        req.params.messageId,
        req.params.attachmentId,
      );
      svc.store.event(req.params.id, "SAFE_ATTACHMENT_READ", "admin", {
        messageId: req.params.messageId,
        attachmentId: req.params.attachmentId,
        bytes: bytes.length,
      });
      ok(res, {
        text: bytes.toString("utf8"),
        automaticallySentToModel: false,
      });
    }),
  );
  router.get(
    "/gmail/status",
    wrap((req, res) => ok(res, service(req).status().gmail)),
  );
  router.get(
    "/gmail/oauth/start",
    wrap((_req, res) => {
      requirePolicy(
        live.vault.configured(),
        "Configure PI_CREDENTIAL_ENCRYPTION_KEY first",
      );
      requirePolicy(
        process.env.PI_GMAIL_CLIENT_ID &&
          process.env.PI_GMAIL_CLIENT_SECRET &&
          process.env.PI_GMAIL_REDIRECT_URI,
        "Gmail OAuth client configuration is incomplete",
      );
      const scopes = [
        "https://www.googleapis.com/auth/gmail.readonly",
        ...(!live.sendLocked
          ? ["https://www.googleapis.com/auth/gmail.send"]
          : []),
      ];
      const params = new URLSearchParams({
        client_id: process.env.PI_GMAIL_CLIENT_ID!,
        redirect_uri: process.env.PI_GMAIL_REDIRECT_URI!,
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        login_hint: live.store.settings().mailbox,
        state: live.vault.issueState(),
      });
      ok(res, {
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      });
    }),
  );
  router.post(
    "/gmail/federation/connect",
    wrap(async (_req, res) => {
      requirePolicy(live.federation, "Federated Gmail is not configured");
      const profile = await live.gmail.profile();
      requirePolicy(
        profile.emailAddress.toLowerCase() ===
          live.store.settings().mailbox.toLowerCase(),
        "Connected mailbox mismatch",
      );
      live.connectFederation();
      ok(res, live.status().gmail);
    }),
  );
  router.post(
    "/gmail/disconnect",
    wrap(async (_req, res) => {
      if (live.federation) {
        live.vault.remove(live.store.settings().mailbox);
        ok(res, {
          disconnected: true,
          revoked: false,
          warning:
            "Local connection disabled; shared cluster credentials were not revoked",
        });
        return;
      }
      let revoked = false;
      try {
        const token = live.vault.get(live.store.settings().mailbox);
        const response = await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(10000),
        });
        revoked = response.ok;
      } catch {}
      live.vault.remove(live.store.settings().mailbox);
      ok(res, {
        disconnected: true,
        revoked,
        warning: revoked
          ? null
          : "Also revoke access in the Google account if the provider could not be reached",
      });
    }),
  );
  router.post(
    "/gmail/sync",
    wrap((_req, res) => {
      requirePolicy(
        live.enabled,
        "Enable PI_CLARIFICATION_ENABLED before polling",
      );
      live.store.enqueue("sync", `manual-sync:${id("request")}`, {});
      ok(res, { queued: true });
    }),
  );
  router.post(
    "/outbox/:id/request-send",
    wrap((req, res) => {
      const svc = service(req);
      requirePolicy(
        !svc.sendLocked && !svc.demo,
        "Outbound email is deployment-locked",
      );
      const row = svc.outbox.get(req.params.id);
      requirePolicy(
        ["prepared", "draft", "blocked"].includes(row.state),
        "Message is not eligible for send review",
      );
      svc.store.enqueue(
        "outbox",
        `send-review:${row.id}:${id("attempt")}`,
        { outboxId: row.id },
        row.caseId,
      );
      svc.store.event(row.caseId, "SEND_REVIEW_REQUESTED", "admin", {
        outboxId: row.id,
      });
      ok(res, { queued: true });
    }),
  );
  router.post(
    "/outbox/:id/reconcile",
    wrap((req, res) => {
      const svc = service(req),
        row = svc.outbox.get(req.params.id);
      requirePolicy(
        ["uncertain", "sending"].includes(row.state),
        "Only uncertain sends can be reconciled",
      );
      svc.store.enqueue(
        "outbox",
        `reconcile:${row.id}:${id("attempt")}`,
        { outboxId: row.id },
        row.caseId,
      );
      ok(res, { queued: true });
    }),
  );
  router.get(
    "/cases/:id/task",
    wrap((req, res) => {
      const tasks = service(req).store.detail(req.params.id).handoffs;
      requirePolicy(tasks.length, "No handoff exists");
      ok(res, tasks.at(-1));
    }),
  );
  app.use(base, router);
  live.start();
  return {
    live,
    demo,
    stop: async () => {
      await Promise.all([live.stop(), demo?.stop()]);
    },
  };
}
