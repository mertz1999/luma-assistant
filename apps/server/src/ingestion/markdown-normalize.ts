/**
 * Deterministic, minimal normalization of MarkItDown's Markdown output.
 *
 * Deliberately narrow: normalize whitespace/line-ending noise only. Never
 * rewrites headings, tables, links, or code blocks, and never runs the
 * content through an LLM -- conversion must stay byte-for-byte reproducible
 * given the same input file, so retrieval/citation offsets stay trustworthy.
 */
export function normalizeConvertedMarkdown(input: string): string {
  const normalized = input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  return normalized.length > 0 ? `${normalized}\n` : normalized;
}
