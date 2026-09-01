import fs from "node:fs";
import os from "node:os";

/**
 * Resource watchdog (spec: "the runtime should know available RAM, CPU
 * load, disk space... local-model launches should be rejected or delayed
 * when hardware requirements exceed configured safe limits").
 *
 * Scope for this phase: RAM and disk only, gating new-run admission --
 * both are cheap, synchronous, zero-added-latency checks (os.freemem(),
 * fs.statfsSync()). CPU load is deliberately NOT gated here: os.loadavg()
 * is a documented no-op on Windows (always returns [0,0,0]), and a real
 * CPU sample requires an async two-snapshot delta over a real time window
 * -- adding that latency to every single run-start request is a real
 * tradeoff, not free, so it's left as a known, stated gap rather than
 * faked with a meaningless always-zero number. GPU/VRAM and local-model
 * resource profiles are also out of scope: Luma has no local-model runner
 * at all yet (runRunnerSchema is "codex" | "claude" only) -- nothing
 * exists to gate. Guessing GPU requirements for a subsystem that isn't
 * built yet would violate "do not guess GPU requirements."
 */

export interface ResourceSnapshot {
  totalMemBytes: number;
  freeMemBytes: number;
  freeMemPercent: number;
  /** null if the workspace's filesystem couldn't be statfs'd (e.g. an unsupported FS) -- never treated as "0 free." */
  diskFreeBytes: number | null;
  cpuCount: number;
}

export interface ResourceLimits {
  minFreeMemoryBytes: number;
  minFreeDiskBytes: number;
}

export type ResourceDecisionKind = "ALLOW" | "DENY";

export interface ResourceDecision {
  decision: ResourceDecisionKind;
  reason: string;
  rule: string;
  snapshot: ResourceSnapshot;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

export function getResourceSnapshot(workspacePath: string): ResourceSnapshot {
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();

  let diskFreeBytes: number | null = null;
  try {
    const stat = fs.statfsSync(workspacePath);
    diskFreeBytes = stat.bavail * stat.bsize;
  } catch {
    // Unreadable/unsupported filesystem -- treated as "unknown," not "no space," by every caller.
    diskFreeBytes = null;
  }

  return {
    totalMemBytes,
    freeMemBytes,
    freeMemPercent: totalMemBytes > 0 ? freeMemBytes / totalMemBytes : 0,
    diskFreeBytes,
    cpuCount: os.cpus().length,
  };
}

export function evaluateResourcePolicy(workspacePath: string, limits: ResourceLimits): ResourceDecision {
  const snapshot = getResourceSnapshot(workspacePath);

  if (snapshot.freeMemBytes < limits.minFreeMemoryBytes) {
    return {
      decision: "DENY",
      rule: "min-free-memory",
      reason: `Only ${formatMb(snapshot.freeMemBytes)} RAM free, below the configured floor of ${formatMb(limits.minFreeMemoryBytes)}. Refusing to start a new run.`,
      snapshot,
    };
  }

  // diskFreeBytes === null means "couldn't determine" -- not gated, since
  // denying every run because a stat call failed would be a worse failure
  // mode than the disk-space check it's supposed to prevent.
  if (snapshot.diskFreeBytes !== null && snapshot.diskFreeBytes < limits.minFreeDiskBytes) {
    return {
      decision: "DENY",
      rule: "min-free-disk",
      reason: `Only ${formatMb(snapshot.diskFreeBytes)} disk free on the workspace's filesystem, below the configured floor of ${formatMb(limits.minFreeDiskBytes)}. Refusing to start a new run.`,
      snapshot,
    };
  }

  return {
    decision: "ALLOW",
    rule: "default-allow",
    reason: "RAM and disk levels are within configured limits.",
    snapshot,
  };
}
