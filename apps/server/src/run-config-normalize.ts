import type { ReasoningEffort, RunRunner, SelectedSkillRef } from "@luma/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeRunRunner(input: unknown): RunRunner {
  return input === "claude" ? "claude" : "codex";
}

export function normalizeReasoningEffort(input: unknown): ReasoningEffort {
  return input === "low" || input === "medium" || input === "high" || input === "xhigh" || input === "max"
    ? input
    : "high";
}

export function normalizeSelectedSkillRefs(input: unknown): SelectedSkillRef[] {
  if (!Array.isArray(input)) return [];

  const next: SelectedSkillRef[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string") continue;
    const id = value.id.trim();
    const skillPath = value.path.trim();
    if (!id || !skillPath) continue;
    const key = `${id}\n${skillPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ id, path: skillPath });
    if (next.length >= 20) break;
  }
  return next;
}
