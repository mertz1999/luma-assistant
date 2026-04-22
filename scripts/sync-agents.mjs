import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const agentsPath = path.join(repoRoot, "AGENTS.md");
const homeDir = process.env.HOME || "";
const fixedConfigPath = path.join(homeDir, "config", "agentic-assistant", "config.yaml");
const repoConfigPath = path.join(repoRoot, "config.yaml");

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readDefaultWorkspace(cfgText) {
  const line = cfgText
    .split(/\r?\n/)
    .find((row) => row.trim().startsWith("default_workspace:"));
  if (!line) {
    throw new Error("config.yaml is missing 'default_workspace'");
  }

  const raw = line.split(":").slice(1).join(":").trim();
  if (!raw) {
    throw new Error("default_workspace is empty in config.yaml");
  }

  let workspace = stripQuotes(raw);
  if (workspace.startsWith("~")) {
    const home = process.env.HOME || "";
    workspace = home ? path.join(home, workspace.slice(1)) : workspace;
  }

  return path.resolve(workspace);
}

function resolveConfigPath() {
  if (fs.existsSync(fixedConfigPath)) return fixedConfigPath;
  if (fs.existsSync(repoConfigPath)) return repoConfigPath;
  throw new Error(`Missing config file. Expected one of: ${fixedConfigPath}, ${repoConfigPath}`);
}

function main() {
  if (!fs.existsSync(agentsPath)) {
    throw new Error(`Missing AGENTS file: ${agentsPath}`);
  }

  const configPath = resolveConfigPath();
  const cfgText = fs.readFileSync(configPath, "utf8");
  const workspaceRoot = readDefaultWorkspace(cfgText);
  const destination = path.join(workspaceRoot, "AGENTS.md");

  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`default_workspace does not exist: ${workspaceRoot}`);
  }
  if (!fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`default_workspace is not a directory: ${workspaceRoot}`);
  }

  if (path.resolve(agentsPath) === path.resolve(destination)) {
    console.log(`[sync-agents] AGENTS.md already in default workspace: ${workspaceRoot}`);
    return;
  }

  fs.copyFileSync(agentsPath, destination);
  console.log(`[sync-agents] Copied AGENTS.md to ${destination}`);
}

main();
