import { resolveCommandPath as resolveCommandPathCrossPlatform } from "../platform/process-utils.js";
import { pickSafeBaseEnv } from "../security/safe-environment.js";

/**
 * Config/env/health-check logic for the local-only "qwythos" runner --
 * extracted out of index.ts (rather than left inline) specifically so it
 * can be unit-tested without importing index.ts, which has the unconditional
 * side effect of starting a real HTTP server (app.listen) at module load.
 *
 * Qwythos spawns `openclaude`, a CLI-compatible fork of Claude Code, pointed
 * at a separately-managed local llama-server endpoint (frozen baseline
 * QWYTHOS-LUMA-BASELINE-v1, see C:\Users\it hp\qwythos-stack\luma\). Luma
 * does not own that server's lifecycle; it only connects to it, and never
 * falls back to any cloud provider if the endpoint is unavailable.
 */

// QWYTHOS_ENDPOINT always resolves to a concrete value (127.0.0.1 unless
// explicitly overridden), so buildQwythosEnvironment() below never leaves
// OPENAI_BASE_URL unset (which would let a generic OpenAI-compatible client
// silently default to the real OpenAI cloud API -- exactly what Phase 10 of
// the qwythos-runner task calls out as unacceptable).
export function resolveQwythosEndpoint(): string {
  // Trim BEFORE falling back, not after: a whitespace-only override (e.g.
  // " ") is truthy and would otherwise survive the `||` and trim down to
  // "", handing buildQwythosEnvironment() a blank OPENAI_BASE_URL -- the
  // exact "silently resolves to nothing" failure mode this function exists
  // to prevent (see the module-level comment above).
  const configured = (process.env.QWYTHOS_ENDPOINT || "").trim();
  return configured || "http://127.0.0.1:8080/v1";
}

export const DEFAULT_QWYTHOS_MODEL = process.env.QWYTHOS_DEFAULT_MODEL || "qwythos-9b-q6";

/** Same resolution pattern as resolveClaudeCodeExecutable, for the CLI-compatible `openclaude` fork. */
export function resolveQwythosExecutable(configured: string | undefined): string {
  const explicit = (configured || "").trim();
  if (explicit) return explicit;
  return resolveCommandPathCrossPlatform("openclaude");
}

/**
 * Same safe-base-allowlist pattern as buildClaudeEnvironment, but the four
 * OpenAI-compat vars are set EXPLICITLY and LAST (never inherited from
 * `process.env`, never left to `openclaude`'s own defaults) so this can
 * never silently resolve to a real cloud endpoint -- the exact failure
 * mode Phase 10 of the qwythos-runner task calls out as unacceptable.
 * SAFE_BASE_ENV_KEYS (security/safe-environment.ts) does not include any
 * OPENAI- or ANTHROPIC-prefixed name, so there is nothing to accidentally
 * inherit even before this override; the explicit set below is defense in
 * depth, not the only thing preventing a leak.
 */
export function buildQwythosEnvironment(model: string, endpoint: string = resolveQwythosEndpoint()): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = pickSafeBaseEnv();
  env.CLAUDE_CODE_USE_OPENAI = "1";
  env.OPENAI_BASE_URL = endpoint;
  env.OPENAI_MODEL = model;
  env.OPENAI_API_KEY = "not-needed-local";
  return env;
}

/**
 * Pre-flight connectivity check so a qwythos run fails immediately and
 * clearly (Phase 4: QWYTHOS_LOCAL_UNAVAILABLE) instead of spawning
 * `openclaude` against a dead endpoint and producing a slow, confusing
 * CLI-level timeout/retry loop -- exactly the failure mode observed
 * during manual testing before this check existed.
 */
export async function checkQwythosEndpointReachable(
  endpoint: string = resolveQwythosEndpoint(),
  timeoutMs = 5000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}/models`, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: `endpoint responded with HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /abort/i.test(message) ? `timeout after ${timeoutMs}ms` : `connection failed (${message})`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}
