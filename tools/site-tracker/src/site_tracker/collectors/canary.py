"""Canary / smoke-string collector.

For each active site with a ``smoke_string`` config field and ``canary`` in
``applies_to``, fetches the homepage and checks that the string is present in
the response body.  A 200 with the right string → green; anything else → red.

This catches broken deploys that Workers Builds reports as green — e.g. a blank
page, a Cloudflare error page, or a Worker that starts but returns wrong content.
"""
from __future__ import annotations

import logging
import sqlite3

import httpx

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)

TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _check(client: httpx.Client, site_name: str, smoke_string: str) -> bool | None:
    url = f"https://{site_name}/"
    try:
        r = client.get(url, follow_redirects=True)
    except httpx.HTTPError as e:
        log.warning("canary fetch %s failed: %s", url, e)
        return None
    if r.status_code != 200:
        log.warning("canary %s returned HTTP %d", site_name, r.status_code)
        return False
    present = smoke_string in r.text
    if not present:
        log.warning("canary %s: smoke string not found in response (status 200)", site_name)
    return present


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    with httpx.Client(
        timeout=TIMEOUT,
        headers={"User-Agent": "site-tracker-canary/0.1"},
    ) as client:
        for site_name, site_cfg in reg.sites.items():
            if not site_cfg.get("active"):
                continue
            applies = site_cfg.get("applies_to", [])
            if "canary" not in applies:
                continue
            smoke_string = site_cfg.get("smoke_string", "")
            if not smoke_string:
                log.warning("canary: %s has canary in applies_to but no smoke_string — skipping", site_name)
                continue
            try:
                result = _check(client, site_name, smoke_string)
                if result is None:
                    emit_unknown(conn, site_name, site_cfg, "canary.smoke_ok")
                else:
                    emit(conn, site_name, site_cfg, "canary.smoke_ok", result)
                log.info("canary %s: %s", site_name, result)
            except Exception:
                log.exception("canary %s crashed", site_name)
