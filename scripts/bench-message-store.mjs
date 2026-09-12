#!/usr/bin/env node
/**
 * Compare JSONL full-read / tail-read vs SQLite paged reads.
 * Usage: node scripts/bench-message-store.mjs [messageCount]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const messageCount = Math.max(100, Number(process.argv[2] || 12000));
const pageLimit = 30;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-msg-bench-"));
const jsonlPath = path.join(tmpDir, "session.jsonl");
const dbPath = path.join(tmpDir, "messages.sqlite");

function hrtimeMs(start) {
  const diff = process.hrtime.bigint() - start;
  return Number(diff) / 1e6;
}

function makeMessage(index, total) {
  const isTool = index % 4 === 3;
  const id = `msg_${index}`;
  return {
    id,
    clientMessageId: null,
    sessionId: "bench-session",
    runId: "run_bench",
    role: isTool ? "tool" : index % 2 === 0 ? "user" : "assistant",
    kind: isTool ? "tool" : "message",
    title: isTool ? "Tool" : index % 2 === 0 ? "You" : "Assistant",
    text: isTool
      ? `tool output ${index} ${"x".repeat(800)}`
      : `hello message ${index} of ${total} ${"y".repeat(120)}`,
    createdAt: 1_700_000_000_000 + index,
    sequence: index + 1,
    deliveryStatus: "sent",
    attachments: [],
    meta: isTool ? { type: "commandexecution", output: "z".repeat(1200), status: "completed" } : undefined,
  };
}

function writeJsonl(count) {
  const fd = fs.openSync(jsonlPath, "w");
  for (let i = 0; i < count; i += 1) {
    fs.writeSync(fd, `${JSON.stringify(makeMessage(i, count))}\n`);
  }
  fs.closeSync(fd);
  return fs.statSync(jsonlPath).size;
}

function readJsonlFull() {
  const lines = fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/);
  const byId = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

function readJsonlTail(minCounted) {
  const fileSize = fs.statSync(jsonlPath).size;
  const fd = fs.openSync(jsonlPath, "r");
  let position = fileSize;
  let leadingPartial = "";
  const newestFirst = [];
  const seen = new Set();
  let counted = 0;
  const chunk = 256 * 1024;
  try {
    while (position > 0 && counted < minCounted) {
      const readSize = Math.min(chunk, position);
      position -= readSize;
      const buf = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, buf, 0, readSize, position);
      const text = `${buf.toString("utf8")}${leadingPartial}`;
      const lines = text.split(/\r?\n/);
      if (position > 0) leadingPartial = lines.shift() || "";
      else leadingPartial = "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        newestFirst.push(row);
        if (row.kind !== "tool" && row.role !== "tool") counted += 1;
        if (counted >= minCounted) break;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return newestFirst.reverse();
}

function openSqlite() {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE messages (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      counts_toward_page INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(session_id, id)
    );
    CREATE INDEX idx_counted ON messages(session_id, counts_toward_page, sequence DESC, created_at DESC, id DESC);
    CREATE INDEX idx_seq ON messages(session_id, sequence ASC, created_at ASC, id ASC);
  `);
  return db;
}

function importSqlite(db, messages) {
  const upsert = db.prepare(`
    INSERT INTO messages(session_id,id,sequence,created_at,role,kind,counts_toward_page,payload)
    VALUES (@session_id,@id,@sequence,@created_at,@role,@kind,@counts_toward_page,@payload)
  `);
  const tx = db.transaction((rows) => {
    for (const message of rows) {
      upsert.run({
        session_id: message.sessionId,
        id: message.id,
        sequence: message.sequence,
        created_at: message.createdAt,
        role: message.role,
        kind: message.kind,
        counts_toward_page: message.kind !== "tool" && message.role !== "tool" ? 1 : 0,
        payload: JSON.stringify(message),
      });
    }
  });
  tx(messages);
}

function sqliteLatestPage(db, limit) {
  const counted = db.prepare(`
    SELECT sequence, created_at, id
    FROM messages
    WHERE session_id = ? AND counts_toward_page = 1
    ORDER BY sequence DESC, created_at DESC, id DESC
    LIMIT ?
  `).all("bench-session", limit);
  if (!counted.length) return [];
  const oldest = counted[counted.length - 1];
  const rows = db.prepare(`
    SELECT payload FROM messages
    WHERE session_id = ?
      AND (
        sequence > ?
        OR (sequence = ? AND created_at > ?)
        OR (sequence = ? AND created_at = ? AND id >= ?)
      )
    ORDER BY sequence ASC, created_at ASC, id ASC
  `).all(
    "bench-session",
    oldest.sequence,
    oldest.sequence,
    oldest.created_at,
    oldest.sequence,
    oldest.created_at,
    oldest.id,
  );
  return rows.map((row) => JSON.parse(row.payload));
}

console.log(`\nLuma message store benchmark`);
console.log(`messages=${messageCount} pageLimit=${pageLimit}`);
console.log(`tmp=${tmpDir}\n`);

const writeStart = process.hrtime.bigint();
const bytes = writeJsonl(messageCount);
const writeMs = hrtimeMs(writeStart);
console.log(`jsonl write: ${writeMs.toFixed(1)}ms (${(bytes / 1e6).toFixed(2)} MB)`);

let start = process.hrtime.bigint();
const full = readJsonlFull();
const fullMs = hrtimeMs(start);
console.log(`jsonl full hydrate: ${fullMs.toFixed(1)}ms → ${full.length} msgs`);

start = process.hrtime.bigint();
const tail = readJsonlTail(pageLimit);
const tailMs = hrtimeMs(start);
console.log(`jsonl tail page: ${tailMs.toFixed(1)}ms → ${tail.length} msgs`);

const db = openSqlite();
start = process.hrtime.bigint();
importSqlite(db, full);
const importMs = hrtimeMs(start);
console.log(`sqlite import: ${importMs.toFixed(1)}ms`);

start = process.hrtime.bigint();
const page1 = sqliteLatestPage(db, pageLimit);
const sqliteMs1 = hrtimeMs(start);
start = process.hrtime.bigint();
const page2 = sqliteLatestPage(db, pageLimit);
const sqliteMs2 = hrtimeMs(start);
console.log(`sqlite latest page (cold): ${sqliteMs1.toFixed(1)}ms → ${page1.length} msgs`);
console.log(`sqlite latest page (warm): ${sqliteMs2.toFixed(1)}ms → ${page2.length} msgs`);

const speedupVsFull = fullMs / Math.max(sqliteMs2, 0.001);
const speedupVsTail = tailMs / Math.max(sqliteMs2, 0.001);
console.log(`\nSpeedup vs JSONL full hydrate: ${speedupVsFull.toFixed(1)}x`);
console.log(`Speedup vs JSONL tail scan: ${speedupVsTail.toFixed(1)}x`);

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

// Touch local compiled module path for sanity when present.
const distDb = path.join(root, "apps/server/dist/message-db.js");
if (fs.existsSync(distDb)) {
  console.log(`\nmessage-db module present: ${distDb}`);
} else {
  console.log(`\n(note) build server to emit ${distDb}`);
}

void pathToFileURL;
