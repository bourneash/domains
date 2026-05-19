"""Shared collector helpers."""
from __future__ import annotations

import logging
import sqlite3
from typing import Any

from site_tracker import store
from site_tracker.fact_keys import FACTS

log = logging.getLogger(__name__)


def emit(
    conn: sqlite3.Connection,
    site_name: str,
    site_cfg: dict,
    key: str,
    value: Any,
    *,
    source: str | None = None,
) -> None:
    """Compute state for `key` via FACTS[key].state_from_value, then upsert."""
    spec = FACTS.get(key)
    if spec is None:
        raise KeyError(f"unknown fact key: {key}")
    state = spec.state_from_value(value, site_cfg)
    store.upsert_fact(
        conn,
        site=site_name,
        key=key,
        value=value,
        source=source or spec.source,
        state=state,
        ttl_hours=spec.ttl_hours,
    )


def emit_unknown(
    conn: sqlite3.Connection,
    site_name: str,
    site_cfg: dict,
    key: str,
    *,
    source: str | None = None,
) -> None:
    """Mark a fact 'unknown' (e.g., collector hit an error)."""
    spec = FACTS.get(key)
    if spec is None:
        raise KeyError(f"unknown fact key: {key}")
    store.upsert_fact(
        conn,
        site=site_name,
        key=key,
        value=None,
        source=source or spec.source,
        state="unknown",
        ttl_hours=spec.ttl_hours,
    )
