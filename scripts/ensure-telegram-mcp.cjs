#!/usr/bin/env node
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

const codexPath = process.env.CODEX_PATH || "codex";
const legacyDefaultName = "telegram-file";
const name = process.env.TELEGRAM_MCP_NAME || "luma-tel";
const port = process.env.TELEGRAM_MCP_PORT || "9013";
const url = process.env.TELEGRAM_MCP_URL || `http://127.0.0.1:${port}/mcp`;

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
    console.log(`[telegram-mcp] Codex MCP '${name}' already points to ${url}`);
    shouldAdd = false;
  } else {
    console.log(`[telegram-mcp] Updating Codex MCP '${name}' from ${configuredUrl || "unknown"} to ${url}`);
    const removed = run(["mcp", "remove", name], { stdio: "inherit" });
    if (removed.status !== 0) {
      process.exit(removed.status || 1);
    }
  }
} else {
  console.log(`[telegram-mcp] Adding Codex MCP '${name}' at ${url}`);
}

if (shouldAdd) {
  const added = run(["mcp", "add", name, "--url", url], { stdio: "inherit" });
  if (added.status !== 0) {
    process.exit(added.status || 1);
  }
}

if (name !== legacyDefaultName) {
  const legacy = run(["mcp", "get", legacyDefaultName]);
  if (legacy.status === 0) {
    const legacyUrl = currentUrl(`${legacy.stdout}\n${legacy.stderr}`);
    if (legacyUrl === url) {
      console.log(`[telegram-mcp] Removing legacy Codex MCP '${legacyDefaultName}' at ${url}`);
      const removed = run(["mcp", "remove", legacyDefaultName], { stdio: "inherit" });
      process.exit(removed.status || 0);
    }
  }
}

process.exit(0);
