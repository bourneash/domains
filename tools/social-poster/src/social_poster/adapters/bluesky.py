# tools/social-poster/src/social_poster/adapters/bluesky.py
from __future__ import annotations
from atproto import Client, client_utils
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class BlueskyAdapter(AbstractAdapter):
    name = "bluesky"

    def post(self, article: Article, creds: dict) -> str:
        client = Client()
        client.login(creds["BLUESKY_HANDLE"], creds["BLUESKY_APP_PASSWORD"])
        hashtags = [f"#{t}" for t in article.tags[:2]]
        tag_suffix = (" " + " ".join(hashtags)) if hashtags else ""
        # 300 char Bluesky limit; reserve room for "\n" + url + tags, truncate title if needed
        budget = 300 - len("\n") - len(article.url) - len(tag_suffix)
        title = article.title if len(article.title) <= budget else article.title[: max(budget - 1, 0)] + "…"

        builder = client_utils.TextBuilder()
        builder.text(f"{title}\n")
        builder.link(article.url, article.url)
        if hashtags:
            builder.text(tag_suffix)

        response = client.send_post(builder)
        return response.uri
