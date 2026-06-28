# tools/social-poster/src/social_poster/adapters/x.py
from __future__ import annotations
import tweepy
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class XAdapter(AbstractAdapter):
    name = "x"

    def post(self, article: Article, creds: dict) -> str:
        client = tweepy.Client(
            consumer_key=creds["X_API_KEY"],
            consumer_secret=creds["X_API_SECRET"],
            access_token=creds["X_ACCESS_TOKEN"],
            access_token_secret=creds["X_ACCESS_SECRET"],
        )
        hashtags = " ".join(f"#{t}" for t in article.tags[:2])
        text = f"{article.title}\n{article.url}"
        if hashtags:
            candidate = f"{text} {hashtags}"
            text = candidate if len(candidate) <= 280 else text
        response = client.create_tweet(text=text[:280])
        tweet_id = response.data["id"]
        return f"https://x.com/i/status/{tweet_id}"
