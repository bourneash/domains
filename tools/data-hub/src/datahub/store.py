import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone


# FastAPI serves requests on multiple worker threads while this service keeps
# one long-lived connection for its read-heavy API.  SQLite connections are
# thread-shareable here, but transaction boundaries are not: two audit writes
# can otherwise interleave and one thread can commit the other thread's
# transaction.  Keep the small API-side write operations serialized; the
# collector is a separate process/connection and remains protected by WAL.
_WRITE_LOCK = threading.RLock()

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
  raw TEXT,             -- JSON object
  content TEXT          -- best-effort full article text (empty if not fetched/extracted)
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
  consecutive_failures INTEGER DEFAULT 0,
  fulltext_attempts INTEGER DEFAULT 0,  -- full_text-enabled sources only; see record_fulltext_result
  fulltext_hits INTEGER DEFAULT 0       -- attempts that yielded real content, not "" -- a source
                                        -- stuck at 0 hits over many attempts is paywalled/broken,
                                        -- burning VPN egress for nothing
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

CREATE TABLE IF NOT EXISTS ga4_metrics (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  grain TEXT NOT NULL,
  dim_key TEXT NOT NULL DEFAULT '',
  sessions INTEGER,
  users INTEGER,
  new_users INTEGER,
  views INTEGER,
  engaged_sessions INTEGER,
  engagement_rate REAL,
  avg_session_duration REAL,
  conversions INTEGER,
  fetched_at TEXT NOT NULL,
  UNIQUE(site, date, grain, dim_key)
);
CREATE INDEX IF NOT EXISTS idx_ga4_metrics_site_date ON ga4_metrics(site, date);
CREATE INDEX IF NOT EXISTS idx_ga4_metrics_lookup ON ga4_metrics(site, grain, dim_key);

CREATE TABLE IF NOT EXISTS gsc_metrics (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  grain TEXT NOT NULL,
  dim_key TEXT NOT NULL DEFAULT '',
  clicks INTEGER,
  impressions INTEGER,
  ctr REAL,
  position REAL,
  fetched_at TEXT NOT NULL,
  UNIQUE(site, date, grain, dim_key)
);
CREATE INDEX IF NOT EXISTS idx_gsc_metrics_site_date ON gsc_metrics(site, date);
CREATE INDEX IF NOT EXISTS idx_gsc_metrics_lookup ON gsc_metrics(site, grain, dim_key);

CREATE TABLE IF NOT EXISTS gsc_query_page_metrics (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER,
  impressions INTEGER,
  ctr REAL,
  position REAL,
  fetched_at TEXT NOT NULL,
  UNIQUE(site, date, query, page)
);
CREATE INDEX IF NOT EXISTS idx_gsc_query_page_site_date ON gsc_query_page_metrics(site, date);
CREATE INDEX IF NOT EXISTS idx_gsc_query_page_lookup ON gsc_query_page_metrics(site, query, page);

CREATE TABLE IF NOT EXISTS fishing_report_sources (
  source_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  provenance TEXT NOT NULL,
  default_port TEXT,
  default_state TEXT,
  default_region TEXT,
  default_lat REAL,
  default_lon REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS fishing_reports (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES fishing_report_sources(source_id),
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  report_date TEXT NOT NULL,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  port TEXT,
  state TEXT,
  region TEXT,
  lat REAL,
  lon REAL,
  area TEXT,
  report_type TEXT NOT NULL DEFAULT 'charter',
  methods TEXT NOT NULL DEFAULT '[]',
  conditions TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_excerpt TEXT,
  raw TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_fishing_reports_date ON fishing_reports(report_date DESC);
CREATE INDEX IF NOT EXISTS idx_fishing_reports_location ON fishing_reports(state, region, port);
CREATE INDEX IF NOT EXISTS idx_fishing_reports_coords ON fishing_reports(lat, lon);

CREATE TABLE IF NOT EXISTS fishing_report_species (
  report_id INTEGER NOT NULL REFERENCES fishing_reports(id) ON DELETE CASCADE,
  species_slug TEXT NOT NULL,
  species_verbatim TEXT,
  catch_count INTEGER,
  disposition TEXT,
  min_size REAL,
  max_size REAL,
  size_unit TEXT,
  PRIMARY KEY(report_id, species_slug, species_verbatim)
);
CREATE INDEX IF NOT EXISTS idx_fishing_report_species_slug ON fishing_report_species(species_slug);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()


def _migrate(conn: sqlite3.Connection) -> None:
    """Additive, idempotent column migrations for DBs created before a column
    existed. CREATE TABLE IF NOT EXISTS (above) only helps a brand-new DB; an
    existing items table on disk needs ALTER TABLE to pick up new columns."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(items)").fetchall()}
    if "content" not in cols:
        conn.execute("ALTER TABLE items ADD COLUMN content TEXT")
    state_cols = {r["name"] for r in conn.execute("PRAGMA table_info(sources_state)").fetchall()}
    if "fulltext_attempts" not in state_cols:
        conn.execute("ALTER TABLE sources_state ADD COLUMN fulltext_attempts INTEGER DEFAULT 0")
    if "fulltext_hits" not in state_cols:
        conn.execute("ALTER TABLE sources_state ADD COLUMN fulltext_hits INTEGER DEFAULT 0")


# Data lifecycle: which table column carries each row's age. Pruning is by
# INGESTION/observation time (when it entered the store), not article publish
# date — so the DB never holds anything older than the retention horizon
# regardless of feed date quirks.
_PRUNE_COLUMNS = {
    "items": "fetched_at",
    "datasets": "observed_at",
    "egress_log": "ts",
    "pull_log": "ts",
    "seen_urls": "first_seen_at",
}


def prune(conn, retention_days: int = 7, report_retention_days: int = 365) -> dict:
    """Prune short-lived hub rows and independently retained fishing reports.

    Returns {table: rows_deleted}. Idempotent; safe to run every cycle.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    deleted = {}
    for table, col in _PRUNE_COLUMNS.items():
        cur = conn.execute(f"DELETE FROM {table} WHERE {col} IS NOT NULL AND {col} < ?", (cutoff,))
        deleted[table] = cur.rowcount
    report_cutoff = (datetime.now(timezone.utc) - timedelta(days=report_retention_days)).isoformat()
    cur = conn.execute(
        "DELETE FROM fishing_reports WHERE fetched_at IS NOT NULL AND fetched_at < ?",
        (report_cutoff,),
    )
    deleted["fishing_reports"] = cur.rowcount
    # Existing databases may have been opened before foreign_keys was enabled.
    conn.execute("DELETE FROM fishing_report_species WHERE report_id NOT IN (SELECT id FROM fishing_reports)")
    conn.commit()
    return deleted


def unseen_urls(conn: sqlite3.Connection, urls: list[str]) -> set[str]:
    """Which of `urls` are NOT already in seen_urls -- i.e. would actually be
    inserted by upsert_items. Lets a caller do expensive per-item work (like a
    full-text fetch) only for items that are genuinely new, instead of redoing
    it every cycle for the same already-stored articles fetch_rss keeps
    re-returning from the live feed."""
    urls = [u for u in urls if u]
    if not urls:
        return set()
    placeholders = ",".join("?" * len(urls))
    seen = {r["url"] for r in conn.execute(
        f"SELECT url FROM seen_urls WHERE url IN ({placeholders})", urls).fetchall()}
    return {u for u in urls if u not in seen}


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
            "(source_id, source_name, url, title, summary, published_iso, fetched_at, tags, raw, content) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (it.get("source_id"), it.get("source_name"), url, it.get("title"),
             it.get("summary"), it.get("published_iso"), now,
             json.dumps(it.get("tags", [])), json.dumps(it.get("raw", {})),
             it.get("content") or None),
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
            "content": r["content"] or "",
        })
    return out


def record_egress(conn, *, source_id, target_host, policy, exit_node, exit_ip,
                  status, item_count=0, byte_count=0, duration_ms=0, note="") -> None:
    with _WRITE_LOCK:
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
    with _WRITE_LOCK:
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
        "stale, consecutive_failures, fulltext_attempts, fulltext_hits "
        "FROM sources_state ORDER BY source_id"
    ).fetchall()]


def record_fulltext_result(conn, *, source_id: str, ok: bool) -> None:
    """Increment a full_text-enabled source's attempt/hit counters. Called once
    per item collector.py attempts extraction for (never for a source without
    `fetch.full_text: true`, since only those ever call extract.fetch_article_text).
    A source stuck at fulltext_hits=0 across many attempts -- surfaced via
    /sources and /health -- is silently burning VPN egress on a paywall/wall
    it will never get past, worth disabling `full_text` for in the registry."""
    conn.execute(
        "INSERT INTO sources_state (source_id, fulltext_attempts, fulltext_hits) VALUES (?, 1, ?) "
        "ON CONFLICT(source_id) DO UPDATE SET "
        "fulltext_attempts = fulltext_attempts + 1, "
        "fulltext_hits = fulltext_hits + excluded.fulltext_hits",
        (source_id, 1 if ok else 0),
    )
    conn.commit()


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


def upsert_fishing_report_source(conn, source: dict) -> None:
    """Register provenance for a fishing-report source.

    Network collectors and local seed adapters share this source record so every
    report returned by the API has an attributable owner and homepage.
    """
    conn.execute(
        "INSERT INTO fishing_report_sources "
        "(source_id,name,homepage_url,source_type,provenance,default_port,default_state,"
        "default_region,default_lat,default_lon,enabled,last_ingested_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(source_id) DO UPDATE SET name=excluded.name, homepage_url=excluded.homepage_url, "
        "source_type=excluded.source_type, provenance=excluded.provenance, "
        "default_port=excluded.default_port, default_state=excluded.default_state, "
        "default_region=excluded.default_region, default_lat=excluded.default_lat, "
        "default_lon=excluded.default_lon, enabled=excluded.enabled, "
        "last_ingested_at=excluded.last_ingested_at",
        (source["source_id"], source["name"], source["homepage_url"], source["source_type"],
         source["provenance"], source.get("default_port"), source.get("default_state"),
         source.get("default_region"), source.get("default_lat"), source.get("default_lon"),
         1 if source.get("enabled", True) else 0, _now()),
    )
    conn.commit()


def upsert_fishing_reports(conn, reports: list[dict]) -> int:
    """Insert or update normalized reports and replace their species facts."""
    changed = 0
    now = _now()
    for report in reports:
        cur = conn.execute(
            "INSERT INTO fishing_reports "
            "(source_id,external_id,url,title,summary,report_date,published_at,fetched_at,port,state,"
            "region,lat,lon,area,report_type,methods,conditions,confidence,evidence_excerpt,raw,"
            "content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(source_id,external_id) DO UPDATE SET "
            "url=excluded.url,title=excluded.title,summary=excluded.summary,report_date=excluded.report_date,"
            "published_at=excluded.published_at,fetched_at=excluded.fetched_at,port=excluded.port,"
            "state=excluded.state,region=excluded.region,lat=excluded.lat,lon=excluded.lon,area=excluded.area,"
            "report_type=excluded.report_type,methods=excluded.methods,conditions=excluded.conditions,"
            "confidence=excluded.confidence,evidence_excerpt=excluded.evidence_excerpt,raw=excluded.raw,"
            "content_hash=excluded.content_hash,updated_at=excluded.updated_at "
            "RETURNING id",
            (report["source_id"], report["external_id"], report["url"], report.get("title"),
             report.get("summary"), report["report_date"], report.get("published_at"),
             report.get("fetched_at") or now, report.get("port"), report.get("state"),
             report.get("region"), report.get("lat"), report.get("lon"), report.get("area"),
             report.get("report_type", "charter"), json.dumps(report.get("methods", [])),
             json.dumps(report.get("conditions", {})), float(report.get("confidence", 0.5)),
             report.get("evidence_excerpt"), json.dumps(report.get("raw", {})),
             report.get("content_hash"), now),
        )
        report_id = cur.fetchone()["id"]
        conn.execute("DELETE FROM fishing_report_species WHERE report_id=?", (report_id,))
        for species in report.get("species", []):
            conn.execute(
                "INSERT INTO fishing_report_species "
                "(report_id,species_slug,species_verbatim,catch_count,disposition,min_size,max_size,size_unit) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (report_id, species["species_slug"], species.get("species_verbatim", ""),
                 species.get("catch_count"), species.get("disposition"), species.get("min_size"),
                 species.get("max_size"), species.get("size_unit")),
            )
        changed += 1
    conn.commit()
    return changed


def query_fishing_reports(conn, *, species=None, state=None, port=None, region=None,
                          source_id=None, since=None, min_lat=None, max_lat=None,
                          min_lon=None, max_lon=None, limit=100) -> list[dict]:
    where, params = [], []
    filters = (("r.state", state), ("r.port", port), ("r.region", region),
               ("r.source_id", source_id))
    for col, value in filters:
        if value:
            where.append(f"{col} = ? COLLATE NOCASE"); params.append(value)
    if since:
        where.append("r.report_date >= ?"); params.append(since)
    for col, value, op in (("r.lat", min_lat, ">="), ("r.lat", max_lat, "<="),
                           ("r.lon", min_lon, ">="), ("r.lon", max_lon, "<=")):
        if value is not None:
            where.append(f"{col} {op} ?"); params.append(float(value))
    if species:
        where.append("EXISTS (SELECT 1 FROM fishing_report_species fs "
                     "WHERE fs.report_id=r.id AND fs.species_slug = ? COLLATE NOCASE)")
        params.append(species)
    sql = ("SELECT r.*,s.name AS source_name,s.homepage_url,s.source_type,s.provenance,"
           "s.last_ingested_at FROM fishing_reports r JOIN fishing_report_sources s "
           "ON s.source_id=r.source_id")
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY r.report_date DESC, r.published_at DESC LIMIT ?"
    params.append(min(int(limit), 500))
    out = []
    for row in conn.execute(sql, params).fetchall():
        item = dict(row)
        item["methods"] = json.loads(item.pop("methods") or "[]")
        item["conditions"] = json.loads(item.pop("conditions") or "{}")
        item["raw"] = json.loads(item.pop("raw") or "{}")
        item["species"] = [dict(r) for r in conn.execute(
            "SELECT species_slug,species_verbatim,catch_count,disposition,min_size,max_size,size_unit "
            "FROM fishing_report_species WHERE report_id=? ORDER BY species_slug", (item["id"],)
        ).fetchall()]
        out.append(item)
    return out


def fishing_report_sources(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT s.*, COUNT(r.id) AS report_count, MAX(r.report_date) AS latest_report_date "
        "FROM fishing_report_sources s LEFT JOIN fishing_reports r ON r.source_id=s.source_id "
        "GROUP BY s.source_id ORDER BY s.name"
    ).fetchall()
    return [dict(r) for r in rows]


def fishing_report_summary(conn, *, since=None) -> dict:
    params = []
    where = ""
    if since:
        where = " WHERE report_date >= ?"; params.append(since)
    row = conn.execute(
        "SELECT COUNT(*) AS report_count, COUNT(DISTINCT source_id) AS source_count, "
        "MAX(report_date) AS latest_report_date FROM fishing_reports" + where, params
    ).fetchone()
    species = conn.execute(
        "SELECT fs.species_slug,COUNT(DISTINCT fs.report_id) AS report_count "
        "FROM fishing_report_species fs JOIN fishing_reports r ON r.id=fs.report_id" +
        (" WHERE r.report_date >= ?" if since else "") +
        " GROUP BY fs.species_slug ORDER BY report_count DESC,species_slug LIMIT 25", params
    ).fetchall()
    return {**dict(row), "species": [dict(r) for r in species]}


def upsert_ga4_metrics(conn, site: str, records: list[dict]) -> int:
    now = _now()
    for r in records:
        conn.execute(
            "INSERT INTO ga4_metrics (site, date, grain, dim_key, sessions, users, new_users, views, "
            "engaged_sessions, engagement_rate, avg_session_duration, conversions, fetched_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(site, date, grain, dim_key) DO UPDATE SET "
            "sessions=excluded.sessions, users=excluded.users, new_users=excluded.new_users, "
            "views=excluded.views, engaged_sessions=excluded.engaged_sessions, "
            "engagement_rate=excluded.engagement_rate, avg_session_duration=excluded.avg_session_duration, "
            "conversions=excluded.conversions, fetched_at=excluded.fetched_at",
            (site, r["date"], r["grain"], r.get("dim_key", ""), r.get("sessions"), r.get("users"),
             r.get("new_users"), r.get("views"), r.get("engaged_sessions"), r.get("engagement_rate"),
             r.get("avg_session_duration"), r.get("conversions"), now),
        )
    conn.commit()
    return len(records)


def query_ga4_metrics(conn, site: str, *, grain: str = "site", dim_key: str | None = None,
                      since: str | None = None, until: str | None = None, limit: int = 400) -> list[dict]:
    where = ["site = ?", "grain = ?"]
    params: list = [site, grain]
    if dim_key is not None:
        where.append("dim_key = ?"); params.append(dim_key)
    if since:
        where.append("date >= ?"); params.append(since)
    if until:
        where.append("date <= ?"); params.append(until)
    sql = ("SELECT site, date, grain, dim_key, sessions, users, new_users, views, engaged_sessions, "
           "engagement_rate, avg_session_duration, conversions, fetched_at FROM ga4_metrics "
           "WHERE " + " AND ".join(where) + " ORDER BY date ASC LIMIT ?")
    params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def upsert_gsc_metrics(conn, site: str, records: list[dict]) -> int:
    now = _now()
    for r in records:
        conn.execute(
            "INSERT INTO gsc_metrics (site, date, grain, dim_key, clicks, impressions, ctr, position, fetched_at) "
            "VALUES (?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(site, date, grain, dim_key) DO UPDATE SET "
            "clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, "
            "position=excluded.position, fetched_at=excluded.fetched_at",
            (site, r["date"], r["grain"], r.get("dim_key", ""), r.get("clicks"), r.get("impressions"),
             r.get("ctr"), r.get("position"), now),
        )
    conn.commit()
    return len(records)


def query_gsc_metrics(conn, site: str, *, grain: str = "site", dim_key: str | None = None,
                      since: str | None = None, until: str | None = None, limit: int = 400) -> list[dict]:
    where = ["site = ?", "grain = ?"]
    params: list = [site, grain]
    if dim_key is not None:
        where.append("dim_key = ?"); params.append(dim_key)
    if since:
        where.append("date >= ?"); params.append(since)
    if until:
        where.append("date <= ?"); params.append(until)
    sql = ("SELECT site, date, grain, dim_key, clicks, impressions, ctr, position, fetched_at FROM gsc_metrics "
           "WHERE " + " AND ".join(where) + " ORDER BY date ASC LIMIT ?")
    params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def upsert_gsc_query_page_metrics(conn, site: str, records: list[dict]) -> int:
    now = _now()
    for r in records:
        conn.execute(
            "INSERT INTO gsc_query_page_metrics (site, date, query, page, clicks, impressions, ctr, position, fetched_at) "
            "VALUES (?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(site, date, query, page) DO UPDATE SET "
            "clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, "
            "position=excluded.position, fetched_at=excluded.fetched_at",
            (site, r["date"], r["query"], r["page"], r.get("clicks"), r.get("impressions"),
             r.get("ctr"), r.get("position"), now),
        )
    conn.commit()
    return len(records)


def query_gsc_query_page_metrics(conn, site: str, *, since: str | None = None,
                                 until: str | None = None, limit: int = 5000) -> list[dict]:
    where = ["site = ?"]
    params: list = [site]
    if since:
        where.append("date >= ?"); params.append(since)
    if until:
        where.append("date <= ?"); params.append(until)
    sql = ("SELECT site, date, query, page, clicks, impressions, ctr, position, fetched_at "
           "FROM gsc_query_page_metrics WHERE " + " AND ".join(where) +
           " ORDER BY date ASC LIMIT ?")
    params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params).fetchall()]
