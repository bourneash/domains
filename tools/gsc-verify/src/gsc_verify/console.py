"""Register verified domains as Search Console properties and submit sitemaps."""
from __future__ import annotations

import time

from googleapiclient.errors import HttpError

_MAX_ATTEMPTS = 4  # 1 initial try + 3 retries
_BACKOFF_BASE_SECONDS = 2  # 2s, 4s, 8s


def sc_property(domain: str) -> str:
    """Domain properties cover every subdomain and protocol."""
    return f"sc-domain:{domain}"


def _retry_on_429(action, sleep=time.sleep) -> Exception | None:
    """Run action(), retrying only HTTP 429 (rate limit) with exponential
    backoff. Any other error returns immediately — only rate limiting is
    worth waiting out; a real failure (403, 404, ...) will not fix itself.

    Returns None on success, the terminal exception otherwise.
    """
    for attempt in range(_MAX_ATTEMPTS):
        try:
            action()
            return None
        except HttpError as exc:
            status = getattr(exc.resp, "status", None)
            if status != 429 or attempt == _MAX_ATTEMPTS - 1:
                return exc
            sleep(_BACKOFF_BASE_SECONDS * (2**attempt))
        except Exception as exc:  # noqa: BLE001
            return exc
    return None  # unreachable — loop always returns


def add_site(client, domain: str, sleep=time.sleep) -> str:
    """Return 'added' or 'failed:<reason>'. Never raises.

    No check-before-add here, unlike ga4-provision's grant.py (which lists
    existing access bindings before creating one). That's deliberate:
    sites().add() is an HTTP PUT — an idempotent upsert — so calling it again
    on an already-registered property is safe and just re-confirms ownership.
    Do not "fix" this into a check-first pattern.
    """
    exc = _retry_on_429(
        lambda: client.sites().add(siteUrl=sc_property(domain)).execute(), sleep=sleep
    )
    if exc is None:
        return "added"
    if isinstance(exc, HttpError):
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    return f"failed:{type(exc).__name__}"


def submit_sitemap(client, domain: str, sitemap_url: str | None = None, sleep=time.sleep) -> str:
    """Return 'submitted' or 'failed:<reason>'. Never raises.

    Also a PUT-style upsert (see add_site) — safe to re-run.

    Caveat: 'submitted' means Google ACCEPTED the submission request, not
    that the sitemap is valid or reachable. Validation happens asynchronously
    server-side and is only visible later in the Search Console UI — a 404
    or malformed sitemap still returns 'submitted' here.
    """
    feedpath = sitemap_url or f"https://{domain}/sitemap.xml"
    exc = _retry_on_429(
        lambda: client.sitemaps().submit(siteUrl=sc_property(domain), feedpath=feedpath).execute(),
        sleep=sleep,
    )
    if exc is None:
        return "submitted"
    if isinstance(exc, HttpError):
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    return f"failed:{type(exc).__name__}"
