"""Cloudflare collector — zone status, worker binding, email routing.

Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from env (already
loaded from /work/.env.shared by the container entrypoint).
"""
from __future__ import annotations

import logging
import os
import sqlite3

import httpx

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)

BASE = "https://api.cloudflare.com/client/v4"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _client() -> httpx.Client:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    return httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=TIMEOUT,
    )


def _get_zone_id(client: httpx.Client, zone_name: str) -> tuple[str | None, bool | None]:
    """Return (zone_id, active_flag) or (None, None) on error."""
    r = client.get("/zones", params={"name": zone_name})
    if r.status_code != 200 or not r.json().get("success"):
        return None, None
    result = r.json().get("result", [])
    if not result:
        return None, False  # zone not in CF
    z = result[0]
    return z["id"], z.get("status") == "active"


def _worker_bound(client: httpx.Client, zone_id: str) -> bool | None:
    r = client.get(f"/zones/{zone_id}/workers/routes")
    if r.status_code != 200:
        return None
    return bool(r.json().get("result"))


def _email_routing(client: httpx.Client, zone_id: str) -> bool | None:
    r = client.get(f"/zones/{zone_id}/email/routing")
    if r.status_code != 200:
        return None
    return bool(r.json().get("result", {}).get("enabled"))


def _collect_site(client: httpx.Client, conn: sqlite3.Connection, site_name: str, site_cfg: dict) -> None:
    zone_name = site_cfg.get("cf_zone")
    if not zone_name:
        return

    zone_id, active = _get_zone_id(client, zone_name)
    if zone_id is None and active is None:
        for k in ("cf.zone_active", "cf.worker_bound", "cf.email_routing"):
            emit_unknown(conn, site_name, site_cfg, k)
        return

    if zone_id is None:
        emit(conn, site_name, site_cfg, "cf.zone_active", False)
        emit(conn, site_name, site_cfg, "cf.worker_bound", False)
        emit(conn, site_name, site_cfg, "cf.email_routing", False)
        return

    emit(conn, site_name, site_cfg, "cf.zone_active", active)

    worker = _worker_bound(client, zone_id)
    if worker is None:
        emit_unknown(conn, site_name, site_cfg, "cf.worker_bound")
    else:
        emit(conn, site_name, site_cfg, "cf.worker_bound", worker)

    email = _email_routing(client, zone_id)
    if email is None:
        emit_unknown(conn, site_name, site_cfg, "cf.email_routing")
    else:
        emit(conn, site_name, site_cfg, "cf.email_routing", email)


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        log.warning("CLOUDFLARE_API_TOKEN missing — cf collector skipped")
        return
    with _client() as client:
        for site_name, site_cfg in reg.sites.items():
            if "cf" not in site_cfg.get("applies_to", []):
                continue
            try:
                _collect_site(client, conn, site_name, site_cfg)
            except Exception:
                log.exception("cf collect %s crashed", site_name)
