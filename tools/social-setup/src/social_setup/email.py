"""CF Email Routing: ensure social@<domain> alias exists."""

from __future__ import annotations

import httpx

from .config import load_env

DEST_EMAIL = "jessetamburino@hotmail.com"


def _headers() -> dict[str, str]:
    env = load_env()
    return {
        "Authorization": f"Bearer {env['CLOUDFLARE_API_TOKEN']}",
        "Content-Type": "application/json",
    }


def _get_zone_id(domain: str) -> str | None:
    resp = httpx.get(
        f"https://api.cloudflare.com/client/v4/zones?name={domain}",
        headers=_headers(),
    )
    data = resp.json()
    results = data.get("result", [])
    return results[0]["id"] if results else None


def _list_rules(zone_id: str) -> list[dict]:
    resp = httpx.get(
        f"https://api.cloudflare.com/client/v4/zones/{zone_id}/email/routing/rules",
        headers=_headers(),
    )
    return resp.json().get("result", [])


def has_social_alias(domain: str, local_part: str = "social") -> bool:
    zone_id = _get_zone_id(domain)
    if not zone_id:
        return False
    rules = _list_rules(zone_id)
    target = f"{local_part}@{domain}"
    for rule in rules:
        for matcher in rule.get("matchers", []):
            if matcher.get("value") == target:
                return True
    return False


def ensure_social_alias(domain: str, local_part: str = "social") -> tuple[bool, str]:
    """Create <local_part>@<domain> if it doesn't exist. Returns (created, message).

    local_part defaults to "social" for the domain-level brand account. Pass a
    persona slug (e.g. "sam-reyes") to get a per-persona alias — every alias
    still forwards to the same shared inbox (DEST_EMAIL), so signup scripts
    that need a real per-account inbox (verification codes) are unaffected;
    only the "unique email per platform account" requirement is what this
    solves.
    """
    zone_id = _get_zone_id(domain)
    if not zone_id:
        return False, f"CF zone not found for {domain}"

    rules = _list_rules(zone_id)
    target = f"{local_part}@{domain}"
    for rule in rules:
        for matcher in rule.get("matchers", []):
            if matcher.get("value") == target:
                return False, f"{target} already exists"

    # Enable routing first (idempotent)
    httpx.post(
        f"https://api.cloudflare.com/client/v4/zones/{zone_id}/email/routing/enable",
        headers=_headers(),
    )

    resp = httpx.post(
        f"https://api.cloudflare.com/client/v4/zones/{zone_id}/email/routing/rules",
        headers=_headers(),
        json={
            "name": f"forward {local_part}",
            "enabled": True,
            "matchers": [{"type": "literal", "field": "to", "value": target}],
            "actions": [{"type": "forward", "value": [DEST_EMAIL]}],
        },
    )
    data = resp.json()
    if data.get("success"):
        return True, f"Created {target} → {DEST_EMAIL}"
    errors = data.get("errors", [])
    return False, f"Failed to create {target}: {errors}"
