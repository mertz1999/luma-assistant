#!/usr/bin/env node
/**
 * Windows-safe log rotation for PM2's operational stdout/stderr files
 * (data/logs/*.log) -- NOT the hash-chained audit log, which is
 * intentionally append-only and untouched by this script.
 *
 * Why this exists instead of `pm2 install pm2-logrotate`: reproduced
 * directly on this machine, that install fails inside npm's own
 * installer (@npmcli/arborist), not in this repo's code or its startup
 * wrapper. PM2's module-installer spawns npm with `shell: true` and an
 * unescaped path argument (confirmed via the DEP0190 warning it prints
 * about exactly this); the space in this Windows account's profile
 * directory ("C:\Users\it hp") gets split by cmd.exe's shell parsing,
 * so npm receives the truncated path "C:\Users\it" and fails to mkdir
 * it. That is a third-party installer bug, not something to patch
 * inside node_modules. This script sidesteps the entire problem by
 * never using pm2-logrotate (or any shell-string command) at all --
 * every filesystem operation below goes through Node's own fs APIs
 * against path.join()-built path *objects*, which is exactly why
 * spaces (or any other shell-special character) in the path never
 * matter here: nothing ever gets parsed by cmd.exe or PowerShell.
 *
 * Usage:
 *   node scripts/pm2/rotate-logs.cjs
 *
 * Env overrides (all optional):
 *   LUMA_LOG_DIR            default: <repo>/data/logs
 *   LUMA_LOG_MAX_BYTES      default: 5242880 (5 MB)
 *   LUMA_LOG_MAX_ROTATIONS  default: 3
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROTATIONS = 3;

/**
 * Rotates one log file if it has reached maxBytes, keeping up to
 * maxRotations previous generations (filePath.1 is newest, .N oldest;
 * anything beyond maxRotations is deleted). Safe to call on a file that
 * does not exist, is empty, or already has rotated siblings in any
 * combination -- every case is handled explicitly rather than assumed.
 */
function rotateLogFile(filePath, { maxBytes = DEFAULT_MAX_BYTES, maxRotations = DEFAULT_MAX_ROTATIONS } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return { file: filePath, rotated: false, reason: "missing" };
    throw err;
  }

  if (stat.size < maxBytes) {
    return { file: filePath, rotated: false, reason: "below-threshold", sizeBefore: stat.size };
  }

  // Walk generations from oldest to newest so an earlier rename never
  // clobbers a file a later step still needs to move. i === maxRotations
  // is the retention boundary: whatever already occupies that slot is
  // dropped to make room, since a fuller cycle previously would have
  // moved something new into it already.
  for (let i = maxRotations; i >= 1; i--) {
    const dest = `${filePath}.${i}`;
    if (i === maxRotations) {
      try {
        fs.rmSync(dest, { force: true });
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    if (i === 1) continue; // the active file itself is renamed after this loop
    const src = `${filePath}.${i - 1}`;
    try {
      fs.renameSync(src, dest);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  fs.renameSync(filePath, `${filePath}.1`);
  // Recreate the active file immediately so a process that has not yet
  // been told to reopen its handle (see reloadLogs below) still has a
  // valid, empty target at the expected name rather than a missing file.
  fs.writeFileSync(filePath, "");

  return { file: filePath, rotated: true, sizeBefore: stat.size };
}

/**
 * Rotates every *.log file directly inside dir (not already-rotated
 * `name.log.N` siblings, which end in a digit rather than ".log", and
 * not the audit/ subdirectory, which this never walks into since it
 * only reads the top level of dir).
 */
function rotateAllLogs(dir, opts = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => rotateLogFile(path.join(dir, entry.name), opts));
}

module.exports = { rotateLogFile, rotateAllLogs, DEFAULT_MAX_BYTES, DEFAULT_MAX_ROTATIONS };

if (require.main === module) {
  const root = path.resolve(__dirname, "..", "..");
  const logDir = process.env.LUMA_LOG_DIR || path.join(root, "data", "logs");
  const maxBytes = Number(process.env.LUMA_LOG_MAX_BYTES) || DEFAULT_MAX_BYTES;
  const maxRotations = Number(process.env.LUMA_LOG_MAX_ROTATIONS) || DEFAULT_MAX_ROTATIONS;

  const results = rotateAllLogs(logDir, { maxBytes, maxRotations });
  for (const r of results) {
    console.log(`[rotate-logs] ${r.file}: ${r.rotated ? `rotated (was ${r.sizeBefore} bytes)` : r.reason}`);
  }

  const rotated = results.filter((r) => r.rotated);
  if (rotated.length > 0) {
    // Best-effort: if PM2 is already running (this script fired at a
    // logon where Luma was never stopped, not a cold start), its
    // processes are still holding open handles to the files we just
    // renamed to *.1 and will keep appending there until told to reopen.
    // `pm2 reloadLogs` is PM2's own built-in command for exactly this.
    // Invoked via this process's own node.exe directly against PM2's JS
    // entrypoint (node_modules/pm2/bin/pm2) -- never through the
    // pm2/pm2.cmd shim -- the same fix already applied for Codex/Claude
    // spawning and for ecosystem.config.cjs's own app entrypoints.
    const pm2Bin = path.join(root, "node_modules", "pm2", "bin", "pm2");
    if (fs.existsSync(pm2Bin)) {
      const result = spawnSync(process.execPath, [pm2Bin, "reloadLogs"], { cwd: root, stdio: "inherit" });
      if (result.error) {
        console.error(`[rotate-logs] pm2 reloadLogs failed (non-fatal, only matters if PM2 was already running): ${result.error.message}`);
      }
    }
  }
}
