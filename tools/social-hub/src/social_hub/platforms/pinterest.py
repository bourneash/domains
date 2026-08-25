"""Pinterest adapter — API v5 pin creation.

Pinterest is image-first: a pin without an image is not a pin, so `publish`
refuses non-retryably when the source has no image rather than posting a
degraded text pin. Board id comes from config or creds, never from the model.

Fleet accounts exist and are vaulted, but they are *consumer* accounts — v5
write access needs a business account plus an approved app. Until that exists
the adapter reports missing creds and the scheduler routes around it.
"""

from __future__ import annotations

import httpx

from social_hub.platforms.base import (
    Adapter,
    AdapterError,
    Capabilities,
    Outgoing,
    PostRef,
)

API = "https://api.pinterest.com/v5"


class PinterestAdapter(Adapter):
    name = "pinterest"
    caps = Capabilities(
        publish=True, reply=False, mentions=False, media=True, max_chars=500, needs_title=True
    )
    required_creds = ("PINTEREST_ACCESS_TOKEN",)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.creds['PINTEREST_ACCESS_TOKEN']}"}

    def _verify(self) -> dict:
        resp = httpx.get(f"{API}/user_account", headers=self._headers(), timeout=30)
        if resp.status_code >= 400:
            raise AdapterError(f"pinterest verify -> {resp.status_code}: {resp.text[:200]}")
        return {"handle": resp.json().get("username", "")}

    def publish(self, out: Outgoing) -> PostRef:
        missing = self.missing_creds()
        if missing:
            raise AdapterError(f"pinterest: missing creds {missing}", retryable=False)
        board = (out.options or {}).get("board_id") or self.creds.get("PINTEREST_BOARD_ID")
        if not board:
            raise AdapterError("pinterest: no board_id configured", retryable=False)
        image = next(iter(out.media), "")
        if not image:
            raise AdapterError("pinterest: pin requires an image", retryable=False)
        payload = {
            "board_id": board,
            "title": (out.title or out.body)[:100],
            "description": self.fit(out.body)[:500],
            "link": out.link or None,
            "media_source": {"source_type": "image_url", "url": image},
        }
        resp = httpx.post(f"{API}/pins", headers=self._headers(), json=payload, timeout=60)
        if resp.status_code >= 400:
            raise AdapterError(
                f"pinterest pin failed {resp.status_code}: {resp.text[:200]}",
                retryable=resp.status_code not in (401, 403, 422),
            )
        pin = resp.json()
        return PostRef(
            remote_id=str(pin.get("id", "")),
            url=f"https://pinterest.com/pin/{pin.get('id', '')}/",
        )
