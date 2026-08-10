"""SQLite store for product-feed.

One table (`candidates`). Each row is a sourced-and-judged product a site's
own scout/judge pipeline decided fits its brand — the hub does no sourcing
or judging itself, it just stores the result and routes it to whichever
subscriber's tags match, one claim at a time.

Concurrency note: `claim_next` is the only mutating read — it runs inside a
BEGIN IMMEDIATE transaction so two simultaneous callers can't claim the same
row. Everything else is a single INSERT/UPDATE, already atomic under
sqlite3's default isolation.
"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS candidates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    site_origin  TEXT NOT NULL,
    asin         TEXT,
    tags         TEXT NOT NULL,   -- JSON list[str]
    candidate    TEXT NOT NULL,   -- JSON: raw sourcing payload (title/price/rating/image_source_url/...)
    decision     TEXT NOT NULL,   -- JSON: judged catalog copy (name/tagline/body/category/...)
    status       TEXT NOT NULL DEFAULT 'queued',  -- queued | claimed | published | rejected | failed
    claimed_by   TEXT,
    created_at   TEXT NOT NULL,
    claimed_at   TEXT,
    published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_site_origin ON candidates(site_origin);
"""

STATUSES = {"queued", "claimed", "published", "rejected", "failed"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tags"] = json.loads(d["tags"])
    d["candidate"] = json.loads(d["candidate"])
    d["decision"] = json.loads(d["decision"])
    return d


def add_candidate(
    conn: sqlite3.Connection,
    *,
    site_origin: str,
    asin: str | None,
    tags: list[str],
    candidate: dict,
    decision: dict,
) -> int:
    cur = conn.execute(
        "INSERT INTO candidates (site_origin, asin, tags, candidate, decision, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, 'queued', ?)",
        (site_origin, asin, json.dumps(tags), json.dumps(candidate), json.dumps(decision), _now()),
    )
    conn.commit()
    return cur.lastrowid


def claim_next(
    conn: sqlite3.Connection,
    *,
    tags_any: list[str],
    site_origin_allow: list[str] | None,
    claimed_by: str,
) -> dict | None:
    """Atomically claim the oldest queued candidate matching this
    subscription. Returns the claimed row as a dict, or None if nothing
    matches."""
    if not tags_any:
        return None

    conn.execute("BEGIN IMMEDIATE")
    try:
        rows = conn.execute(
            "SELECT * FROM candidates WHERE status = 'queued' ORDER BY created_at ASC"
        ).fetchall()
        tag_set = set(tags_any)
        for row in rows:
            row_tags = set(json.loads(row["tags"]))
            if not (row_tags & tag_set):
                continue
            if site_origin_allow is not None and row["site_origin"] not in site_origin_allow:
                continue
            conn.execute(
                "UPDATE candidates SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?",
                (claimed_by, _now(), row["id"]),
            )
            conn.commit()
            claimed = conn.execute("SELECT * FROM candidates WHERE id = ?", (row["id"],)).fetchone()
            return _row_to_dict(claimed)
        conn.commit()  # no match — release the transaction cleanly
        return None
    except Exception:
        conn.rollback()
        raise


def mark_status(conn: sqlite3.Connection, candidate_id: int, status: str) -> bool:
    if status not in STATUSES:
        raise ValueError(f"invalid status {status!r}")

    if status == "queued":
        # Releasing a claimed item back to the queue (e.g. publish failed,
        # retry later) — clear claim markers so it doesn't look permanently
        # "claimed" in listings/stats.
        cur = conn.execute(
            "UPDATE candidates SET status = 'queued', claimed_by = NULL, claimed_at = NULL WHERE id = ?",
            (candidate_id,),
        )
    elif status == "published":
        cur = conn.execute(
            "UPDATE candidates SET status = 'published', published_at = ? WHERE id = ?",
            (_now(), candidate_id),
        )
    else:
        cur = conn.execute("UPDATE candidates SET status = ? WHERE id = ?", (status, candidate_id))

    conn.commit()
    return cur.rowcount > 0


def get_candidate(conn: sqlite3.Connection, candidate_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM candidates WHERE id = ?", (candidate_id,)).fetchone()
    return _row_to_dict(row) if row else None


def list_candidates(
    conn: sqlite3.Connection,
    *,
    status: str | None = None,
    site_origin: str | None = None,
    tag: str | None = None,
    limit: int = 100,
) -> list[dict]:
    clauses, params = [], []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if site_origin:
        clauses.append("site_origin = ?")
        params.append(site_origin)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM candidates {where} ORDER BY created_at DESC LIMIT ?", (*params, limit)
    ).fetchall()
    out = [_row_to_dict(r) for r in rows]
    if tag:
        out = [r for r in out if tag in r["tags"]]
    return out


def active_depth(conn: sqlite3.Connection, *, tags_any: list[str]) -> int:
    """Count of queued+claimed candidates matching any of these tags — the
    number a producer should compare against a subscription's
    max_queue_depth before sourcing more."""
    if not tags_any:
        return 0
    rows = conn.execute("SELECT tags FROM candidates WHERE status IN ('queued', 'claimed')").fetchall()
    tag_set = set(tags_any)
    return sum(1 for r in rows if set(json.loads(r["tags"])) & tag_set)


def stats(conn: sqlite3.Connection) -> dict:
    rows = conn.execute(
        "SELECT site_origin, status, COUNT(*) AS n FROM candidates GROUP BY site_origin, status"
    ).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        out.setdefault(r["site_origin"], {}).update({r["status"]: r["n"]})
    return out
