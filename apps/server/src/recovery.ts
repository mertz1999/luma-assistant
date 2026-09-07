import { getProcessCommandLine, isProcessAlive, killProcessTree } from "./platform/process-utils.js";

/**
 * Crash recovery for a run left "queued"/"running" across a server
 * restart (spec: a process dying -- or a controller restarting -- must not
 * silently mean the run's real-world state is just forgotten).
 *
 * Before this existed, loadPersisted() unconditionally relabeled every such
 * run "failed" without ever checking whether the underlying process was
 * actually still alive. On this platform a spawned child is not
 * automatically killed when its parent Node process exits (neither on
 * Windows, where the shim-unwrapped Codex/Claude process is a fully
 * independent process, nor in general on Unix without explicit process-
 * group signal propagation) -- so a genuinely-still-running, now-orphaned,
 * full-permission agent process could be silently left unmanaged and
 * unmonitored while Luma's own records claimed it had failed.
 *
 * This function decides, and (when it can act confidently) acts:
 *   - no recorded pid, or the pid is not alive: the process really is gone.
 *   - pid alive AND its command line plausibly names this run's own runner
 *     (codex/claude/qwythos -- the qwythos runner spawns the `openclaude`
 *     CLI, so its command-line signature is "openclaude", not "qwythos";
 *     see run-config-normalize.ts's RunRunner->executable-name split):
 *     treat as a confirmed orphan and terminate the whole tree -- leaving
 *     a full-permission agent process running unmonitored is a real
 *     safety hazard, not a cosmetic one.
 *   - pid alive but the command line does not match (or could not be
 *     read): DO NOT kill it. The pid may have been reused by an unrelated
 *     process after a reboot -- a real failure mode, not hypothetical, and
 *     exactly the case "fail closed for dangerous actions" exists for.
 *     Surfaced distinctly so an operator can investigate rather than
 *     either silently leaving it stuck or silently killing the wrong
 *     process.
 *
 * In every branch the run itself ends up "failed" (this server process no
 * longer has a live handle to it either way) -- what differs is the
 * message, and whether a genuine orphan is actually cleaned up.
 */
export function reconcileStaleRunPid(run: {
  pid: number | null | undefined;
  config: { runner?: string };
}): { message: string; orphanKilled: boolean } {
  const pid = run.pid;
  const runnerName =
    run.config?.runner === "claude" ? "claude" : run.config?.runner === "qwythos" ? "openclaude" : "codex";

  if (!pid || !isProcessAlive(pid)) {
    return {
      message:
        "Server restarted before this run completed. Marked as failed because no live process is attached.",
      orphanKilled: false,
    };
  }

  const commandLine = getProcessCommandLine(pid);
  const looksLikeOurs = Boolean(commandLine && commandLine.toLowerCase().includes(runnerName));

  if (looksLikeOurs) {
    killProcessTree(pid, "SIGKILL");
    return {
      message:
        `Server restarted while this run was active. A live orphaned process (pid ${pid}) whose command line ` +
        `matched this run's ${runnerName} runner was found and terminated. Marked failed because Luma's own ` +
        `process handle was lost across the restart.`,
      orphanKilled: true,
    };
  }

  return {
    message:
      `Server restarted while this run was active (pid ${pid} recorded). A process is currently using that ` +
      `pid, but its command line could not be confirmed as this run's ${runnerName} process, so it was left ` +
      `untouched to avoid terminating an unrelated process (the pid may have been reused after a reboot). ` +
      `Marked failed because Luma's own process handle was lost across the restart -- if pid ${pid} is ` +
      `unrelated, no action is needed; otherwise verify and stop it manually.`,
    orphanKilled: false,
  };
}
