"""Load the site→repo map from tools/site-tracker/sites.yml.

We treat site-tracker's sites.yml as the single source of truth for the
domain → GitHub slug mapping (it already encodes the TLD-drift slugs like
bourneash/xxxtea.com vs bourneash/aliencouncil)."""
from __future__ import annotations

from pathlib import Path

import yaml

DEFAULT_PATHS = (
    Path("/work/tools/site-tracker/sites.yml"),
    Path(__file__).resolve().parents[3] / "site-tracker" / "sites.yml",
)


def load_sites(path: Path | None = None) -> dict[str, str]:
    """Return {domain: github_slug} for active sites that declare a repo."""
    if path is None:
        for cand in DEFAULT_PATHS:
            if cand.exists():
                path = cand
                break
    if path is None or not Path(path).exists():
        return {}
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    out: dict[str, str] = {}
    for domain, cfg in (data.get("sites") or {}).items():
        if not cfg.get("active"):
            continue
        slug = cfg.get("github")
        if slug:
            out[domain] = slug
    return out
