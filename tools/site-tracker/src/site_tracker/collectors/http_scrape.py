"""HTTP-scrape collector — looks at the live site.

Detects analytics/ads pixels in <head>, sitemap + robots presence, TLS
expiry. All anonymous GETs. Per-site ~3 requests.
"""
from __future__ import annotations

import logging
import re
import socket
import ssl
import sqlite3
from datetime import datetime, timezone

import httpx

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)

_GA4_RE     = re.compile(
    r"gtag/js\?id=G-[A-Z0-9]+"                          # tag loader URL
    r"|gtag\(['\"]config['\"],\s*['\"]G-[A-Z0-9]+"      # inline gtag('config', 'G-...')
    r"|['\"]G-[A-Z0-9]{6,}['\"]",                       # quoted GA4 ID string literal
    re.I,
)
_ADSENSE_RE = re.compile(r"adsbygoogle\.js|ca-pub-\d+", re.I)
_META_RE    = re.compile(r"fbq\s*\(\s*['\"]init['\"]|connect\.facebook\.net", re.I)
_GTM_RE     = re.compile(r"GTM-[A-Z0-9]+|googletagmanager\.com/gtm\.js", re.I)
_SITEMAP_RE = re.compile(r"^\s*Sitemap:\s*(\S+)", re.I | re.M)

TIMEOUT = httpx.Timeout(8.0, connect=5.0)


def _fetch(client: httpx.Client, url: str) -> httpx.Response | None:
    try:
        return client.get(url, follow_redirects=True)
    except httpx.HTTPError as e:
        log.warning("http fetch %s failed: %s", url, e)
        return None


def _tls_expiry_days(host: str) -> int | None:
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((host, 443), timeout=5) as sock, \
             ctx.wrap_socket(sock, server_hostname=host) as ssock:
            cert = ssock.getpeercert()
    except (OSError, ssl.SSLError) as e:
        log.warning("tls probe %s failed: %s", host, e)
        return None
    not_after_secs = ssl.cert_time_to_seconds(cert["notAfter"])
    not_after = datetime.fromtimestamp(not_after_secs, tz=timezone.utc)
    return int((not_after - datetime.now(timezone.utc)).total_seconds() // 86400)


def _scrape_site(client: httpx.Client, conn: sqlite3.Connection, site_name: str, site_cfg: dict) -> None:
    applies = site_cfg.get("applies_to", [])
    base = f"https://{site_name}"

    home = _fetch(client, f"{base}/")
    if home is None or home.status_code >= 500:
        if "http" in applies:
            for k in ("http.ga4_present", "http.adsense_present",
                      "http.meta_pixel_present", "http.gtm_present"):
                emit_unknown(conn, site_name, site_cfg, k)
    elif "http" in applies:
        # Pixels are frequently deferred to the end of <body> (avoids
        # render-blocking); restricting the scan to <head> produces false
        # negatives for sites that do this, so scan the whole fetched page.
        page = home.text[: 200_000]
        emit(conn, site_name, site_cfg, "http.ga4_present",        bool(_GA4_RE.search(page)))
        emit(conn, site_name, site_cfg, "http.adsense_present",    bool(_ADSENSE_RE.search(page)))
        emit(conn, site_name, site_cfg, "http.meta_pixel_present", bool(_META_RE.search(page)))
        emit(conn, site_name, site_cfg, "http.gtm_present",        bool(_GTM_RE.search(page)))

    if "sitemap" in applies:
        rb = _fetch(client, f"{base}/robots.txt")
        emit(conn, site_name, site_cfg, "http.robots_present", rb is not None and rb.status_code == 200)

        # robots.txt is the canonical place a site declares its sitemap
        # location, which is commonly sitemap-index.xml (Astro/Next default)
        # rather than sitemap.xml. Try that first, then fall back to the
        # two conventional filenames.
        sitemap_url = None
        if rb is not None and rb.status_code == 200:
            m = _SITEMAP_RE.search(rb.text)
            if m:
                sitemap_url = m.group(1)

        sm = _fetch(client, sitemap_url) if sitemap_url else None
        if sm is None or sm.status_code != 200:
            sm = _fetch(client, f"{base}/sitemap.xml")
        if sm is None or sm.status_code != 200:
            sm = _fetch(client, f"{base}/sitemap-index.xml")
        emit(conn, site_name, site_cfg, "http.sitemap_200", sm is not None and sm.status_code == 200)

    if "tls" in applies:
        days = _tls_expiry_days(site_name)
        if days is None:
            emit_unknown(conn, site_name, site_cfg, "http.tls_expiry_days")
        else:
            emit(conn, site_name, site_cfg, "http.tls_expiry_days", days)


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": "site-tracker/0.1"}) as client:
        for site_name, site_cfg in reg.sites.items():
            if not site_cfg.get("active"):
                continue
            try:
                _scrape_site(client, conn, site_name, site_cfg)
            except Exception:
                log.exception("scrape %s crashed", site_name)
