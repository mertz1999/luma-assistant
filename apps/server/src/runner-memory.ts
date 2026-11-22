import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectError } from "./project-store.js";

export function scopedRunnerEnvironment(base: NodeJS.ProcessEnv, capability: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base, ...capability };
  for (const key of ["PASSWORD", "APP_PASSWORD", "JWT_SECRET", "LUMA_IMAGE_PASSWORD", "LUMA_MEMORY_TOKEN", "LUMA_MEMORY_URL"]) delete env[key];
  return { ...env, ...capability };
}

export function codexMemoryArgs(url: string): string[] {
  return ["-c", `mcp_servers.luma-memory.url=${JSON.stringify(url)}`,
    "-c", 'mcp_servers.luma-memory.bearer_token_env_var="LUMA_MEMORY_TOKEN"',
    "-c", "mcp_servers.luma-memory.enabled=true",
    "-c", "mcp_servers.luma-memory.required=true"];
}

export function claudeMemoryConfig(directory: string, runId: string, url: string, token: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "luma-memory": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
  return file;
}

// Cursor reads MCP configuration at startup. Interpolation makes this one static
// entry safe for concurrent runs: each process supplies its own URL and capability.
export function ensureCursorMemoryConfig(): void {
  const file = path.join(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor"), "mcp.json");
  const desired = { url: "${env:LUMA_MEMORY_URL}", headers: { Authorization: "Bearer ${env:LUMA_MEMORY_TOKEN}" } };
  let config: Record<string, any> = { mcpServers: {} };
  if (fs.existsSync(file)) {
    try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { throw new ProjectError("Cursor's mcp.json is invalid; it was left unchanged.", 409); }
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || (config.mcpServers && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))) throw new ProjectError("Cursor's MCP configuration is invalid; it was left unchanged.", 409);
  config.mcpServers ||= {};
  const existing = config.mcpServers["luma-memory"];
  if (existing) {
    if (existing.url !== desired.url || existing.headers?.Authorization !== desired.headers.Authorization) throw new ProjectError("Cursor already has a different luma-memory server. Rename that entry before enabling Luma project memory.", 409);
    return;
  }
  config.mcpServers["luma-memory"] = desired;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
