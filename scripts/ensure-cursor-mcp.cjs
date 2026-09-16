#!/usr/bin/env node
/**
 * Merge Luma MCP HTTP endpoints into ~/.cursor/mcp.json so Cursor Agent
 * (CLI / Luma runner) can use the same telegram/image/tasks tools.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

const cursorConfigPath = path.join(os.homedir(), ".cursor", "mcp.json");

function buildEntries() {
  const entries = {};

  const telegramName = process.env.TELEGRAM_MCP_NAME || "luma-tel";
  const telegramPort = process.env.TELEGRAM_MCP_PORT || "9013";
  const telegramUrl = process.env.TELEGRAM_MCP_URL || `http://127.0.0.1:${telegramPort}/mcp`;
  entries[telegramName] = { url: telegramUrl };

  const imageName = process.env.IMAGE_MCP_NAME || "luma-images";
  const imagePort = process.env.IMAGE_MCP_PORT || "9015";
  const imageUrl = process.env.IMAGE_MCP_URL || `http://127.0.0.1:${imagePort}/mcp`;
  entries[imageName] = { url: imageUrl };

  if (process.env.ENABLE_TASK_MANAGER_MCP === "1") {
    const tasksName = process.env.TASK_MANAGER_MCP_NAME || "luma-tasks";
    const tasksPort = process.env.TASK_MANAGER_MCP_PORT || "9014";
    const tasksUrl = process.env.TASK_MANAGER_MCP_URL || `http://127.0.0.1:${tasksPort}/mcp`;
    entries[tasksName] = { url: tasksUrl };
  }

  return entries;
}

function readConfig() {
  if (!fs.existsSync(cursorConfigPath)) return { mcpServers: {} };
  try {
    const raw = fs.readFileSync(cursorConfigPath, "utf8").trim();
    if (!raw) return { mcpServers: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { mcpServers: {} };
    const servers = parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
    return { ...parsed, mcpServers: servers };
  } catch (error) {
    console.error(`[cursor-mcp] Failed to parse ${cursorConfigPath}:`, error instanceof Error ? error.message : error);
    console.error("[cursor-mcp] Fix or delete the file, then re-run make ensure-cursor-mcp.");
    process.exit(1);
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(cursorConfigPath), { recursive: true });
  fs.writeFileSync(cursorConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

const desired = buildEntries();
const config = readConfig();
let changed = 0;

for (const [name, entry] of Object.entries(desired)) {
  const existing = config.mcpServers[name];
  const existingUrl = existing && typeof existing === "object" ? existing.url : null;
  if (existingUrl === entry.url) {
    console.log(`[cursor-mcp] '${name}' already points to ${entry.url}`);
    continue;
  }
  console.log(`[cursor-mcp] ${existingUrl ? "Updating" : "Adding"} '${name}' -> ${entry.url}`);
  config.mcpServers[name] = { ...(existing && typeof existing === "object" ? existing : {}), ...entry };
  changed += 1;
}

if (changed > 0) {
  writeConfig(config);
  console.log(`[cursor-mcp] Wrote ${changed} MCP entr${changed === 1 ? "y" : "ies"} to ${cursorConfigPath}`);
} else {
  console.log(`[cursor-mcp] No changes needed (${cursorConfigPath})`);
}
