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


def _load_json_collection(
    root: Path,
    domain: str,
    limit: int,
    *,
    glob: str,
    url_template: str,
    fields: dict[str, list[str]],
) -> list[Article]:
    """Generic loader for sites whose postable content is one JSON file per item
    (e.g. a product/curio catalog), rather than markdown articles.

    *fields* maps Article attribute -> ordered list of candidate JSON keys to
    check, first match wins (same "sites use different field names" tolerance
    as the markdown/content.json loaders above).
    """
    files = [p for p in root.glob(glob) if p.is_file()]
    if not files:
        return []

    def _pick(item: dict, keys: list[str]):
        for key in keys:
            if key in item and item[key] not in (None, ""):
                return item[key]
        return None

    articles: list[Article] = []
    for path in files:
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(item, dict):
            continue

        title = _pick(item, fields.get("title", ["title", "name"]))
        if not title:
            continue
        slug = _pick(item, fields.get("slug", ["slug"])) or path.stem

        image = _pick(item, fields.get("image", ["image", "heroImage"]))
        if not image:
            images = item.get("images")
            if isinstance(images, list) and images and isinstance(images[0], dict):
                image = images[0].get("src")

        articles.append(Article(
            slug=str(slug),
            title=str(title),
            url=url_template.format(domain=domain, slug=slug),
            summary=str(_pick(item, fields.get("summary", ["description", "summary"])) or "")[:280],
            tags=[str(t) for t in (_pick(item, fields.get("tags", ["tags", "keywords"])) or [])],
            image_url=image,
            published_at=str(_pick(item, fields.get("date", ["published", "pubDate", "date"])) or ""),
        ))

    articles.sort(key=lambda a: a.published_at, reverse=True)
    return articles[:limit]


_TS_STRING_RE = "(['\"])((?:\\\\.|(?!\\1).)*)\\1"


def _ts_field(body: str, key: str) -> Optional[str]:
    match = re.search(rf"\b{re.escape(key)}\s*:\s*{_TS_STRING_RE}", body, re.DOTALL)
    return match.group(2) if match else None


def _load_ts_record_array(
    root: Path,
    domain: str,
    limit: int,
    *,
    ts_path: str,
    array_name: str,
    url_template: str,
    image_template: Optional[str] = None,
    summary_field: str = "blurb",
    skip_if: Optional[dict] = None,
) -> list[Article]:
    """Generic-ish loader for sites whose catalog is a TS object-literal array
    export (e.g. `export const SKUS: Sku[] = [ {...}, {...} ]`) rather than
    markdown or JSON files.

    Field extraction is done with light regex over quoted string literals —
    good enough for hand-authored registries like `affiliate.ts`, not a real
    TS/JS parser. Records have no publish date, so recency is approximated by
    array position (later entries = more recently added).
    """
    ts_file = root / ts_path
    if not ts_file.exists():
        return []

    text = ts_file.read_text(encoding="utf-8")
    array_match = re.search(rf"export const {re.escape(array_name)}[^=]*=\s*\[(.*)\n\];", text, re.DOTALL)
    if not array_match:
        return []
    array_body = array_match.group(1)

    # Split into top-level object literals: blocks opened by "  {" and closed by "  },".
    blocks = re.findall(r"^  \{\n(.*?)\n  \},?$", array_body, re.DOTALL | re.MULTILINE)

    articles: list[Article] = []
    for idx, body in enumerate(blocks):
        skip = False
        for key, value in (skip_if or {}).items():
            if re.search(rf"\b{re.escape(key)}\s*:\s*{value}\b", body):
                skip = True
        if skip:
            continue

        slug = _ts_field(body, "id") or _ts_field(body, "slug")
        title = _ts_field(body, "name") or _ts_field(body, "title")
        if not slug or not title:
            continue

        image = _ts_field(body, "image")
        image_url = image_template.format(domain=domain, image=image) if (image_template and image) else None

        articles.append(Article(
            slug=slug,
            title=title,
            url=url_template.format(domain=domain, slug=slug),
            summary=(_ts_field(body, summary_field) or "")[:280],
            tags=[],
            image_url=image_url,
            # No real publish date on these records — approximate recency with
            # array position so the sort below (and downstream behavior) matches
            # the date-sorted loaders.
            published_at=f"{idx:06d}",
        ))

    return articles[-limit:][::-1]


# Per-site content-source config for sites whose postable content doesn't live
# in markdown articles or content.json. Add an entry here (not a new branch in
# load_latest_articles) for the next nonstandard site.
SITE_CONTENT_SOURCES: dict[str, dict] = {
    "weirdgirlstore.com": {
        "loader": _load_json_collection,
        "kwargs": dict(
            glob="site/src/content/curios/*.json",
            url_template="https://{domain}/finds/{slug}/",
            fields={
                "title": ["name", "title"],
                "slug": ["slug"],
                "summary": ["tagline", "metaDescription", "verdict"],
                "date": ["published", "pubDate", "date"],
                "tags": ["tags", "keywords"],
            },
        ),
    },
    "ultrarough.com": {
        "loader": _load_ts_record_array,
        "kwargs": dict(
            ts_path="site/src/lib/affiliate.ts",
            array_name="SKUS",
            url_template="https://{domain}/reviews/{slug}/",
            image_template="https://{domain}/gallery/{image}-1200.webp",
            summary_field="blurb",
            skip_if={"campaignOnly": "true"},
        ),
    },
    "xxxtea.com": {
        # Same shape as ultrarough.com: no markdown/content.json collection at
        # all — the entire catalog is the affiliate.ts SKU registry, one
        # review page per SKU (site/src/pages/reviews/[id].astro).
        "loader": _load_ts_record_array,
        "kwargs": dict(
            ts_path="site/src/lib/affiliate.ts",
            array_name="SKUS",
            url_template="https://{domain}/reviews/{slug}/",
            image_template="https://{domain}/gallery/{image}-1200.webp",
            summary_field="blurb",
        ),
    },
}


def load_latest_articles(domain: str, limit: int = 10) -> list[Article]:
    """Return up to *limit* articles for *domain*, newest first.

    Reads from (in order):
      1. A per-site config in SITE_CONTENT_SOURCES, for sites whose postable
         content isn't a markdown/content.json article shape (product catalogs,
         review registries, etc.)
      2. Markdown frontmatter under sites/<domain>/src/content/**/ (or
         site/src/content/**)
      3. sites/<domain>/content.json (fallback)
    """
    root = site_root(domain)

    source = SITE_CONTENT_SOURCES.get(domain)
    if source:
        articles = source["loader"](root, domain, limit, **source["kwargs"])
        if articles:
            return articles

    articles = _load_from_markdown(root, domain, limit)
    if not articles:
        articles = _load_from_content_json(root, domain, limit)

    return articles
