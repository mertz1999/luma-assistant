#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const dataDir = path.resolve(rootDir, "data");
const migrationMetaPath = path.resolve(dataDir, "migrations.json");

function safeReadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${path.relative(rootDir, filePath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  const meta = safeReadJson(migrationMetaPath, { schemaVersion: 1, applied: [] });
  writeJsonAtomic(migrationMetaPath, {
    schemaVersion: 1,
    applied: Array.isArray(meta.applied) ? meta.applied : [],
    lastRunAt: new Date().toISOString(),
  });
  console.log("[migrate-data] complete");
}

try {
  main();
} catch (error) {
  console.error(`[migrate-data] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
