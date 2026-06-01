#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify as html_to_markdown


USER_AGENT = "LumaWebsiteMarkdownExporter/1.0 (+https://github.com/mertz1999/luma-assistant)"
SKIP_EXTENSIONS = {
    ".7z",
    ".avi",
    ".css",
    ".csv",
    ".doc",
    ".docx",
    ".gif",
    ".gz",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".mov",
    ".mp3",
    ".mp4",
    ".pdf",
    ".png",
    ".ppt",
    ".pptx",
    ".rar",
    ".svg",
    ".tar",
    ".webm",
    ".webp",
    ".xls",
    ".xlsx",
    ".xml",
    ".zip",
}


@dataclass
class PageResult:
    url: str
    title: str
    markdown: str


@dataclass
class CrawlFailure:
    url: str
    error: str


def normalize_url(url: str) -> str:
    url, _fragment = urldefrag(url.strip())
    parsed = urlparse(url)
    scheme = parsed.scheme.lower() or "https"
    host = parsed.netloc.lower()
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((scheme, host, path, "", parsed.query, ""))


def is_crawlable_url(url: str, start_host: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    if parsed.netloc.lower() != start_host:
        return False
    lower_path = parsed.path.lower()
    return not any(lower_path.endswith(ext) for ext in SKIP_EXTENSIONS)


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip().lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "website"


def clean_soup(soup: BeautifulSoup) -> BeautifulSoup:
    for selector in ["script", "style", "noscript", "svg", "canvas", "iframe", "form"]:
        for node in soup.select(selector):
            node.decompose()
    return soup


def best_content_node(soup: BeautifulSoup) -> BeautifulSoup:
    for selector in ["main", "article", "[role='main']", ".content", "#content"]:
        node = soup.select_one(selector)
        if node and node.get_text(strip=True):
            return node
    return soup.body or soup


def page_title(soup: BeautifulSoup, fallback_url: str) -> str:
    h1 = soup.find("h1")
    if h1:
        title = h1.get_text(" ", strip=True)
        if title:
            return title
    if soup.title:
        title = soup.title.get_text(" ", strip=True)
        if title:
            return title
    return fallback_url


def extract_links(soup: BeautifulSoup, base_url: str, start_host: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href", "")).strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        normalized = normalize_url(urljoin(base_url, href))
        if not is_crawlable_url(normalized, start_host):
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        links.append(normalized)
    return links


def fetch_page(session: requests.Session, url: str, timeout: float) -> tuple[BeautifulSoup, str]:
    response = session.get(url, timeout=timeout)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "").lower()
    if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
        raise ValueError(f"not an HTML page: {content_type or 'unknown content-type'}")
    soup = BeautifulSoup(response.text, "html.parser")
    return clean_soup(soup), response.url


def markdown_for_page(soup: BeautifulSoup, url: str) -> PageResult:
    title = page_title(soup, url)
    content = best_content_node(soup)
    markdown = html_to_markdown(str(content), heading_style="ATX")
    markdown = re.sub(r"\n{3,}", "\n\n", markdown).strip()
    return PageResult(url=url, title=title, markdown=markdown)


def crawl(start_url: str, max_sublinks: int, timeout: float, delay: float) -> tuple[list[PageResult], list[CrawlFailure]]:
    normalized_start = normalize_url(start_url)
    start_host = urlparse(normalized_start).netloc.lower()
    if not start_host:
        raise ValueError("URL must include a host")

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    queue: deque[str] = deque([normalized_start])
    queued: set[str] = {normalized_start}
    visited: set[str] = set()
    pages: list[PageResult] = []
    failures: list[CrawlFailure] = []
    max_pages = max_sublinks + 1

    while queue and len(pages) < max_pages:
        url = queue.popleft()
        if url in visited:
            continue
        visited.add(url)

        try:
            soup, final_url = fetch_page(session, url, timeout)
            final_url = normalize_url(final_url)
            pages.append(markdown_for_page(soup, final_url))

            if len(queued) < max_pages:
                for link in extract_links(soup, final_url, start_host):
                    if link in queued or link in visited:
                        continue
                    queued.add(link)
                    queue.append(link)
                    if len(queued) >= max_pages:
                        break
        except Exception as exc:  # noqa: BLE001 - failures should be reported and crawl should continue.
            failures.append(CrawlFailure(url=url, error=str(exc)))

        if queue and delay > 0:
            time.sleep(delay)

    return pages, failures


def render_markdown(start_url: str, pages: Iterable[PageResult], failures: Iterable[CrawlFailure]) -> str:
    page_list = list(pages)
    failure_list = list(failures)
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    lines = [
        f"# Website Export: {start_url}",
        "",
        f"- Generated: {generated_at}",
        f"- Pages included: {len(page_list)}",
        f"- Failed pages: {len(failure_list)}",
        "",
        "## Table of Contents",
        "",
    ]
    for index, page in enumerate(page_list, start=1):
        lines.append(f"{index}. [{page.title}](#page-{index})")

    if failure_list:
        lines.extend(["", "## Failed Pages", ""])
        for failure in failure_list:
            lines.append(f"- `{failure.url}`: {failure.error}")

    for index, page in enumerate(page_list, start=1):
        lines.extend([
            "",
            "---",
            "",
            f'<a id="page-{index}"></a>',
            "",
            f"## {page.title}",
            "",
            f"Source: {page.url}",
            "",
            page.markdown or "_No readable text extracted._",
        ])

    return "\n".join(lines).strip() + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a website homepage and same-site sublinks into one Markdown file.")
    parser.add_argument("url", help="Starting website URL")
    parser.add_argument("--output", "-o", help="Output Markdown path")
    parser.add_argument("--max-sublinks", type=int, default=20, help="Maximum same-site sublinks to include, excluding homepage")
    parser.add_argument("--timeout", type=float, default=15, help="Request timeout in seconds")
    parser.add_argument("--delay", type=float, default=0.2, help="Delay between requests in seconds")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    max_sublinks = max(0, min(args.max_sublinks, 20))
    start_url = normalize_url(args.url)
    output = Path(args.output or f"{slugify(urlparse(start_url).netloc)}.md")

    try:
        pages, failures = crawl(start_url, max_sublinks=max_sublinks, timeout=args.timeout, delay=args.delay)
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_markdown(start_url, pages, failures), encoding="utf-8")

    print(f"wrote: {output}")
    print(f"pages included: {len(pages)}")
    print(f"failed pages: {len(failures)}")
    return 0 if pages else 2


if __name__ == "__main__":
    raise SystemExit(main())
