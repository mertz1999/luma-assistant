import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertDocumentForIngestion } from "./document-ingest.js";
import { DocumentIngestError } from "./errors.js";
import { DEFAULT_DOCUMENT_INGEST_LIMITS } from "./limits.js";
import { isAvailable } from "./markitdown-adapter.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string) => path.join(fixturesDir, name);
const baseInput = (filename: string, extension: string) => ({
  workspaceId: "test-workspace",
  filename,
  mimeType: "application/octet-stream",
  extension,
});

const available = isAvailable();
const maybeTest = available ? test : test.skip;

maybeTest("produces a stable SHA-256 content hash across repeated conversions of the same file", async () => {
  const first = await convertDocumentForIngestion(fixture("sample.docx"), baseInput("sample.docx", ".docx"));
  const second = await convertDocumentForIngestion(fixture("sample.docx"), baseInput("sample.docx", ".docx"));
  assert.equal(first.contentHash, second.contentHash);
  assert.match(first.contentHash, /^[0-9a-f]{64}$/);
});

maybeTest("preserves source filename, workspace ID, and file size in metadata", async () => {
  const result = await convertDocumentForIngestion(fixture("sample.docx"), baseInput("sample.docx", ".docx"));
  assert.equal(result.filename, "sample.docx");
  assert.equal(result.metadata.workspaceId, "test-workspace");
  assert.equal(result.metadata.fileSizeBytes, fs.statSync(fixture("sample.docx")).size);
});

maybeTest("detects sheet names for an XLSX workbook", async () => {
  const result = await convertDocumentForIngestion(fixture("sample.xlsx"), baseInput("sample.xlsx", ".xlsx"));
  assert.deepEqual(result.metadata.sheetNames, ["Maintenance", "SpareParts"]);
});

maybeTest("detects slide count for a PPTX deck", async () => {
  const result = await convertDocumentForIngestion(fixture("sample.pptx"), baseInput("sample.pptx", ".pptx"));
  assert.equal(result.metadata.slideCount, 2);
});

maybeTest("converts a ZIP end-to-end and preserves both the archive name and the member path", async () => {
  const result = await convertDocumentForIngestion(fixture("archive-ok.zip"), baseInput("archive-ok.zip", ".zip"));
  assert.equal(result.metadata.archiveSourceName, "archive-ok.zip");
  assert.ok(result.metadata.archiveMembers?.includes("notes/readme.txt"));
  assert.match(result.markdown, /notes\/readme\.txt/);
  assert.match(result.markdown, /Archive member content for ingestion tests\./);
});

maybeTest("silently ignores an unsupported binary member inside an otherwise-valid ZIP", async () => {
  const result = await convertDocumentForIngestion(fixture("archive-ok.zip"), baseInput("archive-ok.zip", ".zip"));
  assert.ok(!result.metadata.archiveMembers?.includes("bin/tool.exe"));
});

maybeTest("rejects a ZIP with a path-traversal member before ever invoking the conversion backend", async () => {
  await assert.rejects(
    () => convertDocumentForIngestion(fixture("archive-traversal.zip"), baseInput("archive-traversal.zip", ".zip")),
    (err: unknown) => err instanceof DocumentIngestError && err.code === "ARCHIVE_TRAVERSAL_BLOCKED",
  );
});

maybeTest("rejects a nested archive disguised with a non-archive extension end-to-end, before MarkItDown would have recursed into it", async () => {
  // End-to-end proof that the scan gate (not just an assumption about it)
  // actually stops this file before convertDocumentForIngestion ever calls
  // the MarkItDown subprocess -- see zip-safe-scan.test.ts for the isolated
  // scan-level regression test and the underlying bypass this covers.
  await assert.rejects(
    () => convertDocumentForIngestion(fixture("archive-disguised-nested-zip.zip"), baseInput("archive-disguised-nested-zip.zip", ".zip")),
    (err: unknown) => err instanceof DocumentIngestError && err.code === "ARCHIVE_NESTED_ARCHIVE_BLOCKED",
  );
});

maybeTest("rejects an oversized document via a tightened per-call limit, without truncating anything", async () => {
  const tinyLimits = { ...DEFAULT_DOCUMENT_INGEST_LIMITS, maxFileBytes: 10 };
  await assert.rejects(
    () => convertDocumentForIngestion(fixture("sample.docx"), baseInput("sample.docx", ".docx"), tinyLimits),
    (err: unknown) => err instanceof DocumentIngestError && err.code === "FILE_TOO_LARGE",
  );
});

maybeTest("flags MARKDOWN_EXCEEDS_LIMIT as a warning (not a rejection) rather than truncating content", async () => {
  const tinyMarkdownLimit = { ...DEFAULT_DOCUMENT_INGEST_LIMITS, maxMarkdownChars: 10 };
  const result = await convertDocumentForIngestion(fixture("sample.docx"), baseInput("sample.docx", ".docx"), tinyMarkdownLimit);
  assert.ok(result.warnings.includes("MARKDOWN_EXCEEDS_LIMIT"));
  assert.ok(result.markdown.length > 10, "full markdown must still be returned, never silently cut");
});

maybeTest("raises CORRUPT_DOCUMENT (not an unhandled throw) for a broken DOCX", async () => {
  await assert.rejects(
    () => convertDocumentForIngestion(fixture("corrupt.docx"), baseInput("corrupt.docx", ".docx")),
    (err: unknown) => err instanceof DocumentIngestError && err.code === "CORRUPT_DOCUMENT",
  );
});

maybeTest("raises UNSUPPORTED_FORMAT for a genuinely unsupported binary", async () => {
  await assert.rejects(
    () => convertDocumentForIngestion(fixture("unsupported.bin"), baseInput("unsupported.bin", ".bin")),
    (err: unknown) => err instanceof DocumentIngestError && err.code === "UNSUPPORTED_FORMAT",
  );
});

maybeTest("converts successfully with no network available (a bogus, unreachable proxy in the parent env is not forwarded to the conversion subprocess)", async () => {
  const restoreHttp = process.env.HTTPS_PROXY;
  const restoreHttps = process.env.HTTP_PROXY;
  process.env.HTTPS_PROXY = "http://127.0.0.1:1"; // unreachable, deliberately
  process.env.HTTP_PROXY = "http://127.0.0.1:1";
  try {
    const result = await convertDocumentForIngestion(fixture("sample.pdf"), baseInput("sample.pdf", ".pdf"));
    assert.match(result.markdown, /Equipment Specification Report/);
  } finally {
    if (restoreHttp === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = restoreHttp;
    if (restoreHttps === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = restoreHttps;
  }
});

test("a plain TXT file round-trips through the pipeline when routed through it directly", async () => {
  if (!available) {
    return;
  }
  const result = await convertDocumentForIngestion(fixture("sample.txt"), baseInput("sample.txt", ".txt"));
  assert.match(result.markdown, /plain text file for ingestion tests/);
});

test("temp workspace copy scenario: conversion works on a file staged outside the repo (workspace isolation simulation)", async () => {
  if (!available) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-ingest-test-"));
  try {
    const staged = path.join(tmpDir, "staged.pdf");
    fs.copyFileSync(fixture("sample.pdf"), staged);
    const result = await convertDocumentForIngestion(staged, baseInput("staged.pdf", ".pdf"));
    assert.match(result.markdown, /Equipment Specification Report/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
