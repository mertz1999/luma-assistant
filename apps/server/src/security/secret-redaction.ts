/**
 * Exact-value redaction for captured process output (spec: "Any known
 * secret value must be removed from stdout captured by Luma where
 * practical... use deterministic exact-value redaction").
 *
 * This is a different mechanism from audit-log.ts's redaction: that one
 * redacts by KEY NAME in structured payloads Luma itself constructs (it
 * has never seen the actual value, only that a field is named
 * "password"). This one redacts by VALUE in raw, unstructured text a
 * child process produced -- exactly the case where an authorized
 * credential's real value could appear verbatim if a run echoes its own
 * environment (deliberately, by mistake, or via prompt injection). Only
 * values this run was ACTUALLY authorized to receive are ever known here
 * to redact -- there is no way to catch a value Luma never had a record
 * of granting.
 *
 * Simple, deterministic, exact substring replacement -- not a heuristic
 * secret scanner. Does not log secret lengths, prefixes, or hashes; a
 * redacted value carries no information about what it was, on purpose.
 */
export function redactKnownSecretValues(text: string, secretValues: readonly string[]): string {
  if (!text) return text;
  let result = text;
  for (const value of secretValues) {
    if (!value) continue;
    result = result.split(value).join("[REDACTED]");
  }
  return result;
}
