import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutableForSpawn, killProcessTree } from "../platform/process-utils.js";
import { pickSafeBaseEnv } from "../security/safe-environment.js";
import type { DocumentRejectCode } from "./errors.js";

/**
 * Local MarkItDown conversion backend (github.com/microsoft/markitdown).
 *
 * Follows the same shape as the browser-act adapter
 * (apps/server/src/browser/browseract-adapter.ts): an external, optional,
 * CLI-invoked tool, resolved and spawned defensively, never assumed present.
 * The difference is MarkItDown is a Python *library*, not a standalone CLI
 * on PATH -- so instead of resolving a global command, this resolves a
 * Python interpreter (preferring the project-local venv this integration
 * provisions at tools/markitdown/.venv) and spawns a tiny wrapper script
 * (tools/markitdown/convert.py) that does exactly one thing: convert one
 * file and print one JSON object to stdout.
 *
 * Local-only by construction: convert.py constructs `MarkItDown()` with no
 * llm_client/mlm_client and enable_plugins=False, so it never calls out to
 * OpenAI, Azure, or any other remote inference API, and never loads a
 * third-party MarkItDown plugin. This adapter adds no network calls of its
 * own on top of that -- it only spawns a local subprocess.
 *
 * This file is the ONLY place in Luma that should know MarkItDown-specific
 * details (its exception names, its JSON shape, where its venv lives).
 * Everything else talks to `convertDocument()`'s generic result type.
 */

const SIGTERM_GRACE_MS = 2_000;

export interface MarkItDownSuccess {
  ok: true;
  markdown: string;
  title: string | null;
  backend: string;
}

export interface MarkItDownFailure {
  ok: false;
  code: DocumentRejectCode;
  message: string;
}

export type MarkItDownConvertResult = MarkItDownSuccess | MarkItDownFailure;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// apps/server/{src,dist}/ingestion -> repo root is four levels up.
const REPO_ROOT = path.resolve(moduleDir, "..", "..", "..", "..");
const TOOL_DIR = path.join(REPO_ROOT, "tools", "markitdown");
const CONVERT_SCRIPT = path.join(TOOL_DIR, "convert.py");
const BACKEND_NAME = "markitdown";

function venvPythonPath(): string {
  return process.platform === "win32"
    ? path.join(TOOL_DIR, ".venv", "Scripts", "python.exe")
    : path.join(TOOL_DIR, ".venv", "bin", "python");
}

/**
 * Resolution order: explicit override (MARKITDOWN_PYTHON) > the project-local
 * venv this integration provisions > a bare "python3"/"python" on PATH as a
 * last resort (used only if someone installed markitdown into their system
 * interpreter instead of the venv). Returns null if nothing resolvable.
 */
export function resolvePythonExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.MARKITDOWN_PYTHON?.trim();
  if (override) return fs.existsSync(override) ? override : null;

  const venvPython = venvPythonPath();
  if (fs.existsSync(venvPython)) return venvPython;

  for (const candidate of ["python3", "python"]) {
    const resolved = spawnSync(process.platform === "win32" ? "where" : "which", [candidate], { encoding: "utf8" });
    if (resolved.status === 0 && resolved.stdout.trim()) {
      return candidate;
    }
  }
  return null;
}

export interface AvailabilityResult {
  available: boolean;
  pythonPath: string | null;
  reason?: string;
}

/**
 * Cheap, bounded probe: does a resolvable Python interpreter actually have
 * `markitdown` importable? Never throws. Used by callers to fail gracefully
 * ("report exactly what is missing") before ever touching a user's file.
 */
export function checkAvailability(env: NodeJS.ProcessEnv = process.env): AvailabilityResult {
  const pythonPath = resolvePythonExecutable(env);
  if (!pythonPath) {
    return { available: false, pythonPath: null, reason: "No Python interpreter with MarkItDown installed was found (checked tools/markitdown/.venv and PATH)." };
  }
  if (!fs.existsSync(CONVERT_SCRIPT)) {
    return { available: false, pythonPath, reason: `Conversion wrapper script is missing: ${CONVERT_SCRIPT}` };
  }

  try {
    let resolved = { command: pythonPath, prependArgs: [] as string[] };
    try {
      resolved = resolveExecutableForSpawn(pythonPath);
    } catch {
      // Bare "python"/"python3" fallback resolved via `where`/`which` above may not
      // be an absolute path yet; let spawnSync's own PATH search handle it.
    }
    const probe = spawnSync(resolved.command, [...resolved.prependArgs, "-c", "import markitdown"], {
      env: pickSafeBaseEnv(env),
      timeout: 10_000,
      windowsHide: true,
    });
    if (probe.status !== 0) {
      return { available: false, pythonPath, reason: "MarkItDown is not importable from this interpreter. Run: pip install -r tools/markitdown/requirements.txt" };
    }
    return { available: true, pythonPath };
  } catch (err) {
    return { available: false, pythonPath, reason: err instanceof Error ? err.message : "Availability probe failed." };
  }
}

export function isAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return checkAvailability(env).available;
}

function classifyProcessFailure(stderr: string, timedOut: boolean): MarkItDownFailure {
  if (timedOut) return { ok: false, code: "CONVERSION_TIMEOUT", message: "Conversion exceeded the configured time limit." };
  return { ok: false, code: "DEPENDENCY_MISSING", message: stderr.trim().slice(0, 500) || "MarkItDown subprocess exited without producing output." };
}

/**
 * Converts one file already staged on local disk. Bounded by `timeoutMs`;
 * on timeout the whole process tree is killed (SIGTERM then SIGKILL), same
 * pattern as browseract-adapter.ts. Runs with the safe base environment
 * only (apps/server/src/security/safe-environment.ts) -- the conversion
 * subprocess never sees Luma's own secrets.
 */
export function convertDocument(absolutePath: string, timeoutMs: number): Promise<MarkItDownConvertResult> {
  return new Promise((resolve) => {
    const availability = checkAvailability();
    if (!availability.available || !availability.pythonPath) {
      resolve({ ok: false, code: "DEPENDENCY_MISSING", message: availability.reason || "MarkItDown is not available on this host." });
      return;
    }

    let resolved: { command: string; prependArgs: string[] };
    try {
      resolved = resolveExecutableForSpawn(availability.pythonPath);
    } catch {
      resolved = { command: availability.pythonPath, prependArgs: [] };
    }

    const child = spawn(resolved.command, [...resolved.prependArgs, CONVERT_SCRIPT, absolutePath], {
      env: pickSafeBaseEnv(),
      windowsHide: true,
      cwd: TOOL_DIR,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const hardTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => killProcessTree(child.pid, "SIGKILL"), SIGTERM_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));

    const finish = (result: MarkItDownConvertResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(result);
    };

    child.on("error", (err) => {
      finish({ ok: false, code: "DEPENDENCY_MISSING", message: err.message });
    });

    child.on("close", () => {
      if (timedOut) {
        finish(classifyProcessFailure(stderr, true));
        return;
      }
      if (!stdout.trim()) {
        finish(classifyProcessFailure(stderr, false));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as
          | { ok: true; markdown: string; title: string | null }
          | { ok: false; error_code: DocumentRejectCode; message: string };
        if (parsed.ok) {
          finish({ ok: true, markdown: parsed.markdown, title: parsed.title, backend: BACKEND_NAME });
        } else {
          finish({ ok: false, code: parsed.error_code, message: parsed.message });
        }
      } catch {
        finish({ ok: false, code: "CORRUPT_DOCUMENT", message: "Conversion output could not be parsed." });
      }
    });
  });
}

export const MARKITDOWN_BACKEND_NAME = BACKEND_NAME;
export const MARKITDOWN_TOOL_DIR = TOOL_DIR;
