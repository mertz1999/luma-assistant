#!/usr/bin/env node
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

function isEnabled(raw, defaultEnabled = false) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return defaultEnabled;
  return ["1", "true", "yes", "on"].includes(value);
}

// Opt-in: skip Codex MCP registration unless explicitly enabled.
if (!isEnabled(process.env.ENABLE_TASK_MANAGER_MCP, false)) {
  console.log("[taskmanager-mcp] skipped (ENABLE_TASK_MANAGER_MCP is off by default)");
  process.exit(0);
}

const codexPath = process.env.CODEX_PATH || "codex";
const name = process.env.TASK_MANAGER_MCP_NAME || "luma-tasks";
const port = process.env.TASK_MANAGER_MCP_PORT || "9014";
const url = process.env.TASK_MANAGER_MCP_URL || `http://127.0.0.1:${port}/mcp`;

function run(args, options = {}) {
  return spawnSync(codexPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
}

function currentUrl(output) {
  const match = output.match(/^\s*url:\s*(.+?)\s*$/im);
  return match ? match[1].trim() : null;
}

let shouldAdd = true;
const existing = run(["mcp", "get", name]);
if (existing.status === 0) {
  const configuredUrl = currentUrl(`${existing.stdout}\n${existing.stderr}`);
  if (configuredUrl === url) {
    console.log(`[taskmanager-mcp] Codex MCP '${name}' already points to ${url}`);
    shouldAdd = false;
  } else {
    console.log(`[taskmanager-mcp] Updating Codex MCP '${name}' from ${configuredUrl || "unknown"} to ${url}`);
    const removed = run(["mcp", "remove", name], { stdio: "inherit" });
    if (removed.status !== 0) {
      process.exit(removed.status || 1);
    }
  }
} else {
  console.log(`[taskmanager-mcp] Adding Codex MCP '${name}' at ${url}`);
}

if (shouldAdd) {
  const added = run(["mcp", "add", name, "--url", url], { stdio: "inherit" });
  if (added.status !== 0) {
    process.exit(added.status || 1);
  }
}

process.exit(0);
