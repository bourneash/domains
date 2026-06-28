import json
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_name TEXT,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  summary TEXT,
  published_iso TEXT,
  fetched_at TEXT,
  tags TEXT,            -- JSON array
  raw TEXT              -- JSON object
);
CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_iso DESC);

CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  dataset_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload TEXT,
  tags TEXT,
  UNIQUE(source_id, dataset_key, observed_at)
);

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
  byte_count INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_egress_ts ON egress_log(ts DESC);

CREATE TABLE IF NOT EXISTS sources_state (
  source_id TEXT PRIMARY KEY,
  last_fetch_at TEXT,
  last_status TEXT,
  last_error TEXT,
  stale INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS seen_urls (
  url TEXT PRIMARY KEY,
  first_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS source_overrides (
  source_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS pull_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  site TEXT,
  endpoint TEXT,
  item_count INTEGER DEFAULT 0,
  client_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_pull_ts ON pull_log(ts DESC);
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


def upsert_items(conn: sqlite3.Connection, items: list[dict]) -> int:
    inserted = 0
    now = _now()
    for it in items:
        url = (it.get("url") or "").strip()
        if not url:
            continue
        seen = conn.execute("SELECT 1 FROM seen_urls WHERE url = ?", (url,)).fetchone()
        if seen:
            continue
        conn.execute(
            "INSERT OR IGNORE INTO items "
            "(source_id, source_name, url, title, summary, published_iso, fetched_at, tags, raw) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (it.get("source_id"), it.get("source_name"), url, it.get("title"),
             it.get("summary"), it.get("published_iso"), now,
             json.dumps(it.get("tags", [])), json.dumps(it.get("raw", {}))),
        )
        conn.execute("INSERT OR IGNORE INTO seen_urls (url, first_seen_at) VALUES (?, ?)", (url, now))
        inserted += 1
    conn.commit()
    return inserted


def query_items(conn, tags_any=None, tags_all=None, include_sources=None,
                exclude_sources=None, since_iso=None, limit=200) -> list[dict]:
    where = []
    params: list = []
    if tags_any:
        sub = " OR ".join(["EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value = ?)"] * len(tags_any))
        where.append(f"({sub})")
        params.extend(tags_any)
    if tags_all:
        for t in tags_all:
            where.append("EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value = ?)")
            params.append(t)
    if include_sources:
        where.append("source_id IN (%s)" % ",".join("?" * len(include_sources)))
        params.extend(include_sources)
    if exclude_sources:
        where.append("source_id NOT IN (%s)" % ",".join("?" * len(exclude_sources)))
        params.extend(exclude_sources)
    if since_iso:
        where.append("published_iso >= ?")
        params.append(since_iso)
    sql = "SELECT * FROM items"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY published_iso DESC LIMIT ?"
    params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()
    out = []
    for r in rows:
        out.append({
            "title": r["title"], "url": r["url"], "summary": r["summary"],
            "published_iso": r["published_iso"], "source": r["source_name"],
            "source_id": r["source_id"], "tags": json.loads(r["tags"] or "[]"),
        })
    return out


def record_egress(conn, *, source_id, target_host, policy, exit_node, exit_ip,
                  status, item_count=0, byte_count=0, duration_ms=0, note="") -> None:
    conn.execute(
        "INSERT INTO egress_log "
        "(ts, source_id, target_host, policy, exit_node, exit_ip, status, item_count, byte_count, duration_ms, note) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (_now(), source_id, target_host, policy, exit_node, exit_ip, status,
         item_count, byte_count, duration_ms, note),
    )
    conn.commit()


def record_pull(conn, *, site="", endpoint="", item_count=0, client_ip="") -> None:
    """Record an inbound consumer pull (a site/agent querying the hub API): which
    endpoint, how many items it received, from which client IP, and when. The
    inbound counterpart to record_egress (which logs the hub's outbound fetches)."""
    conn.execute(
        "INSERT INTO pull_log (ts, site, endpoint, item_count, client_ip) VALUES (?,?,?,?,?)",
        (_now(), site, endpoint, int(item_count), client_ip),
    )
    conn.commit()


def query_pulls(conn, since_iso=None, limit=200, site=None) -> list[dict]:
    where, params = [], []
    if since_iso:
        where.append("ts >= ?"); params.append(since_iso)
    if site:
        where.append("site = ?"); params.append(site)
    sql = "SELECT ts, site, endpoint, item_count, client_ip FROM pull_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def query_egress(conn, since_iso=None, limit=200, policy=None) -> list[dict]:
    where, params = [], []
    if since_iso:
        where.append("ts >= ?"); params.append(since_iso)
    if policy:
        where.append("policy = ?"); params.append(policy)
    sql = "SELECT * FROM egress_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def set_source_state(conn, *, source_id, status, error="", stale=False) -> None:
    failures_expr = "0" if status == "ok" else "consecutive_failures + 1"
    conn.execute(
        f"INSERT INTO sources_state (source_id, last_fetch_at, last_status, last_error, stale, consecutive_failures) "
        f"VALUES (?, ?, ?, ?, ?, CASE WHEN ?='ok' THEN 0 ELSE 1 END) "
        f"ON CONFLICT(source_id) DO UPDATE SET "
        f"last_fetch_at=excluded.last_fetch_at, last_status=excluded.last_status, "
        f"last_error=excluded.last_error, stale=excluded.stale, "
        f"consecutive_failures=CASE WHEN excluded.last_status='ok' THEN 0 ELSE {failures_expr} END",
        (source_id, _now(), status, error, 1 if stale else 0, status),
    )
    conn.commit()


def get_sources_state(conn) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT source_id, last_fetch_at, last_status AS status, last_error AS error, "
        "stale, consecutive_failures FROM sources_state ORDER BY source_id"
    ).fetchall()]


def set_source_override(conn, *, source_id: str, enabled: bool) -> None:
    """Persist a runtime enabled/disabled override for a source (survives image
    rebuilds via the mounted DB; the collector applies it each cycle, the UI
    toggles it). Overrides the registry's declared `enabled` default."""
    conn.execute(
        "INSERT INTO source_overrides (source_id, enabled, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(source_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at",
        (source_id, 1 if enabled else 0, _now()),
    )
    conn.commit()


def clear_source_override(conn, *, source_id: str) -> None:
    """Remove a source's runtime override so the registry default governs again."""
    conn.execute("DELETE FROM source_overrides WHERE source_id=?", (source_id,))
    conn.commit()


def get_source_overrides(conn) -> dict:
    """Map of source_id -> bool for every source with a runtime override set."""
    return {r["source_id"]: bool(r["enabled"]) for r in conn.execute(
        "SELECT source_id, enabled FROM source_overrides"
    ).fetchall()}


def upsert_datasets(conn, source_id: str, dataset_key: str, tags: list, records: list[dict]) -> int:
    inserted = 0
    tags_json = json.dumps(tags or [])
    for rec in records:
        observed_at = rec.get("observed_at")
        if not observed_at:
            continue
        cur = conn.execute(
            "INSERT OR IGNORE INTO datasets (source_id, dataset_key, observed_at, payload, tags) "
            "VALUES (?,?,?,?,?)",
            (source_id, dataset_key, observed_at, json.dumps(rec.get("payload", {})), tags_json),
        )
        if cur.rowcount:
            inserted += 1
    conn.commit()
    return inserted


def query_datasets(conn, dataset_key: str, since_iso=None, limit=50) -> list[dict]:
    where = ["dataset_key = ?"]
    params: list = [dataset_key]
    if since_iso:
        where.append("observed_at >= ?")
        params.append(since_iso)
    sql = ("SELECT source_id, dataset_key, observed_at, payload, tags FROM datasets "
           "WHERE " + " AND ".join(where) + " ORDER BY observed_at DESC LIMIT ?")
    params.append(int(limit))
    out = []
    for r in conn.execute(sql, params).fetchall():
        out.append({
            "source_id": r["source_id"], "dataset_key": r["dataset_key"],
            "observed_at": r["observed_at"], "payload": json.loads(r["payload"] or "{}"),
            "tags": json.loads(r["tags"] or "[]"),
        })
    return out


def dataset_keys(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT dataset_key, COUNT(*) AS count, MAX(observed_at) AS latest_observed_at "
        "FROM datasets GROUP BY dataset_key ORDER BY dataset_key"
    ).fetchall()
    return [dict(r) for r in rows]
