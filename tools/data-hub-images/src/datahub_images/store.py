import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_image_key TEXT,
  blob_path TEXT,
  width INTEGER,
  height INTEGER,
  phash TEXT,
  score REAL,
  license TEXT,
  credit_json TEXT,
  topics_json TEXT,
  tags_json TEXT,
  entropy REAL,
  status TEXT NOT NULL DEFAULT 'active',
  fetched_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_fetched_at ON images(fetched_at);

CREATE TABLE IF NOT EXISTS seen_sources (
  source_image_key TEXT PRIMARY KEY,
  image_id TEXT,
  first_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  image_id TEXT NOT NULL,
  site TEXT NOT NULL,
  slug TEXT,
  topic TEXT,
  assigned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_image_ts ON assignments(image_id, assigned_at);
CREATE INDEX IF NOT EXISTS idx_assignments_site_ts ON assignments(site, assigned_at);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  topic TEXT,
  keywords_json TEXT,
  slug TEXT,
  count INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  requested_at TEXT,
  served_at TEXT,
  client_ip TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

CREATE TABLE IF NOT EXISTS egress_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  source_id TEXT,
  target_host TEXT,
  policy TEXT,
  exit_node TEXT,
  exit_ip TEXT,
  status TEXT,
  item_count INTEGER DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_egress_ts ON egress_log(ts DESC);

CREATE TABLE IF NOT EXISTS pull_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  site TEXT,
  endpoint TEXT,
  item_count INTEGER DEFAULT 0,
  client_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_pull_ts ON pull_log(ts DESC);

CREATE TABLE IF NOT EXISTS sources_state (
  source_id TEXT PRIMARY KEY,
  last_fetch_at TEXT,
  last_status TEXT,
  last_error TEXT,
  stale INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_overrides (
  source_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS blacklist_phash (
  phash TEXT PRIMARY KEY,
  image_id TEXT,
  blacklisted_at TEXT
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def _image_row_to_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["credit"] = json.loads(d.pop("credit_json") or "{}")
    d["topics"] = json.loads(d.pop("topics_json") or "[]")
    d["tags"] = json.loads(d.pop("tags_json") or "[]")
    return d


def upsert_image(conn: sqlite3.Connection, image: dict) -> bool:
    """Insert a new image row. Returns True if inserted, False if the id
    already existed (INSERT OR IGNORE dedup by primary key)."""
    cur = conn.execute(
        "INSERT OR IGNORE INTO images "
        "(id, source_id, source_image_key, blob_path, width, height, phash, score, "
        " license, credit_json, topics_json, tags_json, entropy, status, fetched_at, last_used_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            image["id"], image.get("source_id"), image.get("source_image_key"),
            image.get("blob_path"), image.get("width"), image.get("height"),
            image.get("phash"), image.get("score"), image.get("license"),
            json.dumps(image.get("credit") or {}),
            json.dumps(image.get("topics") or []),
            json.dumps(image.get("tags") or []),
            image.get("entropy"), image.get("status", "active"),
            image.get("fetched_at"), image.get("last_used_at"),
        ),
    )
    conn.commit()
    return cur.rowcount > 0


def seen_source(conn: sqlite3.Connection, source_image_key: str) -> str | None:
    row = conn.execute(
        "SELECT image_id FROM seen_sources WHERE source_image_key = ?", (source_image_key,)
    ).fetchone()
    return row["image_id"] if row else None


def mark_seen(conn: sqlite3.Connection, source_image_key: str, image_id: str, ts: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO seen_sources (source_image_key, image_id, first_seen_at) VALUES (?,?,?)",
        (source_image_key, image_id, ts),
    )
    conn.commit()


def pool_for_topic(conn: sqlite3.Connection, topic: str, statuses=("active",)) -> list[dict]:
    placeholders = ",".join("?" * len(statuses))
    sql = (
        f"SELECT * FROM images WHERE status IN ({placeholders}) "
        "AND EXISTS (SELECT 1 FROM json_each(images.topics_json) WHERE value = ?) "
        "ORDER BY score ASC"
    )
    rows = conn.execute(sql, (*statuses, topic)).fetchall()
    return [_image_row_to_dict(r) for r in rows]


def pool_depth(conn: sqlite3.Connection, topic: str, statuses=("active",)) -> int:
    return len(pool_for_topic(conn, topic, statuses=statuses))


def record_assignment(conn: sqlite3.Connection, image_id: str, site: str, slug: str, topic: str, ts: str) -> None:
    conn.execute(
        "INSERT INTO assignments (image_id, site, slug, topic, assigned_at) VALUES (?,?,?,?,?)",
        (image_id, site, slug, topic, ts),
    )
    conn.commit()


def set_last_used(conn: sqlite3.Connection, image_id: str, ts: str) -> None:
    conn.execute("UPDATE images SET last_used_at = ? WHERE id = ?", (ts, image_id))
    conn.commit()


def assignments_for_image(conn: sqlite3.Connection, image_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT id, image_id, site, slug, topic, assigned_at FROM assignments "
        "WHERE image_id = ? ORDER BY assigned_at DESC",
        (image_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def site_recent_assignments(conn: sqlite3.Connection, site: str, since_iso: str) -> list[dict]:
    rows = conn.execute(
        "SELECT id, image_id, site, slug, topic, assigned_at FROM assignments "
        "WHERE site = ? AND assigned_at >= ? ORDER BY assigned_at DESC",
        (site, since_iso),
    ).fetchall()
    return [dict(r) for r in rows]


def create_request(conn: sqlite3.Connection, site: str, topic: str, keywords: list,
                    count: int, ts: str, client_ip: str, slug: str | None = None) -> int:
    cur = conn.execute(
        "INSERT INTO requests (site, topic, keywords_json, slug, count, status, requested_at, client_ip) "
        "VALUES (?,?,?,?,?, 'pending', ?, ?)",
        (site, topic, json.dumps(keywords or []), slug, count, ts, client_ip),
    )
    conn.commit()
    return cur.lastrowid


def get_request(conn: sqlite3.Connection, request_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
    if row is None:
        return None
    d = dict(row)
    d["keywords"] = json.loads(d.pop("keywords_json") or "[]")
    d["result"] = json.loads(d.pop("result_json") or "null")
    return d


def pending_requests(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM requests WHERE status = 'pending' ORDER BY requested_at ASC"
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["keywords"] = json.loads(d.pop("keywords_json") or "[]")
        d["result"] = json.loads(d.pop("result_json") or "null")
        out.append(d)
    return out


def finish_request(conn: sqlite3.Connection, req_id: int, status: str, result: dict, ts: str) -> None:
    conn.execute(
        "UPDATE requests SET status = ?, result_json = ?, served_at = ? WHERE id = ?",
        (status, json.dumps(result if result is not None else {}), ts, req_id),
    )
    conn.commit()


def record_egress(conn: sqlite3.Connection, **row) -> None:
    conn.execute(
        "INSERT INTO egress_log (ts, source_id, target_host, policy, exit_node, exit_ip, status, item_count, note) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            row.get("ts") or _now(), row.get("source_id"), row.get("target_host"),
            row.get("policy"), row.get("exit_node"), row.get("exit_ip"),
            row.get("status"), row.get("item_count", 0), row.get("note", ""),
        ),
    )
    conn.commit()


def record_pull(conn: sqlite3.Connection, **row) -> None:
    conn.execute(
        "INSERT INTO pull_log (ts, site, endpoint, item_count, client_ip) VALUES (?,?,?,?,?)",
        (
            row.get("ts") or _now(), row.get("site", ""), row.get("endpoint", ""),
            row.get("item_count", 0), row.get("client_ip", ""),
        ),
    )
    conn.commit()


def get_image(conn: sqlite3.Connection, image_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    return _image_row_to_dict(row) if row else None


def list_images(conn: sqlite3.Connection, topic: str | None = None, status: str | None = None,
                 limit: int = 100) -> list[dict]:
    where, params = [], []
    if status:
        where.append("status = ?")
        params.append(status)
    if topic:
        where.append("EXISTS (SELECT 1 FROM json_each(images.topics_json) WHERE value = ?)")
        params.append(topic)
    sql = "SELECT * FROM images"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY fetched_at DESC LIMIT ?"
    params.append(int(limit))
    return [_image_row_to_dict(r) for r in conn.execute(sql, params).fetchall()]


def delete_image(conn: sqlite3.Connection, image_id: str) -> bool:
    """Hard-remove one image row (curation reject). Does not touch the blob
    file or blacklist_phash — use blacklist_image for that."""
    cur = conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
    conn.commit()
    return cur.rowcount > 0


def query_egress(conn: sqlite3.Connection, since_iso: str | None = None, limit: int = 200,
                  policy: str | None = None) -> list[dict]:
    where, params = [], []
    if since_iso:
        where.append("ts >= ?")
        params.append(since_iso)
    if policy:
        where.append("policy = ?")
        params.append(policy)
    sql = "SELECT * FROM egress_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def query_pulls(conn: sqlite3.Connection, since_iso: str | None = None, limit: int = 200,
                 site: str | None = None) -> list[dict]:
    where, params = [], []
    if since_iso:
        where.append("ts >= ?")
        params.append(since_iso)
    if site:
        where.append("site = ?")
        params.append(site)
    sql = "SELECT * FROM pull_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def get_sources_state(conn: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT source_id, last_fetch_at, last_status AS status, last_error AS error, "
        "stale, consecutive_failures FROM sources_state ORDER BY source_id"
    ).fetchall()]


def set_source_override(conn: sqlite3.Connection, *, source_id: str, enabled: bool) -> None:
    conn.execute(
        "INSERT INTO source_overrides (source_id, enabled, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(source_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at",
        (source_id, 1 if enabled else 0, _now()),
    )
    conn.commit()


def clear_source_override(conn: sqlite3.Connection, *, source_id: str) -> None:
    conn.execute("DELETE FROM source_overrides WHERE source_id = ?", (source_id,))
    conn.commit()


def get_source_overrides(conn: sqlite3.Connection) -> dict:
    return {r["source_id"]: bool(r["enabled"]) for r in conn.execute(
        "SELECT source_id, enabled FROM source_overrides"
    ).fetchall()}


def blacklist_image(conn: sqlite3.Connection, image_id: str) -> None:
    row = conn.execute("SELECT phash FROM images WHERE id = ?", (image_id,)).fetchone()
    conn.execute("UPDATE images SET status = 'blacklisted' WHERE id = ?", (image_id,))
    if row and row["phash"]:
        conn.execute(
            "INSERT OR IGNORE INTO blacklist_phash (phash, image_id, blacklisted_at) VALUES (?,?,?)",
            (row["phash"], image_id, _now()),
        )
    conn.commit()


def is_blacklisted_phash(conn: sqlite3.Connection, phash: str) -> bool:
    row = conn.execute("SELECT 1 FROM blacklist_phash WHERE phash = ?", (phash,)).fetchone()
    return row is not None


def prune(conn: sqlite3.Connection, pool_ttl_days: int, retention_days: int, now: str) -> dict:
    """Delete unused, expired active images (and their blobs) plus trim
    time-series audit logs. Never touches assigned/used images or blacklist
    entries. Returns {table: rows_deleted}."""
    now_dt = datetime.fromisoformat(now.replace("Z", "+00:00"))
    pool_cutoff = (now_dt - timedelta(days=pool_ttl_days)).isoformat()
    retention_cutoff = (now_dt - timedelta(days=retention_days)).isoformat()

    candidates = conn.execute(
        "SELECT id, blob_path FROM images WHERE status = 'active' "
        "AND last_used_at IS NULL AND fetched_at < ? "
        "AND id NOT IN (SELECT DISTINCT image_id FROM assignments)",
        (pool_cutoff,),
    ).fetchall()

    images_deleted = 0
    for row in candidates:
        blob_path = row["blob_path"]
        if blob_path and os.path.exists(blob_path):
            try:
                os.remove(blob_path)
            except OSError:
                pass
        cur = conn.execute("DELETE FROM images WHERE id = ?", (row["id"],))
        images_deleted += cur.rowcount

    egress_cur = conn.execute("DELETE FROM egress_log WHERE ts < ?", (retention_cutoff,))
    pull_cur = conn.execute("DELETE FROM pull_log WHERE ts < ?", (retention_cutoff,))
    conn.commit()

    return {
        "images": images_deleted,
        "egress_log": egress_cur.rowcount,
        "pull_log": pull_cur.rowcount,
    }
