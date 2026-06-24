"""Thin Amazon Creators API client. Raises AMZError on non-success; callers decide how to degrade."""
from __future__ import annotations

import fcntl
import json
import time
from pathlib import Path
from typing import Any

import httpx

TOKEN_URL = "https://api.amazon.com/auth/o2/token"
API_BASE = "https://creatorsapi.amazon"

DEFAULT_RESOURCES = [
    "itemInfo.title",
    "itemInfo.byLineInfo",
    "images.primary.medium",
    "offersV2",
    "customerReviews",
    "parentASIN",
]

_TOKEN_SAFETY_BUFFER = 60  # seconds before expiry to refresh


class AMZError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class TokenCache:
    def __init__(self, cache_file: Path):
        self._path = cache_file

    def get(self) -> str | None:
        """Return cached token if still valid (with 60s safety buffer), else None."""
        if not self._path.exists():
            return None
        try:
            data = json.loads(self._path.read_text())
            if time.time() < data["expires_at"] - _TOKEN_SAFETY_BUFFER:
                return data["token"]
        except (KeyError, ValueError, OSError):
            pass
        return None

    def set(self, token: str, expires_in: int) -> None:
        """Write token + expiry to cache file using flock for write safety."""
        payload = json.dumps({"token": token, "expires_at": time.time() + expires_in})
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, "w") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                fh.write(payload)
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)


class AMZClient:
    def __init__(
        self,
        key_id: str,
        key_secret: str,
        store_id: str,
        cache_file: Path,
        marketplace: str = "www.amazon.com",
        timeout: float = 30.0,
    ):
        self._key_id = key_id
        self._key_secret = key_secret
        self.store_id = store_id
        self.marketplace = marketplace
        self._timeout = timeout
        self._cache = TokenCache(cache_file)
        self._client: httpx.Client | None = None

    def __enter__(self) -> AMZClient:
        self._client = httpx.Client(timeout=self._timeout)
        return self

    def __exit__(self, *_) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def _get_token(self) -> str:
        """Return a valid Bearer token, fetching and caching a new one if needed."""
        cached = self._cache.get()
        if cached:
            return cached

        assert self._client is not None, "AMZClient must be used as a context manager"
        r = self._client.post(
            TOKEN_URL,
            json={
                "grant_type": "client_credentials",
                "client_id": self._key_id,
                "client_secret": self._key_secret,
                "scope": "creatorsapi::default",
            },
            headers={"Content-Type": "application/json"},
        )
        if not r.is_success:
            raise AMZError(r.status_code, f"token fetch failed: {r.text[:200]}")
        body = r.json()
        token: str = body["access_token"]
        expires_in: int = body.get("expires_in", 3600)
        self._cache.set(token, expires_in)
        return token

    def _request(self, method: str, path: str, **kw) -> dict[str, Any]:
        """Execute a request against API_BASE with 3 retries and exponential backoff."""
        assert self._client is not None, "AMZClient must be used as a context manager"
        token = self._get_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-marketplace": self.marketplace,
        }
        url = f"{API_BASE}{path}"
        retries = 3
        for attempt in range(retries):
            try:
                r = self._client.request(method, url, headers=headers, **kw)
            except httpx.HTTPError as e:
                if attempt == retries - 1:
                    raise AMZError(0, f"transport: {e}") from e
                time.sleep(1.0 * (2 ** attempt))
                continue
            if r.status_code == 429 and attempt < retries - 1:
                time.sleep(1.0 * (2 ** attempt))
                continue
            try:
                body = r.json()
            except Exception:
                raise AMZError(r.status_code, f"non-json response: {r.text[:200]}")
            if not r.is_success:
                msg = body.get("message") or body.get("error") or r.text[:200]
                raise AMZError(r.status_code, str(msg))
            return body
        raise AMZError(0, "exhausted retries")

    def get_items(
        self,
        asins: list[str],
        resources: list[str] | None = None,
    ) -> dict[str, Any]:
        """POST /catalog/v1/getItems and return the full response dict."""
        return self._request(
            "POST",
            "/catalog/v1/getItems",
            json={
                "itemIds": asins,
                "resources": resources if resources is not None else DEFAULT_RESOURCES,
                "partnerTag": self.store_id,
                "marketplace": self.marketplace,
            },
        )
