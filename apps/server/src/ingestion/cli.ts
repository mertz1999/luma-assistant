import path from "node:path";
import { convertDocumentForIngestion } from "./document-ingest.js";
import { checkAvailability } from "./markitdown-adapter.js";
import { sectionizeMarkdown } from "./sectionize-markdown.js";
import { DocumentIngestError } from "./errors.js";

/**
 * Internal test/inspection CLI for the document-ingestion pipeline.
 *
 *   npx tsx src/ingestion/cli.ts <path-to-file>
 *
 * Deliberately does not dump the converted document by default -- prints a
 * status summary only, matching the "no verbose dumping" requirement.
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: tsx src/ingestion/cli.ts <path-to-file>");
    process.exitCode = 1;
    return;
  }

  const absolutePath = path.resolve(inputPath);
  const extension = path.extname(absolutePath).toLowerCase();

  const availability = checkAvailability();
  if (!availability.available) {
    console.log(JSON.stringify({ status: "error", error_code: "DEPENDENCY_MISSING", message: availability.reason }, null, 2));
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  try {
    const result = await convertDocumentForIngestion(absolutePath, {
      workspaceId: "cli-test",
      filename: path.basename(absolutePath),
      mimeType: "application/octet-stream",
      extension,
    });
    const sections = sectionizeMarkdown(result.markdown);
    console.log(
      JSON.stringify(
        {
          status: "ok",
          detected_type: extension,
          backend: result.conversionBackend,
          characters_extracted: result.markdown.length,
          sections: sections.length,
          warnings: result.warnings,
          elapsed_ms: Date.now() - startedAt,
          content_hash: result.contentHash,
          title: result.title,
          metadata: result.metadata,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const code = err instanceof DocumentIngestError ? err.code : "CORRUPT_DOCUMENT";
    console.log(
      JSON.stringify(
        {
          status: "error",
          error_code: code,
          message: err instanceof Error ? err.message : String(err),
          elapsed_ms: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

void main();
