import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerModelCatalogs } from "@luma/shared";
import { createModelOptions } from "../src/lib/model-catalog.js";
const base = { source: "live" as const, updatedAt: 1, checkedAt: 1, refreshing: false, error: null, cliVersion: "test" };
const catalogs: RunnerModelCatalogs = {
  codex: { ...base, models: [{ id: "brand-new-codex", displayName: "New Codex", supportedEfforts: ["low", "ultra"], defaultEffort: "low" }] },
  claude: { ...base, models: [{ id: "fable", resolvedModel: "claude-fable-new", displayName: "Fable", supportedEfforts: ["high", "max"] }, { id: "small", displayName: "Small", supportsEffort: false }] },
};
test("uses discovered IDs and resolved aliases without a release-specific allowlist", () => {
  const options = createModelOptions(catalogs);
  assert.deepEqual(options.modelOptionsForRunner("codex"), ["brand-new-codex"]);
  assert.deepEqual(options.modelOptionsForRunner("claude"), ["fable", "small"]);
  assert.equal(options.modelLabel("claude", "fable"), "Fable · claude-fable-new");
  assert.equal(options.modelLabel("codex", "saved-custom-id"), "saved-custom-id");
});
test("effort controls reflect model capabilities and normalize only deliberate model changes", () => {
  const options = createModelOptions(catalogs);
  assert.deepEqual(options.reasoningEffortOptionsForRunner("codex", "brand-new-codex"), ["low", "ultra"]);
  assert.equal(options.effortForModel("codex", "brand-new-codex", "high"), "low");
  assert.equal(options.effortForModel("claude", "fable", "ultra"), "high");
  assert.equal(options.effortForModel("claude", "fable", "max"), "max");
  assert.equal(options.modelSupportsEffort("claude", "small"), false);
});
