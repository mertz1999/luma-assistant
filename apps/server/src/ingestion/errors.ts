/**
 * Structured error/warning codes for the document-ingestion pipeline.
 *
 * Codes are the stable, user/audit-facing contract; message strings are for
 * humans and may change. Split into REJECT codes (conversion did not
 * produce usable output; the upload is refused) and WARNING codes (the
 * attachment is still created, but the caller/agent should know about a
 * limitation).
 */

export const DOCUMENT_REJECT_CODES = [
  "UNSUPPORTED_FORMAT",
  "CORRUPT_DOCUMENT",
  "DEPENDENCY_MISSING",
  "PASSWORD_PROTECTED",
  "CONVERSION_TIMEOUT",
  "FILE_TOO_LARGE",
  "ARCHIVE_TOO_LARGE",
  "ARCHIVE_TRAVERSAL_BLOCKED",
  "ARCHIVE_TOO_MANY_FILES",
  "ARCHIVE_TOO_DEEP",
  "ARCHIVE_NESTED_ARCHIVE_BLOCKED",
] as const;
export type DocumentRejectCode = (typeof DOCUMENT_REJECT_CODES)[number];

export const DOCUMENT_WARNING_CODES = [
  "NO_EXTRACTABLE_TEXT",
  "OCR_REQUIRED",
  "MARKDOWN_EXCEEDS_LIMIT",
] as const;
export type DocumentWarningCode = (typeof DOCUMENT_WARNING_CODES)[number];

export class DocumentIngestError extends Error {
  readonly code: DocumentRejectCode;
  readonly detail?: string;

  constructor(code: DocumentRejectCode, message: string, detail?: string) {
    super(message);
    this.name = "DocumentIngestError";
    this.code = code;
    this.detail = detail;
  }
}

const USER_MESSAGES: Record<DocumentRejectCode, string> = {
  UNSUPPORTED_FORMAT: "This file format isn't supported for document conversion.",
  CORRUPT_DOCUMENT: "This file appears to be corrupted or unreadable.",
  DEPENDENCY_MISSING: "A required local conversion dependency is missing on this host.",
  PASSWORD_PROTECTED: "This document is password-protected and can't be converted.",
  CONVERSION_TIMEOUT: "Conversion took too long and was stopped.",
  FILE_TOO_LARGE: "This file exceeds the maximum allowed size for document ingestion.",
  ARCHIVE_TOO_LARGE: "This archive's uncompressed contents exceed the maximum allowed size.",
  ARCHIVE_TRAVERSAL_BLOCKED: "This archive contains an unsafe file path and was rejected.",
  ARCHIVE_TOO_MANY_FILES: "This archive contains too many files.",
  ARCHIVE_TOO_DEEP: "This archive's folder structure is nested too deeply.",
  ARCHIVE_NESTED_ARCHIVE_BLOCKED: "This archive contains a nested archive, which isn't allowed.",
};

export function userMessageForCode(code: DocumentRejectCode): string {
  return USER_MESSAGES[code];
}
