"""Fact registry — loads catalog from registry/standard.yaml.

Public API is unchanged from before:
  FACTS              — dict[str, FactSpec]
  families()         — canonical column order
  keys_for_family(f) — list of keys in family

State rules are functions defined in this module and referenced by name
(via STATE_RULES) from the YAML catalog. To add a rule, define it here
and reference its name in standard.yaml's state_rule field.

Catalog path resolution:
  1. env SITE_TRACKER_REGISTRY (full path to a YAML file)
  2. /opt/site-tracker/registry/standard.yaml (Docker install path)
  3. <repo>/tools/site-tracker/registry/standard.yaml (local dev — walk up)
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import yaml


@dataclass(frozen=True)
class FactSpec:
    key: str
    family: str
    source: str
    ttl_hours: int
    describe: str
    state_from_value: Callable[[Any, dict], str]
    recipe: dict | None = None


# ---------------- state rule functions ----------------

def _bool_green_red(v: Any, _site: dict) -> str:
    if v is True:
        return "green"
    if v is False:
        return "red"
    return "unknown"


def _bool_green_yellow(v: Any, _site: dict) -> str:
    if v is True:
        return "green"
    if v is False:
        return "yellow"
    return "unknown"


def _tls_expiry(days: Any, _site: dict) -> str:
    if days is None:
        return "unknown"
    if days < 7:
        return "red"
    if days < 30:
        return "yellow"
    return "green"


def _commit_age(hours: Any, site: dict) -> str:
    if hours is None:
        return "unknown"
    if not site.get("active", False):
        return "green"
    if hours < 24 * 7:
        return "green"
    if hours < 24 * 30:
        return "yellow"
    return "red"


def _push_age(hours: Any, _site: dict) -> str:
    if hours is None:
        return "unknown"
    if hours < 24 * 7:
        return "green"
    if hours < 24 * 30:
        return "yellow"
    return "red"


def _ops_board_age(hours: Any, _site: dict) -> str:
    if hours is None:
        return "unknown"
    if hours < 25:
        return "green"
    if hours < 24 * 3:
        return "yellow"
    return "red"


def _commits_ahead(n: Any, _site: dict) -> str:
    if n is None:
        return "unknown"
    if n == 0:
        return "green"
    if n < 5:
        return "yellow"
    return "red"


def _amz_asin_count(n: Any, _site: dict) -> str:
    if n is None:
        return "unknown"
    return "green" if int(n) > 0 else "yellow"


def _amz_oos_count(n: Any, _site: dict) -> str:
    if n is None:
        return "unknown"
    n = int(n)
    if n == 0:
        return "green"
    if n < 3:
        return "yellow"
    return "red"


def _amz_delisted_count(n: Any, _site: dict) -> str:
    if n is None:
        return "unknown"
    n = int(n)
    if n == 0:
        return "green"
    if n == 1:
        return "yellow"
    return "red"


def _amz_last_scan(ts: Any, _site: dict) -> str:
    if ts is None:
        return "unknown"
    try:
        t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        age_hours = (datetime.now(timezone.utc) - t).total_seconds() / 3600
    except (ValueError, TypeError):
        return "unknown"
    if age_hours < 25:
        return "green"
    if age_hours < 50:
        return "yellow"
    return "red"


STATE_RULES: dict[str, Callable[[Any, dict], str]] = {
    "bool_green_red":      _bool_green_red,
    "bool_green_yellow":   _bool_green_yellow,
    "tls_expiry":          _tls_expiry,
    "commit_age":          _commit_age,
    "push_age":            _push_age,
    "ops_board_age":       _ops_board_age,
    "commits_ahead":       _commits_ahead,
    "amz_asin_count":     _amz_asin_count,
    "amz_oos_count":      _amz_oos_count,
    "amz_delisted_count": _amz_delisted_count,
    "amz_last_scan":      _amz_last_scan,
}


# ---------------- catalog loading ----------------

def _candidate_paths() -> list[Path]:
    paths: list[Path] = []
    env = os.environ.get("SITE_TRACKER_REGISTRY")
    if env:
        paths.append(Path(env))
    paths.append(Path("/opt/site-tracker/registry/standard.yaml"))
    # Walk up from this file looking for `tools/site-tracker/registry/standard.yaml`.
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "tools" / "site-tracker" / "registry" / "standard.yaml"
        if cand.exists():
            paths.append(cand)
            break
        # Also handle the case where __file__ is already inside the tool tree
        cand2 = parent / "registry" / "standard.yaml"
        if cand2.exists():
            paths.append(cand2)
            break
    return paths


def _load_catalog() -> tuple[dict[str, FactSpec], list[str]]:
    for path in _candidate_paths():
        if path.exists():
            data = yaml.safe_load(path.read_text()) or {}
            facts_yaml = data.get("facts", {}) or {}
            families_list = data.get("families", []) or []
            specs: dict[str, FactSpec] = {}
            for key, body in facts_yaml.items():
                rule_name = body["state_rule"]
                rule = STATE_RULES.get(rule_name)
                if rule is None:
                    raise ValueError(
                        f"unknown state_rule {rule_name!r} for fact {key!r} in {path}"
                    )
                specs[key] = FactSpec(
                    key=key,
                    family=body["family"],
                    source=body["source"],
                    ttl_hours=int(body["ttl_hours"]),
                    describe=body["describe"],
                    state_from_value=rule,
                    recipe=body.get("recipe"),
                )
            return specs, list(families_list)
    raise FileNotFoundError(
        "registry/standard.yaml not found in any candidate path; "
        "set SITE_TRACKER_REGISTRY or run from inside the project tree"
    )


FACTS, _FAMILIES = _load_catalog()


def keys_for_family(family: str) -> list[str]:
    return [k for k, spec in FACTS.items() if spec.family == family]


def families() -> list[str]:
    return list(_FAMILIES)
