/**
 * Credential isolation for spawned agent processes (spec: "Never assume
 * every agent may access every credential").
 *
 * Before this existed, both spawn sites gave the child process the ENTIRE
 * Luma server environment: Codex's spawn call passed no `env` option at
 * all (child_process.spawn inherits the full parent environment when
 * `env` is omitted), and Claude's buildClaudeEnvironment() explicitly did
 * `{...process.env}` and deleted only two or three specific keys. Both
 * meant every agent run received Luma's own PASSWORD, JWT_SECRET,
 * TASK_MANAGER_JWT_SECRET, TASK_MANAGER_ADMIN_PASSWORD, TELEGRAM_BOT_TOKEN
 * -- its entire operational secret set -- regardless of what that run's
 * actual task needed. A prompt-injected or simply overly-curious agent run
 * could read any of these with `echo $JWT_SECRET`, and Luma would then
 * store that value in the run's own persisted output/audit trail.
 *
 * This is an allowlist, not a denylist: only variables a Windows/Unix
 * process genuinely needs to function at all (resolve node/git/the CLI
 * itself on PATH, find its own config/cache directories, know its own
 * temp dir) pass through by default. Everything else -- including secrets
 * neither this file nor any future one has to specifically know the name
 * of -- is excluded by construction, not by trying to enumerate and
 * blocklist every possible secret name.
 */

const SAFE_BASE_ENV_KEYS = [
  "PATH",
  "Path",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "ComSpec",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "USERNAME",
  "USER",
  "USERDOMAIN",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
];

/**
 * Returns only the safe-base subset of `sourceEnv` (defaults to this
 * process's own env). Never mutates the source.
 */
export function pickSafeBaseEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of SAFE_BASE_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) base[key] = value;
  }
  return base;
}
