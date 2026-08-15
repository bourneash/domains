"""Read-only loader for registry/fleet.yaml — the canonical fleet site list.

Consumers should ask this module who exists instead of keeping their own
roster. Tool-specific settings stay in the tool's own config, keyed by domain,
as an *overlay* on this list.

    from fleet_registry import load, sites, get, with_capability

    for domain in sites(status="live"):
        ...
    for domain in with_capability("analytics"):
        ...
    entry = get("totaljerks.com")   # dict, or None

The registry is cached after the first read; pass ``fresh=True`` to reload.
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml

_DEFAULT_ROOT = Path(__file__).resolve().parents[2]
_cache: dict[str, dict] = {}


def registry_path(root: str | os.PathLike | None = None) -> Path:
    """Resolve the registry path. Container roots mount the repo at /work."""
    if root:
        return Path(root) / "registry" / "fleet.yaml"
    env = os.environ.get("FLEET_REGISTRY")
    if env:
        return Path(env)
    for candidate in (_DEFAULT_ROOT, Path("/work")):
        path = candidate / "registry" / "fleet.yaml"
        if path.exists():
            return path
    return _DEFAULT_ROOT / "registry" / "fleet.yaml"


def load(root: str | os.PathLike | None = None, fresh: bool = False) -> dict[str, dict]:
    """Return ``{domain: entry}`` for every registered site."""
    path = registry_path(root)
    key = str(path)
    if fresh or key not in _cache:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        _cache[key] = data.get("sites") or {}
    return _cache[key]


def sites(status: str | None = None, root=None) -> list[str]:
    """Domains, optionally filtered by status (live / scaffold / parked / redirect)."""
    entries = load(root)
    return sorted(d for d, e in entries.items() if status is None or e.get("status") == status)


def get(domain: str, root=None) -> dict | None:
    return load(root).get(domain)


def with_capability(capability: str, root=None) -> list[str]:
    """Domains a given fleet system applies to (site, ops, cron, smoke, tasks,
    affiliate, analytics, social, data-hub, product-feed)."""
    entries = load(root)
    return sorted(
        d for d, e in entries.items()
        if capability in (e.get("capabilities_override") or e.get("capabilities") or [])
    )


def repo(domain: str, root=None) -> str | None:
    entry = get(domain, root) or {}
    return entry.get("repo")


def analytics(domain: str, root=None) -> dict:
    entry = get(domain, root) or {}
    return entry.get("analytics") or {}
