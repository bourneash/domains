"""Register verified domains as Search Console properties and submit sitemaps."""
from __future__ import annotations

from googleapiclient.errors import HttpError


def sc_property(domain: str) -> str:
    """Domain properties cover every subdomain and protocol."""
    return f"sc-domain:{domain}"


def add_site(client, domain: str) -> str:
    """Return 'added' or 'failed:<reason>'. Never raises.

    No check-before-add here, unlike ga4-provision's grant.py (which lists
    existing access bindings before creating one). That's deliberate:
    sites().add() is an HTTP PUT — an idempotent upsert — so calling it again
    on an already-registered property is safe and just re-confirms ownership.
    Do not "fix" this into a check-first pattern.
    """
    try:
        client.sites().add(siteUrl=sc_property(domain)).execute()
        return "added"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001
        return f"failed:{type(exc).__name__}"


def submit_sitemap(client, domain: str, sitemap_url: str | None = None) -> str:
    """Return 'submitted' or 'failed:<reason>'. Never raises.

    Also a PUT-style upsert (see add_site) — safe to re-run.

    Caveat: 'submitted' means Google ACCEPTED the submission request, not
    that the sitemap is valid or reachable. Validation happens asynchronously
    server-side and is only visible later in the Search Console UI — a 404
    or malformed sitemap still returns 'submitted' here.
    """
    feedpath = sitemap_url or f"https://{domain}/sitemap.xml"
    try:
        client.sitemaps().submit(siteUrl=sc_property(domain), feedpath=feedpath).execute()
        return "submitted"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001
        return f"failed:{type(exc).__name__}"
