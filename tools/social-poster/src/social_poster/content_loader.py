# tools/social-poster/src/social_poster/content_loader.py
from __future__ import annotations

import json
import re
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml
from social_lib.credentials import site_root


@dataclass
class Article:
    slug: str
    title: str
    url: str
    summary: str
    tags: list[str] = field(default_factory=list)
    image_url: Optional[str] = None
    published_at: str = ""


def _parse_frontmatter(text: str) -> dict:
    match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return {}
    try:
        return yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        return {}


def _collect_md_files(root: Path) -> list[Path]:
    """Search common Astro content layout variants, returning first non-empty result."""
    patterns = [
        "src/content/**/*.md",
        "src/content/**/*.mdx",
        "site/src/content/**/*.md",
        "site/src/content/**/*.mdx",
        "content/**/*.md",
    ]
    for pattern in patterns:
        files = [p for p in root.glob(pattern) if p.is_file()]
        if files:
            return files
    warnings.warn(
        f"No content files found for {root.name} — check glob patterns or add content.json",
        stacklevel=2,
    )
    return []


def _article_from_frontmatter(fm: dict, slug: str, domain: str, content_subdir: str = "articles") -> Optional[Article]:
    if not fm.get("title"):
        return None

    # Normalise date field — sites use pubDate, published, date, publishedDate
    pub_date = str(
        fm.get("pubDate")
        or fm.get("published")
        or fm.get("date")
        or fm.get("publishedDate")
        or ""
    )

    # Normalise tags field — sites use tags or keywords
    raw_tags = fm.get("tags") or fm.get("keywords") or []
    tags = [str(t) for t in raw_tags]

    # Normalise image field
    image_url: Optional[str] = fm.get("image") or fm.get("heroImage") or None

    # Build canonical URL — infer subdir from the file path context
    url = f"https://{domain}/{content_subdir}/{slug}"

    return Article(
        slug=slug,
        title=str(fm["title"]),
        url=url,
        summary=str(fm.get("description") or fm.get("excerpt") or "")[:280],
        tags=tags,
        image_url=image_url,
        published_at=pub_date,
    )


def _load_from_markdown(root: Path, domain: str, limit: int) -> list[Article]:
    md_files = _collect_md_files(root)
    articles: list[Article] = []

    for path in md_files:
        fm = _parse_frontmatter(path.read_text(encoding="utf-8"))
        slug = path.stem
        # Derive the content sub-collection from the parent directory name
        # e.g. site/src/content/articles/ -> "articles"
        content_subdir = path.parent.name
        article = _article_from_frontmatter(fm, slug, domain, content_subdir)
        if article:
            articles.append(article)

    articles.sort(key=lambda a: a.published_at, reverse=True)
    return articles[:limit]


def _load_from_content_json(root: Path, domain: str, limit: int) -> list[Article]:
    content_json = root / "content.json"
    if not content_json.exists():
        return []

    raw = json.loads(content_json.read_text(encoding="utf-8"))
    # Support both a top-level list and {"articles": [...]}
    items: list[dict] = raw if isinstance(raw, list) else raw.get("articles", [])

    articles: list[Article] = []
    for item in items:
        slug = item.get("slug") or ""
        title = item.get("title") or ""
        if not title:
            continue
        articles.append(Article(
            slug=slug,
            title=title,
            url=item.get("url") or f"https://{domain}/articles/{slug}",
            summary=str(item.get("description") or item.get("summary") or "")[:280],
            tags=[str(t) for t in (item.get("tags") or item.get("keywords") or [])],
            image_url=item.get("image") or item.get("heroImage"),
            published_at=str(item.get("pubDate") or item.get("published") or item.get("date") or ""),
        ))

    articles.sort(key=lambda a: a.published_at, reverse=True)
    return articles[:limit]


def load_latest_articles(domain: str, limit: int = 10) -> list[Article]:
    """Return up to *limit* articles for *domain*, newest first.

    Reads from:
      1. Markdown frontmatter under sites/<domain>/src/content/**/ (or site/src/content/**)
      2. sites/<domain>/content.json (fallback)
    """
    root = site_root(domain)

    articles = _load_from_markdown(root, domain, limit)
    if not articles:
        articles = _load_from_content_json(root, domain, limit)

    return articles
