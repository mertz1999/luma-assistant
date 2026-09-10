import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Cross-platform process spawn/termination helpers.
 *
 * Why this file exists: the rest of the server was written and tested on
 * Unix (README: "A Unix-like host for the best terminal experience"), and
 * relies on `which`/`pgrep` (not present on Windows) plus bare-name
 * `child_process.spawn("codex" | "claude", ...)`. On Windows, a globally
 * installed npm CLI is a `.cmd` shim; `spawn` cannot invoke a `.cmd`
 * directly (Windows cannot CreateProcess it without a shell), so spawning
 * "codex" or "claude" bare fails with ENOENT -- verified directly on this
 * machine before writing this fix. Routing the shim through a shell
 * instead is not a safe fallback here: Codex's CLI args include
 * `JSON.stringify`-produced config values, and cmd.exe's quoting can
 * corrupt them. Reading each shim and spawning its real target directly
 * avoids both problems and matches how Node itself resolves shims.
 */

export type ResolvedExecutable = {
  command: string;
  prependArgs: string[];
};

export class ExecutableNotFoundError extends Error {
  constructor(command: string, detail?: string) {
    super(`Executable not found or not spawnable: ${command}${detail ? ` (${detail})` : ""}`);
    this.name = "ExecutableNotFoundError";
  }
}

const WINDOWS_EXECUTABLE_EXTENSIONS = [".cmd", ".exe", ".bat"];

/**
 * Cross-platform replacement for a bare `which` call (`which` does not
 * exist on Windows). On Windows, `where <command>` for an npm-installed CLI
 * commonly returns multiple candidates -- observed directly on this
 * machine: an extensionless POSIX shim (for Git Bash/WSL) THEN the `.cmd`
 * file, in that order. The extensionless file is not natively spawnable on
 * Windows either, so this prefers the first candidate with a recognized
 * Windows executable extension, falling back to the plain first line only
 * if `where` returned nothing better.
 */
export function resolveCommandPath(command: string): string {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout?.trim()) return "";
  const candidates = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0) return "";

  if (process.platform === "win32") {
    const preferred = candidates.find((candidate) =>
      WINDOWS_EXECUTABLE_EXTENSIONS.includes(path.extname(candidate).toLowerCase()),
    );
    if (preferred) return preferred;
  }

  return candidates[0];
}

/**
 * Resolves a command name or path to something `child_process.spawn` can
 * actually execute without `shell: true`. On non-Windows platforms this is
 * a passthrough (spawn already handles bare names via PATH there). On
 * Windows, unwraps a `.cmd`/`.bat` npm shim to its real target.
 *
 * Fails closed: an unrecognized shim shape or a missing target throws
 * ExecutableNotFoundError rather than silently falling back to a
 * shell-wrapped spawn (which would reintroduce the quoting-corruption risk
 * this function exists to avoid).
 */
export function resolveExecutableForSpawn(commandOrPath: string): ResolvedExecutable {
  if (process.platform !== "win32") {
    return { command: commandOrPath, prependArgs: [] };
  }

  let shimPath = commandOrPath;
  if (!path.isAbsolute(shimPath) || !fs.existsSync(shimPath)) {
    const resolved = resolveCommandPath(commandOrPath);
    if (!resolved) {
      throw new ExecutableNotFoundError(commandOrPath, "not found on PATH (where)");
    }
    shimPath = resolved;
  }

  const lower = shimPath.toLowerCase();
  if (!lower.endsWith(".cmd") && !lower.endsWith(".bat")) {
    // Already directly spawnable (e.g. a real .exe).
    return { command: shimPath, prependArgs: [] };
  }

  let content: string;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch (err) {
    throw new ExecutableNotFoundError(commandOrPath, `could not read shim: ${(err as Error).message}`);
  }

  const dp0 = path.dirname(shimPath);

  // Only match the actual invocation line (ends in `%*`, the passthrough of
  // this shim's own arguments) -- NOT an incidental `%dp0%\node.exe`
  // existence check earlier in the script, which also matches a naive
  // `.exe` pattern but is not the real target.
  const invocation = /%dp0%\\([^"%]+)"\s+%\*/i.exec(content);
  if (!invocation) {
    throw new ExecutableNotFoundError(commandOrPath, "unrecognized .cmd shim format");
  }
  const targetRelative = invocation[1];
  const targetExt = path.extname(targetRelative).toLowerCase();

  if (targetExt === ".exe") {
    // Shim forwards to a real .exe next to it (observed: claude.cmd -> claude.exe).
    const exePath = path.join(dp0, targetRelative);
    if (!fs.existsSync(exePath)) {
      throw new ExecutableNotFoundError(commandOrPath, `shim points at missing file: ${exePath}`);
    }
    return { command: exePath, prependArgs: [] };
  }

  if (targetExt !== ".js" && targetExt !== "") {
    // Anything else (.ps1, .sh, ...) is a genuinely unrecognized shape --
    // fail closed rather than guess how to spawn it.
    throw new ExecutableNotFoundError(commandOrPath, `unrecognized shim target extension: "${targetExt}"`);
  }

  // Shim forwards to a .js entrypoint via node.exe (observed: codex.cmd ->
  // bin/codex.js), OR to an extensionless shebang-style bin script (observed:
  // openclaude.cmd -> bin/openclaude, npm's usual shape for a package whose
  // "bin" entrypoint has no file extension) -- node runs both identically
  // when passed as a script path, extension or not.
  const jsPath = path.join(dp0, targetRelative);
  if (!fs.existsSync(jsPath)) {
    throw new ExecutableNotFoundError(commandOrPath, `shim points at missing file: ${jsPath}`);
  }
  // A node.exe copy next to the shim (npm ships one on some installs) takes
  // priority since it is what the shim itself would have used. Otherwise
  // use this process's own Node binary -- an always-valid absolute path,
  // rather than the bare string "node" relying on implicit PATH resolution.
  const nodeExe = path.join(dp0, "node.exe");
  const nodeCommand = fs.existsSync(nodeExe) ? nodeExe : process.execPath;
  return { command: nodeCommand, prependArgs: [jsPath] };
}

function getChildPidsUnix(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * Terminates a process and every descendant it spawned.
 *
 * Windows: `taskkill /T` recursively terminates the whole tree in one call.
 * There is no reliable graceful/forceful distinction for a background
 * process on Windows (a plain `taskkill` frequently fails with "This
 * process can only be terminated forcefully") so `/F` is always used
 * regardless of the requested signal.
 *
 * Unix: walks the tree via `pgrep -P` (best effort -- a process that exits
 * mid-walk is simply absent from the next query) and signals each pid,
 * deepest descendants first, then the root.
 */
export function killProcessTree(pid: number | undefined | null, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!pid || pid <= 0) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  const visited = new Set<number>();
  const queue: number[] = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const child of getChildPidsUnix(current)) {
      if (!visited.has(child)) queue.push(child);
    }
  }

  const ordered = [...visited].sort((a, b) => b - a);
  for (const target of ordered) {
    try {
      process.kill(target, signal);
    } catch {
      // Already exited, or no permission -- not fatal for a best-effort kill.
    }
  }
}

/**
 * Checks whether a pid genuinely refers to a live process, using the
 * standard `kill -0` idiom: signal 0 sends no actual signal, only performs
 * the existence/permission check. Node implements this identically on
 * Windows (no real POSIX signals there either).
 */
export function isProcessAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort command-line lookup for a live pid, used to distinguish "this
 * is genuinely the process we started" from "the OS reused this pid for an
 * unrelated process" after a restart -- a real failure mode, not a
 * hypothetical one, on any long-lived host. Returns null if the pid is
 * gone, permission is denied, or the lookup itself fails for any reason;
 * callers must treat null as "cannot verify," never as "confirmed unrelated."
 */
export function getProcessCommandLine(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      // `wmic` is deprecated and absent on current Windows 11 builds
      // (verified directly on this machine: `wmic` is not on PATH) --
      // Get-CimInstance is its still-supported replacement.
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      if (result.status !== 0 || !result.stdout) return null;
      const line = result.stdout.trim();
      return line || null;
    }

    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}
