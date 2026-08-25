"""Reddit adapter — praw, script-app auth.

Reddit is parked fleet-wide (see [[project_social_media_vault_rollout_2026-08]]:
anti-abuse is pattern-matching this fleet's signups, and OAuth app creation is
silently blocked). The adapter is complete and tested against the contract so
that unparking is a credential change, not a code change — but every channel
using it will report `missing creds` until an OAuth app actually exists.

Subreddit routing comes from per-site config (`platform_overrides.reddit.
subreddit`), never from the model: picking a subreddit is a community-rules
decision, not a copywriting one.
"""

from __future__ import annotations

from typing import Any

from social_hub.platforms.base import (
    Adapter,
    AdapterError,
    Capabilities,
    Mention,
    Outgoing,
    PostRef,
)


class RedditAdapter(Adapter):
    name = "reddit"
    caps = Capabilities(
        publish=True, reply=True, mentions=True, media=False, max_chars=40000, needs_title=True
    )
    required_creds = (
        "REDDIT_CLIENT_ID",
        "REDDIT_CLIENT_SECRET",
        "REDDIT_USERNAME",
        "REDDIT_PASSWORD",
    )

    def __init__(self, creds: dict | None = None):
        super().__init__(creds)
        self._client: Any = None

    def client(self):
        if self._client is not None:
            return self._client
        missing = self.missing_creds()
        if missing:
            raise AdapterError(f"reddit: missing creds {missing}", retryable=False)
        import praw

        self._client = praw.Reddit(
            client_id=self.creds["REDDIT_CLIENT_ID"],
            client_secret=self.creds["REDDIT_CLIENT_SECRET"],
            username=self.creds["REDDIT_USERNAME"],
            password=self.creds["REDDIT_PASSWORD"],
            user_agent=self.creds.get("REDDIT_USER_AGENT")
            or f"social-hub/1.0 by u/{self.creds['REDDIT_USERNAME']}",
            check_for_async=False,
        )
        return self._client

    def _verify(self) -> dict:
        return {"handle": str(self.client().user.me())}

    def publish(self, out: Outgoing) -> PostRef:
        subreddit = (out.options or {}).get("subreddit") or self.creds.get("REDDIT_SUBREDDIT")
        if not subreddit:
            raise AdapterError(
                "reddit: no subreddit configured (platform_overrides.reddit.subreddit)",
                retryable=False,
            )
        subreddit = subreddit.removeprefix("r/").strip("/")
        title = (out.title or out.body.splitlines()[0])[:300]
        try:
            sub = self.client().subreddit(subreddit)
            if out.link:
                submission = sub.submit(title=title, url=out.link)
            else:
                submission = sub.submit(title=title, selftext=out.body)
        except Exception as exc:
            msg = str(exc).lower()
            raise AdapterError(
                f"reddit submit failed: {exc}",
                retryable=not any(w in msg for w in ("forbidden", "banned", "invalid")),
            ) from exc
        return PostRef(remote_id=submission.id, url=f"https://reddit.com{submission.permalink}")

    def reply(self, out: Outgoing) -> PostRef:
        if not out.reply_to_remote_id:
            raise AdapterError("reddit: reply requires reply_to_remote_id", retryable=False)
        try:
            comment = self.client().comment(out.reply_to_remote_id).reply(out.body)
        except Exception as exc:
            raise AdapterError(f"reddit reply failed: {exc}") from exc
        return PostRef(remote_id=comment.id, url=f"https://reddit.com{comment.permalink}")

    def fetch_mentions(self, limit: int = 25, since: str | None = None) -> list[Mention]:
        try:
            items = list(self.client().inbox.unread(limit=limit))
        except Exception as exc:
            raise AdapterError(f"reddit inbox failed: {exc}") from exc
        out: list[Mention] = []
        for item in items:
            from datetime import datetime, timezone

            created = datetime.fromtimestamp(
                getattr(item, "created_utc", 0), tz=timezone.utc
            ).isoformat(timespec="seconds")
            if since and created <= since:
                continue
            out.append(
                Mention(
                    remote_id=item.id,
                    text=getattr(item, "body", "") or "",
                    author=str(getattr(item, "author", "") or ""),
                    author_handle=str(getattr(item, "author", "") or ""),
                    url=f"https://reddit.com{getattr(item, 'context', '')}",
                    parent_remote_id=item.id,
                    created_at=created,
                    kind="comment",
                )
            )
        return out
