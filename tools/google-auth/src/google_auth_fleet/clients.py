"""Scoped Google API clients built from the fleet service account.

Scopes are least-privilege: readonly everywhere except site verification,
which necessarily mutates ownership state.
"""
from __future__ import annotations

from pathlib import Path

from googleapiclient.discovery import build

from . import creds

SCOPES: dict[str, list[str]] = {
    "ga4_data": ["https://www.googleapis.com/auth/analytics.readonly"],
    "ga4_admin": ["https://www.googleapis.com/auth/analytics.readonly"],
    "search_console": ["https://www.googleapis.com/auth/webmasters.readonly"],
    "search_console_write": ["https://www.googleapis.com/auth/webmasters"],
    "site_verification": ["https://www.googleapis.com/auth/siteverification"],
}


def _client(service: str, version: str, scope_key: str, path: Path | None):
    credentials = creds.load_service_account(path, scopes=SCOPES[scope_key])
    return build(service, version, credentials=credentials, cache_discovery=False)


def search_console(path: Path | None = None):
    """Search Analytics + sitemaps. NOTE: this API has no permissions endpoint."""
    return _client("searchconsole", "v1", "search_console", path)


def search_console_write(path: Path | None = None):
    """Write-capable Search Console client.

    `sites().add()` and `sitemaps().submit()` are both PUT requests and the
    live Google discovery document requires the full
    `https://www.googleapis.com/auth/webmasters` scope for both — a service
    account self-signs its JWT for whatever scope it's handed, so
    `webmasters.readonly` gets a 403 on every call. This factory exists ONLY
    for the one-time verification/registration flow in tools/gsc-verify.
    `search_console()` above stays readonly and is what the recurring daily
    metrics collector must keep using — do not widen that one.
    """
    return _client("searchconsole", "v1", "search_console_write", path)


def site_verification(path: Path | None = None):
    """Site Verification API — the service account verifies domains itself."""
    return _client("siteVerification", "v1", "site_verification", path)


def ga4_admin(path: Path | None = None):
    """GA4 Admin API — property discovery and access bindings."""
    return _client("analyticsadmin", "v1beta", "ga4_admin", path)


def ga4_data(path: Path | None = None):
    """GA4 Data API — metric reporting (consumed by Plan 2)."""
    return _client("analyticsdata", "v1beta", "ga4_data", path)
