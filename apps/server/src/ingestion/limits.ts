/**
 * Resource limits for the document-ingestion pipeline (MarkItDown adapter).
 *
 * Mirrors the existing convention in index.ts (ATTACHMENT_MAX_BYTES etc.):
 * env-overridable, conservative defaults, read once at module load. Kept in
 * its own file (rather than added to index.ts's constant block) because the
 * ingestion module is meant to be usable/testable independently of the
 * 300KB+ server entrypoint.
 */

export interface DocumentIngestLimits {
  /** Largest single document file MarkItDown will be asked to convert. */
  maxFileBytes: number;
  /** Largest total uncompressed size a ZIP archive may expand to. */
  maxArchiveExpandedBytes: number;
  /** Largest number of entries a ZIP archive may contain. */
  maxArchiveFiles: number;
  /** Deepest path-segment nesting (e.g. a/b/c/file.pdf = depth 3) allowed inside a ZIP. */
  maxArchiveDepth: number;
  /** Wall-clock budget for a single MarkItDown subprocess conversion. */
  maxConversionMs: number;
  /** Largest converted Markdown document Luma will treat as "normal" before flagging it. */
  maxMarkdownChars: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadDocumentIngestLimits(env: NodeJS.ProcessEnv = process.env): DocumentIngestLimits {
  return {
    maxFileBytes: envInt("DOCUMENT_MAX_FILE_MB", 25) * 1024 * 1024,
    maxArchiveExpandedBytes: envInt("DOCUMENT_MAX_ARCHIVE_MB", 100) * 1024 * 1024,
    maxArchiveFiles: envInt("DOCUMENT_MAX_ARCHIVE_FILES", 200),
    maxArchiveDepth: envInt("DOCUMENT_MAX_ARCHIVE_DEPTH", 8),
    maxConversionMs: envInt("DOCUMENT_CONVERSION_TIMEOUT_SECONDS", 60) * 1000,
    maxMarkdownChars: envInt("DOCUMENT_MAX_MARKDOWN_CHARS", 2_000_000),
  };
}

export const DEFAULT_DOCUMENT_INGEST_LIMITS: DocumentIngestLimits = loadDocumentIngestLimits({});
