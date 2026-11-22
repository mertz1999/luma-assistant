import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { reasoningEffortSchema, type ReasoningEffort, type RunnerModelInfo, type RunnerModelCatalog, type RunnerModelCatalogs } from "@luma/shared";

const execFileAsync = promisify(execFile);
type Runner = keyof RunnerModelCatalogs;
type Discovery = { models: RunnerModelInfo[]; cliVersion: string | null };
type RunnerConfig = {
  executable: string;
  defaultModel: string;
  env: () => NodeJS.ProcessEnv;
  command?: (args: string[]) => { executable: string; args: string[]; cwd: string };
};
type Options = {
  cachePath: string;
  cwd: string;
  codex: RunnerConfig;
  claude: RunnerConfig;
  refreshMs?: number;
  timeoutMs?: number;
  // Injectable metadata loader for cache/retry tests; production uses the CLI protocol below.
  discover?: (runner: Runner) => Promise<Discovery>;
};

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function effort(value: unknown): ReasoningEffort | undefined {
  const parsed = reasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function uniqueModels(models: RunnerModelInfo[]): RunnerModelInfo[] {
  return [...new Map(models.map(model => [model.id, model])).values()];
}

export function parseCodexModels(data: unknown): RunnerModelInfo[] {
  if (!Array.isArray(data)) throw new Error("Codex returned an invalid model catalog.");
  return uniqueModels(data.filter(record).filter(m => !m.hidden && typeof m.model === "string" && m.model.trim()).map(m => {
    const efforts = Array.isArray(m.supportedReasoningEfforts)
      ? m.supportedReasoningEfforts.map((e: unknown) => record(e) ? effort(e.reasoningEffort) : undefined).filter((e: ReasoningEffort | undefined): e is ReasoningEffort => !!e)
      : undefined;
    return {
      id: m.model,
      displayName: typeof m.displayName === "string" ? m.displayName : m.model,
      supportedEfforts: efforts,
      supportsEffort: efforts ? efforts.length > 0 : undefined,
      defaultEffort: effort(m.defaultReasoningEffort),
    };
  }));
}

export function parseClaudeModels(data: unknown): RunnerModelInfo[] {
  if (!Array.isArray(data)) throw new Error("Claude returned an invalid model catalog.");
  return uniqueModels(data.filter(record).filter(m => typeof m.value === "string" && m.value.trim()).map(m => ({
    id: m.value,
    displayName: typeof m.displayName === "string" ? m.displayName : m.value,
    resolvedModel: typeof m.resolvedModel === "string" ? m.resolvedModel : undefined,
    supportsEffort: typeof m.supportsEffort === "boolean" ? m.supportsEffort : undefined,
    supportedEfforts: Array.isArray(m.supportedEffortLevels)
      ? m.supportedEffortLevels.map(effort).filter((e: ReasoningEffort | undefined): e is ReasoningEffort => !!e)
      : undefined,
  })));
}

// Both handshakes request metadata only: no thread/start, user prompt, or inference.
// Claude's initialize response is the same catalog exposed by SDK supportedModels().
export function discoverCliModels(runner: Runner, config: RunnerConfig, cwd: string, timeoutMs = 30_000): Promise<RunnerModelInfo[]> {
  return new Promise((resolve, reject) => {
    const args = runner === "codex" ? ["app-server"] : [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence",
      "--settings", '{"disableAllHooks":true}',
    ];
    const command = config.command?.(args) ?? { executable: config.executable, args, cwd };
    const child = spawn(command.executable, command.args, { cwd: command.cwd, env: config.env(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let settled = false;
    let bytes = 0;
    let requestId = 2;
    let pages = 0;
    const cursors = new Set<string>();
    const models: RunnerModelInfo[] = [];
    const lines = createInterface({ input: child.stdout });
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, name); } catch { /* Process has already exited. */ }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      signal("SIGTERM");
      const killTimer = setTimeout(() => signal("SIGKILL"), 1000);
      killTimer.unref();
      child.once("close", () => clearTimeout(killTimer));
      if (error) reject(error);
      else if (!models.length) reject(new Error(`${runner === "codex" ? "Codex" : "Claude"} returned no selectable models.`));
      else resolve(uniqueModels(models));
    };
    const timer = setTimeout(() => finish(new Error(`Model discovery timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdin.on("error", () => finish(new Error("CLI closed its metadata input unexpectedly.")));
    child.on("error", (error: NodeJS.ErrnoException) => finish(new Error(`Cannot start ${runner} CLI (${error.code || "spawn error"}). Check its executable path and permissions.`)));
    child.on("exit", code => finish(new Error(`${runner} CLI exited before returning models (exit ${code ?? "signal"}). Check CLI login and configuration.`)));
    // Never expose stderr, which can include credentials or user configuration.
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) finish(new Error("CLI model response exceeded the size limit."));
    });
    lines.on("line", line => {
      if (settled || !line.trim()) return;
      let msg: Record<string, any>;
      try { msg = JSON.parse(line); } catch { return; }
      if (!record(msg)) return;
      try {
        if (runner === "claude") {
          if (msg.type !== "control_response" || msg.response?.request_id !== "luma_models") return;
          if (msg.response.subtype !== "success") throw new Error("Claude rejected model discovery. Check CLI version and login.");
          models.push(...parseClaudeModels(msg.response.response?.models));
          finish();
        } else {
          if (msg.id === 1) {
            if (msg.error) throw new Error("Codex rejected initialization. Check CLI version and configuration.");
            send({ method: "initialized", params: {} });
            send({ method: "model/list", id: requestId, params: { limit: 100, includeHidden: false } });
          } else if (msg.id === requestId) {
            if (msg.error) throw new Error("Codex rejected model discovery. Check CLI login and provider configuration.");
            models.push(...parseCodexModels(msg.result?.data));
            const cursor = msg.result?.nextCursor;
            if (cursor) {
              if (typeof cursor !== "string" || cursors.has(cursor) || ++pages > 20) throw new Error("Codex returned invalid model pagination.");
              cursors.add(cursor);
              send({ method: "model/list", id: ++requestId, params: { limit: 100, includeHidden: false, cursor } });
            } else finish();
          }
        }
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid CLI model response.")); }
    });
    if (runner === "codex") send({ method: "initialize", id: 1, params: { clientInfo: { name: "luma_assistant", title: "Luma Assistant", version: "0.1.0" } } });
    else send({ type: "control_request", request_id: "luma_models", request: { subtype: "initialize", hooks: {} } });
  });
}

export class ModelCatalogService {
  private catalogs: RunnerModelCatalogs;
  private pending = new Map<Runner, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly refreshMs: number;
  constructor(private readonly options: Options) {
    this.refreshMs = options.refreshMs ?? 15 * 60_000;
    const fallback = (runner: Runner): RunnerModelCatalog => ({
      models: uniqueModels([options[runner].defaultModel, ...(runner === "claude" ? ["sonnet", "opus", "haiku"] : [])].map(id => ({ id, displayName: id }))),
      source: "fallback", updatedAt: null, checkedAt: null, refreshing: false, error: null, cliVersion: null,
    });
    this.catalogs = { codex: fallback("codex"), claude: fallback("claude") };
    try {
      const stored = JSON.parse(fs.readFileSync(options.cachePath, "utf8"));
      for (const runner of ["codex", "claude"] as const) {
        const item = stored[runner];
        if (item?.identity !== this.identity(runner) || !Array.isArray(item.models) || !item.models.length || !Number.isFinite(item.updatedAt)) continue;
        const valid = item.models.every((m: unknown) => record(m) && typeof m.id === "string" && typeof m.displayName === "string"
          && (m.supportedEfforts === undefined || (Array.isArray(m.supportedEfforts) && m.supportedEfforts.every((e: unknown) => !!effort(e)))));
        if (valid) this.catalogs[runner] = { ...fallback(runner), models: item.models, updatedAt: item.updatedAt, cliVersion: typeof item.cliVersion === "string" ? item.cliVersion : null, source: "cache" };
      }
    } catch { /* A missing/corrupt cache must never prevent startup. */ }
  }
  private identity(runner: Runner): string {
    const config = this.options[runner];
    const env = config.env();
    return createHash("sha256").update(JSON.stringify([config.executable, env.HOME, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.CLAUDE_AUTH_MODE])).digest("hex");
  }
  snapshot(): RunnerModelCatalogs {
    return structuredClone(this.catalogs);
  }
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.refreshMs);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
  async refresh(force = false, only?: Runner): Promise<RunnerModelCatalogs> {
    await Promise.all((only ? [only] : ["codex", "claude"] as const).map(runner => this.refreshRunner(runner, force)));
    return this.snapshot();
  }
  private refreshRunner(runner: Runner, force: boolean): Promise<void> {
    const existing = this.pending.get(runner);
    if (existing) return existing;
    const item = this.catalogs[runner];
    if (!force && item.checkedAt !== null && Date.now() - item.checkedAt < this.refreshMs) return Promise.resolve();
    item.refreshing = true;
    const pending = (async () => {
      try {
        const config = this.options[runner];
        const result = this.options.discover ? await this.options.discover(runner) : await (async () => {
          const versionCommand = config.command?.(["--version"]) ?? { executable: config.executable, args: ["--version"], cwd: this.options.cwd };
          const [models, version] = await Promise.all([
            discoverCliModels(runner, config, this.options.cwd, this.options.timeoutMs),
            execFileAsync(versionCommand.executable, versionCommand.args, { cwd: versionCommand.cwd, env: config.env(), timeout: 5000, maxBuffer: 4096 }).catch(() => ({ stdout: "" })),
          ]);
          return { models, cliVersion: version.stdout.trim().slice(0, 160) || null };
        })();
        if (!result.models.length) throw new Error("CLI returned no selectable models.");
        this.catalogs[runner] = { models: result.models, cliVersion: result.cliVersion, source: "live", updatedAt: Date.now(), checkedAt: Date.now(), refreshing: false, error: null };
        this.persist();
      } catch (error) {
        this.catalogs[runner] = { ...this.catalogs[runner], source: item.updatedAt === null ? "fallback" : "cache", checkedAt: Date.now(), refreshing: false, error: error instanceof Error ? error.message : "Model discovery failed." };
      } finally { this.pending.delete(runner); }
    })();
    this.pending.set(runner, pending);
    return pending;
  }
  private persist(): void {
    const data = Object.fromEntries((["codex", "claude"] as const).filter(runner => this.catalogs[runner].updatedAt !== null).map(runner => [runner, { identity: this.identity(runner), models: this.catalogs[runner].models, updatedAt: this.catalogs[runner].updatedAt, cliVersion: this.catalogs[runner].cliVersion }]));
    const temporary = `${this.options.cachePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(temporary), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temporary, this.options.cachePath);
    } catch { /* Keep the live catalog usable when disk persistence is unavailable. */ }
  }
}
