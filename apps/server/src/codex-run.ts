import { createHash } from "node:crypto";

const repeatLimit = 5;
const recentCommandLimit = 40;

export const codexLoopStopMessage = `Luma stopped Codex after the same command returned the same result ${repeatLimit} times without progress.`;
export const codexInterruptedMessage = "Codex was interrupted before it finished the turn.";

export class CodexCommandLoop {
  private recent: { command: string; result: string }[] = [];

  reset(): void {
    this.recent = [];
  }

  record(item: Record<string, unknown>): boolean {
    if (item.status === "in_progress" || typeof item.command !== "string" || typeof item.aggregated_output !== "string") return false;
    // Explicit wait commands can report the same status while they wait for external work.
    if (/\b(?:watch\s|sleep\s|kubectl\s+(?:wait|rollout\s+status)|gh\s+run\s+watch)\b/i.test(item.command)) return false;
    const command = createHash("sha256").update(item.command.trim()).digest("hex");
    const result = createHash("sha256").update(String(item.exit_code)).update("\0").update(item.aggregated_output.trim()).digest("hex");
    this.recent = this.recent.filter(previous => previous.command !== command || previous.result === result);
    this.recent.push({ command, result });
    if (this.recent.length > recentCommandLimit) this.recent.shift();
    return this.recent.filter(previous => previous.command === command).length >= repeatLimit;
  }
}

type CodexTurn = "completed" | "failed" | "interrupted";

export function codexExitStatus({ turn, stopRequested, code, signal }: {
  turn?: CodexTurn;
  stopRequested: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}): "completed" | "failed" | "stopped" {
  if (stopRequested || turn === "interrupted") return "stopped";
  if (turn === "completed") return "completed";
  if (turn === "failed") return "failed";
  if (signal || code === 0 || code === 130 || code === 143) return "stopped";
  return "failed";
}
