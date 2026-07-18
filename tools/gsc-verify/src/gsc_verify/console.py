"""Register verified domains as Search Console properties and submit sitemaps."""
from __future__ import annotations

from googleapiclient.errors import HttpError


def sc_property(domain: str) -> str:
    """Domain properties cover every subdomain and protocol."""
    return f"sc-domain:{domain}"


def add_site(client, domain: str) -> str:
    """Return 'added' or 'failed:<reason>'. Never raises."""
    try:
        client.sites().add(siteUrl=sc_property(domain)).execute()
        return "added"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001
        return f"failed:{type(exc).__name__}"


def submit_sitemap(client, domain: str, sitemap_url: str | None = None) -> str:
    """Return 'submitted' or 'failed:<reason>'. Never raises."""
    feedpath = sitemap_url or f"https://{domain}/sitemap.xml"
    try:
        client.sitemaps().submit(siteUrl=sc_property(domain), feedpath=feedpath).execute()
        return "submitted"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001
        return f"failed:{type(exc).__name__}"
