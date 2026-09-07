"""Local MarkItDown conversion wrapper for Luma's ingestion adapter.

Invoked as a subprocess by apps/server/src/ingestion/markitdown-adapter.ts.
Reads exactly one file path from argv[1], converts it with MarkItDown, and
writes a single JSON object to stdout -- nothing else goes to stdout, so the
Node side can parse it directly.

Local-only by construction: MarkItDown() below is never given an
llm_client/mlm_client, so it never calls any LLM/OCR API (OpenAI, Azure, or
otherwise) and plugin discovery is explicitly disabled. No network access is
attempted at all during conversion.
"""

import json
import sys
import traceback

from markitdown import MarkItDown
from markitdown._exceptions import (
    FileConversionException,
    MissingDependencyException,
    UnsupportedFormatException,
)


def classify_error(exc: Exception) -> str:
    if isinstance(exc, MissingDependencyException):
        return "DEPENDENCY_MISSING"
    if isinstance(exc, UnsupportedFormatException):
        return "UNSUPPORTED_FORMAT"
    if isinstance(exc, FileConversionException):
        text = str(exc).lower()
        if "password" in text or "encrypt" in text or "decrypt" in text:
            return "PASSWORD_PROTECTED"
        return "CORRUPT_DOCUMENT"
    text = str(exc).lower()
    if "password" in text or "encrypt" in text or "decrypt" in text:
        return "PASSWORD_PROTECTED"
    return "CORRUPT_DOCUMENT"


def main() -> int:
    if len(sys.argv) < 2:
        json.dump({"ok": False, "error_code": "CORRUPT_DOCUMENT", "message": "No input path provided"}, sys.stdout)
        return 1

    path = sys.argv[1]

    try:
        md = MarkItDown(enable_builtins=True, enable_plugins=False)
        result = md.convert(path)
        json.dump(
            {
                "ok": True,
                "markdown": result.markdown,
                "title": result.title,
            },
            sys.stdout,
        )
        return 0
    except Exception as exc:  # noqa: BLE001 - deliberately broad: every failure must produce structured JSON, never a raw traceback on stdout
        json.dump(
            {
                "ok": False,
                "error_code": classify_error(exc),
                "message": str(exc)[:2000],
                "exception_type": type(exc).__name__,
            },
            sys.stdout,
        )
        # Full traceback goes to stderr only, for local debugging -- never stdout,
        # which must stay pure JSON for the Node adapter to parse.
        traceback.print_exc(file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
