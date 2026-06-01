---
name: website-md-exporter
description: Use when a user wants to crawl a website and export the homepage plus up to 20 same-site sublinks into one Markdown file. Provides a Python script and requires creating a local .venv in this skill directory before running.
---

# Website Markdown Exporter

Use this skill to generate one `.md` file from a website.

## What It Does

The bundled Python script:

- Fetches the start URL.
- Discovers same-site links from the homepage.
- Crawls the homepage plus up to 20 same-site sublinks by default.
- Converts each page's readable HTML content into Markdown.
- Writes all pages into one Markdown file with source URLs and page headings.

## Setup

Before running the script, create a Python virtual environment inside this skill directory:

```bash
cd skills/website-md-exporter
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Keep the `.venv` local to this skill directory. Do not commit `.venv`.

## Usage

Run from the skill directory:

```bash
. .venv/bin/activate
python scripts/website_to_markdown.py "https://example.com/" --output example-site.md --max-sublinks 20
```

Useful options:

- `--output PATH`: output Markdown file. Defaults to a slug based on the domain.
- `--max-sublinks N`: maximum same-site sublinks to include, excluding the homepage. Defaults to `20`.
- `--timeout N`: request timeout in seconds. Defaults to `15`.
- `--delay N`: polite delay between requests in seconds. Defaults to `0.2`.

## Rules

- Crawl only public pages that can be fetched without credentials.
- Stay on the same host as the starting URL.
- Do not include binary files, downloads, anchors, `mailto:`, `tel:`, or JavaScript links.
- If a page fails, include it in the crawl summary but do not stop the entire export.
- If the user gives a larger number, cap sublinks at 20 unless they explicitly ask to change the script.
- If the output would contain sensitive or private data, stop and ask before writing it.

## Validation

After running:

- Confirm the output `.md` file exists.
- Report how many pages were included and how many failed.
- Show the output path.
