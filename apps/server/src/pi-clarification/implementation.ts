import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { load, JSON_SCHEMA } from "js-yaml";
import { z } from "zod";
import { PIStore, digest, id } from "./store.js";
import { RepositoryRegistry, gitRead, safeCodePath } from "./repositories.js";
import {
  LocalJsonRunner,
  boundedProcess,
  sandboxBase,
} from "./local-runner.js";
import { HandoffService } from "./handoff.js";
import {
  requirePolicy,
  requireProcessingAuthorization,
  sanitizeBody,
} from "./policy.js";
import { ReviewedInputService } from "./reviewed-input.js";

const ProposalSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    changes: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            content: z.string().max(100000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type ImplementationRecord = {
  id: string;
  caseId: string;
  repository: string;
  specDigest: string;
  sourceDigest: string;
  baseCommit: string;
  branch: string;
  workspace: string;
  contentDigest: string;
  state: "preparing" | "ready" | "failed" | "publishing" | "published";
  summary: string;
  paths: string[];
  checks: { command: string[]; passed: boolean }[];
  error: string | null;
  prUrl: string | null;
  createdAt: string;
};

// Never push or open a PR if that event can start deployment automation.
// Unsupported event configurations fail closed. Manual workflows are never dispatched.
export function assertWorkflowSafe(raw: string, branch: string) {
  requirePolicy(raw.length <= 200000, "Workflow too large to inspect");
  const doc = load(raw, { schema: JSON_SCHEMA }) as Record<string, unknown>;
  requirePolicy(doc && typeof doc === "object", "Invalid workflow");
  const on = doc.on;
  const events =
    typeof on === "string"
      ? { [on]: null }
      : Array.isArray(on)
        ? Object.fromEntries(on.map((e) => [e, null]))
        : (on as Record<string, unknown>);
  requirePolicy(
    events && typeof events === "object",
    "Cannot verify workflow triggers",
  );
  for (const [event, config] of Object.entries(events)) {
    if (
      ["workflow_dispatch", "workflow_call", "schedule", "release"].includes(
        event,
      )
    )
      continue;
    if (event === "push") {
      const branches = (config as { branches?: unknown } | null)?.branches;
      requirePolicy(
        Array.isArray(branches) &&
          branches.length &&
          branches.every(
            (v) =>
              typeof v === "string" &&
              /^[a-zA-Z0-9_./-]+$/.test(v) &&
              v !== branch,
          ),
        "Branch push could trigger automation; publication blocked",
      );
      continue;
    }
    requirePolicy(
      event === "pull_request",
      `Unsupported automatic workflow event ${event}; publication blocked`,
    );
    requirePolicy(
      !/\b(?:deploy|kubectl|helm|doctl|terraform|pulumi|ssh|scp|workflow_dispatch|repository_dispatch|docker|buildah|build-push-action)\b|secrets\.|github\.token|"[^"]+"\s*:\s*"write"|write-all|\.github\/workflows\//i.test(
        JSON.stringify(doc.jobs),
      ),
      "PR workflow can deploy, use credentials or delegate unchecked workflows; publication blocked",
    );
  }
}

function command(command: string, args: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  try {
    return execFileSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "Repository/PR operation failed; check configured GitHub access without exposing credentials",
    );
  }
}
export class ImplementationService {
  constructor(
    readonly store: PIStore,
    readonly registry: RepositoryRegistry,
    readonly handoff: HandoffService,
    readonly root: string,
    readonly runner = new LocalJsonRunner(),
  ) {}
  list(caseId: string) {
    return (
      this.store.db
        .prepare(
          "SELECT payload FROM pi_implementations WHERE case_id=? ORDER BY rowid",
        )
        .all(caseId) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as ImplementationRecord);
  }
  erase(caseId: string) {
    for (const record of this.list(caseId)) {
      const expected = path.join(
        this.root,
        "data/pi-implementations",
        record.id,
      );
      requirePolicy(
        record.workspace === expected,
        "Invalid implementation artifact path",
      );
      fs.rmSync(expected, { recursive: true, force: true });
      fs.rmSync(`${expected}-pr.md`, { force: true });
    }
    this.store.db
      .prepare("DELETE FROM pi_implementations WHERE case_id=?")
      .run(caseId);
  }
  get(recordId: string) {
    const row = this.store.db
      .prepare("SELECT payload FROM pi_implementations WHERE id=?")
      .get(recordId) as { payload: string } | undefined;
    requirePolicy(row, "Implementation not found");
    return JSON.parse(row.payload) as ImplementationRecord;
  }
  save(record: ImplementationRecord) {
    this.store.db
      .prepare(
        "INSERT INTO pi_implementations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(record.id, record.caseId, JSON.stringify(record));
    return record;
  }
  diff(recordId: string) {
    const record = this.get(recordId);
    requirePolicy(
      record.state === "ready",
      "Implementation is not ready for review",
    );
    // Include untracked files without staging them in the original application checkout.
    command(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "add",
        "--intent-to-add",
        "--",
        ...record.paths.filter((p) =>
          fs.existsSync(path.join(record.workspace, p)),
        ),
      ],
      record.workspace,
    );
    return gitRead(
      record.workspace,
      ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...record.paths],
      1_000_000,
    );
  }
  authorize(caseId: string, repository: string) {
    requirePolicy(
      process.env.PI_IMPLEMENTATION_ENABLED === "true",
      "Implementation/PR service is not enabled",
    );
    requirePolicy(
      ["reviewed_summary", "automatic"].includes(
        this.store.settings().modelInputMode,
      ),
      "Local implementation requires a configured protected input mode",
    );
    requireProcessingAuthorization(this.store.settings());
    const input = new ReviewedInputService(this.store);
    const brief =
      this.store.settings().modelInputMode === "automatic"
        ? {
            sourceDigest: input.sourceDigest(caseId),
            summary: this.store
              .detail(caseId)
              .messages.filter((m) => m.direction !== "outgoing")
              .slice(-15)
              .map((m) => sanitizeBody(m.body))
              .join("\n\n")
              .slice(0, 12000),
          }
        : input.requireCurrent(caseId);
    const task = this.handoff.publish(caseId);
    requirePolicy(
      task.repositoryCandidates.includes(repository),
      "Repository is outside the approved task",
    );
    requirePolicy(
      this.registry.get(repository).implementationAllowed,
      "Implementation is disabled for this repository",
    );
    return { task, brief };
  }
  async prepare(caseId: string, repository: string) {
    const { task, brief } = this.authorize(caseId, repository);
    const entry = this.registry.get(repository);
    requirePolicy(
      entry.validation.length,
      "Configure isolated validation commands for this repository before implementation",
    );
    const snapshot = this.registry.snapshot(repository, brief.summary);
    const recordId = id("implementation");
    const workspace = path.join(this.root, "data/pi-implementations", recordId);
    const record: ImplementationRecord = {
      id: recordId,
      caseId,
      repository,
      specDigest: task.specDigest,
      sourceDigest: digest({
        source: brief.sourceDigest,
        summary: brief.summary,
      }),
      baseCommit: snapshot.commit,
      branch: `pi-automation/${caseId.toLowerCase()}-${recordId.slice(-8)}`,
      workspace,
      contentDigest: "",
      state: "preparing",
      summary: "",
      paths: [],
      checks: [],
      error: null,
      prUrl: null,
      createdAt: this.store.at(),
    };
    const prior = this.list(caseId).find(
      (r) =>
        r.repository === repository &&
        r.specDigest === task.specDigest &&
        r.sourceDigest === record.sourceDigest &&
        ["ready", "publishing", "published"].includes(r.state),
    );
    if (prior) return prior;
    this.save(record);
    try {
      const { sourceGmailThreadId: _threadId, ...safeTask } = task;
      const proposal = ProposalSchema.parse(
        await this.runner.json(
          JSON.stringify({
            prompt: fs.readFileSync(
              path.join(this.root, "agents/pi-implementor/AGENT.md"),
              "utf8",
            ),
            task: "Propose source-code changes only for this exact approved task. Return complete new contents for each changed file, null for deletion. No deployments, release changes, workflow edits, database operations, credentials, patient details or completion claims. Only propose changes in fully supplied source files, or new safe source files. Validation is performed separately by the server.",
            specification: safeTask,
            reviewedSummary: brief.summary,
            snapshot,
          }),
          {
            type: "object",
            properties: {
              summary: { type: "string" },
              changes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    content: { type: ["string", "null"] },
                  },
                  required: ["path", "content"],
                  additionalProperties: false,
                },
              },
            },
            required: ["summary", "changes"],
            additionalProperties: false,
          },
          AbortSignal.timeout(150000),
        ),
      );
      requirePolicy(
        new Set(proposal.changes.map((c) => c.path)).size ===
          proposal.changes.length,
        "Duplicate changed paths",
      );
      fs.mkdirSync(path.dirname(workspace), { recursive: true, mode: 0o700 });
      command(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "clone",
          "--no-hardlinks",
          "--no-checkout",
          "--local",
          "--",
          entry.path,
          workspace,
        ],
        this.root,
      );
      command(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "checkout",
          "-b",
          record.branch,
          snapshot.commit,
        ],
        workspace,
      );
      for (const change of proposal.changes) {
        requirePolicy(
          safeCodePath(change.path),
          "Changes to secrets/data/deployment/workflow paths are prohibited",
        );
        const target = path.join(workspace, change.path);
        for (let dir = target; dir !== workspace; dir = path.dirname(dir))
          requirePolicy(
            !fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink(),
            "Symlink changes are prohibited",
          );
        if (fs.existsSync(target)) {
          const supplied = snapshot.files.find((f) => f.path === change.path);
          requirePolicy(
            supplied &&
              gitRead(entry.path, [
                "show",
                `${snapshot.commit}:${change.path}`,
              ]) === supplied.content,
            "Cannot replace an incompletely supplied or redacted source file",
          );
        }
        if (change.content === null) fs.rmSync(target);
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, change.content, { mode: 0o644 });
        }
      }
      record.paths = proposal.changes.map((c) => c.path);
      record.summary = proposal.summary;
      for (const check of entry.validation) {
        requirePolicy(
          ["python3", "node", "npm"].includes(check[0]) &&
            !check.some((arg) =>
              /(?:deploy|release|publish|kubectl|helm|terraform)/i.test(arg),
            ),
          "Validation command is not an allowed local check",
        );
        const args = sandboxBase();
        args.push(
          "--unshare-net",
          "--bind",
          workspace,
          "/work",
          "--tmpfs",
          "/work/.git",
          "--setenv",
          "HOME",
          "/tmp",
          "--chdir",
          "/work",
          "--",
          `/usr/bin/${check[0]}`,
          ...check.slice(1),
        );
        let passed = true;
        try {
          await boundedProcess(
            "/usr/bin/bwrap",
            args,
            "",
            AbortSignal.timeout(120000),
          );
        } catch {
          passed = false;
        }
        record.checks.push({ command: check, passed });
        requirePolicy(
          passed,
          "Isolated validation failed; no branch pushed and no PR created",
        );
      }
      const latest = this.authorize(caseId, repository);
      requirePolicy(
        latest.task.specDigest === record.specDigest &&
          digest({
            source: latest.brief.sourceDigest,
            summary: latest.brief.summary,
          }) === record.sourceDigest,
        "Case or reviewed input changed during implementation",
      );
      record.contentDigest = digest(
        record.paths.map((p) => ({
          path: p,
          content: fs.existsSync(path.join(workspace, p))
            ? fs.readFileSync(path.join(workspace, p), "utf8")
            : null,
        })),
      );
      record.state = "ready";
      this.store.event(
        caseId,
        "IMPLEMENTATION_READY_FOR_REVIEW",
        "implementation",
        {
          implementationId: recordId,
          repository,
          paths: record.paths,
          deploymentAuthorized: false,
        },
      );
    } catch (error) {
      record.state = "failed";
      record.error =
        error instanceof Error ? error.message : "Implementation failed";
      this.store.event(caseId, "IMPLEMENTATION_FAILED", "implementation", {
        implementationId: recordId,
        reason: record.error,
        deploymentAuthorized: false,
      });
    }
    return this.save(record);
  }
  publish(recordId: string, codeReviewed: boolean) {
    requirePolicy(
      codeReviewed,
      "Review the implementation diff before publishing a draft PR",
    );
    const record = this.get(recordId);
    if (record.state === "published") return record;
    requirePolicy(
      record.state === "ready" &&
        record.checks.length &&
        record.checks.every((c) => c.passed),
      "Implementation has not passed validation/review",
    );
    const { task, brief } = this.authorize(record.caseId, record.repository);
    requirePolicy(
      task.specDigest === record.specDigest &&
        digest({ source: brief.sourceDigest, summary: brief.summary }) ===
          record.sourceDigest,
      "Case changed; implementation authorization is stale",
    );
    const entry = this.registry.get(record.repository);
    const remote = command(
      "gh",
      ["api", `repos/${entry.id}/commits/${entry.baseBranch}`, "--jq", ".sha"],
      this.root,
    ).trim();
    requirePolicy(
      remote === record.baseCommit,
      "Remote base changed; regenerate and validate the implementation",
    );
    const workflows = gitRead(record.workspace, [
      "ls-tree",
      "-r",
      "--name-only",
      record.baseCommit,
      ".github/workflows",
    ])
      .split("\n")
      .filter((name) => /\.ya?ml$/.test(name));
    for (const name of workflows)
      assertWorkflowSafe(
        gitRead(record.workspace, ["show", `${record.baseCommit}:${name}`]),
        record.branch,
      );
    // Bind publication to the exact source contents that passed isolated checks.
    const changed = gitRead(record.workspace, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    requirePolicy(
      changed.length &&
        changed.every((p) => record.paths.includes(p) && safeCodePath(p)),
      "Implementation workspace changed outside reviewed paths",
    );
    requirePolicy(
      record.paths.every((p) => changed.includes(p)),
      "Implementation workspace differs from generated proposal",
    );
    const contentDigest = digest(
      record.paths.map((p) => ({
        path: p,
        content: fs.existsSync(path.join(record.workspace, p))
          ? fs.readFileSync(path.join(record.workspace, p), "utf8")
          : null,
      })),
    );
    requirePolicy(
      contentDigest === record.contentDigest,
      "Implementation changed since validation",
    );
    record.state = "publishing";
    this.save(record);
    try {
      command(
        "/usr/bin/git",
        ["-c", "core.hooksPath=/dev/null", "add", "--", ...record.paths],
        record.workspace,
      );
      command(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=PI AI Assistant",
          "-c",
          "user.email=pi-assistant@users.noreply.github.com",
          "commit",
          "-m",
          `${record.caseId}: approved implementation [skip ci]`,
        ],
        record.workspace,
      );
      command(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          `https://github.com/${entry.id}.git`,
          `HEAD:refs/heads/${record.branch}`,
        ],
        record.workspace,
      );
      const bodyFile = path.join(
        this.root,
        "data/pi-implementations",
        `${record.id}-pr.md`,
      );
      fs.writeFileSync(
        bodyFile,
        `${record.caseId}, specification v${task.specVersion} (${record.specDigest}).\n\n${record.summary}\n\nValidation passed in an isolated environment without network or deployment credentials.\n\nDraft PR only. No merge, deployment, release, image publication or production data changes are authorized.\n`,
        { mode: 0o600 },
      );
      const url = command(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          entry.id,
          "--draft",
          "--base",
          entry.baseBranch,
          "--head",
          record.branch,
          "--title",
          `${record.caseId}: proposed implementation`,
          "--body-file",
          bodyFile,
        ],
        record.workspace,
      ).trim();
      requirePolicy(
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url),
        "GitHub did not confirm a PR URL",
      );
      record.state = "published";
      record.prUrl = url;
      this.store.event(record.caseId, "DRAFT_PR_CREATED", "implementation", {
        implementationId: record.id,
        prUrl: url,
        deploymentAuthorized: false,
      });
    } catch {
      // Do not blindly retry a push or PR creation after an uncertain network result.
      record.error =
        "Publication outcome needs manual reconciliation; automatic retry disabled";
    }
    return this.save(record);
  }
}
