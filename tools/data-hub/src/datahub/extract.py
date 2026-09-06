"""Best-effort full-article-text extraction for RSS items.

Sources opt in per-entry via `fetch.full_text: true` in registry/sources.yaml
(see collector.run_cycle) -- this is NOT attempted for every source by
default: it's an extra fetch (through the same VPN proxy as the feed itself)
plus an extraction pass, and some feeds (e.g. Google News search RSS) hand out
a redirect/interstitial page instead of the article, which trafilatura can't
always resolve. Callers must treat an empty return as "no full text available,
fall back to title/summary" -- never as an error.
"""
import httpx

from .fetch_rss import DEFAULT_UA

MAX_CHARS = 12000  # cap so one runaway page can't blow up the DB row / API payload


def fetch_article_text(url: str, *, proxy: str | None = None, ua: str = DEFAULT_UA,
                       timeout: float = 15, client: httpx.Client | None = None) -> str:
    """Fetch `url` and extract the main article text. Returns "" on ANY failure
    (network error, non-HTML response, extraction finding nothing) -- never
    raises. A missing/short result just means the consumer falls back to the
    RSS summary, exactly like before this module existed."""
    owns = client is None
    client = client or httpx.Client(proxy=proxy, timeout=timeout, follow_redirects=True)
    try:
        r = client.get(url, headers={"User-Agent": ua})
        r.raise_for_status()
        content_type = r.headers.get("content-type", "")
        if "html" not in content_type and content_type:
            return ""
        html = r.text
    except Exception:
        return ""
    finally:
        if owns:
            client.close()

    try:
        import trafilatura
        text = trafilatura.extract(html, include_comments=False, include_tables=False,
                                   favor_precision=True) or ""
    except Exception:
        text = ""
    return text.strip()[:MAX_CHARS]
