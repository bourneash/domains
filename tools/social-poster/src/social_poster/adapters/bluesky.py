# tools/social-poster/src/social_poster/adapters/bluesky.py
from __future__ import annotations
from atproto import Client
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class BlueskyAdapter(AbstractAdapter):
    name = "bluesky"

    def post(self, article: Article, creds: dict) -> str:
        client = Client()
        client.login(creds["BLUESKY_HANDLE"], creds["BLUESKY_APP_PASSWORD"])
        hashtags = " ".join(f"#{t}" for t in article.tags[:2])
        text = f"{article.title}\n{article.url}"
        if hashtags:
            candidate = f"{text} {hashtags}"
            text = candidate if len(candidate) <= 300 else text
        response = client.send_post(text=text[:300])
        return response.uri
