"""GitHub collector — last push age + (placeholder) commits-ahead.

commits_ahead requires a local working copy to compare against; we set it
'unknown' here and let the filesystem collector compute it in a future
revision (or leave it for v2).
"""
from __future__ import annotations

import logging
import os
import sqlite3
from datetime import datetime, timezone

import httpx

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)

BASE = "https://api.github.com"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _client() -> httpx.Client:
    token = os.environ.get("GITHUB_TOKEN", "")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(base_url=BASE, headers=headers, timeout=TIMEOUT)


def _collect_site(client: httpx.Client, conn: sqlite3.Connection, site_name: str, site_cfg: dict) -> None:
    repo = site_cfg.get("github")
    if not repo:
        return
    r = client.get(f"/repos/{repo}")
    if r.status_code != 200:
        emit_unknown(conn, site_name, site_cfg, "github.last_push_age_hours")
        emit_unknown(conn, site_name, site_cfg, "github.commits_ahead")
        return
    pushed = r.json().get("pushed_at")
    if not pushed:
        emit_unknown(conn, site_name, site_cfg, "github.last_push_age_hours")
    else:
        ts = datetime.fromisoformat(pushed.replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
        emit(conn, site_name, site_cfg, "github.last_push_age_hours", round(age, 2))

    # commits_ahead is local vs origin; we don't compute it remotely.
    emit_unknown(conn, site_name, site_cfg, "github.commits_ahead")


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    with _client() as client:
        for site_name, site_cfg in reg.sites.items():
            if "github" not in site_cfg.get("applies_to", []):
                continue
            try:
                _collect_site(client, conn, site_name, site_cfg)
            except Exception:
                log.exception("github collect %s crashed", site_name)
