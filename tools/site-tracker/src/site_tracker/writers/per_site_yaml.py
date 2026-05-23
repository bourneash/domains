"""Per-site facts.yaml writer.

Each call to write_fact() does a read-modify-write of one site's facts.yaml.
The file is YAML with a top-level {last_updated, facts: {<key>: {...}}} shape.

The site's path is computed from the SITE_TRACKER_DOMAINS_ROOT env var,
defaulting to /work (matches the Docker bind mount). For tests / local dev,
override the env var or pass domains_root explicitly.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _domains_root(override: Path | None = None) -> Path:
    if override is not None:
        return override
    return Path(os.environ.get("SITE_TRACKER_DOMAINS_ROOT", "/work"))


def _site_facts_path(site_name: str, domains_root: Path | None = None) -> Path:
    return _domains_root(domains_root) / "sites" / site_name / "ops" / "facts.yaml"


def _load(path: Path) -> dict:
    if not path.exists():
        return {"last_updated": None, "facts": {}}
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as e:
        log.warning("facts.yaml at %s malformed; rewriting from scratch: %s", path, e)
        return {"last_updated": None, "facts": {}}
    data.setdefault("facts", {})
    return data


def write_fact(
    site_name: str,
    key: str,
    *,
    value: Any,
    source: str,
    state: str,
    ttl_hours: int | None,
    domains_root: Path | None = None,
) -> None:
    """Read-modify-write one fact into the site's facts.yaml.

    Silently no-ops (with a warning log) if the site's ops/ directory
    doesn't exist — the site simply isn't tracked yet at the per-site level.
    """
    path = _site_facts_path(site_name, domains_root)
    if not path.parent.exists():
        log.warning("ops dir missing for %s; skipping per-site write to %s", site_name, path)
        return
    data = _load(path)
    ts = _now_iso()
    data["facts"][key] = {
        "value": value,
        "state": state,
        "source": source,
        "verified_at": ts,
        "ttl_hours": ttl_hours,
    }
    data["last_updated"] = ts
    path.write_text(yaml.safe_dump(data, sort_keys=False, default_flow_style=False))
