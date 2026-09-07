import crypto from "node:crypto";
import fs from "node:fs";
import { convertDocument } from "./markitdown-adapter.js";
import { scanZipSafely } from "./zip-safe-scan.js";
import { normalizeConvertedMarkdown } from "./markdown-normalize.js";
import { DEFAULT_DOCUMENT_INGEST_LIMITS, type DocumentIngestLimits } from "./limits.js";
import { DocumentIngestError, type DocumentWarningCode } from "./errors.js";

/**
 * Document-ingestion orchestration: the one function the rest of Luma
 * (apps/server/src/index.ts's attachment upload handler) calls. Everything
 * MarkItDown-specific stays behind ./markitdown-adapter.ts; this file only
 * knows the generic pipeline: validate -> (ZIP safety gate) -> convert ->
 * normalize -> extract cheap structural hints -> hash -> return.
 *
 * Never throws for a "the document converted, but with a caveat" outcome
 * (e.g. a scanned PDF with no extractable text) -- those become entries in
 * `warnings` on a successful result. Only throws DocumentIngestError for
 * outcomes where no usable attachment can be created at all.
 */

export interface DocumentMetadata {
  workspaceId: string;
  fileSizeBytes: number;
  sha256: string;
  conversionTimestamp: string;
  /** Best-effort, parsed out of MarkItDown's own markdown markers -- omitted (never fabricated) when not confidently detected. */
  slideCount?: number;
  sheetNames?: string[];
  /** Present only when `extension` is .zip -- member paths as MarkItDown reported them. */
  archiveMembers?: string[];
  archiveSourceName?: string;
}

export interface DocumentConversionResult {
  sourcePath: string;
  filename: string;
  mimeType: string;
  extension: string;
  markdown: string;
  title: string | null;
  metadata: DocumentMetadata;
  warnings: DocumentWarningCode[];
  conversionBackend: string;
  conversionDurationMs: number;
  contentHash: string;
}

export interface DocumentIngestInput {
  workspaceId: string;
  filename: string;
  mimeType: string;
  extension: string;
}

const SLIDE_MARKER = /<!--\s*Slide number:\s*\d+\s*-->/g;
const ARCHIVE_MEMBER_HEADER = /^## File: (.+)$/gm;
const SHEET_HEADING_LIMIT = 50;

function extractStructuralHints(markdown: string, extension: string): { slideCount?: number; sheetNames?: string[] } {
  if (extension === ".pptx" || extension === ".ppt") {
    const matches = markdown.match(SLIDE_MARKER);
    if (matches && matches.length > 0) return { slideCount: matches.length };
  }
  if (extension === ".xlsx" || extension === ".xls") {
    // MarkItDown emits one `## <SheetName>` heading per worksheet, immediately
    // followed by that sheet's table -- distinguished from a converted
    // document's own `##` headings only by adjacency to context, but for a
    // spreadsheet MIME type every top-level `##` heading IS a sheet name.
    const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim()).slice(0, SHEET_HEADING_LIMIT);
    if (headings.length > 0) return { sheetNames: headings };
  }
  return {};
}

function extractArchiveMembers(markdown: string): string[] {
  return [...markdown.matchAll(ARCHIVE_MEMBER_HEADER)].map((m) => m[1]!.trim());
}

function detectMissingText(markdown: string, extension: string, fileSizeBytes: number): DocumentWarningCode[] {
  const strippedLength = markdown.replace(/\s+/g, "").length;
  if (strippedLength === 0) {
    return extension === ".pdf" ? ["NO_EXTRACTABLE_TEXT", "OCR_REQUIRED"] : ["NO_EXTRACTABLE_TEXT"];
  }
  // Heuristic only (MarkItDown does not report page count): a PDF whose
  // extracted text is vanishingly small relative to its file size is very
  // likely scanned/image-heavy rather than genuinely near-empty. Bounded and
  // named as a heuristic in the warning code itself -- never asserted as fact.
  if (extension === ".pdf" && fileSizeBytes > 5_000 && strippedLength < 30) {
    return ["NO_EXTRACTABLE_TEXT", "OCR_REQUIRED"];
  }
  return [];
}

export async function convertDocumentForIngestion(
  absolutePath: string,
  input: DocumentIngestInput,
  limits: DocumentIngestLimits = DEFAULT_DOCUMENT_INGEST_LIMITS,
): Promise<DocumentConversionResult> {
  const stat = fs.statSync(absolutePath);
  if (stat.size > limits.maxFileBytes) {
    throw new DocumentIngestError("FILE_TOO_LARGE", `File is ${stat.size} bytes, exceeding the ${limits.maxFileBytes} byte limit.`);
  }

  if (input.extension === ".zip") {
    const scan = await scanZipSafely(absolutePath, limits);
    if (!scan.ok) {
      throw new DocumentIngestError(scan.code, scan.message);
    }
  }

  const startedAt = Date.now();
  const conversion = await convertDocument(absolutePath, limits.maxConversionMs);
  const conversionDurationMs = Date.now() - startedAt;

  if (!conversion.ok) {
    throw new DocumentIngestError(conversion.code, conversion.message);
  }

  const normalizedMarkdown = normalizeConvertedMarkdown(conversion.markdown);
  const warnings: DocumentWarningCode[] = [...detectMissingText(normalizedMarkdown, input.extension, stat.size)];
  if (normalizedMarkdown.length > limits.maxMarkdownChars) {
    warnings.push("MARKDOWN_EXCEEDS_LIMIT");
  }

  const contentHash = crypto.createHash("sha256").update(normalizedMarkdown, "utf8").digest("hex");
  const structuralHints = extractStructuralHints(normalizedMarkdown, input.extension);
  const archiveMembers = input.extension === ".zip" ? extractArchiveMembers(normalizedMarkdown) : undefined;

  return {
    sourcePath: absolutePath,
    filename: input.filename,
    mimeType: input.mimeType,
    extension: input.extension,
    markdown: normalizedMarkdown,
    title: conversion.title,
    metadata: {
      workspaceId: input.workspaceId,
      fileSizeBytes: stat.size,
      sha256: contentHash,
      conversionTimestamp: new Date().toISOString(),
      ...structuralHints,
      ...(archiveMembers ? { archiveMembers, archiveSourceName: input.filename } : {}),
    },
    warnings,
    conversionBackend: conversion.backend,
    conversionDurationMs,
    contentHash,
  };
}

export { DocumentIngestError } from "./errors.js";
export { checkAvailability as checkMarkItDownAvailability, isAvailable as isMarkItDownAvailable } from "./markitdown-adapter.js";
export { DEFAULT_DOCUMENT_INGEST_LIMITS, loadDocumentIngestLimits, type DocumentIngestLimits } from "./limits.js";
