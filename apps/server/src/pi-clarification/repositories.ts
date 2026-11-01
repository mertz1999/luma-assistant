import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  PIExternalSchemas,
  PIInvestigationResultSchema,
  type PIInvestigationRequest,
} from "@luma/shared";
import type { Investigator } from "./runtime.js";
import { LocalJsonRunner, localRunnerReady } from "./local-runner.js";
import { requirePolicy, redactTree } from "./policy.js";

export const RepositorySchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    path: z.string(),
    baseBranch: z
      .string()
      .regex(/^[A-Za-z0-9_./-]+$/)
      .default("main"),
    implementationAllowed: z.boolean().default(true),
    validation: z
      .array(z.array(z.string().min(1)).min(1))
      .max(10)
      .default([]),
  })
  .strict();
export type PIRepository = z.infer<typeof RepositorySchema>;
export function gitRead(
  repository: string,
  args: string[],
  maxBuffer = 12_000_000,
): string {
  return execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      repository,
      ...args,
    ],
    {
      encoding: "utf8",
      maxBuffer,
      timeout: 15000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
}
export function safeCodePath(name: string) {
  return (
    name.length < 240 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.startsWith("."),
      ) &&
    !/(?:^|\/)(?:data|uploads|logs|secrets?|credentials?|fixtures?|samples?|exports?|backups?|node_modules|vendor|dist|build|deploy(?:ments?)?|k8s|kubernetes|helm|infra|terraform|docker)(?:\/|\.)/i.test(
      name,
    ) &&
    !/(?:^|\/)(?:makefile|dockerfile|compose[^/]*|deploy[^/]*|release[^/]*|.*\.(?:pem|key|crt|p12|sqlite|db|sql|csv|pdf|png|jpg|jpeg|lock))$/i.test(
      name,
    ) &&
    /\.(?:py|ts|tsx|js|jsx|mjs|cjs|html|css|scss|svelte|vue|go|rs|java|md|json|toml|txt)$/.test(
      name,
    )
  );
}
export class RepositoryRegistry {
  constructor(readonly entries: PIRepository[]) {}
  static load(file = process.env.PI_REPOSITORY_REGISTRY || "") {
    if (!file) return new RepositoryRegistry([]);
    const entries = z
      .array(RepositorySchema)
      .max(100)
      .parse(JSON.parse(fs.readFileSync(file, "utf8")));
    const ids = new Set<string>();
    for (const entry of entries) {
      const actual = fs.realpathSync(entry.path);
      requirePolicy(
        actual.startsWith("/home/pi/") && actual === entry.path,
        "Repository must be a canonical path beneath /home/pi",
      );
      const remote = gitRead(actual, ["config", "--get", "remote.origin.url"])
        .trim()
        .replace(/\.git$/, "");
      requirePolicy(
        remote.toLowerCase() ===
          `https://github.com/${entry.id}`.toLowerCase() ||
          remote.toLowerCase() === `git@github.com:${entry.id}`.toLowerCase(),
        "Repository remote does not match registry",
      );
      requirePolicy(
        !ids.has(entry.id.toLowerCase()),
        "Duplicate repository registration",
      );
      ids.add(entry.id.toLowerCase());
    }
    return new RepositoryRegistry(entries);
  }
  get(id: string) {
    const entry = this.entries.find((r) => r.id === id);
    requirePolicy(entry, "Repository is outside the PI registry");
    return entry;
  }
  publicEntries() {
    return this.entries.map(
      ({ id, baseBranch, implementationAllowed, validation }) => ({
        id,
        baseBranch,
        implementationAllowed,
        validationConfigured: validation.length > 0,
      }),
    );
  }
  snapshot(id: string, question: string) {
    const entry = this.get(id);
    const commit = gitRead(entry.path, [
      "rev-parse",
      `refs/remotes/origin/${entry.baseBranch}^{commit}`,
    ]).trim();
    requirePolicy(
      /^[0-9a-f]{40,64}$/.test(commit),
      "Invalid repository revision",
    );
    const terms = [
      ...new Set(question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []),
    ].slice(0, 30);
    const files = gitRead(entry.path, ["ls-tree", "-r", "--name-only", commit])
      .split("\n")
      .filter(safeCodePath);
    const selected = files
      .map((name) => ({
        name,
        score: terms.filter((term) => name.toLowerCase().includes(term)).length,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const excerpts: { ref: string; path: string; content: string }[] = [];
    let bytes = 0;
    for (const { name, score } of selected) {
      if (excerpts.length >= 30 || bytes >= 110000) break;
      // Restrict metadata-only files to relevant entries when the repository is large.
      if (!score && excerpts.length >= 12) continue;
      const mode = gitRead(entry.path, ["ls-tree", commit, "--", name]);
      if (!/^100(?:644|755) blob /.test(mode)) continue;
      const content = gitRead(
        entry.path,
        ["show", `${commit}:${name}`],
        2_000_000,
      );
      if (content.includes("\0") || content.length > 30000) continue;
      const ref = `${id}@${commit}:${name}:1`;
      if (ref.length > 240) continue;
      const safe = content
        .replace(
          /\b(?:Bearer\s+[A-Za-z0-9_.=-]+|(?:api[_ -]?key|password|refresh[_ -]?token|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*["']?[^\s,"';]+)/gi,
          "[REDACTED]",
        )
        .slice(0, Math.min(12000, 110000 - bytes));
      bytes += safe.length;
      excerpts.push({
        ref,
        path: name,
        content: safe,
      });
    }
    return {
      repository: id,
      commit,
      files: excerpts,
      limitations: [
        "Local origin-tracking revision; may lag the remote",
        "Bounded source excerpts; secrets, data files and deployment files excluded",
        "Static inspection only; no reproduction or tests executed",
      ],
    };
  }
}

export class LocalInvestigator implements Investigator {
  get isolated() {
    return (
      this.registry.entries.length > 0 && localRunnerReady(this.runner.kind)
    );
  }
  constructor(
    readonly registry: RepositoryRegistry,
    readonly runner = new LocalJsonRunner(),
    readonly promptPath?: string,
  ) {}
  async investigate(request: PIInvestigationRequest, signal: AbortSignal) {
    requirePolicy(
      request.permissions === "read_only",
      "Investigator must be read-only",
    );
    requirePolicy(
      request.repositories.length <= 2,
      "Investigate at most two scoped repositories per request",
    );
    const snapshots = request.repositories.map((id) =>
      this.registry.snapshot(id, request.question),
    );
    const evidence = new Set(
      snapshots.flatMap((s) => s.files.map((f) => f.ref)),
    );
    const result = PIInvestigationResultSchema.parse(
      redactTree(
        await this.runner.json(
          JSON.stringify({
            prompt: this.promptPath
              ? fs.readFileSync(this.promptPath, "utf8")
              : "Read-only PI code investigator; no execution or deployment.",
            task: "Inspect only supplied source excerpts. Never claim tests, reproduction, fixes or deployment. Cite exact supplied file refs. Unproven conclusions belong in hypotheses. Include snapshot limitations.",
            request,
            snapshots,
          }),
          PIExternalSchemas.InvestigationResult,
          signal,
        ),
      ),
    );
    requirePolicy(
      result.correlationId === request.correlationId,
      "Investigation case mismatch",
    );
    requirePolicy(
      result.confirmedFacts.every((fact) =>
        fact.evidenceRefs.every((ref) => evidence.has(ref)),
      ) && result.fileRefs.every((ref) => evidence.has(ref)),
      "Investigator cited unsupplied evidence",
    );
    requirePolicy(
      result.commitRefs.every((ref) =>
        snapshots.some((s) => ref === s.commit),
      ) && !result.prRefs.length,
      "Investigator invented commit/PR evidence",
    );
    return {
      ...result,
      limitations: [
        ...new Set([
          ...result.limitations,
          ...snapshots.flatMap((s) => s.limitations),
        ]),
      ].slice(0, 100),
    };
  }
}
