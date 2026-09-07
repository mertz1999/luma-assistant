/**
 * Splits converted Markdown along its own structural boundaries (headings,
 * MarkItDown's slide markers) instead of fixed character counts.
 *
 * Luma has no vector index or retrieval layer to feed today (verified during
 * this integration's reconnaissance -- the whole product routes documents to
 * a spawned Codex/Claude CLI process that reads files itself, not to an
 * embeddings store). This module exists so that future layer has something
 * structurally sound to consume without needing a second implementation: it
 * is intentionally the smallest useful step to prepare for section-level
 * citations ("Section: Hydraulic circuit"), not a chunker wired into an
 * index that does not exist yet.
 */

export interface MarkdownSection {
  index: number;
  headingPath: string[];
  headingLevel: number | null;
  content: string;
}

const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const SLIDE_MARKER_LINE = /^<!--\s*Slide number:\s*(\d+)\s*-->$/;

export function sectionizeMarkdown(markdown: string): MarkdownSection[] {
  const lines = markdown.split("\n");
  const sections: MarkdownSection[] = [];
  let headingStack: { level: number; text: string }[] = [];
  let buffer: string[] = [];
  let index = 0;

  const flush = () => {
    const content = buffer.join("\n").trim();
    buffer = [];
    if (!content) return;
    sections.push({
      index: index++,
      headingPath: headingStack.map((h) => h.text),
      headingLevel: headingStack.length > 0 ? headingStack[headingStack.length - 1]!.level : null,
      content,
    });
  };

  for (const line of lines) {
    const headingMatch = HEADING_LINE.exec(line);
    if (headingMatch) {
      flush();
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();
      headingStack = headingStack.filter((h) => h.level < level);
      headingStack.push({ level, text });
      continue;
    }

    const slideMatch = SLIDE_MARKER_LINE.exec(line.trim());
    if (slideMatch) {
      flush();
      // Level 0 (below any real Markdown heading level, which starts at 1) so a
      // following "# Slide Title" nests under the slide instead of replacing it.
      headingStack = [{ level: 0, text: `Slide ${slideMatch[1]}` }];
      continue;
    }

    buffer.push(line);
  }
  flush();

  return sections;
}
