import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAvailability, convertDocument, isAvailable } from "./markitdown-adapter.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string) => path.join(fixturesDir, name);

// This host has a provisioned MarkItDown venv (tools/markitdown/.venv, set up
// during this integration per tools/markitdown/requirements.txt) -- these
// tests exercise the real conversion path, matching the "honest, real state
// of this environment" convention used elsewhere (see
// apps/server/src/browser/browseract-adapter.test.ts). If a future host
// lacks the venv, these are skipped rather than failed.
const available = isAvailable();
const maybeTest = available ? test : test.skip;

test("checkAvailability reports the real state of this host honestly", () => {
  const result = checkAvailability();
  assert.equal(typeof result.available, "boolean");
  if (!result.available) {
    assert.ok(result.reason, "an unavailable result must explain why");
  }
});

maybeTest("converts a text-native PDF and extracts its text", async () => {
  const result = await convertDocument(fixture("sample.pdf"), 30_000);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.markdown, /Equipment Specification Report/);
    assert.equal(result.backend, "markitdown");
  }
});

maybeTest("converts a DOCX preserving headings and its table", async () => {
  const result = await convertDocument(fixture("sample.docx"), 30_000);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.markdown, /^# Hydraulic Circuit Manual/m);
    assert.match(result.markdown, /^## Section 2: Specifications/m);
    assert.match(result.markdown, /\| Max Pressure \| 250 bar \|/);
  }
});

maybeTest("converts an XLSX preserving sheet names as headings and rows as a table", async () => {
  const result = await convertDocument(fixture("sample.xlsx"), 30_000);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.markdown, /^## Maintenance/m);
    assert.match(result.markdown, /^## SpareParts/m);
    assert.match(result.markdown, /\| P-1001 \| Hydraulic seal \| 4 \|/);
  }
});

maybeTest("converts a PPTX preserving slide boundaries and notes", async () => {
  const result = await convertDocument(fixture("sample.pptx"), 30_000);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.markdown, /Slide number: 1/);
    assert.match(result.markdown, /Slide number: 2/);
    assert.match(result.markdown, /Remember to check hydraulic hoses\./);
  }
});

maybeTest("reports CORRUPT_DOCUMENT for a truncated/invalid DOCX rather than throwing", async () => {
  const result = await convertDocument(fixture("corrupt.docx"), 30_000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CORRUPT_DOCUMENT");
});

maybeTest("reports UNSUPPORTED_FORMAT for a genuinely unsupported binary", async () => {
  const result = await convertDocument(fixture("unsupported.bin"), 30_000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "UNSUPPORTED_FORMAT");
});

maybeTest("times out and reports CONVERSION_TIMEOUT rather than hanging, for an unreasonably small budget", async () => {
  const result = await convertDocument(fixture("sample.docx"), 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CONVERSION_TIMEOUT");
});

maybeTest("conversion succeeds even when cloud-AI-shaped env vars are present in the parent process (no external call is attempted or needed)", async () => {
  const restore = { ...process.env };
  process.env.OPENAI_API_KEY = "sk-should-never-be-used-or-leaked";
  process.env.AZURE_OPENAI_API_KEY = "azure-should-never-be-used-or-leaked";
  try {
    const result = await convertDocument(fixture("sample.pdf"), 30_000);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(!result.markdown.includes("should-never-be-used-or-leaked"));
    }
  } finally {
    process.env = restore;
  }
});

test("convertDocument reports DEPENDENCY_MISSING (not a crash) when pointed at a nonexistent interpreter", async () => {
  const restore = process.env.MARKITDOWN_PYTHON;
  process.env.MARKITDOWN_PYTHON = path.join(fixturesDir, "does-not-exist-python.exe");
  try {
    const result = await convertDocument(fixture("sample.pdf"), 5_000);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "DEPENDENCY_MISSING");
  } finally {
    if (restore === undefined) delete process.env.MARKITDOWN_PYTHON;
    else process.env.MARKITDOWN_PYTHON = restore;
  }
});
