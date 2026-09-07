import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConvertedMarkdown } from "./markdown-normalize.js";

test("normalizes CRLF and lone CR to LF", () => {
  assert.equal(normalizeConvertedMarkdown("a\r\nb\rc"), "a\nb\nc\n");
});

test("strips trailing whitespace per line without touching content", () => {
  assert.equal(normalizeConvertedMarkdown("# Title   \nBody text\t\n"), "# Title\nBody text\n");
});

test("collapses runs of 4+ blank lines to at most 2, preserving intentional spacing", () => {
  assert.equal(normalizeConvertedMarkdown("a\n\n\n\n\n\nb"), "a\n\n\nb\n");
});

test("preserves a markdown table and heading structure verbatim", () => {
  const input = "# Title\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
  assert.equal(normalizeConvertedMarkdown(input), input);
});

test("is idempotent (running twice gives the same result)", () => {
  const input = "a\r\n\r\n\r\n\r\n\r\nb   \n";
  const once = normalizeConvertedMarkdown(input);
  const twice = normalizeConvertedMarkdown(once);
  assert.equal(once, twice);
});
