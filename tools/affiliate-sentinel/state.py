"""Per-site streak state, so "N consecutive runs" survives across cron ticks.

Lives at `ops/state/affiliate-sentinel.json` inside the site repo, per the
fleet's per-site-data-ownership rule: the site owns its own state, central
tools aggregate.

Why streaks at all: both failure modes are transient far more often than they
are real. Products restock. PA-API drops live ASINs from responses. Cloudflare
has a bad minute. Acting on a single observation is how you end up auto-swapping
a healthy product, which — now that healing writes to `affiliate.ts` and
deploys — is a live-site change, not just a noisy task file.

Moving from weekly to daily makes the streak requirement *cheaper*, not more
expensive: two consecutive daily runs is a 24-hour confirmation window, where
the old weekly cadence needed two weeks to reach the same confidence.
"""
from __future__ import annotations

import json
from pathlib import Path

STATE_VERSION = 2


def path_for(site_root: Path) -> Path:
    return site_root / "ops" / "state" / "affiliate-sentinel.json"


def load(site_root: Path) -> dict:
    p = path_for(site_root)
    if not p.is_file():
        return {"version": STATE_VERSION, "streaks": {}, "last_run": None}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        # A corrupt state file must not wedge the sentinel — worst case we
        # lose streak history and re-confirm over the next couple of runs.
        return {"version": STATE_VERSION, "streaks": {}, "last_run": None}
    data.setdefault("streaks", {})
    data.setdefault("last_run", None)
    data["version"] = STATE_VERSION
    return data


def save(site_root: Path, data: dict) -> Path:
    p = path_for(site_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return p


def bump(data: dict, key: str) -> int:
    """Record another consecutive observation of `key`; return the new streak."""
    n = int(data["streaks"].get(key, 0)) + 1
    data["streaks"][key] = n
    return n


def clear(data: dict, key: str) -> None:
    data["streaks"].pop(key, None)


def reconcile(data: dict, observed: set[str]) -> list[str]:
    """Drop streaks for anything not observed this run; return what recovered."""
    recovered = [k for k in list(data["streaks"]) if k not in observed]
    for k in recovered:
        data["streaks"].pop(k, None)
    return recovered
