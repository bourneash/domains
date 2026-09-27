# tools/social-poster/src/social_poster/adapters/bluesky.py
from __future__ import annotations
from pathlib import Path

import httpx
from atproto import Client, client_utils
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article
from social_lib.credentials import site_root


def _load_image(article: Article) -> bytes | None:
    """Load a product image from the local site checkout, or its public URL."""
    if not article.image_url:
        return None

    ref = article.image_url
    if ref.startswith(("http://", "https://")):
        try:
            response = httpx.get(ref, timeout=20, follow_redirects=True)
            response.raise_for_status()
            return response.content
        except httpx.HTTPError:
            return None

    # Article URLs are the only site identity available to this adapter.
    domain = article.url.split("//", 1)[-1].split("/", 1)[0]
    for path in (
        site_root(domain) / "site" / "public" / ref.lstrip("/"),
        site_root(domain) / "public" / ref.lstrip("/"),
    ):
        try:
            if Path(path).is_file():
                return Path(path).read_bytes()
        except OSError:
            continue
    return None


class BlueskyAdapter(AbstractAdapter):
    name = "bluesky"

    def post(self, article: Article, creds: dict) -> str:
        client = Client()
        # Prefer a real App Password (Bluesky's recommended API auth,
        # written by bsky_app_password_refresh.py / social_setup.platforms.bluesky),
        # falling back to the raw account password bsky_signup.py writes by
        # default — same fallback tools/social-hub's adapter already has.
        # Without this fallback every site whose signup only ran bsky_signup.py
        # (creds carry BLUESKY_PASSWORD, no BLUESKY_APP_PASSWORD) hits a bare
        # KeyError here on every post attempt.
        password = creds.get("BLUESKY_APP_PASSWORD") or creds.get("BLUESKY_PASSWORD")
        client.login(creds["BLUESKY_HANDLE"], password)
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

        image = _load_image(article)
        if image:
            response = client.send_image(
                builder,
                image=image,
                image_alt=article.title[:290],
            )
        else:
            response = client.send_post(builder)
        return response.uri
