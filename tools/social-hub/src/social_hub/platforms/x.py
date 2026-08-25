"""X (Twitter) adapter — v2 API via tweepy.

Mentions are gated behind paid API tiers, so `caps.mentions` is advertised but
`fetch_mentions` degrades to an empty list on a 403 rather than failing the
tick: a free-tier account can still post, and the inbox simply stays empty for
this platform instead of poisoning every run with an error.
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


class XAdapter(Adapter):
    name = "x"
    caps = Capabilities(
        publish=True, reply=True, mentions=True, media=False, metrics=True,
        max_chars=280, url_weight=23,
    )
    required_creds = (
        "X_API_KEY",
        "X_API_SECRET",
        "X_ACCESS_TOKEN",
        "X_ACCESS_SECRET",
    )

    def __init__(self, creds: dict | None = None):
        super().__init__(creds)
        self._client: Any = None
        self._me: Any = None

    def client(self):
        if self._client is not None:
            return self._client
        missing = self.missing_creds()
        if missing:
            raise AdapterError(f"x: missing creds {missing}", retryable=False)
        import tweepy

        self._client = tweepy.Client(
            consumer_key=self.creds["X_API_KEY"],
            consumer_secret=self.creds["X_API_SECRET"],
            access_token=self.creds["X_ACCESS_TOKEN"],
            access_token_secret=self.creds["X_ACCESS_SECRET"],
            bearer_token=self.creds.get("X_BEARER_TOKEN") or None,
        )
        return self._client

    def _me_id(self) -> str:
        if self._me is None:
            self._me = self.client().get_me().data
        return str(self._me.id)

    def _verify(self) -> dict:
        me = self.client().get_me().data
        return {"handle": getattr(me, "username", "")}

    def _send(self, text: str, reply_to: str = "") -> PostRef:
        kwargs = {"text": text}
        if reply_to:
            kwargs["in_reply_to_tweet_id"] = reply_to
        try:
            resp = self.client().create_tweet(**kwargs)
        except Exception as exc:
            retryable = "duplicate" not in str(exc).lower()
            raise AdapterError(f"x post failed: {exc}", retryable=retryable) from exc
        tid = str(resp.data["id"])
        handle = self.creds.get("X_USERNAME") or self.creds.get("X_HANDLE") or "i"
        return PostRef(remote_id=tid, url=f"https://x.com/{handle}/status/{tid}")

    def publish(self, out: Outgoing) -> PostRef:
        return self._send(self.fit(out.body, out.link))

    def reply(self, out: Outgoing) -> PostRef:
        if not out.reply_to_remote_id:
            raise AdapterError("x: reply requires reply_to_remote_id", retryable=False)
        return self._send(self.fit(out.body, out.link), reply_to=out.reply_to_remote_id)

    def fetch_mentions(self, limit: int = 25, since: str | None = None) -> list[Mention]:
        try:
            resp = self.client().get_users_mentions(
                id=self._me_id(),
                max_results=max(5, min(limit, 100)),
                tweet_fields=["created_at", "author_id", "conversation_id"],
                expansions=["author_id"],
            )
        except Exception as exc:
            if "403" in str(exc) or "453" in str(exc):
                # Free tier: mentions endpoint is not entitled. Not an error
                # worth failing the run over — post-only is a valid mode.
                return []
            raise AdapterError(f"x mentions failed: {exc}") from exc

        users = {
            str(u.id): u for u in (getattr(resp, "includes", {}) or {}).get("users", [])
        }
        out: list[Mention] = []
        for tweet in resp.data or []:
            created = str(getattr(tweet, "created_at", "") or "")
            if since and created and created <= since:
                continue
            user = users.get(str(getattr(tweet, "author_id", "")))
            handle = getattr(user, "username", "") if user else ""
            out.append(
                Mention(
                    remote_id=str(tweet.id),
                    text=tweet.text or "",
                    author=getattr(user, "name", handle) if user else handle,
                    author_handle=handle,
                    url=f"https://x.com/{handle or 'i'}/status/{tweet.id}",
                    parent_remote_id=str(tweet.id),
                    created_at=created,
                    kind="mention",
                )
            )
        return out

    def fetch_metrics(self, remote_ids: list[str]) -> dict[str, dict]:
        if not remote_ids:
            return {}
        try:
            resp = self.client().get_tweets(
                ids=remote_ids[:100], tweet_fields=["public_metrics"]
            )
        except Exception as exc:
            if "403" in str(exc):
                return {}  # not entitled on this tier
            raise AdapterError(f"x metrics failed: {exc}") from exc
        out: dict[str, dict] = {}
        for tweet in resp.data or []:
            metrics = getattr(tweet, "public_metrics", None) or {}
            out[str(tweet.id)] = {
                "likes": int(metrics.get("like_count", 0)),
                "reposts": int(metrics.get("retweet_count", 0)),
                "replies": int(metrics.get("reply_count", 0)),
            }
        return out
