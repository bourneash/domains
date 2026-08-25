"""Mastodon adapter — plain REST over httpx, no SDK.

Mastodon needs only a per-instance access token (no app review, no paid tier),
which makes it the natural second live channel after Bluesky for any site that
wants one. Full post/reply/mentions support.
"""

from __future__ import annotations

import httpx

from social_hub.platforms.base import (
    Adapter,
    AdapterError,
    Capabilities,
    Mention,
    Outgoing,
    PostRef,
)


class MastodonAdapter(Adapter):
    name = "mastodon"
    caps = Capabilities(publish=True, reply=True, mentions=True, media=False, max_chars=500)
    required_creds = ("MASTODON_INSTANCE", "MASTODON_ACCESS_TOKEN")

    def _base(self) -> str:
        return self.creds["MASTODON_INSTANCE"].rstrip("/")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.creds['MASTODON_ACCESS_TOKEN']}"}

    def _request(self, method: str, path: str, **kwargs):
        missing = self.missing_creds()
        if missing:
            raise AdapterError(f"mastodon: missing creds {missing}", retryable=False)
        try:
            resp = httpx.request(
                method, f"{self._base()}{path}", headers=self._headers(), timeout=30, **kwargs
            )
        except httpx.HTTPError as exc:
            raise AdapterError(f"mastodon request failed: {exc}") from exc
        if resp.status_code >= 400:
            raise AdapterError(
                f"mastodon {path} -> {resp.status_code}: {resp.text[:200]}",
                retryable=resp.status_code not in (401, 403, 422),
            )
        return resp.json()

    def _verify(self) -> dict:
        me = self._request("GET", "/api/v1/accounts/verify_credentials")
        return {"handle": me.get("acct", "")}

    def _status(self, text: str, reply_to: str = "") -> PostRef:
        payload = {"status": text}
        if reply_to:
            payload["in_reply_to_id"] = reply_to
        data = self._request("POST", "/api/v1/statuses", json=payload)
        return PostRef(remote_id=str(data["id"]), url=data.get("url", ""))

    def publish(self, out: Outgoing) -> PostRef:
        return self._status(self.fit(out.body, out.link))

    def reply(self, out: Outgoing) -> PostRef:
        if not out.reply_to_remote_id:
            raise AdapterError("mastodon: reply requires reply_to_remote_id", retryable=False)
        return self._status(self.fit(out.body, out.link), reply_to=out.reply_to_remote_id)

    def fetch_mentions(self, limit: int = 25, since: str | None = None) -> list[Mention]:
        notes = self._request(
            "GET", "/api/v1/notifications", params={"types[]": "mention", "limit": min(limit, 40)}
        )
        out: list[Mention] = []
        for note in notes:
            status = note.get("status") or {}
            created = status.get("created_at") or note.get("created_at") or ""
            if since and created and created <= since:
                continue
            account = note.get("account") or {}
            out.append(
                Mention(
                    remote_id=str(status.get("id") or note.get("id")),
                    text=_strip_html(status.get("content", "")),
                    author=account.get("display_name") or account.get("acct", ""),
                    author_handle=account.get("acct", ""),
                    url=status.get("url", ""),
                    parent_remote_id=str(status.get("id") or ""),
                    created_at=created,
                    kind="mention",
                )
            )
        return out


def _strip_html(html: str) -> str:
    import re

    text = re.sub(r"<br\s*/?>|</p>", "\n", html)
    return re.sub(r"<[^>]+>", "", text).strip()
