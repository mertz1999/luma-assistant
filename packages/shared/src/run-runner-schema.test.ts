import { test } from "node:test";
import assert from "node:assert/strict";
import { runRunnerSchema } from "./index.js";

// Regression coverage for the qwythos-runner integration: runRunnerSchema
// was a closed two-value enum (["codex", "claude"]); this pins that
// "qwythos" is now a genuine third accepted value, that "codex"/"claude"
// remain valid, and that an arbitrary/unknown runner name is still rejected
// outright rather than silently coerced.

test("runRunnerSchema: accepts 'qwythos'", () => {
  const result = runRunnerSchema.safeParse("qwythos");
  assert.equal(result.success, true);
});

test("runRunnerSchema: still accepts 'codex' and 'claude', unchanged", () => {
  assert.equal(runRunnerSchema.safeParse("codex").success, true);
  assert.equal(runRunnerSchema.safeParse("claude").success, true);
});

test("runRunnerSchema: rejects an unknown runner name (e.g. a cloud provider) rather than silently accepting it", () => {
  for (const bogus of ["openai", "anthropic", "gemini", "deepseek", "bedrock", "vertex", "together", "fireworks", "groq", "azure", ""]) {
    const result = runRunnerSchema.safeParse(bogus);
    assert.equal(result.success, false, `expected "${bogus}" to be rejected`);
  }
});
