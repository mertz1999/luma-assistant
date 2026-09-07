import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionizeMarkdown } from "./sectionize-markdown.js";

test("splits on headings and tracks heading hierarchy", () => {
  const markdown = "# Manual\n\nIntro text.\n\n## Section 1\n\nBody one.\n\n## Section 2\n\nBody two.\n";
  const sections = sectionizeMarkdown(markdown);
  assert.equal(sections.length, 3);
  assert.deepEqual(sections[0]!.headingPath, ["Manual"]);
  assert.equal(sections[0]!.content, "Intro text.");
  assert.deepEqual(sections[1]!.headingPath, ["Manual", "Section 1"]);
  assert.equal(sections[1]!.content, "Body one.");
  assert.deepEqual(sections[2]!.headingPath, ["Manual", "Section 2"]);
});

test("resets heading hierarchy at a PowerPoint slide marker", () => {
  const markdown = "<!-- Slide number: 1 -->\n# Title\nContent one\n\n<!-- Slide number: 2 -->\n# Findings\nContent two";
  const sections = sectionizeMarkdown(markdown);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0]!.headingPath, ["Slide 1", "Title"]);
  assert.deepEqual(sections[1]!.headingPath, ["Slide 2", "Findings"]);
});

test("drops empty sections between adjacent headings", () => {
  const markdown = "# A\n## B\n## C\nonly this has content";
  const sections = sectionizeMarkdown(markdown);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]!.headingPath, ["A", "C"]);
});

test("a document with no headings is a single section with an empty heading path", () => {
  const sections = sectionizeMarkdown("Just plain text.\nSecond line.");
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]!.headingPath, []);
  assert.equal(sections[0]!.headingLevel, null);
});
