"""Bluesky adapter — the fleet's most complete channel.

Bluesky is the one platform where every account in the fleet is already
provisioned and vaulted ([[project_social_media_vault_rollout_2026-08]]), the
API is open, and mentions/replies are readable without an approval process.
It is therefore the reference implementation: post, reply, and inbox all work
here, and it is what americastrikes.com and 0daynews.com run on first.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from social_hub.platforms.base import (
    Adapter,
    AdapterError,
    Capabilities,
    Mention,
    Outgoing,
    PostRef,
)

# Every worker pass (publish, poll mentions, poll metrics, verify) builds its
# own Adapter instance and used to call client.login(handle, password) fresh
# every time — that's a full createSession call, which Bluesky rate-limits to
# 10/24h *per account*. A handful of accounts with several passes per tick
# burned through that fast (saveusfarms.com's brand channel hit it 5x on
# 2026-08-26). Session tokens survive across processes via
# export_session_string()/login(session_string=...), which uses a refresh
# call instead of createSession and isn't subject to the same limit — so
# cache one per handle on disk and only fall back to a real password login
# when there's no cached session or it's actually expired/revoked.
_SESSION_CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "bluesky-sessions"


def _session_cache_path(handle: str) -> Path:
    # Handle is already a safe filename in practice (a Bluesky handle), but
    # hash it anyway so a weird future handle can't escape the directory.
    return _SESSION_CACHE_DIR / f"{hashlib.sha256(handle.encode()).hexdigest()[:16]}.txt"


def _handle_to_url(handle: str, rkey: str) -> str:
    return f"https://bsky.app/profile/{handle}/post/{rkey}"


def _rkey(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


#: Bluesky self-label values that mark a post as adult content.
ADULT_LABELS = {"sexual", "nudity", "porn", "graphic-media"}
_URL_RE = re.compile(rb"https?://[^\s\]\)]+")


def link_facets(text: str) -> list:
    """Byte-offset link facets for every URL in *text*.

    `send_post` builds these automatically, but a self-labeled post has to be
    written through create_record, which does not — and without facets the
    trailing URL renders as dead plain text. Offsets are in UTF-8 bytes, not
    characters: any non-ASCII earlier in the post (an em dash, an accent) would
    shift a character-based index and mislink the URL.
    """
    from atproto import models

    raw = text.encode("utf-8")
    facets = []
    for match in _URL_RE.finditer(raw):
        url = match.group(0).rstrip(b".,);:").decode("utf-8", "ignore")
        facets.append(
            models.AppBskyRichtextFacet.Main(
                index=models.AppBskyRichtextFacet.ByteSlice(
                    byte_start=match.start(), byte_end=match.start() + len(url.encode("utf-8"))
                ),
                features=[models.AppBskyRichtextFacet.Link(uri=url)],
            )
        )
    return facets


class BlueskyAdapter(Adapter):
    name = "bluesky"
    caps = Capabilities(
        publish=True, reply=True, mentions=True, media=True, metrics=True, max_chars=300
    )
    # An app password is strongly preferred, but the fleet's older Bluesky
    # items only carry the account password — accept either rather than
    # locking every existing account out of the hub.
    required_creds = ("BLUESKY_HANDLE",)

    def __init__(self, creds: dict | None = None):
        super().__init__(creds)
        self._client: Any = None
        self._last_image_error: str = ""

    # --- plumbing ---------------------------------------------------------
    def identifier(self) -> str:
        return self.creds.get("BLUESKY_HANDLE") or self.creds.get("BLUESKY_USERNAME") or ""

    def password(self) -> str:
        return self.creds.get("BLUESKY_APP_PASSWORD") or self.creds.get("BLUESKY_PASSWORD") or ""

    def missing_creds(self) -> list[str]:
        missing = super().missing_creds()
        if not self.password():
            missing.append("BLUESKY_APP_PASSWORD")
        return missing

    def client(self):
        if self._client is not None:
            return self._client
        missing = self.missing_creds()
        if missing:
            raise AdapterError(f"bluesky: missing creds {missing}", retryable=False)
        from atproto import Client  # imported lazily: keeps CLI startup cheap

        handle = self.identifier()
        cache_path = _session_cache_path(handle)
        client = Client()

        # Keep the cache fresh if the SDK auto-refreshes the token mid-use
        # (a long-lived process holding one client across several calls).
        client.on_session_change(lambda *_a, **_kw: self._persist_session(client, cache_path))

        cached = cache_path.read_text().strip() if cache_path.exists() else ""
        if cached:
            try:
                client.login(session_string=cached)
                self._client = client
                self._persist_session(client, cache_path)
                return client
            except Exception:
                pass  # cached session dead/revoked — fall through to a real login

        try:
            client.login(self.identifier(), self.password())
        except Exception as exc:
            raise AdapterError(f"bluesky login failed: {exc}", retryable=False) from exc
        self._client = client
        self._persist_session(client, cache_path)
        return client

    @staticmethod
    def _persist_session(client, cache_path: Path) -> None:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(client.export_session_string())
        except Exception:
            pass  # best-effort — a missed cache write just costs the next real login

    def _verify(self) -> dict:
        client = self.client()
        return {"handle": getattr(client.me, "handle", self.identifier())}

    # --- verbs ------------------------------------------------------------
    def _send_labeled(self, text: str, label: str, reply_ref=None) -> PostRef:
        """Post with a self-label (adult content).

        Bluesky's rules require adult material to be labeled by the poster, and
        the SDK's convenience helpers don't carry labels — so this writes the
        record directly. Images are deliberately not supported on this path:
        an unlabeled-image mistake on an adult account costs the account.
        """
        from atproto import models

        client = self.client()
        record = models.AppBskyFeedPost.Record(
            text=text,
            created_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            facets=link_facets(text) or None,
            reply=reply_ref,
            labels=models.ComAtprotoLabelDefs.SelfLabels(
                values=[models.ComAtprotoLabelDefs.SelfLabel(val=label)]
            ),
        )
        try:
            resp = client.com.atproto.repo.create_record(
                models.ComAtprotoRepoCreateRecord.Data(
                    repo=client.me.did, collection="app.bsky.feed.post", record=record
                )
            )
        except Exception as exc:
            raise AdapterError(f"bluesky labeled post failed: {exc}") from exc
        return PostRef(remote_id=resp.uri, url=_handle_to_url(self.identifier(), _rkey(resp.uri)))

    def _send(self, text: str, out: Outgoing, reply_ref=None) -> PostRef:
        """One send path for posts and replies, with or without a picture.

        A failed image upload falls back to the text-only post rather than
        losing the post entirely — the copy is the payload, the cover is a
        bonus.
        """
        label = str((out.options or {}).get("content_label") or "").strip()
        if label:
            return self._send_labeled(text, label, reply_ref)

        client = self.client()
        image = next((i for i in out.images if i.data), None)
        kwargs = {"reply_to": reply_ref} if reply_ref else {}
        resp = None
        if image:
            try:
                resp = client.send_image(
                    text=text, image=image.data, image_alt=image.alt,
                    facets=link_facets(text) or None, **kwargs
                )
            except Exception as exc:
                resp = None
                self._last_image_error = str(exc)
        if resp is None:
            try:
                # send_post only builds facets when given a TextBuilder — a
                # plain str leaves facets=None and the URL renders as dead
                # text, so we compute them ourselves here too.
                resp = client.send_post(text=text, facets=link_facets(text) or None, **kwargs)
            except Exception as exc:
                raise AdapterError(f"bluesky post failed: {exc}") from exc
        return PostRef(remote_id=resp.uri, url=_handle_to_url(self.identifier(), _rkey(resp.uri)))

    def publish(self, out: Outgoing) -> PostRef:
        return self._send(self.fit(out.body, out.link if out.link else ""), out)

    def reply(self, out: Outgoing) -> PostRef:
        if not out.reply_to_remote_id:
            raise AdapterError("bluesky: reply requires reply_to_remote_id", retryable=False)
        client = self.client()
        from atproto import models

        parent_uri = out.reply_to_remote_id
        try:
            thread = client.get_posts([parent_uri]).posts
        except Exception as exc:
            raise AdapterError(f"bluesky: cannot load parent post: {exc}") from exc
        if not thread:
            raise AdapterError("bluesky: parent post not found", retryable=False)
        parent = thread[0]
        parent_ref = models.ComAtprotoRepoStrongRef.Main(uri=parent.uri, cid=parent.cid)
        # Reply must carry the *thread root*, not just the immediate parent —
        # replying to a reply with root=parent silently detaches the thread.
        root = getattr(getattr(parent.record, "reply", None), "root", None)
        root_ref = (
            models.ComAtprotoRepoStrongRef.Main(uri=root.uri, cid=root.cid)
            if root
            else parent_ref
        )
        return self._send(
            self.fit(out.body, out.link if out.link else ""),
            out,
            reply_ref=models.AppBskyFeedPost.ReplyRef(parent=parent_ref, root=root_ref),
        )

    def fetch_mentions(self, limit: int = 25, since: str | None = None) -> list[Mention]:
        client = self.client()
        try:
            resp = client.app.bsky.notification.list_notifications({"limit": min(limit, 100)})
        except Exception as exc:
            raise AdapterError(f"bluesky notifications failed: {exc}") from exc

        out: list[Mention] = []
        for note in getattr(resp, "notifications", []) or []:
            reason = getattr(note, "reason", "")
            if reason not in ("mention", "reply", "quote"):
                continue
            record = getattr(note, "record", None)
            text = getattr(record, "text", "") or ""
            author = getattr(note, "author", None)
            handle = getattr(author, "handle", "") if author else ""
            created = getattr(note, "indexed_at", "") or ""
            if since and created and created <= since:
                continue
            out.append(
                Mention(
                    remote_id=note.uri,
                    text=text,
                    author=(getattr(author, "display_name", "") or handle) if author else "",
                    author_handle=handle,
                    url=_handle_to_url(handle, _rkey(note.uri)),
                    parent_remote_id=note.uri,
                    created_at=created,
                    kind="reply" if reason == "reply" else "mention",
                )
            )
        return out

    def fetch_metrics(self, remote_ids: list[str]) -> dict[str, dict]:
        client = self.client()
        out: dict[str, dict] = {}
        # get_posts takes at most 25 URIs per call.
        for start in range(0, len(remote_ids), 25):
            chunk = [uri for uri in remote_ids[start : start + 25] if uri.startswith("at://")]
            if not chunk:
                continue
            try:
                posts = client.get_posts(chunk).posts
            except Exception as exc:
                raise AdapterError(f"bluesky metrics failed: {exc}") from exc
            for post in posts:
                out[post.uri] = {
                    "likes": int(getattr(post, "like_count", 0) or 0),
                    "reposts": int(getattr(post, "repost_count", 0) or 0),
                    "replies": int(getattr(post, "reply_count", 0) or 0),
                }
        return out
