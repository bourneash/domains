"""Stable organic-social attribution without changing editorial copy."""

from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from social_hub import db
from social_hub.config import SiteConfig


def attributed_link(post: dict, link: str, cfg: SiteConfig) -> str:
    if not link or not cfg.get("attribution.enabled", True):
        return link
    parsed = urlsplit(link)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return link
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    defaults = {
        "utm_source": post.get("platform") or "social",
        "utm_medium": cfg.get("attribution.medium", "organic_social"),
        "utm_campaign": cfg.get("attribution.campaign", "always_on"),
        "utm_content": f"hub-{post.get('id')}",
    }
    for key, value in defaults.items():
        query.setdefault(key, str(value))
    result = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
    if post.get("id"):
        db.update("posts", int(post["id"]), {"utm_link": result})
    return result
