# tools/social-poster/src/social_poster/adapters/tiktok.py
from __future__ import annotations
import httpx
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class TikTokAdapter(AbstractAdapter):
    name = "tiktok"

    def post(self, article: Article, creds: dict) -> str:
        # TikTok Content Posting API v2 — text post
        token = creds.get("TIKTOK_ACCESS_TOKEN", "")
        text = f"{article.title}\n\n{article.summary[:150]}\n\n{article.url}"
        resp = httpx.post(
            "https://open.tiktokapis.com/v2/post/publish/text/",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"post_info": {"text": text[:2200], "privacy_level": "PUBLIC_TO_EVERYONE"}},
        )
        resp.raise_for_status()
        return resp.json().get("data", {}).get("share_url", "https://tiktok.com")
