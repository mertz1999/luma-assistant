#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

function readDotenvValue(key) {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return "";
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const name = trimmed.slice(0, index).trim();
    if (name !== key) continue;
    return trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

const host = process.env.WAIT_HOST || process.argv[2] || "127.0.0.1";
const port = Number(process.env.WAIT_PORT || process.argv[3] || process.env.API_PORT || readDotenvValue("API_PORT") || 9001);
const timeoutMs = Number(process.env.WAIT_TIMEOUT_MS || 30000);
const intervalMs = Number(process.env.WAIT_INTERVAL_MS || 250);
const startedAt = Date.now();

function tryConnect() {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(intervalMs);

  socket.once("connect", () => {
    socket.destroy();
    process.exit(0);
  });

  const retry = () => {
    socket.destroy();
    if (Date.now() - startedAt >= timeoutMs) {
      console.error(`Timed out waiting for ${host}:${port}`);
      process.exit(1);
    }
    setTimeout(tryConnect, intervalMs);
  };

  socket.once("error", retry);
  socket.once("timeout", retry);
}

tryConnect();
