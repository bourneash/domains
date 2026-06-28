"""Write and read per-site social-status.json files."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path


def _sites_dir() -> Path:
    """Return the sites/ directory, respecting the DOMAINS_ROOT env override (for tests)."""
    override = os.environ.get("DOMAINS_ROOT")
    if override:
        return Path(override) / "sites"
    # Default: resolve from this file's location
    # src/social_setup/status.py -> domains/
    return Path(__file__).resolve().parents[4] / "sites"


def _status_path(domain: str) -> Path:
    return _sites_dir() / domain / "ops" / "social" / "social-status.json"


def write_social_status(domain: str, platform_results: dict) -> None:
    """Write enriched platform states to ops/social/social-status.json."""
    path = _status_path(domain)
    path.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    enriched: dict = {}
    for platform, data in platform_results.items():
        entry = dict(data)
        if entry.get("state") == "provisioned" and "provisioned_at" not in entry:
            entry["provisioned_at"] = now
        enriched[platform] = entry
    path.write_text(json.dumps(enriched, indent=2))


def read_social_status(domain: str) -> dict:
    """Return the social-status.json for a domain, or {} if not yet written."""
    path = _status_path(domain)
    if not path.exists():
        return {}
    return json.loads(path.read_text())
