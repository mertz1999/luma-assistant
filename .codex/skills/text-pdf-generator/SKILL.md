---
name: text-pdf-generator
description: Generate simple PDF files from user-provided plain text by using the bundled Python helper script in this skill.
---

# Text PDF Generator

Use this skill when the user asks to create a PDF from input text.

## Required Workflow

1. Use the bundled script at `scripts/text_to_pdf.py`.
2. Do not write a separate PDF generator or use external PDF libraries for the normal path.
3. Put generated PDFs in the current workspace unless the user specifies another output path.
4. After generation, report the output path and confirm the file exists.

## Script Usage

Generate from inline text:

```bash
python3 .codex/skills/text-pdf-generator/scripts/text_to_pdf.py \
  --text "Text to place in the PDF" \
  --output output.pdf \
  --title "Document title"
```

Generate from a text file:

```bash
python3 .codex/skills/text-pdf-generator/scripts/text_to_pdf.py \
  --input input.txt \
  --output output.pdf
```

The script writes a basic PDF using built-in Python only.
