# tools/social-poster/src/social_poster/adapters/pinterest.py
from __future__ import annotations
import httpx
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class PinterestAdapter(AbstractAdapter):
    name = "pinterest"

    def post(self, article: Article, creds: dict) -> str:
        token = creds.get("PINTEREST_ACCESS_TOKEN", "")
        board_id = creds.get("PINTEREST_BOARD_ID", "")
        payload = {
            "board_id": board_id,
            "title": article.title[:100],
            "description": article.summary[:500],
            "link": article.url,
        }
        if article.image_url:
            payload["media_source"] = {"source_type": "image_url", "url": article.image_url}
        resp = httpx.post(
            "https://api.pinterest.com/v5/pins",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        pin_id = resp.json()["id"]
        return f"https://www.pinterest.com/pin/{pin_id}/"
