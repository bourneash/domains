"""Content ingestion — turn site content into postable source rows.

Order of preference:
  1. `sources:` in the site's hub.yaml (explicit globs + url template). Use this
     when a site's content lives somewhere unusual; it is the escape hatch that
     keeps site-specific knowledge in the site's own config file.
  2. `social_poster.content_loader`, if installed — it already encodes every
     odd fleet layout (TS catalogs, JSON curios, content.json). Reusing it
     means the hub inherits that work instead of forking it.
  3. A built-in markdown-frontmatter loader as the floor.

Ingestion is idempotent: a source is keyed (site, source_type, source_id) and
re-ingesting an existing article never resets its state or re-queues drafts.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml

from social_hub import db
from social_hub.config import SiteConfig, site_root

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)


def _parse_frontmatter(text: str) -> dict:
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}
    try:
        return yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        return {}


def _first(fm: dict, keys: list[str], default: Any = "") -> Any:
    for key in keys:
        value = fm.get(key)
        if value not in (None, "", []):
            return value
    return default


def _from_frontmatter(path: Path, domain: str, url_template: str) -> dict | None:
    fm = _parse_frontmatter(path.read_text(encoding="utf-8"))
    title = _first(fm, ["title"])
    if not title:
        return None
    slug = path.stem
    return {
        "source_id": slug,
        "title": str(title),
        "url": url_template.format(domain=domain, slug=slug, collection=path.parent.name),
        "summary": str(_first(fm, ["description", "excerpt", "summary"]))[:600],
        "tags": [str(t) for t in (_first(fm, ["keywords", "tags"], []) or [])],
        "image_url": _first(fm, ["image", "heroImage", "imageCard"], None),
        "published_at": str(_first(fm, ["published", "pubDate", "date", "publishedDate"])),
    }


def _builtin_scan(domain: str, cfg: SiteConfig | None) -> list[dict]:
    root = site_root(domain)
    sources_cfg = (cfg.get("sources") if cfg else None) or {}
    globs = sources_cfg.get("globs") or [
        "site/src/content/articles/*.md",
        "site/src/content/articles/*.mdx",
        "src/content/articles/*.md",
    ]
    url_template = sources_cfg.get("url_template") or "https://{domain}/{collection}/{slug}/"

    found: list[dict] = []
    for pattern in globs:
        for path in sorted(root.glob(pattern)):
            if not path.is_file():
                continue
            item = _from_frontmatter(path, domain, url_template)
            if item:
                found.append(item)
    return found


def _via_social_poster(domain: str) -> list[dict]:
    try:
        from social_poster.content_loader import load_latest_articles
    except Exception:
        return []
    try:
        articles = load_latest_articles(domain, limit=25)
    except Exception:
        return []
    return [
        {
            "source_id": a.slug,
            "title": a.title,
            "url": a.url,
            "summary": a.summary,
            "tags": list(a.tags),
            "image_url": a.image_url,
            "published_at": a.published_at,
        }
        for a in articles
    ]


def discover(domain: str, cfg: SiteConfig | None = None) -> list[dict]:
    """Candidate source items for *domain*, newest first, unfiltered."""
    sources_cfg = (cfg.get("sources") if cfg else None) or {}
    items: list[dict] = []
    if sources_cfg.get("globs"):
        items = _builtin_scan(domain, cfg)
    if not items:
        items = _via_social_poster(domain)
    if not items:
        items = _builtin_scan(domain, cfg)
    items.sort(key=lambda i: i.get("published_at") or "", reverse=True)
    return items


def _is_fresh(published_at: str, max_age_hours: int) -> bool:
    if not published_at:
        return True  # undated content (catalogs) — age can't disqualify it
    try:
        stamp = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp >= datetime.now(timezone.utc) - timedelta(hours=max_age_hours)


def ingest(domain: str, cfg: SiteConfig, limit: int = 25) -> dict:
    """Record new source items for *domain*.

    Items older than `max_source_age_hours` are recorded as `skipped` rather
    than `new`: the hub should never wake up after an outage and blast a week
    of stale headlines, but it should still remember it saw them.
    """
    max_age = int(cfg.get("max_source_age_hours", 72))
    found = discover(domain, cfg)[:limit]
    new = skipped = 0
    now = db.utcnow()

    for item in found:
        existing = db.one(
            "SELECT id FROM sources WHERE site = ? AND source_type = ? AND source_id = ?",
            (domain, "article", item["source_id"]),
        )
        if existing:
            continue
        state = "new" if _is_fresh(item.get("published_at", ""), max_age) else "skipped"
        db.insert(
            "sources",
            {
                "site": domain,
                "source_type": "article",
                "source_id": item["source_id"],
                "title": item["title"],
                "url": item["url"],
                "summary": item.get("summary", ""),
                "tags": json.dumps(item.get("tags", [])),
                "image_url": item.get("image_url"),
                "published_at": item.get("published_at", ""),
                "first_seen_at": now,
                "state": state,
            },
        )
        if state == "new":
            new += 1
        else:
            skipped += 1

    if new or skipped:
        db.log_event(
            "sources.ingest",
            site=domain,
            message=f"{new} new, {skipped} too old",
            data={"scanned": len(found)},
        )
    return {"scanned": len(found), "new": new, "skipped": skipped}


def pending_sources(domain: str, limit: int = 5) -> list[dict]:
    return db.rows_to_dicts(
        db.query(
            "SELECT * FROM sources WHERE site = ? AND state = 'new' "
            "ORDER BY published_at DESC LIMIT ?",
            (domain, limit),
        )
    )


def mark_source(source_id: int, state: str) -> None:
    db.update("sources", source_id, {"state": state})
