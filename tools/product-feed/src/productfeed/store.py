"""SQLite store for product-feed.

The primary model is a shared inventory of Amazon products plus independent
per-site state.  A product is sourced and verified once, but Weird Girl Store,
Weird Ass Stuff, and future consumers can each review, queue, reject, and
publish it without racing one another for the same global row.

The original ``candidates`` table and helpers remain during the migration so
already queued site-owned candidates can still drain safely.

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

CREATE TABLE IF NOT EXISTS products (
    asin             TEXT PRIMARY KEY,
    amazon_url       TEXT NOT NULL,
    title            TEXT NOT NULL,
    price            TEXT,
    rating           REAL,
    review_count     INTEGER,
    image_url        TEXT,
    tags             TEXT NOT NULL,   -- JSON list[str], assigned by discovery query
    source_query     TEXT,
    source            TEXT NOT NULL DEFAULT 'amazon',
    metadata          TEXT NOT NULL DEFAULT '{}',
    first_seen_at     TEXT NOT NULL,
    last_verified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_verified ON products(last_verified_at);

CREATE TABLE IF NOT EXISTS site_product_state (
    site          TEXT NOT NULL,
    asin          TEXT NOT NULL REFERENCES products(asin),
    status        TEXT NOT NULL, -- reviewing | queued | publishing | rejected | published
    decision      TEXT,
    reason        TEXT,
    claimed_at    TEXT,
    updated_at    TEXT NOT NULL,
    published_at  TEXT,
    PRIMARY KEY (site, asin)
);
CREATE INDEX IF NOT EXISTS idx_site_product_status
ON site_product_state(site, status, updated_at);
"""

STATUSES = {"queued", "claimed", "published", "rejected", "failed"}
SITE_PRODUCT_STATUSES = {"reviewing", "queued", "publishing", "rejected", "published"}


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


def _product_row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tags"] = json.loads(d["tags"])
    d["metadata"] = json.loads(d["metadata"])
    return d


def _site_product_row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tags"] = json.loads(d["tags"])
    d["metadata"] = json.loads(d["metadata"])
    d["decision"] = json.loads(d["decision"]) if d.get("decision") else None
    return d


def canonical_amazon_url(asin: str) -> str:
    """Return the untagged, canonical product URL stored by the feed.

    Search URLs never enter the inventory. Consumers attach their own
    Associates tag to this ASIN when they publish it.
    """
    return f"https://www.amazon.com/dp/{asin}"


def upsert_product(
    conn: sqlite3.Connection,
    *,
    asin: str,
    title: str,
    tags: list[str],
    price: str | None = None,
    rating: float | None = None,
    review_count: int | None = None,
    image_url: str | None = None,
    source_query: str | None = None,
    source: str = "amazon",
    metadata: dict | None = None,
) -> tuple[dict, bool]:
    """Insert or refresh one verified product, keyed by ASIN.

    Returns ``(product, created)``. Tags are merged on refresh so a product
    discovered by more than one query remains visible to every matching site.
    """
    now = _now()
    existing = conn.execute("SELECT tags FROM products WHERE asin = ?", (asin,)).fetchone()
    existing_tags = json.loads(existing["tags"]) if existing else []
    merged_tags = sorted(set(existing_tags) | {str(tag) for tag in tags if tag})
    conn.execute(
        """
        INSERT INTO products (
            asin, amazon_url, title, price, rating, review_count, image_url,
            tags, source_query, source, metadata, first_seen_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asin) DO UPDATE SET
            amazon_url=excluded.amazon_url,
            title=excluded.title,
            price=COALESCE(excluded.price, products.price),
            rating=COALESCE(excluded.rating, products.rating),
            review_count=COALESCE(excluded.review_count, products.review_count),
            image_url=COALESCE(excluded.image_url, products.image_url),
            tags=excluded.tags,
            source_query=COALESCE(excluded.source_query, products.source_query),
            source=excluded.source,
            metadata=excluded.metadata,
            last_verified_at=excluded.last_verified_at
        """,
        (
            asin,
            canonical_amazon_url(asin),
            title,
            price,
            rating,
            review_count,
            image_url,
            json.dumps(merged_tags),
            source_query,
            source,
            json.dumps(metadata or {}),
            now,
            now,
        ),
    )
    conn.commit()
    return get_product(conn, asin), existing is None


def get_product(conn: sqlite3.Connection, asin: str) -> dict | None:
    row = conn.execute("SELECT * FROM products WHERE asin = ?", (asin,)).fetchone()
    return _product_row_to_dict(row) if row else None


def list_products(
    conn: sqlite3.Connection,
    *,
    tag: str | None = None,
    limit: int = 100,
) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM products ORDER BY last_verified_at DESC LIMIT ?", (limit,)
    ).fetchall()
    products = [_product_row_to_dict(row) for row in rows]
    return [p for p in products if tag in p["tags"]] if tag else products


def _matching_products(conn: sqlite3.Connection, tags_any: list[str]) -> list[sqlite3.Row]:
    if not tags_any:
        return []
    tag_set = set(tags_any)
    rows = conn.execute("SELECT * FROM products ORDER BY first_seen_at ASC").fetchall()
    return [row for row in rows if set(json.loads(row["tags"])) & tag_set]


def claim_product_for_review(
    conn: sqlite3.Connection, *, site: str, tags_any: list[str]
) -> dict | None:
    """Claim the oldest matching product this site has never considered.

    State is per-site, so another site may independently claim the same ASIN.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        for row in _matching_products(conn, tags_any):
            existing = conn.execute(
                "SELECT 1 FROM site_product_state WHERE site = ? AND asin = ?",
                (site, row["asin"]),
            ).fetchone()
            if existing:
                continue
            now = _now()
            conn.execute(
                """
                INSERT INTO site_product_state
                    (site, asin, status, claimed_at, updated_at)
                VALUES (?, ?, 'reviewing', ?, ?)
                """,
                (site, row["asin"], now, now),
            )
            conn.commit()
            return get_site_product(conn, site=site, asin=row["asin"])
        conn.commit()
        return None
    except Exception:
        conn.rollback()
        raise


def get_site_product(conn: sqlite3.Connection, *, site: str, asin: str) -> dict | None:
    row = conn.execute(
        """
        SELECT p.*, s.site, s.status, s.decision, s.reason, s.claimed_at,
               s.updated_at, s.published_at
        FROM site_product_state s
        JOIN products p ON p.asin = s.asin
        WHERE s.site = ? AND s.asin = ?
        """,
        (site, asin),
    ).fetchone()
    return _site_product_row_to_dict(row) if row else None


def set_site_product_status(
    conn: sqlite3.Connection,
    *,
    site: str,
    asin: str,
    status: str,
    decision: dict | None = None,
    reason: str | None = None,
) -> bool:
    if status not in SITE_PRODUCT_STATUSES:
        raise ValueError(f"invalid site product status {status!r}")
    now = _now()
    published_at = now if status == "published" else None
    cur = conn.execute(
        """
        UPDATE site_product_state
        SET status = ?,
            decision = COALESCE(?, decision),
            reason = COALESCE(?, reason),
            claimed_at = CASE
                WHEN ? IN ('reviewing', 'publishing') THEN ?
                ELSE claimed_at
            END,
            updated_at = ?,
            published_at = COALESCE(?, published_at)
        WHERE site = ? AND asin = ?
        """,
        (
            status,
            json.dumps(decision) if decision is not None else None,
            reason,
            status,
            now,
            now,
            published_at,
            site,
            asin,
        ),
    )
    conn.commit()
    return cur.rowcount > 0


def release_site_product_review(conn: sqlite3.Connection, *, site: str, asin: str) -> bool:
    """Make a failed/abandoned review claim available to the same site again."""
    cur = conn.execute(
        "DELETE FROM site_product_state WHERE site = ? AND asin = ? AND status = 'reviewing'",
        (site, asin),
    )
    conn.commit()
    return cur.rowcount > 0


def claim_queued_product_for_publish(conn: sqlite3.Connection, *, site: str) -> dict | None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            """
            SELECT asin FROM site_product_state
            WHERE site = ? AND status = 'queued'
            ORDER BY updated_at ASC LIMIT 1
            """,
            (site,),
        ).fetchone()
        if row is None:
            conn.commit()
            return None
        now = _now()
        conn.execute(
            """
            UPDATE site_product_state
            SET status = 'publishing', claimed_at = ?, updated_at = ?
            WHERE site = ? AND asin = ?
            """,
            (now, now, site, row["asin"]),
        )
        conn.commit()
        return get_site_product(conn, site=site, asin=row["asin"])
    except Exception:
        conn.rollback()
        raise


def list_site_queue(conn: sqlite3.Connection, *, site: str, limit: int = 100) -> list[dict]:
    rows = conn.execute(
        """
        SELECT p.*, s.site, s.status, s.decision, s.reason, s.claimed_at,
               s.updated_at, s.published_at
        FROM site_product_state s
        JOIN products p ON p.asin = s.asin
        WHERE s.site = ? AND s.status IN ('queued', 'publishing')
        ORDER BY s.updated_at ASC LIMIT ?
        """,
        (site, limit),
    ).fetchall()
    return [_site_product_row_to_dict(row) for row in rows]


def inventory_depth(conn: sqlite3.Connection, *, site: str, tags_any: list[str]) -> dict:
    matching = _matching_products(conn, tags_any)
    matching_asins = {row["asin"] for row in matching}
    counts = {status: 0 for status in SITE_PRODUCT_STATUSES}
    states = conn.execute(
        "SELECT asin, status FROM site_product_state WHERE site = ?", (site,)
    ).fetchall()
    considered = set()
    for row in states:
        if row["asin"] not in matching_asins:
            continue
        considered.add(row["asin"])
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    counts["available"] = len(matching_asins - considered)
    counts["active"] = counts["available"] + counts["reviewing"] + counts["queued"] + counts["publishing"]
    return counts


def product_inventory_stats(conn: sqlite3.Connection) -> dict:
    total = conn.execute("SELECT COUNT(*) AS n FROM products").fetchone()["n"]
    site_rows = conn.execute(
        "SELECT site, status, COUNT(*) AS n FROM site_product_state GROUP BY site, status"
    ).fetchall()
    sites: dict[str, dict[str, int]] = {}
    for row in site_rows:
        sites.setdefault(row["site"], {})[row["status"]] = row["n"]
    return {"products": total, "sites": sites}


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
