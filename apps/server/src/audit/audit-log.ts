import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Append-only, hash-chained audit log.
 *
 * Storage is a JSONL file (data/audit/audit.jsonl by default), matching
 * the append-only event-stream pattern this codebase already uses for
 * per-run output (data/runs/<runId>.jsonl) -- not a new persistence
 * technology introduced just for this. Every write is a single
 * fs.appendFileSync of one line; nothing here ever updates or deletes an
 * existing line, which is the actual append-only guarantee (the file
 * format alone doesn't stop a determined edit -- the hash chain below is
 * what makes a tampered or dropped entry detectable).
 *
 * Chaining follows the shape the spec asks for directly:
 *   entry_hash = SHA256(prev_hash + timestamp + event_type + canonical_payload)
 * Deliberately simple -- a single SHA-256 over a canonical (sorted-key)
 * JSON string, no signing, no external dependency. This detects accidental
 * or intentional modification of the log's own content; it is not a
 * defense against an attacker with write access to the file who also
 * rewrites every subsequent entry to match (no local file format can
 * prevent that without an external anchor, which is out of scope here).
 */

export interface AuditEventInput {
  event_type: string;
  run_id?: string | null;
  actor?: string;
  payload?: Record<string, unknown>;
}

export interface AuditEntry {
  seq: number;
  id: string;
  timestamp: string;
  event_type: string;
  run_id: string | null;
  actor: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  firstBrokenSeq?: number;
  reason?: string;
}

export const AUDIT_GENESIS_HASH = "0".repeat(64);

/** Deterministic (sorted-key) JSON stringify so hashing doesn't depend on property insertion order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

// Deliberately broad and key-name-based, not value-shape-based: catches
// anything that LOOKS like it might hold a secret before it ever reaches
// disk, at the cost of occasionally redacting a harmless field with a
// matching name. That tradeoff is intentional -- this is the "never store
// raw secrets" guarantee, not a UX nicety.
const SECRET_KEY_PATTERN = /password|secret|token|api[_-]?key|credential|authorization|cookie/i;

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactPayload(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function auditFilePath(auditDir: string): string {
  return path.join(auditDir, "audit.jsonl");
}

function readAllLines(auditDir: string): string[] {
  const filePath = auditFilePath(auditDir);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

/**
 * Reads the whole file to find the last entry on every append. Simple and
 * correct; O(n) per append rather than O(1). Fine for this log's actual
 * write volume (lifecycle events, not per-token streaming) -- documented
 * here as a known tradeoff rather than silently accepted, not treated as
 * something to prematurely optimize before it is ever actually slow.
 */
function readLastEntry(auditDir: string): AuditEntry | null {
  const lines = readAllLines(auditDir);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]!) as AuditEntry;
}

function computeHash(prevHash: string, timestamp: string, eventType: string, hashablePayload: unknown): string {
  const material = `${prevHash}${timestamp}${eventType}${canonicalJson(hashablePayload)}`;
  return crypto.createHash("sha256").update(material).digest("hex");
}

export function appendAuditEvent(auditDir: string, input: AuditEventInput): AuditEntry {
  fs.mkdirSync(auditDir, { recursive: true });

  const last = readLastEntry(auditDir);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? AUDIT_GENESIS_HASH;

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const eventType = input.event_type;
  const runId = input.run_id ?? null;
  const actor = input.actor ?? "system";
  const payload = redactPayload(input.payload ?? {});

  const hash = computeHash(prevHash, timestamp, eventType, { id, run_id: runId, actor, payload });

  const entry: AuditEntry = {
    seq,
    id,
    timestamp,
    event_type: eventType,
    run_id: runId,
    actor,
    payload,
    prev_hash: prevHash,
    hash,
  };

  fs.appendFileSync(auditFilePath(auditDir), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readAuditEvents(auditDir: string): AuditEntry[] {
  return readAllLines(auditDir).map((line) => JSON.parse(line) as AuditEntry);
}

/** Recomputes the chain from the beginning and reports the first break, if any. */
export function verifyAuditChain(auditDir: string): AuditVerifyResult {
  const entries = readAuditEvents(auditDir);
  let expectedPrevHash = AUDIT_GENESIS_HASH;

  for (const entry of entries) {
    if (entry.prev_hash !== expectedPrevHash) {
      return { ok: false, checked: entry.seq, firstBrokenSeq: entry.seq, reason: `prev_hash mismatch at seq ${entry.seq}` };
    }
    const recomputed = computeHash(entry.prev_hash, entry.timestamp, entry.event_type, {
      id: entry.id,
      run_id: entry.run_id,
      actor: entry.actor,
      payload: entry.payload,
    });
    if (recomputed !== entry.hash) {
      return { ok: false, checked: entry.seq, firstBrokenSeq: entry.seq, reason: `hash mismatch at seq ${entry.seq}` };
    }
    expectedPrevHash = entry.hash;
  }

  return { ok: true, checked: entries.length };
}
