"""Thin GitHub REST client. Returns parsed JSON; raises GHError on non-2xx
so collectors can degrade per-repo without aborting the snapshot."""
from __future__ import annotations

import time
from typing import Any

import httpx

API_BASE = "https://api.github.com"


class GHError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class GHClient:
    def __init__(self, token: str, timeout: float = 15.0):
        headers = {"Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(base_url=API_BASE, headers=headers, timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def get(self, path: str, params: dict | None = None) -> Any:
        retries = 3
        backoff = 1.0
        for attempt in range(retries):
            try:
                r = self._client.get(path, params=params)
            except httpx.HTTPError as e:
                if attempt == retries - 1:
                    raise GHError(0, f"transport: {e}") from e
                time.sleep(backoff * (2 ** attempt))
                continue
            if r.status_code in (429, 502, 503) and attempt < retries - 1:
                time.sleep(backoff * (2 ** attempt))
                continue
            if r.status_code >= 400:
                msg = r.text[:200]
                try:
                    msg = r.json().get("message", msg)
                except Exception:
                    pass
                raise GHError(r.status_code, msg)
            return r.json()
        raise GHError(0, "exhausted retries")
