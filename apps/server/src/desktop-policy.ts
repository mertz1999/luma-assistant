import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { RunRunner, SandboxMode } from "@luma/shared";

export const desktopMode = process.env.LUMA_DESKTOP === "1";

export function desktopDefaultSandbox(fallback: SandboxMode): SandboxMode {
  const file = process.env.LUMA_DESKTOP_SETTINGS_FILE;
  if (!desktopMode || !file) return fallback;
  try {
    const mode: unknown = JSON.parse(fs.readFileSync(file, "utf8")).defaultSandbox;
    if (mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access") return mode;
  } catch { /* Use the configured default. */ }
  return fallback;
}

let systemTemporaryDirectory = "";
if (desktopMode && process.platform === "darwin") {
  const result = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
  try { systemTemporaryDirectory = fs.realpathSync(result.stdout.trim()); } catch { /* Cache access stays denied if discovery fails. */ }
}

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Resolve existing ancestors too: an attachment may not have been written yet.
export function realTarget(target: string): string {
  let ancestor = path.resolve(target);
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Path has no existing parent");
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

export function desktopWorkspaces(): string[] {
  if (!desktopMode) return [];
  const file = process.env.LUMA_DESKTOP_FOLDERS_FILE;
  if (!file) return [];
  try {
    const folders: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(folders)) return [];
    return [...new Set(folders.filter((item): item is string => typeof item === "string").flatMap(folder => {
      try { return fs.statSync(folder).isDirectory() ? [fs.realpathSync(folder)] : []; } catch { return []; }
    }))];
  } catch { return []; }
}

export function assertDesktopWorkspace(workspace: string): string {
  if (!desktopMode) return workspace;
  const canonical = fs.realpathSync(workspace);
  if (!fs.statSync(canonical).isDirectory() || !desktopWorkspaces().some(root => inside(root, canonical))) {
    throw new Error("Choose an enabled folder in Luma Desktop before running this session.");
  }
  return canonical;
}

export function assertDesktopFile(workspace: string, target: string): void {
  if (!desktopMode) return;
  const root = assertDesktopWorkspace(workspace);
  if (!inside(root, realTarget(target))) throw new Error("File resolves outside the selected workspace.");
}

function literal(value: string): string { return JSON.stringify(value); }
const profileVariables = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", cursor: "CURSOR_CONFIG_DIR" } as const;

function runnerProfile(runner: RunRunner): string {
  const variable = profileVariables[runner];
  const directory = process.env[variable] || (runner === "claude" ? path.join(os.homedir(), ".claude") : "");
  if (!directory) throw new Error(`The local ${runner} profile is unavailable. Restart Luma Desktop.`);
  return fs.realpathSync(directory);
}

function desktopSandboxProfile(root: string, executable: string, readOnly: boolean, runner: RunRunner, readableFile?: string): string {
  const runtime = runnerProfile(runner);
  const temporary = fs.realpathSync(process.env.TMPDIR || os.tmpdir());
  const resolvedExecutable = path.isAbsolute(executable) ? executable : spawnSync("/usr/bin/which", [executable], { encoding: "utf8" }).stdout.trim();
  if (!resolvedExecutable) throw new Error(`Executable not found: ${executable}`);
  const executableRoot = path.dirname(fs.realpathSync(resolvedExecutable));
  const readRoots = ["/System", "/usr", "/bin", "/sbin", "/Library", "/Applications", "/opt", "/private/etc", "/private/var/db", "/dev", executableRoot, root, runtime, temporary];
  const writeRoots = [runtime, temporary, ...(readOnly ? [] : [root])];
  const gitConfigFiles = [".gitconfig", ".gitignore_global", ".config/git/config", ".config/git/ignore", ".config/git/attributes"].map(file => path.join(os.homedir(), file));
  const readFiles = [...gitConfigFiles];
  if (runner === "claude") {
    const home = os.homedir();
    readFiles.push(home, path.join(home, ".claude.json"), path.join(home, "Library/Keychains/login.keychain-db"));
  }
  if (readableFile) readFiles.push(fs.realpathSync(readableFile));
  const xcrunCachePattern = systemTemporaryDirectory ? `^${systemTemporaryDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/xcrun_db-[^/]+$` : "";
  return [
    "(version 1)", "(allow default)", "(deny file-read* file-write*)", "(deny appleevent-send)",
    // Metadata on parent folders is needed for cwd/realpath; their contents remain unreadable.
    "(allow file-read-metadata)",
    '(allow file-read* (literal "/"))',
    ...readRoots.map(item => `(allow file-read* (subpath ${literal(item)}))`),
    ...readFiles.map(item => `(allow file-read* (literal ${literal(item)}))`),
    ...(xcrunCachePattern ? [`(allow file-read* file-write* (regex #${literal(xcrunCachePattern)}))`] : []),
    ...writeRoots.map(item => `(allow file-write* (subpath ${literal(item)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys"))',
  ].join("\n");
}

function sandboxCommand(executable: string, args: string[], root: string, readOnly: boolean, runner: RunRunner, readableFile?: string) {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
    throw new Error("This macOS version does not provide the filesystem sandbox required for local sessions.");
  }
  return { executable: "/usr/bin/sandbox-exec", args: ["-p", desktopSandboxProfile(root, executable, readOnly, runner, readableFile), executable, ...args] };
}

export function desktopCommand(executable: string, args: string[], workspace: string, sandbox: SandboxMode = "workspace-write", runner: RunRunner = "codex", readableFile?: string) {
  if (!desktopMode) return { executable, args };
  const root = assertDesktopWorkspace(workspace);
  if (sandbox === "danger-full-access") return { executable, args };
  return sandboxCommand(executable, args, root, sandbox === "read-only", runner, readableFile);
}

export function desktopProbeCommand(runner: RunRunner, executable: string, args: string[]) {
  const cwd = runnerProfile(runner);
  return { ...sandboxCommand(executable, args, cwd, true, runner), cwd };
}

export function desktopRunnerEnvironment(runner: RunRunner = "codex", sandbox: SandboxMode = "workspace-write"): NodeJS.ProcessEnv {
  if (!desktopMode) return { ...process.env };
  const allowed = ["HOME", "PATH", "LANG", "LC_ALL", "SHELL", "TMPDIR", "TERM", "COLORTERM", profileVariables[runner]];
  if (sandbox === "danger-full-access") allowed.push("SSH_AUTH_SOCK");
  if (runner === "cursor") allowed.push("CURSOR_DATA_DIR");
  const env = Object.fromEntries(allowed.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  if (runner === "claude") {
    const { username } = os.userInfo();
    env.USER = username;
    env.LOGNAME = username;
    // Claude Code defaults to /tmp on macOS even when TMPDIR is set.
    env.CLAUDE_CODE_TMPDIR = env.TMPDIR || os.tmpdir();
  }
  if (runner === "cursor") {
    env.HOME = runnerProfile(runner);
    env.AGENT_CLI_CREDENTIAL_STORE = "file";
    env.NODE_DISABLE_COMPILE_CACHE = "1";
  }
  return env;
}
