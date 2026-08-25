"""SQLite store for the fleet social hub.

Why a central DB when the fleet convention is per-site data ownership
([[feedback_per_site_data_ownership]])? Because scheduling is inherently
cross-site: rate limits, quiet hours and the "don't fire eleven sites at
09:00" stagger can only be enforced by something that can see every queued
post at once. The compromise: this DB is the *operational* store (queue,
scheduler bookkeeping, inbox), and every post that actually goes out is also
mirrored back into `sites/<domain>/ops/social/post-log.jsonl` — the file the
site already owns — so the site repo remains the durable record of what was
published in its name. Losing this DB loses schedule state, never history.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "hub.db"

_local = threading.local()


def db_path() -> Path:
    return Path(os.environ.get("SOCIAL_HUB_DB", str(DEFAULT_DB)))


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS channels (
    id            INTEGER PRIMARY KEY,
    site          TEXT NOT NULL,
    platform      TEXT NOT NULL,
    handle        TEXT,
    persona       TEXT,
    -- registry status (active/suspended/...); `enabled` is the hub's own switch
    status        TEXT NOT NULL DEFAULT 'unknown',
    enabled       INTEGER NOT NULL DEFAULT 1,
    has_creds     INTEGER NOT NULL DEFAULT 0,
    last_posted_at TEXT,
    last_polled_at TEXT,
    note          TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (site, platform, persona)
);

CREATE TABLE IF NOT EXISTS sources (
    id            INTEGER PRIMARY KEY,
    site          TEXT NOT NULL,
    source_type   TEXT NOT NULL DEFAULT 'article',
    source_id     TEXT NOT NULL,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    summary       TEXT DEFAULT '',
    tags          TEXT DEFAULT '[]',
    image_url     TEXT,
    published_at  TEXT DEFAULT '',
    first_seen_at TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'new',
    UNIQUE (site, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS posts (
    id             INTEGER PRIMARY KEY,
    site           TEXT NOT NULL,
    platform       TEXT NOT NULL,
    channel_id     INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    kind           TEXT NOT NULL DEFAULT 'post',      -- post | reply
    status         TEXT NOT NULL DEFAULT 'draft',     -- draft|pending|approved|scheduled|publishing|posted|failed|rejected|cancelled
    body           TEXT NOT NULL,
    link           TEXT,
    media          TEXT DEFAULT '[]',
    source_type    TEXT,
    source_id      TEXT,
    mention_id     INTEGER REFERENCES mentions(id) ON DELETE SET NULL,
    reply_to_remote_id TEXT,
    scheduled_at   TEXT,
    posted_at      TEXT,
    remote_id      TEXT,
    remote_url     TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    error          TEXT,
    origin         TEXT NOT NULL DEFAULT 'ai',        -- ai | human | rule
    ai_model       TEXT,
    approved_by    TEXT,
    approved_at    TEXT,
    likes          INTEGER,
    reposts        INTEGER,
    replies        INTEGER,
    metrics_at     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_due ON posts (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_site ON posts (site, status);
CREATE INDEX IF NOT EXISTS idx_posts_source ON posts (site, platform, source_type, source_id);

CREATE TABLE IF NOT EXISTS mentions (
    id                INTEGER PRIMARY KEY,
    site              TEXT NOT NULL,
    platform          TEXT NOT NULL,
    channel_id        INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    remote_id         TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'mention',  -- mention | reply | comment
    author            TEXT,
    author_handle     TEXT,
    text              TEXT NOT NULL DEFAULT '',
    url               TEXT,
    parent_remote_id  TEXT,
    remote_created_at TEXT,
    fetched_at        TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'new',      -- new|drafted|answered|ignored|blocked
    reply_post_id     INTEGER,
    UNIQUE (platform, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_status ON mentions (site, status);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,
    site        TEXT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    ok          INTEGER,
    stats       TEXT DEFAULT '{}',
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY,
    ts        TEXT NOT NULL,
    site      TEXT,
    kind      TEXT NOT NULL,
    ref_type  TEXT,
    ref_id    INTEGER,
    message   TEXT DEFAULT '',
    data      TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    """Thread-local connection — FastAPI serves on a threadpool and sqlite3
    connections are not shareable across threads."""
    path = db_path()
    key = f"conn::{path}"
    conn = getattr(_local, key, None)
    if conn is not None:
        return conn
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    setattr(_local, key, conn)
    return conn


#: Columns added after the first release. `CREATE TABLE IF NOT EXISTS` does
#: nothing for an existing database, so new columns are added here instead.
#: Additive only — never a destructive migration on a live queue.
MIGRATIONS: list[tuple[str, str, str]] = [
    ("posts", "likes", "INTEGER"),
    ("posts", "reposts", "INTEGER"),
    ("posts", "replies", "INTEGER"),
    ("posts", "metrics_at", "TEXT"),
]


def _migrate(conn: sqlite3.Connection) -> None:
    for table, column, decl in MIGRATIONS:
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def reset_connections() -> None:
    """Drop cached handles — used by tests that repoint SOCIAL_HUB_DB."""
    for key in [k for k in vars(_local) if k.startswith("conn::")]:
        try:
            getattr(_local, key).close()
        except Exception:
            pass
        delattr(_local, key)


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def query(sql: str, params: tuple | dict = ()) -> list[sqlite3.Row]:
    return connect().execute(sql, params).fetchall()


def one(sql: str, params: tuple | dict = ()) -> sqlite3.Row | None:
    return connect().execute(sql, params).fetchone()


def execute(sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
    return connect().execute(sql, params)


def insert(table: str, data: dict[str, Any]) -> int:
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)
    cur = execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(data.values()))
    return int(cur.lastrowid)


def update(table: str, row_id: int, data: dict[str, Any]) -> None:
    if not data:
        return
    if "updated_at" not in data and _has_column(table, "updated_at"):
        data = {**data, "updated_at": utcnow()}
    sets = ", ".join(f"{k} = ?" for k in data)
    execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*data.values(), row_id))


def _has_column(table: str, column: str) -> bool:
    return any(r["name"] == column for r in query(f"PRAGMA table_info({table})"))


def log_event(
    kind: str,
    *,
    site: str | None = None,
    ref_type: str | None = None,
    ref_id: int | None = None,
    message: str = "",
    data: dict | None = None,
) -> int:
    return insert(
        "events",
        {
            "ts": utcnow(),
            "site": site,
            "kind": kind,
            "ref_type": ref_type,
            "ref_id": ref_id,
            "message": message,
            "data": json.dumps(data or {}),
        },
    )


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    out = dict(row)
    for key in ("tags", "media", "stats", "data"):
        if key in out and isinstance(out[key], str):
            try:
                out[key] = json.loads(out[key])
            except (ValueError, TypeError):
                pass
    return out


def rows_to_dicts(rows) -> list[dict]:
    return [row_to_dict(r) for r in rows]
