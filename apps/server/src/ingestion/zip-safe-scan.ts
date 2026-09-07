import yauzl from "yauzl";
import path from "node:path";
import type { DocumentIngestLimits } from "./limits.js";
import type { DocumentRejectCode } from "./errors.js";

/**
 * Safety gate that runs BEFORE a ZIP is ever handed to MarkItDown.
 *
 * MarkItDown's own ZipConverter (tools/markitdown/.venv/.../_zip_converter.py)
 * reads each member into an in-memory BytesIO via `zipObj.read(name)` -- it
 * never calls `extract()`/`extractall()` with the member's own name, so a
 * "../../etc/passwd"-style entry cannot make it write outside a directory.
 * That removes classic zip-slip as a *file-write* vector for this specific
 * converter, but does NOT bound:
 *   - decompression-bomb memory use (every member is fully decompressed into
 *     RAM, uncapped)
 *   - member count (unbounded loop)
 *   - recursive expansion (a .zip nested inside a .zip is itself a valid
 *     stream MarkItDown will recurse into via convert_stream, with no depth
 *     limit this integration can inject without patching the library)
 *
 * This module reads only the ZIP central directory (via yauzl, streaming,
 * no decompression) to enforce those bounds up front, and independently
 * rejects any traversal-shaped path as defense in depth even though the
 * downstream converter does not extract to disk -- "do not trust archive
 * paths" per the ingestion security requirements, not "trust this one
 * converter's current implementation forever."
 *
 * The extension-based nested-archive check below is NOT sufficient on its
 * own: MarkItDown resolves each ZIP member's converter by content-sniffing
 * (magika-backed guessing inside `_markitdown.py`'s `_convert`), not by
 * trusting the declared extension it was handed. Empirically verified
 * during this integration: a ZIP member named "sneaky.pdf" whose actual
 * bytes are a nested ZIP is still detected and recursively expanded by
 * MarkItDown's ZipConverter. A renamed nested archive (".zip" saved as
 * ".pdf", ".docx", etc.) would silently bypass a name-only check, defeating
 * the whole point of blocking nested archives. Every non-directory entry is
 * therefore also peeked for a ZIP local-file-header magic number
 * (`PK\x03\x04`/`PK\x05\x06`/`PK\x07\x08`) via a bounded partial read
 * (`readStream.destroy()` after 4 bytes -- never decompresses the rest of
 * the entry), regardless of its declared name.
 */

const NESTED_ARCHIVE_EXTENSIONS = new Set([".zip", ".jar", ".war", ".ear", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz"]);

const ZIP_LOCAL_HEADER_MAGICS: readonly Buffer[] = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // normal local file header
  Buffer.from([0x50, 0x4b, 0x05, 0x06]), // empty archive (End Of Central Directory, no entries)
  Buffer.from([0x50, 0x4b, 0x07, 0x08]), // spanned/streamed data descriptor variant
];

/**
 * Reads at most the first 4 bytes of an entry's DEcompressed content and
 * destroys the stream immediately after -- bounded work regardless of the
 * entry's true (possibly bomb-shaped) uncompressed size, per yauzl's own
 * documented zip-bomb defense (`readStream.destroy()` before the stream
 * finishes piping). A read/open error here is not itself a security
 * verdict -- it is left for the real conversion attempt to classify
 * (CORRUPT_DOCUMENT etc.); this function only ever answers "is this
 * specific entry ZIP-shaped," resolving `false` on any inconclusive outcome.
 */
function peekEntryIsZipShaped(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<boolean> {
  return new Promise((resolve) => {
    if (entry.uncompressedSize < 4) {
      resolve(false);
      return;
    }
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err || !readStream) {
        resolve(false);
        return;
      }

      let collected: Buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (matched: boolean) => {
        if (settled) return;
        settled = true;
        readStream.removeAllListeners("data");
        readStream.removeAllListeners("end");
        readStream.removeAllListeners("error");
        readStream.destroy();
        resolve(matched);
      };

      readStream.on("data", (chunk: Buffer) => {
        collected = collected.length > 0 ? Buffer.concat([collected, chunk]) : chunk;
        if (collected.length >= 4) {
          const head = collected.subarray(0, 4);
          finish(ZIP_LOCAL_HEADER_MAGICS.some((magic) => head.equals(magic)));
        }
      });
      readStream.on("end", () => finish(false));
      readStream.on("error", () => finish(false));
    });
  });
}

export interface ZipScanOk {
  ok: true;
  fileCount: number;
  totalUncompressedBytes: number;
  maxDepth: number;
}

export interface ZipScanFailure {
  ok: false;
  code: DocumentRejectCode;
  message: string;
}

export type ZipScanResult = ZipScanOk | ZipScanFailure;

function isTraversalUnsafe(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  const segments = normalized.split("/");
  return segments.some((segment) => segment === "..");
}

function pathDepth(entryName: string): number {
  const normalized = entryName.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").length - 1;
}

/**
 * yauzl itself refuses to hand out an entry whose name is an absolute path
 * or escapes via "..", surfacing that as a plain Error on the zipfile's
 * "error" event (message shapes: "absolute path: X" / "invalid relative
 * path: X"). Recognized here so it is reported as the specific
 * ARCHIVE_TRAVERSAL_BLOCKED code this module promises, rather than the
 * generic CORRUPT_DOCUMENT fallback.
 */
function isPathSafetyError(message: string): boolean {
  return /absolute path|relative path/i.test(message);
}

export function scanZipSafely(absolutePath: string, limits: DocumentIngestLimits): Promise<ZipScanResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ZipScanResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    yauzl.open(absolutePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        const message = openErr?.message || "Could not open archive.";
        const code: DocumentRejectCode = isPathSafetyError(message) ? "ARCHIVE_TRAVERSAL_BLOCKED" : "CORRUPT_DOCUMENT";
        settle({ ok: false, code, message });
        return;
      }

      let fileCount = 0;
      let totalUncompressedBytes = 0;
      let maxDepth = 0;

      const closeAndSettle = (result: ZipScanResult) => {
        settle(result);
        try {
          zipfile.close();
        } catch {
          // Already closed/errored -- not fatal for a read-only scan.
        }
      };

      zipfile.on("error", (err) => {
        const code: DocumentRejectCode = isPathSafetyError(err.message) ? "ARCHIVE_TRAVERSAL_BLOCKED" : "CORRUPT_DOCUMENT";
        closeAndSettle({ ok: false, code, message: err.message });
      });

      zipfile.on("entry", (entry) => {
        void (async () => {
          const isDirectory = /\/$/.test(entry.fileName);

          if (isTraversalUnsafe(entry.fileName)) {
            closeAndSettle({ ok: false, code: "ARCHIVE_TRAVERSAL_BLOCKED", message: `Unsafe archive path: ${entry.fileName}` });
            return;
          }

          if (!isDirectory) {
            fileCount += 1;
            totalUncompressedBytes += entry.uncompressedSize;
            maxDepth = Math.max(maxDepth, pathDepth(entry.fileName));

            const extension = path.extname(entry.fileName).toLowerCase();
            if (NESTED_ARCHIVE_EXTENSIONS.has(extension)) {
              closeAndSettle({ ok: false, code: "ARCHIVE_NESTED_ARCHIVE_BLOCKED", message: `Archive contains a nested archive member: ${entry.fileName}` });
              return;
            }

            if (fileCount > limits.maxArchiveFiles) {
              closeAndSettle({ ok: false, code: "ARCHIVE_TOO_MANY_FILES", message: `Archive contains more than ${limits.maxArchiveFiles} files.` });
              return;
            }
            if (totalUncompressedBytes > limits.maxArchiveExpandedBytes) {
              closeAndSettle({ ok: false, code: "ARCHIVE_TOO_LARGE", message: `Archive would expand beyond ${limits.maxArchiveExpandedBytes} bytes.` });
              return;
            }
            if (maxDepth > limits.maxArchiveDepth) {
              closeAndSettle({ ok: false, code: "ARCHIVE_TOO_DEEP", message: `Archive path nesting exceeds ${limits.maxArchiveDepth} levels: ${entry.fileName}` });
              return;
            }

            // Defeats a nested archive disguised with a non-archive extension
            // (see module doc comment) -- checked regardless of what the
            // extension-based check above already concluded.
            const zipShaped = await peekEntryIsZipShaped(zipfile, entry);
            if (settled) return; // scan may have been settled by another path while this peek was in flight
            if (zipShaped) {
              closeAndSettle({ ok: false, code: "ARCHIVE_NESTED_ARCHIVE_BLOCKED", message: `Archive contains a nested archive disguised as: ${entry.fileName}` });
              return;
            }
          }

          zipfile.readEntry();
        })();
      });

      zipfile.on("end", () => {
        closeAndSettle({ ok: true, fileCount, totalUncompressedBytes, maxDepth });
      });

      zipfile.readEntry();
    });
  });
}
