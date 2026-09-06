"""Best-effort full-article-text extraction for RSS items.

Sources opt in per-entry via `fetch.full_text: true` in registry/sources.yaml
(see collector.run_cycle) -- this is NOT attempted for every source by
default: it's an extra fetch (through the same VPN proxy as the feed itself)
plus an extraction pass, and some feeds (e.g. Google News search RSS) hand out
a redirect/interstitial page instead of the article, which trafilatura can't
always resolve. Callers must treat an empty return as "no full text available,
fall back to title/summary" -- never as an error.
"""
import re
import httpx

from .fetch_rss import DEFAULT_UA

MAX_CHARS = 12000  # cap so one runaway page can't blow up the DB row / API payload

# A "successful" extraction that's actually a paywall/consent wall reads as
# real content to a downstream writer role -- worse than an honest empty
# string, which the role already knows to treat as "fall back to summary".
# Below this length, treat it as a failed extraction rather than a thin
# article: real articles this site subscribes to run well past this (see
# MIN_CHARS choice below vs. a typical consent-wall's 1-3 short sentences).
MIN_CHARS = 200

# Phrases that show up in the *entire* extracted text of a wall page rather
# than as an aside within a real article -- checked against the full text,
# not just a substring search, so a genuine article that happens to mention
# "cookies" in passing isn't penalized.
_WALL_PATTERNS = [
    re.compile(r"^\W*(accept|manage|allow)\s+(all\s+)?cookies\W*$", re.I),
    re.compile(r"^\W*(please\s+)?enable\s+javascript", re.I),
    re.compile(r"^\W*subscribe\s+to\s+(continue|read)", re.I),
    re.compile(r"^\W*you\s+(have\s+)?reached\s+your\s+(free\s+)?article\s+limit", re.I),
    re.compile(r"^\W*sign\s+in\s+to\s+continue\s+reading", re.I),
]


def _looks_like_a_wall(text: str) -> bool:
    return any(p.search(text) for p in _WALL_PATTERNS)


def fetch_article_text(url: str, *, proxy: str | None = None, ua: str = DEFAULT_UA,
                       timeout: float = 15, client: httpx.Client | None = None) -> str:
    """Fetch `url` and extract the main article text. Returns "" on ANY failure
    (network error, non-HTML response, extraction finding nothing, or a result
    that's too short / looks like a paywall or consent wall rather than an
    article) -- never raises. A missing result just means the consumer falls
    back to the RSS summary, exactly like before this module existed."""
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
    text = text.strip()
    if len(text) < MIN_CHARS or _looks_like_a_wall(text):
        return ""
    return text[:MAX_CHARS]
