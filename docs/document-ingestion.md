# Document ingestion (MarkItDown adapter)

Luma's attachment upload path (`POST /api/attachments`) now accepts a fourth
attachment kind, `"document"`, for formats it previously rejected outright:
PDF, DOCX, PPTX, XLSX/XLS, ZIP, EPUB. These are converted to Markdown locally
via [Microsoft MarkItDown](https://github.com/microsoft/markitdown) before
the attachment reference is returned, so a spawned Codex/Claude run gets
clean Markdown to read instead of having to parse a binary format itself.

Everything else about the attachment pipeline (workspace-scoped storage
under `.agentic/attachments/`, path sanitization, size limits, prompt
injection into the run) is unchanged from the existing `"image"`/`"text"`
kinds -- this is an addition, not a rewrite.

## Where the code lives

```
apps/server/src/ingestion/
  markitdown-adapter.ts   only file that knows MarkItDown/Python specifics
  zip-safe-scan.ts        pre-conversion ZIP safety gate (traversal/bomb/depth)
  document-ingest.ts      orchestration: validate -> convert -> normalize -> hash
  markdown-normalize.ts   deterministic whitespace/line-ending cleanup only
  sectionize-markdown.ts  heading/slide-boundary splitter (for future retrieval)
  limits.ts               env-driven resource limits
  errors.ts               structured DocumentRejectCode / warning codes
  cli.ts                  `npm run ingest -w @luma/server -- <path>`

tools/markitdown/
  requirements.txt        pinned markitdown version + extras, with rationale
  convert.py              subprocess wrapper: one file in, one JSON object out
  .venv/                  project-local Python venv (gitignored; see setup)
```

`apps/server/src/index.ts` only calls `convertDocumentForIngestion()` from
`document-ingest.ts` and never imports anything MarkItDown-specific.

## Setup

```bash
cd tools/markitdown
python -m venv .venv
./.venv/Scripts/pip install -r requirements.txt   # Windows
# ./.venv/bin/pip install -r requirements.txt     # macOS/Linux
```

If `tools/markitdown/.venv` doesn't exist, document uploads fail closed with
`DEPENDENCY_MISSING` and a message naming the missing venv -- image/text
attachments are unaffected either way.

## Local-only guarantee

`convert.py` constructs `MarkItDown(enable_plugins=False)` with no
`llm_client`/`mlm_client`, so it never calls OpenAI, Azure, or any other
inference API. The subprocess runs with Luma's existing safe base
environment (`pickSafeBaseEnv()`) -- it never receives Luma's own secrets,
and no cloud API key would help it anyway since it never attempts an
outbound call for any of the format converters this integration enables
(verified against MarkItDown 0.1.7's own source: only `_bing_serp_converter`
and `_youtube_converter`, neither reachable from a local-path `.convert()`
call, touch a URL at all).

Deliberately-excluded MarkItDown extras and why are documented inline in
`tools/markitdown/requirements.txt` (`az-doc-intel`, `az-content-understanding`,
`audio-transcription`, `youtube-transcription`, `all`).

## Security controls

- **ZIP**: `zip-safe-scan.ts` reads only the central directory (no
  decompression) before MarkItDown ever sees the file, and rejects: any
  entry with an absolute or `..`-escaping path, any nested archive member
  (`.zip`/`.jar`/`.7z`/...), more files than `DOCUMENT_MAX_ARCHIVE_FILES`,
  more uncompressed bytes than `DOCUMENT_MAX_ARCHIVE_MB`, or deeper folder
  nesting than `DOCUMENT_MAX_ARCHIVE_DEPTH`.
- **Timeout**: every conversion is bounded by
  `DOCUMENT_CONVERSION_TIMEOUT_SECONDS`; on expiry the whole process tree is
  killed (SIGTERM then SIGKILL), same helper `killProcessTree()` the
  browser-act adapter uses.
- **Size**: `DOCUMENT_MAX_FILE_MB` is enforced independently of the
  attachment endpoint's general `ATTACHMENT_MAX_BYTES` cap.
- **No truncation**: if converted Markdown exceeds `DOCUMENT_MAX_MARKDOWN_CHARS`
  the full content is still written and returned; a `MARKDOWN_EXCEEDS_LIMIT`
  warning is attached instead of silently cutting content.
- **On rejection**: the raw uploaded file is deleted and a
  `document.rejected` audit event is recorded; nothing partial is left in
  the workspace.

## Known limitations

- MarkItDown does not report PDF page count or a structured OCR signal.
  `document-ingest.ts` flags `NO_EXTRACTABLE_TEXT` (+`OCR_REQUIRED` for PDFs)
  using a length-based heuristic, not a guarantee -- a very short but
  genuinely text-native PDF could be misflagged, and a scanned PDF with a
  thin OCR text layer already baked in could be missed. No OCR backend is
  wired in; `OCR_REQUIRED` is a signal for a future local OCR extension
  point, not an automatic fallback.
- Sheet names and slide counts in `DocumentMetadata` are parsed out of
  MarkItDown's own Markdown markers (`## <name>` headings for XLSX,
  `<!-- Slide number: N -->` for PPTX) as a best-effort courtesy, not read
  from structured library output -- MarkItDown's `DocumentConverterResult`
  exposes only `markdown` and `title`.
- `sectionize-markdown.ts` produces heading/slide-bounded sections for a
  future retrieval layer to consume, but Luma has no vector index or
  chunk-retrieval system today -- reasoning currently happens by the spawned
  Codex/Claude CLI process reading the attached Markdown file directly.
