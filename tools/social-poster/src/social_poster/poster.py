# tools/social-poster/src/social_poster/poster.py
from __future__ import annotations

from social_poster.content_loader import load_latest_articles
from social_poster.post_log import already_posted, record_post
from social_poster.adapters import ALL_ADAPTERS
from social_lib.credentials import read_creds


def post_domain(domain: str, platforms: list[str] | None = None) -> list[dict]:
    """Post latest unposted articles to all requested platforms.

    For each article (newest first) and each platform, skips if already posted
    or credentials are missing, otherwise posts and records the result.

    Returns a list of result dicts with keys:
        platform, slug, result ("posted"|"skipped"|"error"), url?, error?, reason?
    """
    active = platforms or list(ALL_ADAPTERS.keys())
    articles = load_latest_articles(domain, limit=5)
    results: list[dict] = []

    for platform_name in active:
        if platform_name not in ALL_ADAPTERS:
            continue
        adapter = ALL_ADAPTERS[platform_name]
        creds = read_creds(domain, platform_name) or {}
        if not creds:
            results.append({
                "platform": platform_name,
                "result": "skipped",
                "reason": "no creds",
            })
            continue
        for article in articles:
            if already_posted(domain, article.slug, platform_name):
                results.append({
                    "platform": platform_name,
                    "slug": article.slug,
                    "result": "skipped",
                })
                continue
            try:
                url = adapter.post(article, creds)
                record_post(domain, article.slug, platform_name, url)
                results.append({
                    "platform": platform_name,
                    "slug": article.slug,
                    "result": "posted",
                    "url": url,
                })
            except Exception as e:
                results.append({
                    "platform": platform_name,
                    "slug": article.slug,
                    "result": "error",
                    "error": str(e),
                })
            break  # one article per platform per run

    return results
