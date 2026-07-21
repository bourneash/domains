"""sites.yml load + save + manual-fact write."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

# Manual-fact values are baked verbatim into git commit messages (see
# app/main.py), so they're bounded and control-char-free to keep commit
# history sane and prevent a value from forging fake multi-line commits.
MAX_MANUAL_VALUE_LEN = 500
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")  # allow \t (0x09)


class InvalidManualValue(ValueError):
    """Raised when a manual-fact value fails length/content validation."""


@dataclass
class Registry:
    config: dict[str, Any] = field(default_factory=dict)
    sites: dict[str, dict[str, Any]] = field(default_factory=dict)


def load(path: Path) -> Registry:
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    sites = data.get("sites", {}) or {}
    for site_cfg in sites.values():
        manual = site_cfg.get("manual") or {}
        normalized = {}
        for k, v in manual.items():
            if isinstance(v, dict) and "value" in v:
                normalized[k] = v
            else:
                normalized[k] = {"value": v, "set_at": None}
        site_cfg["manual"] = normalized
    return Registry(
        config=data.get("config", {}),
        sites=sites,
    )


def _dump(reg: Registry, path: Path) -> None:
    """Atomically write sites.yml — tmp file + os.replace, so a crash/OOM/
    full-disk mid-write can never leave a truncated or corrupted registry."""
    out = {"config": reg.config, "sites": reg.sites}
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w") as f:
        yaml.safe_dump(out, f, sort_keys=False, default_flow_style=False)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def _validate_manual_value(value: Any) -> None:
    if not isinstance(value, str):
        return
    if len(value) > MAX_MANUAL_VALUE_LEN:
        raise InvalidManualValue(
            f"value is {len(value)} characters, max {MAX_MANUAL_VALUE_LEN}"
        )
    if _CONTROL_CHAR_RE.search(value):
        raise InvalidManualValue(
            "value contains control characters (e.g. newlines) — not allowed, "
            "these can forge fake multi-line commit messages"
        )


def set_manual_facts_bulk(
    reg: Registry, path: Path, entries: list[tuple[str, str, Any]]
) -> None:
    """Set one or more manual facts across one or more sites in a single
    read-validate-write pass — one disk write total, regardless of how many
    (site, key, value) entries are given. Used by both the single-cell edit
    endpoint and the bulk-edit page so both share one write path."""
    for site, _key, value in entries:
        if site not in reg.sites:
            raise KeyError(f"unknown site: {site}")
        _validate_manual_value(value)
    ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    for site, key, value in entries:
        manual = reg.sites[site].setdefault("manual", {})
        manual[key] = {"value": value, "set_at": ts}
    _dump(reg, path)


def set_manual_fact(reg: Registry, path: Path, site: str, key: str, value: Any) -> None:
    set_manual_facts_bulk(reg, path, [(site, key, value)])


def delete_manual_fact(reg: Registry, path: Path, site: str, key: str) -> Any:
    """Remove a manual.<key> from a site. Returns the removed {value, set_at}
    dict (or None if it wasn't set). Raises KeyError for an unknown site."""
    if site not in reg.sites:
        raise KeyError(f"unknown site: {site}")
    manual = reg.sites[site].get("manual") or {}
    old = manual.pop(key, None)
    _dump(reg, path)
    return old


def active_sites(reg: Registry) -> dict[str, dict[str, Any]]:
    return {k: v for k, v in reg.sites.items() if v.get("active")}


def site_applies_to(reg: Registry, site: str, family: str) -> bool:
    if site not in reg.sites:
        return False
    return family in reg.sites[site].get("applies_to", [])
