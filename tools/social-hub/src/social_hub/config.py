"""Layered configuration: fleet defaults <- per-site overrides.

Fleet defaults live in `tools/social-hub/config/fleet.yaml`; a site opts in and
tunes itself with `sites/<domain>/ops/social/hub.yaml`. Per-site config is the
site's own file in the site's own repo — same ownership rule as the rest of the
fleet; the hub only ever reads it.

A site with no hub.yaml is *not* managed by the hub. That is deliberate: the
hub is opt-in per site so rolling it out stays a reviewed, per-site decision
rather than a fleet-wide switch flip.
"""

from __future__ import annotations

import copy
import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

TOOL_ROOT = Path(__file__).resolve().parents[2]
FLEET_CONFIG = Path(os.environ.get("SOCIAL_HUB_FLEET_CONFIG", TOOL_ROOT / "config" / "fleet.yaml"))


def domains_root() -> Path:
    return Path(os.environ.get("DOMAINS_ROOT", "/home/jesse/projects/domains"))


def site_root(domain: str) -> Path:
    return domains_root() / "sites" / domain


def site_config_path(domain: str) -> Path:
    return site_root(domain) / "ops" / "social" / "hub.yaml"


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _read_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


BUILTIN_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "platforms": ["bluesky"],
    # manual: drafts wait in the approval queue. auto: drafts self-approve and
    # schedule. Per-platform overrides live under platform_overrides.<name>.
    "approval": "manual",
    "variants_per_source": 1,
    "max_source_age_hours": 72,
    "cadence": {
        "per_platform_per_day": 3,
        "min_gap_minutes": 90,
        # UTC hour range that must stay silent, [start, end); wraps midnight.
        "quiet_hours": [3, 11],
        # Preferred UTC send times. The scheduler snaps to the next free slot.
        "slots": ["12:20", "17:40", "21:10"],
        # Deterministic per-site minute offset so 20 sites don't all fire at :20.
        "stagger": True,
    },
    "reply": {
        "enabled": True,
        "approval": "manual",
        "max_per_day": 12,
        "poll_limit": 25,
        "min_author_age_days": 0,
        "ignore_authors": [],
        "ignore_keywords": [],
    },
    "ai": {
        "model": "claude-sonnet-4-6",
        "max_tokens": 1200,
        "backend": "auto",  # auto | cli | api | fake
    },
    "voice": "",
    "hashtags": [],
    "link_style": "append",  # append | none
    "platform_overrides": {},
}


@dataclass
class SiteConfig:
    site: str
    data: dict = field(default_factory=dict)

    # --- generic access ---------------------------------------------------
    def get(self, key: str, default: Any = None) -> Any:
        cur: Any = self.data
        for part in key.split("."):
            if not isinstance(cur, dict) or part not in cur:
                return default
            cur = cur[part]
        return cur

    def for_platform(self, platform: str) -> "SiteConfig":
        """A view of this config with platform_overrides.<platform> merged on top."""
        override = (self.data.get("platform_overrides") or {}).get(platform) or {}
        return SiteConfig(self.site, _deep_merge(self.data, override))

    # --- convenience ------------------------------------------------------
    @property
    def enabled(self) -> bool:
        return bool(self.data.get("enabled", True))

    @property
    def platforms(self) -> list[str]:
        return list(self.data.get("platforms") or [])

    @property
    def approval(self) -> str:
        return str(self.data.get("approval", "manual"))

    @property
    def voice(self) -> str:
        return str(self.data.get("voice") or "")

    @property
    def stagger_minutes(self) -> int:
        """Deterministic 0-29 minute offset derived from the domain name, so
        every managed site lands on a different minute inside a shared slot."""
        if not self.get("cadence.stagger", True):
            return 0
        digest = hashlib.sha256(self.site.encode()).digest()
        return digest[0] % 30


def load_fleet_defaults() -> dict:
    return _deep_merge(BUILTIN_DEFAULTS, _read_yaml(FLEET_CONFIG).get("defaults", {}))


def load_site_config(domain: str) -> SiteConfig | None:
    """Return the merged config for *domain*, or None when the site has not
    opted in (no ops/social/hub.yaml)."""
    path = site_config_path(domain)
    if not path.exists():
        return None
    return SiteConfig(domain, _deep_merge(load_fleet_defaults(), _read_yaml(path)))


def managed_sites() -> list[str]:
    """Every site under sites/ that has opted in, sorted."""
    sites_dir = domains_root() / "sites"
    if not sites_dir.exists():
        return []
    found = [
        p.name
        for p in sorted(sites_dir.iterdir())
        if p.is_dir() and site_config_path(p.name).exists()
    ]
    return found


def load_all() -> dict[str, SiteConfig]:
    out: dict[str, SiteConfig] = {}
    for site in managed_sites():
        cfg = load_site_config(site)
        if cfg and cfg.enabled:
            out[site] = cfg
    return out
