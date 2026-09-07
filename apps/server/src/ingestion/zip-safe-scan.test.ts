import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanZipSafely } from "./zip-safe-scan.js";
import { DEFAULT_DOCUMENT_INGEST_LIMITS } from "./limits.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string) => path.join(fixturesDir, name);

test("scanZipSafely accepts a well-formed archive and counts its members", async () => {
  const result = await scanZipSafely(fixture("archive-ok.zip"), DEFAULT_DOCUMENT_INGEST_LIMITS);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.fileCount, 2);
    assert.ok(result.totalUncompressedBytes > 0);
  }
});

test("scanZipSafely blocks a relative path-traversal entry (../evil.txt)", async () => {
  const result = await scanZipSafely(fixture("archive-traversal.zip"), DEFAULT_DOCUMENT_INGEST_LIMITS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ARCHIVE_TRAVERSAL_BLOCKED");
});

test("scanZipSafely blocks an absolute path entry (/etc/passwd)", async () => {
  const result = await scanZipSafely(fixture("archive-absolute-path.zip"), DEFAULT_DOCUMENT_INGEST_LIMITS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ARCHIVE_TRAVERSAL_BLOCKED");
});

test("scanZipSafely blocks a nested archive member (zip-in-zip)", async () => {
  const result = await scanZipSafely(fixture("archive-nested-zip.zip"), DEFAULT_DOCUMENT_INGEST_LIMITS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ARCHIVE_NESTED_ARCHIVE_BLOCKED");
});

test("scanZipSafely blocks a nested archive disguised with a non-archive extension (zip renamed to .pdf)", async () => {
  // Regression coverage for a real bypass found during verification: MarkItDown
  // content-sniffs each ZIP member's format rather than trusting its declared
  // extension, so a nested ZIP saved as "sneaky.pdf" is still recursively
  // expanded by MarkItDown's ZipConverter unless this scan also peeks magic
  // bytes instead of relying on the member's name alone.
  const result = await scanZipSafely(fixture("archive-disguised-nested-zip.zip"), DEFAULT_DOCUMENT_INGEST_LIMITS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ARCHIVE_NESTED_ARCHIVE_BLOCKED");
});

test("scanZipSafely rejects an archive exceeding the configured file-count limit", async () => {
  const tightLimits = { ...DEFAULT_DOCUMENT_INGEST_LIMITS, maxArchiveFiles: 1 };
  const result = await scanZipSafely(fixture("archive-ok.zip"), tightLimits);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ARCHIVE_TOO_MANY_FILES");
});

test("scanZipSafely rejects an archive exceeding the configured expanded-size limit", async () => {
  const tightLimits = { ...DEFAULT_DOCUMENT_INGEST_LIMITS, maxArchiveExpandedBytes: 5 };
  const result = await scanZipSafely(fixture("archive-ok.zip"), tightLimits);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ARCHIVE_TOO_LARGE");
});

test("scanZipSafely reports CORRUPT_DOCUMENT for a file that is not actually a zip", async () => {
  const result = await scanZipSafely(fixture("corrupt.docx"), DEFAULT_DOCUMENT_INGEST_LIMITS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CORRUPT_DOCUMENT");
});
