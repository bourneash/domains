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

import hashlib
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


def _body_after_frontmatter(text: str) -> str:
    match = FRONTMATTER_RE.match(text)
    body = text[match.end():] if match else text
    return re.sub(r"\s+", " ", body).strip()


def _summary_from_body(text: str, limit: int = 400) -> str:
    """First sentences of the body, for content that carries no description.

    Some collections are pure prose with structural frontmatter only (a daily
    horoscope has a sign and a date, no title and no summary). The opening
    lines are the only honest summary available, so take them rather than
    letting the model write from a title alone.
    """
    body = _body_after_frontmatter(text)
    if len(body) <= limit:
        return body
    cut = body[:limit]
    stop = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    return (cut[: stop + 1] if stop > 120 else cut.rsplit(" ", 1)[0]) .strip()


def _pick_one_per_day(items: list[dict]) -> list[dict]:
    """Collapse a day's worth of sibling items to a single deterministic pick.

    A daily horoscope collection has one file per sign per day. Posting twelve
    of those is spam; posting the same sign every day is favouritism and looks
    automated. Hashing the date rotates the choice in a way that is stable
    across runs — the same day always resolves to the same item, so re-ingesting
    never produces a second post for a day already covered.
    """
    by_day: dict[str, list[dict]] = {}
    for item in items:
        by_day.setdefault((item.get("published_at") or "")[:10], []).append(item)
    out = []
    for day, group in by_day.items():
        group.sort(key=lambda i: i["source_id"])
        index = int(hashlib.sha256(day.encode()).hexdigest(), 16) % len(group)
        out.append(group[index])
    return out


def _format(template: str, context: dict) -> str:
    try:
        return template.format(**context)
    except (KeyError, IndexError):
        return template


def _load_collection(root: Path, domain: str, spec: dict) -> list[dict]:
    """Load one configured collection.

    This is the escape hatch for content that isn't article-shaped. Everything
    a site needs to describe such a collection — where the files are, how to
    build their URL, where the title/summary/date come from, and how many of a
    day's siblings are postable — lives in that site's own hub.yaml.
    """
    glob = spec.get("glob")
    if not glob:
        return []
    items: list[dict] = []
    for path in sorted(root.glob(glob)):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        # A catalog site's items are one JSON file each rather than markdown
        # with frontmatter. Same field mapping either way — only the parser
        # differs, so `format: json` is all a site has to say.
        if spec.get("format") == "json" or path.suffix == ".json":
            try:
                fm = json.loads(text)
            except ValueError:
                continue
            if not isinstance(fm, dict):
                continue
            text = ""
        else:
            fm = _parse_frontmatter(text)
        context = {
            "domain": domain,
            "slug": path.stem,
            "parent": path.parent.name,
            "Parent": path.parent.name.replace("-", " ").title(),
            "collection": path.parent.name,
            **{k: v for k, v in fm.items() if isinstance(v, (str, int, float))},
        }

        date_from = spec.get("date_from")
        if date_from == "slug":
            published = path.stem
        elif date_from:
            published = str(fm.get(date_from, ""))
        else:
            published = str(_first(fm, ["published", "pubDate", "date", "generated_at"]))

        title = (
            _format(spec["title_template"], context)
            if spec.get("title_template")
            else str(_first(fm, ["title", "name", "news_thread"]) or path.stem)
        )
        summary_from = spec.get("summary_from")
        if summary_from == "body":
            summary = _summary_from_body(text)
        elif summary_from:
            summary = str(fm.get(summary_from) or "")
        else:
            summary = str(
                _first(fm, ["excerpt", "description", "summary", "caption", "tagline", "blurb"])
                or ""
            )

        items.append(
            {
                "source_id": _format(spec.get("id_template", "{slug}"), context),
                "source_type": spec.get("name", "article"),
                "title": title,
                "url": _format(spec.get("url_template", "https://{domain}/{slug}/"), context),
                "summary": summary[:600],
                "tags": [str(t) for t in (_first(fm, ["keywords", "tags"], []) or [])],
                "image_url": _first(fm, ["image", "heroImage", "hero", "cover"], None),
                "published_at": published,
            }
        )

    pick = spec.get("pick", "all")
    if pick == "one_per_day":
        items = _pick_one_per_day(items)
    elif pick == "latest":
        items.sort(key=lambda i: i.get("published_at") or "", reverse=True)
        items = items[:1]
    return items


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
    """Candidate source items for *domain*, newest first, unfiltered.

    The `spotlight` collection (the promoter role's evergreen self-promotion
    items) is always additive: it never enters the collections/globs/default
    exclusivity chain below, so wiring it onto a site does not silently
    displace that site's real article/guide/product source. Everything
    else keeps the original fallback semantics — collections, if configured,
    win outright; otherwise globs; otherwise social_poster's loader; otherwise
    the bare articles/*.md scan. ingest() is idempotent per
    (site, source_type, source_id), so any overlap is just a skipped
    duplicate, never a wrong or missing post.
    """
    sources_cfg = (cfg.get("sources") if cfg else None) or {}
    all_collections = sources_cfg.get("collections") or []
    primary_collections = [c for c in all_collections if c.get("name") != "spotlight"]
    spotlight_collections = [c for c in all_collections if c.get("name") == "spotlight"]

    items: list[dict] = []
    if primary_collections:
        root = site_root(domain)
        for spec in primary_collections:
            items.extend(_load_collection(root, domain, spec))
    if not items and sources_cfg.get("globs"):
        items = _builtin_scan(domain, cfg)
    if not items:
        items = _via_social_poster(domain)
    if not items:
        items = _builtin_scan(domain, cfg)

    if spotlight_collections:
        root = site_root(domain)
        for spec in spotlight_collections:
            items.extend(_load_collection(root, domain, spec))

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
        source_type = item.get("source_type", "article")
        existing = db.one(
            "SELECT id FROM sources WHERE site = ? AND source_type = ? AND source_id = ?",
            (domain, source_type, item["source_id"]),
        )
        if existing:
            continue
        state = "new" if _is_fresh(item.get("published_at", ""), max_age) else "skipped"
        db.insert(
            "sources",
            {
                "site": domain,
                "source_type": source_type,
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
