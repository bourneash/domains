import re
from datetime import datetime, timezone
import feedparser
import httpx
from .config import Source

DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0"


def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", text).strip()


def parse_published(entry) -> str:
    if getattr(entry, "published_parsed", None):
        try:
            return datetime(*entry.published_parsed[:6], tzinfo=timezone.utc).isoformat()
        except Exception:
            pass
    return datetime.now(timezone.utc).isoformat()


def fetch_feed_bytes(url: str, *, proxy: str | None = None, ua: str = DEFAULT_UA,
                     timeout: float = 20, client: httpx.Client | None = None) -> bytes:
    owns = client is None
    client = client or httpx.Client(proxy=proxy, timeout=timeout, follow_redirects=True)
    try:
        r = client.get(url, headers={"User-Agent": ua})
        r.raise_for_status()
        return r.content
    finally:
        if owns:
            client.close()


def fetch_rss(source: Source, *, proxy: str | None = None, client: httpx.Client | None = None) -> list[dict]:
    ua = source.fetch.get("user_agent", DEFAULT_UA)
    raw = fetch_feed_bytes(source.url, proxy=proxy, ua=ua, client=client)
    feed = feedparser.parse(raw)
    pattern = source.fetch.get("required_pattern")
    rx = re.compile(pattern, re.I) if pattern else None

    out: list[dict] = []
    for entry in feed.entries[:20]:
        url = (entry.get("link") or "").strip()
        title = strip_html(entry.get("title") or "")
        if not url or not title:
            continue
        summary = strip_html(entry.get("summary") or entry.get("description") or "")[:500]
        if rx and not rx.search(title + " " + summary):
            continue
        out.append({
            "title": title,
            "url": url,
            "summary": summary,
            "published_iso": parse_published(entry),
            "source_id": source.id,
            "source_name": source.fetch.get("source_name", source.id),
            "tags": list(source.tags),
            "raw": {},
        })
    return out
