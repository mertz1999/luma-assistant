#!/usr/bin/env node
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

const codexPath = process.env.CODEX_PATH || "codex";
const claudePath = process.env.CLAUDE_CODE_EXECUTABLE || "claude";
const name = process.env.IMAGE_MCP_NAME || "luma-images";
const port = process.env.IMAGE_MCP_PORT || "9015";
const url = process.env.IMAGE_MCP_URL || `http://127.0.0.1:${port}/mcp`;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
}

function currentUrl(output) {
  const match = output.match(/^\s*url:\s*(.+?)\s*$/im) || output.match(/^\s*URL:\s*(.+?)\s*$/im);
  return match ? match[1].trim() : null;
}

function ensureCodex() {
  let shouldAdd = true;
  const existing = run(codexPath, ["mcp", "get", name]);
  if (existing.status === 0) {
    const configuredUrl = currentUrl(`${existing.stdout}\n${existing.stderr}`);
    if (configuredUrl === url) {
      console.log(`[image-mcp] Codex MCP '${name}' already points to ${url}`);
      shouldAdd = false;
    } else {
      console.log(`[image-mcp] Updating Codex MCP '${name}' from ${configuredUrl || "unknown"} to ${url}`);
      const removed = run(codexPath, ["mcp", "remove", name], { stdio: "inherit" });
      if (removed.status !== 0) process.exit(removed.status || 1);
    }
  } else {
    console.log(`[image-mcp] Adding Codex MCP '${name}' at ${url}`);
  }

  if (shouldAdd) {
    const added = run(codexPath, ["mcp", "add", name, "--url", url], { stdio: "inherit" });
    if (added.status !== 0) process.exit(added.status || 1);
  }
}

function ensureClaude() {
  const help = run(claudePath, ["mcp", "--help"]);
  if (help.status !== 0) {
    console.log(`[image-mcp] Claude CLI not available; skipping Claude MCP registration.`);
    return;
  }

  let shouldAdd = true;
  const existing = run(claudePath, ["mcp", "get", name]);
  if (existing.status === 0) {
    const configuredUrl = currentUrl(`${existing.stdout}\n${existing.stderr}`);
    if (configuredUrl === url) {
      console.log(`[image-mcp] Claude MCP '${name}' already points to ${url}`);
      shouldAdd = false;
    } else {
      console.log(`[image-mcp] Updating Claude MCP '${name}' from ${configuredUrl || "unknown"} to ${url}`);
      const removed = run(claudePath, ["mcp", "remove", name], { stdio: "inherit" });
      if (removed.status !== 0) process.exit(removed.status || 1);
    }
  } else {
    console.log(`[image-mcp] Adding Claude MCP '${name}' at ${url}`);
  }

  if (shouldAdd) {
    const added = run(claudePath, ["mcp", "add", "--transport", "http", name, url], { stdio: "inherit" });
    if (added.status !== 0) process.exit(added.status || 1);
  }
}

ensureCodex();
ensureClaude();
