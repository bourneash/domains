# tools/social-poster/src/social_poster/adapters/reddit.py
from __future__ import annotations
import praw
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class RedditAdapter(AbstractAdapter):
    name = "reddit"

    def post(self, article: Article, creds: dict) -> str:
        reddit = praw.Reddit(
            client_id=creds["REDDIT_CLIENT_ID"],
            client_secret=creds["REDDIT_CLIENT_SECRET"],
            username=creds["REDDIT_USERNAME"],
            password=creds["REDDIT_PASSWORD"],
            user_agent=f"social-poster/0.1 by {creds['REDDIT_USERNAME']}",
        )
        subreddit_name = creds.get("REDDIT_SUBREDDIT", "news")
        sub = reddit.subreddit(subreddit_name)
        submission = sub.submit(title=article.title, url=article.url)
        return f"https://reddit.com{submission.permalink}"
