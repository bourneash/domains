"""Cloudflare DNS TXT management for Search Console verification.

Follows the auth/timeout pattern in
tools/site-tracker/src/site_tracker/collectors/cloudflare.py:22-40.
"""
from __future__ import annotations

import os

import httpx

BASE = "https://api.cloudflare.com/client/v4"
TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class CloudflareError(RuntimeError):
    """The Cloudflare API rejected a request."""


def cf_client() -> httpx.Client:
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CF_API_TOKEN", "")
    if not token:
        raise CloudflareError(
            "CLOUDFLARE_API_TOKEN not set. Expected it in "
            "/home/jesse/projects/domains/.env"
        )
    return httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=TIMEOUT,
    )


def _json(response: httpx.Response) -> dict:
    if response.status_code != 200:
        raise CloudflareError(f"HTTP {response.status_code}: {response.text[:200]}")
    payload = response.json()
    if not payload.get("success"):
        raise CloudflareError(f"API error: {payload.get('errors')}")
    return payload


def zone_id(client: httpx.Client, domain: str) -> str | None:
    """Return the CF zone id for a domain, or None if the zone is absent."""
    result = _json(client.get("/zones", params={"name": domain})).get("result", [])
    return result[0]["id"] if result else None


def find_txt(client: httpx.Client, zone: str, name: str, content: str) -> str | None:
    """Return the id of an existing TXT record with this exact content.

    Pages through the entire result set. Cloudflare paginates dns_records
    responses, and a hostname can easily accumulate more TXT records (SPF,
    multiple DKIM selectors, prior verification codes) than fit on one page.
    Missing a match on a later page would cause upsert_txt to POST a
    duplicate, which breaks this module's idempotency guarantee.
    """
    MAX_PAGES = 50  # hard cap: a malformed total_pages must not drive unbounded GETs
    page = 1
    while page <= MAX_PAGES:
        payload = _json(
            client.get(
                f"/zones/{zone}/dns_records",
                params={"type": "TXT", "name": name, "page": page, "per_page": 100},
            )
        )
        for record in payload.get("result", []):
            if record.get("content", "").strip('"') == content:
                return record["id"]

        result_info = payload.get("result_info")
        if not isinstance(result_info, dict):
            return None
        total_pages = result_info.get("total_pages")
        if not isinstance(total_pages, int) or total_pages <= page:
            return None
        page += 1
    return None


def upsert_txt(client: httpx.Client, zone: str, name: str, content: str) -> str:
    """Create the TXT record unless an identical one already exists.

    Idempotent: re-running never duplicates a record. Existing unrelated TXT
    records on the same name are left alone, so verifying as the service
    account never disturbs a separate human verification.
    """
    existing = find_txt(client, zone, name, content)
    if existing:
        return existing

    payload = _json(
        client.post(
            f"/zones/{zone}/dns_records",
            json={"type": "TXT", "name": name, "content": content, "ttl": 120},
        )
    )
    return payload["result"]["id"]
