#!/usr/bin/env python3
"""Generate a simple PDF from plain text using only the Python standard library."""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import textwrap
from pathlib import Path


PAGE_WIDTH = 612
PAGE_HEIGHT = 792
MARGIN = 72
FONT_SIZE = 11
LINE_HEIGHT = 15
MAX_CHARS_PER_LINE = 88
LINES_PER_PAGE = int((PAGE_HEIGHT - (MARGIN * 2)) / LINE_HEIGHT)


def _pdf_string(value: str) -> str:
    safe = value.encode("latin-1", "replace").decode("latin-1")
    return safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").replace("\r", "")


def _wrap_text(text: str) -> list[str]:
    lines: list[str] = []
    for raw_line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not raw_line.strip():
            lines.append("")
            continue
        wrapped = textwrap.wrap(
            raw_line,
            width=MAX_CHARS_PER_LINE,
            replace_whitespace=False,
            drop_whitespace=False,
        )
        lines.extend(wrapped or [""])
    return lines or [""]


def _paginate(lines: list[str]) -> list[list[str]]:
    pages = [lines[index : index + LINES_PER_PAGE] for index in range(0, len(lines), LINES_PER_PAGE)]
    return pages or [[""]]


def _page_stream(lines: list[str]) -> bytes:
    commands = [
        "BT",
        f"/F1 {FONT_SIZE} Tf",
        f"{LINE_HEIGHT} TL",
        f"{MARGIN} {PAGE_HEIGHT - MARGIN} Td",
    ]
    for index, line in enumerate(lines):
        if index > 0:
            commands.append("T*")
        commands.append(f"({_pdf_string(line)}) Tj")
    commands.append("ET")
    return ("\n".join(commands) + "\n").encode("latin-1", "replace")


def build_pdf_bytes(text: str, title: str = "Generated PDF") -> bytes:
    pages = _paginate(_wrap_text(text))
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    page_ids: list[int] = []
    for page_lines in pages:
        page_id = len(objects) + 1
        content_id = page_id + 1
        page_ids.append(page_id)
        stream = _page_stream(page_lines)
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
                f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
            ).encode("ascii")
        )
        objects.append(b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"endstream")

    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects[1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode("ascii")

    created = _dt.datetime.now(_dt.UTC).strftime("D:%Y%m%d%H%M%SZ")
    objects.append(
        (
            f"<< /Title ({_pdf_string(title)}) /Creator (text-pdf-generator skill) "
            f"/CreationDate ({created}) >>"
        ).encode("latin-1", "replace")
    )

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")

    xref_start = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {len(objects)} 0 R >>\n"
            f"startxref\n{xref_start}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def text_to_pdf(text: str, output_path: str | os.PathLike[str], title: str = "Generated PDF") -> Path:
    output = Path(output_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(build_pdf_bytes(text, title=title))
    return output


def _read_text(args: argparse.Namespace) -> str:
    if args.input:
        return Path(args.input).read_text(encoding="utf-8")
    if args.text is not None:
        return args.text
    raise SystemExit("Provide --text or --input.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a simple PDF from plain text.")
    parser.add_argument("--text", help="Text content to write into the PDF.")
    parser.add_argument("--input", help="Path to a UTF-8 text file to convert.")
    parser.add_argument("--output", required=True, help="PDF output path.")
    parser.add_argument("--title", default="Generated PDF", help="PDF metadata title.")
    args = parser.parse_args()

    output = text_to_pdf(_read_text(args), args.output, title=args.title)
    print(output)


if __name__ == "__main__":
    main()
