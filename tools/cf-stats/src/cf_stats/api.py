"""Thin Cloudflare API client. Raises CFError on non-success; callers decide how to degrade."""
from __future__ import annotations

import time
from typing import Any

import httpx

API_BASE = "https://api.cloudflare.com/client/v4"


class CFError(Exception):
    def __init__(self, status: int, message: str, errors: list | None = None):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message
        self.errors = errors or []


class CFClient:
    def __init__(self, token: str, account_id: str, timeout: float = 30.0):
        self.account_id = account_id
        self._client = httpx.Client(
            base_url=API_BASE,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _request(self, method: str, path: str, **kw) -> dict[str, Any]:
        retries = 3
        backoff = 1.0
        for attempt in range(retries):
            try:
                r = self._client.request(method, path, **kw)
            except httpx.HTTPError as e:
                if attempt == retries - 1:
                    raise CFError(0, f"transport: {e}") from e
                time.sleep(backoff * (2 ** attempt))
                continue
            if r.status_code == 429 and attempt < retries - 1:
                time.sleep(backoff * (2 ** attempt))
                continue
            try:
                body = r.json()
            except Exception:
                raise CFError(r.status_code, f"non-json response: {r.text[:200]}")
            if not r.is_success or not body.get("success", False):
                msgs = body.get("errors") or [{"message": r.text[:200]}]
                raise CFError(r.status_code, msgs[0].get("message", "unknown"), msgs)
            return body
        raise CFError(0, "exhausted retries")

    def get(self, path: str, params: dict | None = None) -> dict[str, Any]:
        return self._request("GET", path, params=params)

    def post(self, path: str, json: dict | None = None) -> dict[str, Any]:
        return self._request("POST", path, json=json)

    def paginate(self, path: str, params: dict | None = None, per_page: int = 50) -> list[dict]:
        results: list[dict] = []
        page = 1
        params = dict(params or {})
        params["per_page"] = per_page
        while True:
            params["page"] = page
            body = self.get(path, params=params)
            results.extend(body.get("result") or [])
            info = body.get("result_info") or {}
            total_pages = info.get("total_pages") or 1
            if page >= total_pages:
                break
            page += 1
        return results

    def graphql(self, query: str, variables: dict) -> dict[str, Any]:
        r = self._client.post(
            "/graphql",
            json={"query": query, "variables": variables},
        )
        try:
            body = r.json()
        except Exception:
            raise CFError(r.status_code, f"non-json graphql response: {r.text[:200]}")
        if r.status_code >= 400:
            raise CFError(r.status_code, str(body)[:200])
        if body.get("errors"):
            raise CFError(200, str(body["errors"])[:200], body["errors"])
        return body.get("data") or {}
