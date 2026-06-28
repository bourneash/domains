# tools/social-poster/src/social_poster/adapters/linkedin.py
from __future__ import annotations
import httpx
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class LinkedInAdapter(AbstractAdapter):
    name = "linkedin"

    def post(self, article: Article, creds: dict) -> str:
        token = creds.get("LI_ACCESS_TOKEN", "")
        author_urn = creds.get("LI_PERSON_URN", "")  # urn:li:person:xxxxx
        text = f"{article.title}\n\n{article.summary}\n\nRead more: {article.url}"
        payload = {
            "author": author_urn,
            "lifecycleState": "PUBLISHED",
            "specificContent": {
                "com.linkedin.ugc.ShareContent": {
                    "shareCommentary": {"text": text[:3000]},
                    "shareMediaCategory": "ARTICLE",
                    "media": [{"status": "READY", "originalUrl": article.url}],
                }
            },
            "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"},
        }
        resp = httpx.post(
            "https://api.linkedin.com/v2/ugcPosts",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        post_id = resp.headers.get("x-restli-id", "")
        return f"https://www.linkedin.com/feed/update/{post_id}/"
