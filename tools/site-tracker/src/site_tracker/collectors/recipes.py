"""Recipe-driven collector — executes the `recipe:` block on each fact in
the catalog. Adding a new recipe-able fact requires no Python — just an
entry in registry/standard.yaml.

Supported recipe types:
  regex_on_head:   pattern: '<regex>'   — match against <head> slice of homepage
  regex_on_body:   pattern: '<regex>'   — match against full response body
  path_status:     path: '/foo'         — GET <site>/foo; expected: <int> (default 200)
"""
from __future__ import annotations

import logging
import re
import sqlite3
from typing import Any

import httpx

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown
from site_tracker.fact_keys import FACTS

log = logging.getLogger(__name__)

TIMEOUT = httpx.Timeout(8.0, connect=5.0)


def _fetch(client: httpx.Client, url: str) -> httpx.Response | None:
    try:
        return client.get(url, follow_redirects=True)
    except httpx.HTTPError as e:
        log.warning("recipes fetch %s failed: %s", url, e)
        return None


def _eval_regex_on_head(client: httpx.Client, base: str, recipe: dict,
                       homepage_cache: dict) -> bool | None:
    if base not in homepage_cache:
        homepage_cache[base] = _fetch(client, f"{base}/")
    r = homepage_cache[base]
    if r is None or r.status_code >= 500:
        return None
    head = r.text[:200_000].split("</head>", 1)[0]
    return bool(re.search(recipe["pattern"], head, re.I))


def _eval_regex_on_body(client: httpx.Client, base: str, recipe: dict,
                        homepage_cache: dict) -> bool | None:
    """Run a regex against the full homepage response body."""
    if base not in homepage_cache:
        homepage_cache[base] = _fetch(client, f"{base}/")
    r = homepage_cache[base]
    if r is None or r.status_code >= 500:
        return None
    body = r.text[:500_000]   # cap at 500k to avoid pathologically large pages
    return bool(re.search(recipe["pattern"], body, re.I))


def _eval_path_status(client: httpx.Client, base: str, recipe: dict) -> bool | None:
    path = recipe["path"]
    expected = int(recipe.get("expected", 200))
    r = _fetch(client, f"{base}{path}")
    if r is None:
        return None
    return r.status_code == expected


_DISPATCH = {
    "regex_on_head": _eval_regex_on_head,
    "regex_on_body": _eval_regex_on_body,
    "path_status":   _eval_path_status,
}


def _recipe_facts() -> list[tuple[str, Any]]:
    """Return [(key, spec)] for facts that carry a recipe."""
    return [(k, s) for k, s in FACTS.items() if s.recipe is not None]


def _collect_site(client: httpx.Client, conn: sqlite3.Connection,
                  site_name: str, site_cfg: dict) -> None:
    applies = site_cfg.get("applies_to", [])
    base = f"https://{site_name}"
    homepage_cache: dict[str, httpx.Response | None] = {}

    for key, spec in _recipe_facts():
        if spec.family not in applies:
            continue
        recipe = spec.recipe or {}
        rtype = recipe.get("type")
        handler = _DISPATCH.get(rtype)
        if handler is None:
            log.warning("unknown recipe type %r for fact %s", rtype, key)
            emit_unknown(conn, site_name, site_cfg, key, source="recipes")
            continue
        if rtype in ("regex_on_head", "regex_on_body"):
            value = handler(client, base, recipe, homepage_cache)
        else:
            value = handler(client, base, recipe)
        if value is None:
            emit_unknown(conn, site_name, site_cfg, key, source="recipes")
        else:
            emit(conn, site_name, site_cfg, key, value, source="recipes")


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": "site-tracker/0.1 recipes"}) as client:
        for site_name, site_cfg in reg.sites.items():
            if not site_cfg.get("active"):
                continue
            try:
                _collect_site(client, conn, site_name, site_cfg)
            except Exception:
                log.exception("recipes collect %s crashed", site_name)
