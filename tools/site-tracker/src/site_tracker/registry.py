"""sites.yml load + save + manual-fact write."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


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
    out = {"config": reg.config, "sites": reg.sites}
    with open(path, "w") as f:
        yaml.safe_dump(out, f, sort_keys=False, default_flow_style=False)


def set_manual_fact(reg: Registry, path: Path, site: str, key: str, value: Any) -> None:
    if site not in reg.sites:
        raise KeyError(f"unknown site: {site}")
    manual = reg.sites[site].setdefault("manual", {})
    manual[key] = {
        "value": value,
        "set_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    _dump(reg, path)


def active_sites(reg: Registry) -> dict[str, dict[str, Any]]:
    return {k: v for k, v in reg.sites.items() if v.get("active")}


def site_applies_to(reg: Registry, site: str, family: str) -> bool:
    if site not in reg.sites:
        return False
    return family in reg.sites[site].get("applies_to", [])
