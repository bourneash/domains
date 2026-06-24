"""Amazon affiliate health facts — reads tools/amz-stats/out/latest.json."""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)

# tools/site-tracker/src/site_tracker/collectors/ → parents[5] = domains root
AMZ_STATS_OUT = Path(__file__).parents[5] / "tools" / "amz-stats" / "out" / "latest.json"

_AMZ_FACTS = ("amz.asin_count", "amz.oos_count", "amz.delisted_count", "amz.last_scan")


def _load_snapshot() -> dict | None:
    """Load latest.json; return None if missing or unreadable."""
    try:
        return json.loads(AMZ_STATS_OUT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("amazon collector: could not read %s: %s", AMZ_STATS_OUT, exc)
        return None


def _is_stale(snap: dict) -> bool:
    """Return True if snapshot timestamp is older than 49 hours."""
    try:
        ts = datetime.fromisoformat(snap["timestamp"].replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - ts) > timedelta(hours=49)
    except (KeyError, ValueError):
        return True


def run(reg, conn: sqlite3.Connection) -> None:
    snap = _load_snapshot()

    for site_name, site_cfg in reg.sites.items():
        if "amz" not in site_cfg.get("applies_to", []):
            continue

        try:
            _collect_site(conn, site_name, site_cfg, snap)
        except Exception:
            log.exception("amazon collect %s crashed", site_name)


def _collect_site(
    conn: sqlite3.Connection,
    site_name: str,
    site_cfg: dict,
    snap: dict | None,
) -> None:
    if snap is None:
        for key in _AMZ_FACTS:
            emit_unknown(conn, site_name, site_cfg, key)
        return

    if _is_stale(snap):
        emit(conn, site_name, site_cfg, "amz.last_scan", snap.get("timestamp"))
        for key in ("amz.asin_count", "amz.oos_count", "amz.delisted_count"):
            emit_unknown(conn, site_name, site_cfg, key)
        return

    per_site = snap.get("summary", {}).get("per_site", {})
    site_data = per_site.get(site_name)

    if site_data is None:
        for key in _AMZ_FACTS:
            emit_unknown(conn, site_name, site_cfg, key)
        return

    emit(conn, site_name, site_cfg, "amz.asin_count",     site_data.get("asin_count", 0))
    emit(conn, site_name, site_cfg, "amz.oos_count",      site_data.get("oos_count", 0))
    emit(conn, site_name, site_cfg, "amz.delisted_count", site_data.get("delisted_count", 0))
    emit(conn, site_name, site_cfg, "amz.last_scan",      snap.get("timestamp"))
