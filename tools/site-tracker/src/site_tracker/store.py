"""SQLite store for facts + audit log.

Schema:
    facts(site, key, value, source, verified_at, state, ttl_hours)  PK (site, key)
    audit(ts, site, key, old_value, new_value, source)

Values are JSON-encoded so booleans, ints, and small objects round-trip.
get_site_facts() degrades stale-past-TTL rows from 'green/yellow/red' to 'stale'.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS facts (
  site         TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT,
  source       TEXT NOT NULL,
  verified_at  TEXT NOT NULL,
  state        TEXT NOT NULL,
  ttl_hours    INTEGER,
  PRIMARY KEY (site, key)
);

CREATE TABLE IF NOT EXISTS audit (
  ts          TEXT NOT NULL,
  site        TEXT NOT NULL,
  key         TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  source      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_site_key ON audit(site, key, ts);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=2000")
    return conn


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(db_path)
    try:
        for stmt in _SCHEMA.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                conn.execute(stmt)
    finally:
        conn.close()


def upsert_fact(
    conn: sqlite3.Connection,
    *,
    site: str,
    key: str,
    value: Any,
    source: str,
    state: str,
    ttl_hours: int | None,
) -> None:
    """Insert or update a fact. Appends to audit when value changes."""
    encoded = json.dumps(value)
    ts = _now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        existing = conn.execute(
            "SELECT value FROM facts WHERE site=? AND key=?", (site, key)
        ).fetchone()
        old = existing[0] if existing else None
        if old != encoded:
            conn.execute(
                "INSERT INTO audit(ts, site, key, old_value, new_value, source) "
                "VALUES (?,?,?,?,?,?)",
                (ts, site, key, old, encoded, source),
            )
        conn.execute(
            "INSERT INTO facts(site, key, value, source, verified_at, state, ttl_hours) "
            "VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT(site, key) DO UPDATE SET "
            "  value=excluded.value, source=excluded.source, "
            "  verified_at=excluded.verified_at, state=excluded.state, "
            "  ttl_hours=excluded.ttl_hours",
            (site, key, encoded, source, ts, state, ttl_hours),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def get_site_facts(conn: sqlite3.Connection, site: str) -> dict[str, dict[str, Any]]:
    """Return {key: {value, source, verified_at, state, ttl_hours}}.

    States degrade to 'stale' if verified_at + ttl_hours is in the past.
    """
    now = datetime.now(timezone.utc)
    out: dict[str, dict[str, Any]] = {}
    rows = conn.execute(
        "SELECT key, value, source, verified_at, state, ttl_hours "
        "FROM facts WHERE site=?", (site,)
    ).fetchall()
    for key, val, src, ts, st, ttl in rows:
        verified_at = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        age_hours = (now - verified_at).total_seconds() / 3600
        eff_state = "stale" if (ttl is not None and age_hours > ttl and st in ("green", "yellow", "red")) else st
        out[key] = {
            "value": json.loads(val) if val is not None else None,
            "source": src,
            "verified_at": ts,
            "state": eff_state,
            "ttl_hours": ttl,
            "age_hours": round(age_hours, 1),
        }
    return out


def all_sites(conn: sqlite3.Connection) -> list[str]:
    return [r[0] for r in conn.execute("SELECT DISTINCT site FROM facts ORDER BY site").fetchall()]
