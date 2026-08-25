"""Platform adapter contract.

An adapter is a thin, stateless-ish wrapper over one platform's API. It knows
three verbs — publish, reply, fetch_mentions — plus a self-check. Anything the
platform cannot do is declared in `caps` rather than raising at call time, so
the scheduler can route around a read-only or post-only platform instead of
generating work that will fail.

Adapters never touch the DB, never format copy, and never decide *when* to
post. They take text in and return a PostRef.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


class AdapterError(RuntimeError):
    """Adapter failed in a way worth surfacing (auth, rate limit, rejection)."""

    def __init__(self, message: str, *, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class Capabilities:
    publish: bool = True
    reply: bool = False
    mentions: bool = False
    media: bool = False
    metrics: bool = False
    max_chars: int = 5000
    # Some platforms count a URL as a fixed-length token (X: 23 chars).
    url_weight: Optional[int] = None
    needs_title: bool = False


@dataclass
class PostRef:
    remote_id: str
    url: str = ""


@dataclass
class Mention:
    remote_id: str
    text: str
    author: str = ""
    author_handle: str = ""
    url: str = ""
    parent_remote_id: str = ""
    created_at: str = ""
    kind: str = "mention"  # mention | reply | comment


@dataclass
class Image:
    """A picture already resolved to bytes, with the URL it came from.

    Both forms are carried because platforms differ: Bluesky and Mastodon
    upload a blob, Pinterest wants a URL it can fetch itself.
    """

    data: bytes = b""
    alt: str = ""
    url: str = ""


@dataclass
class Outgoing:
    """What the scheduler hands an adapter."""

    body: str
    link: str = ""
    title: str = ""
    media: list[str] = field(default_factory=list)
    #: media resolved to bytes — populated by the publisher for adapters whose
    #: caps.media is true, so adapters never touch the filesystem themselves.
    images: list[Image] = field(default_factory=list)
    reply_to_remote_id: str = ""
    # Free-form platform routing hints from config (subreddit, board id, ...).
    options: dict = field(default_factory=dict)


class Adapter:
    name: str = "base"
    caps = Capabilities()
    #: credential keys that must be present for the adapter to be usable
    required_creds: tuple[str, ...] = ()

    def __init__(self, creds: dict | None = None):
        self.creds = creds or {}

    # --- lifecycle --------------------------------------------------------
    def missing_creds(self) -> list[str]:
        return [k for k in self.required_creds if not self.creds.get(k)]

    def verify(self) -> dict:
        """Cheap auth check. Returns {ok, handle?, error?} and never raises."""
        missing = self.missing_creds()
        if missing:
            return {"ok": False, "error": f"missing creds: {', '.join(missing)}"}
        try:
            return {"ok": True, **(self._verify() or {})}
        except Exception as exc:  # adapters wrap SDKs with wildly varied errors
            return {"ok": False, "error": str(exc)}

    def _verify(self) -> dict:
        return {}

    # --- verbs ------------------------------------------------------------
    def publish(self, out: Outgoing) -> PostRef:
        raise AdapterError(f"{self.name}: publish not supported", retryable=False)

    def reply(self, out: Outgoing) -> PostRef:
        raise AdapterError(f"{self.name}: reply not supported", retryable=False)

    def fetch_mentions(self, limit: int = 25, since: str | None = None) -> list[Mention]:
        return []

    def fetch_metrics(self, remote_ids: list[str]) -> dict[str, dict]:
        """Engagement counts keyed by remote id: {likes, reposts, replies}.

        Batched on purpose — every platform that exposes counts exposes them
        for many posts at once, and per-post polling is how you get rate
        limited.
        """
        return {}

    # --- helpers ----------------------------------------------------------
    def fit(self, body: str, link: str = "") -> str:
        """Trim body so body+link fits the platform limit, cutting on a word
        boundary and appending an ellipsis rather than slicing mid-word."""
        limit = self.caps.max_chars
        link_cost = 0
        if link:
            link_cost = (self.caps.url_weight or len(link)) + 1
        budget = limit - link_cost
        text = body.strip()
        if len(text) > budget:
            text = text[: max(0, budget - 1)].rsplit(" ", 1)[0].rstrip(" ,.;:—-") + "…"
        return f"{text} {link}".strip() if link else text
