import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const sourceConfigPath = path.join(repoRoot, "config.yaml");
const homeDir = process.env.HOME || "";
const targetConfigDir = path.join(homeDir, "config", "agentic-assistant");
const targetConfigPath = path.join(targetConfigDir, "config.yaml");

function main() {
  if (!homeDir) {
    throw new Error("HOME is not set. Cannot resolve ~/config path.");
  }

  if (!fs.existsSync(sourceConfigPath)) {
    throw new Error(`Missing source config: ${sourceConfigPath}`);
  }

  fs.mkdirSync(targetConfigDir, { recursive: true });
  fs.copyFileSync(sourceConfigPath, targetConfigPath);
  console.log(`[sync-config] Copied config to ${targetConfigPath}`);
}

main();
