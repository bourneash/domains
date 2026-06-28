# Data Hub — Plan 1: Hub Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a VPN-routed central collector that fetches RSS sources once, tags + stores them in SQLite, records a per-fetch egress ledger, and serves filtered slices over a loopback HTTP API.

**Architecture:** A single Python `collector` process reads a YAML source registry, routes each source through the existing PIA VPN proxy (`tools/vpn-proxy`) under a fail-closed policy, normalizes + tags items, and upserts into a WAL-mode SQLite store. A FastAPI app serves `/items`, `/egress`, `/sources`, `/subscriptions`, `/health`. Both run as Docker containers under `tools/data-hub/`. This plan delivers the RSS path end-to-end; dataset fetchers (Plan 2), the dashboard tab (Plan 3), and per-site migration (Plan 4) build on it.

**Tech Stack:** Python 3.11, feedparser, httpx, PyYAML, pydantic v2, FastAPI, uvicorn, SQLite (WAL), pytest, Docker Compose, supercronic.

## Global Constraints

- Python 3.11 (matches the fleet's local-LLM writer pattern; `python:3.11-slim` base image).
- All collection routes through `tools/vpn-proxy` by default (`policy: vpn`), **fail-closed**: if the chosen VPN node is down or its exit IP equals a known home/host IP, the source is **skipped**, never fetched off-VPN. Only `policy: direct` sources may use the host network.
- API binds **`127.0.0.1` only**. Containers reach it via `host.docker.internal` with `extra_hosts: ["host.docker.internal:host-gateway"]`.
- Known home/host IPs that must NEVER appear as a VPN exit IP: `24.55.143.75` (home), `158.173.25.169` (host VPN). Sourced from env `DATAHUB_HOME_IPS` (comma-separated), defaulting to those two.
- VPN proxy endpoints (host loopback): US `http://127.0.0.1:8181`, EU `http://127.0.0.1:8182`. gluetun control/health API: US `http://127.0.0.1:9281`, EU `http://127.0.0.1:9282`. From inside a container, swap `127.0.0.1` → `host.docker.internal`.
- A source carries an **array** of tags and is fetched **once / stored once**. Dedup key for RSS items is the item `url`.
- Item rows must preserve the fields the fleet build already consumes downstream: `title, url, published_iso, summary, source` (plus hub-internal `tags`, `source_id`, `fetched_at`, `raw`). `beat` is intentionally NOT computed here — it stays site-local (applied by Plan 4 pullers).
- Secrets/config come from the shared env file `/home/jesse/projects/domains/.env` (already holds `VPN_PIA_*`). New vars get the `DATAHUB_` prefix.
- API port: **4760** (fleet convention: dashboard 4754, site-tracker 4742).

---

## File Structure

```
tools/data-hub/
  requirements.txt
  pyproject.toml                # pytest config + package metadata
  registry/
    sources.yaml                # all RSS sources (seeded in Task 7), multi-tagged
    subscriptions.yaml          # per-site tag queries
  src/datahub/
    __init__.py
    config.py                   # Settings (env) + Source/Subscription models + loaders
    store.py                    # SQLite schema, upsert/query, egress, source state, seen-urls
    vpn.py                      # proxy resolver, exit-IP probe, leak guard, fail-closed decision
    fetch_rss.py                # RSS fetch + normalize to item dicts
    collector.py                # orchestration: per-source fetch→store→egress, isolation
    api.py                      # FastAPI app factory + endpoints
    __main__.py                 # `python -m datahub collect` / `python -m datahub serve`
  tests/
    conftest.py                 # tmp db + fixtures
    fixtures/sample_feed.xml    # recorded RSS for fetch tests
    test_config.py
    test_store.py
    test_vpn.py
    test_fetch_rss.py
    test_collector.py
    test_api.py
  Dockerfile
  docker-compose.yml            # collector (cron) + api services, wired to vpn-proxy
  crontab.docker                # supercronic schedule for the collector
  README.md
```

**Responsibilities (one per file):**
- `config.py` — load + validate registry and env; no I/O beyond reading files.
- `store.py` — all SQLite access; pure data layer, no network, no VPN logic.
- `vpn.py` — decide *how/whether* a source may be fetched; no storage.
- `fetch_rss.py` — turn a feed URL (+ optional proxy) into normalized item dicts; no storage, no policy.
- `collector.py` — glue: policy → fetch → store → egress, with per-source isolation.
- `api.py` — read-only HTTP surface over `store.py` + live VPN health.

---

### Task 1: Project scaffold + config & registry loader

**Files:**
- Create: `tools/data-hub/requirements.txt`
- Create: `tools/data-hub/pyproject.toml`
- Create: `tools/data-hub/src/datahub/__init__.py`
- Create: `tools/data-hub/src/datahub/config.py`
- Create: `tools/data-hub/tests/conftest.py`
- Test: `tools/data-hub/tests/test_config.py`

**Interfaces:**
- Produces:
  - `class Source(BaseModel)`: `id: str`, `type: Literal["rss","dataset"]`, `url: str | None`, `dataset_key: str | None`, `fetcher: str | None`, `params: dict = {}`, `tags: list[str]`, `policy: Literal["vpn","direct"] = "vpn"`, `exit: Literal["us","eu","any"] = "any"`, `fetch: dict = {}`.
  - `class ItemsQuery(BaseModel)`: `tags_any: list[str] = []`, `tags_all: list[str] = []`, `include_sources: list[str] = []`, `exclude_sources: list[str] = []`, `limit: int = 200`, `window_hours: int = 48`.
  - `class Subscription(BaseModel)`: `site: str`, `items: ItemsQuery`, `datasets: list[str] = []`.
  - `class Settings(BaseModel)`: `db_path: str`, `home_ips: set[str]`, `proxy_us: str`, `proxy_eu: str`, `control_us: str`, `control_eu: str`, `registry_dir: str`.
  - `load_sources(path: str) -> list[Source]`
  - `load_subscriptions(path: str) -> dict[str, Subscription]`
  - `Settings.from_env() -> Settings` (classmethod; reads `DATAHUB_*`, applies defaults from Global Constraints).

- [ ] **Step 1: Create requirements.txt**

```
feedparser==6.0.11
httpx==0.27.2
PyYAML==6.0.2
pydantic==2.9.2
fastapi==0.115.4
uvicorn==0.32.0
pytest==8.3.3
```

- [ ] **Step 2: Create pyproject.toml**

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "datahub"
version = "0.1.0"
requires-python = ">=3.11"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

- [ ] **Step 3: Create `src/datahub/__init__.py`**

```python
"""datahub — centralized fleet data collection."""
__version__ = "0.1.0"
```

- [ ] **Step 4: Write the failing test** — `tests/test_config.py`

```python
import textwrap
from datahub.config import load_sources, load_subscriptions, Settings


def test_load_sources_parses_multi_tag_and_defaults(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text(textwrap.dedent("""
        sources:
          - id: reuters-world
            type: rss
            url: https://example.com/reuters.rss
            tags: [news, world, defense]
          - id: fred-gdp
            type: dataset
            dataset_key: gdp
            fetcher: fred
            params: {series_id: GDPC1}
            tags: [economy, dataset]
            policy: vpn
            exit: us
    """))
    sources = load_sources(str(p))
    assert len(sources) == 2
    reuters = sources[0]
    assert reuters.id == "reuters-world"
    assert reuters.type == "rss"
    assert reuters.tags == ["news", "world", "defense"]
    assert reuters.policy == "vpn"   # default
    assert reuters.exit == "any"     # default
    fred = sources[1]
    assert fred.fetcher == "fred"
    assert fred.params["series_id"] == "GDPC1"
    assert fred.exit == "us"


def test_load_subscriptions_builds_items_query(tmp_path):
    p = tmp_path / "subs.yaml"
    p.write_text(textwrap.dedent("""
        subscriptions:
          americastrikes.com:
            items:
              tags_any: [defense, iran, markets]
              limit: 200
              window_hours: 48
            datasets: []
          sinderella.org:
            items:
              tags_any: [space, science]
              window_hours: 24
            datasets: [ephemeris, fred-gdp]
    """))
    subs = load_subscriptions(str(p))
    assert set(subs) == {"americastrikes.com", "sinderella.org"}
    a = subs["americastrikes.com"]
    assert a.items.tags_any == ["defense", "iran", "markets"]
    assert a.items.limit == 200
    s = subs["sinderella.org"]
    assert s.items.window_hours == 24
    assert s.datasets == ["ephemeris", "fred-gdp"]


def test_settings_from_env_defaults(monkeypatch):
    monkeypatch.delenv("DATAHUB_HOME_IPS", raising=False)
    monkeypatch.setenv("DATAHUB_DB_PATH", "/tmp/x.db")
    s = Settings.from_env()
    assert s.db_path == "/tmp/x.db"
    assert "24.55.143.75" in s.home_ips
    assert "158.173.25.169" in s.home_ips
    assert s.proxy_us.endswith(":8181")
    assert s.control_eu.endswith(":9282")
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.config'`.

- [ ] **Step 6: Create `tests/conftest.py`** (shared fixtures used by later tasks too)

```python
import sqlite3
import pytest
from datahub import store as store_mod


@pytest.fixture
def db(tmp_path):
    path = str(tmp_path / "data-hub.db")
    conn = store_mod.connect(path)
    store_mod.init_schema(conn)
    yield conn
    conn.close()
```

(`store` does not exist yet — `conftest` is only imported by tests that request `db`; `test_config.py` does not, so it runs fine. Later tasks create `store`.)

- [ ] **Step 7: Implement `src/datahub/config.py`**

```python
import os
from typing import Literal
import yaml
from pydantic import BaseModel, Field

DEFAULT_HOME_IPS = {"24.55.143.75", "158.173.25.169"}


class Source(BaseModel):
    id: str
    type: Literal["rss", "dataset"]
    url: str | None = None
    dataset_key: str | None = None
    fetcher: str | None = None
    params: dict = Field(default_factory=dict)
    tags: list[str]
    policy: Literal["vpn", "direct"] = "vpn"
    exit: Literal["us", "eu", "any"] = "any"
    fetch: dict = Field(default_factory=dict)


class ItemsQuery(BaseModel):
    tags_any: list[str] = Field(default_factory=list)
    tags_all: list[str] = Field(default_factory=list)
    include_sources: list[str] = Field(default_factory=list)
    exclude_sources: list[str] = Field(default_factory=list)
    limit: int = 200
    window_hours: int = 48


class Subscription(BaseModel):
    site: str
    items: ItemsQuery = Field(default_factory=ItemsQuery)
    datasets: list[str] = Field(default_factory=list)


class Settings(BaseModel):
    db_path: str
    home_ips: set[str]
    proxy_us: str
    proxy_eu: str
    control_us: str
    control_eu: str
    registry_dir: str

    @classmethod
    def from_env(cls) -> "Settings":
        home = os.environ.get("DATAHUB_HOME_IPS", "")
        home_ips = {ip.strip() for ip in home.split(",") if ip.strip()} or set(DEFAULT_HOME_IPS)
        # Inside a container, callers set DATAHUB_PROXY_HOST=host.docker.internal.
        host = os.environ.get("DATAHUB_PROXY_HOST", "127.0.0.1")
        return cls(
            db_path=os.environ.get("DATAHUB_DB_PATH", "/data/data-hub.db"),
            home_ips=home_ips,
            proxy_us=os.environ.get("DATAHUB_PROXY_US", f"http://{host}:8181"),
            proxy_eu=os.environ.get("DATAHUB_PROXY_EU", f"http://{host}:8182"),
            control_us=os.environ.get("DATAHUB_CONTROL_US", f"http://{host}:9281"),
            control_eu=os.environ.get("DATAHUB_CONTROL_EU", f"http://{host}:9282"),
            registry_dir=os.environ.get("DATAHUB_REGISTRY_DIR", "/app/registry"),
        )


def load_sources(path: str) -> list[Source]:
    data = yaml.safe_load(open(path, encoding="utf-8").read()) or {}
    return [Source(**s) for s in data.get("sources", [])]


def load_subscriptions(path: str) -> dict[str, Subscription]:
    data = yaml.safe_load(open(path, encoding="utf-8").read()) or {}
    out: dict[str, Subscription] = {}
    for site, body in (data.get("subscriptions") or {}).items():
        body = dict(body or {})
        body["site"] = site
        out[site] = Subscription(**body)
    return out
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_config.py -v`
Expected: PASS (3 passed).

- [ ] **Step 9: Commit**

```bash
git add tools/data-hub/requirements.txt tools/data-hub/pyproject.toml \
  tools/data-hub/src/datahub/__init__.py tools/data-hub/src/datahub/config.py \
  tools/data-hub/tests/conftest.py tools/data-hub/tests/test_config.py
git commit -m "feat(data-hub): config + registry loader (sources, subscriptions, settings)"
```

---

### Task 2: SQLite store

**Files:**
- Create: `tools/data-hub/src/datahub/store.py`
- Test: `tools/data-hub/tests/test_store.py`

**Interfaces:**
- Consumes: nothing from other tasks (pure data layer).
- Produces:
  - `connect(db_path: str) -> sqlite3.Connection` (WAL, `row_factory=sqlite3.Row`).
  - `init_schema(conn) -> None`.
  - `upsert_items(conn, items: list[dict]) -> int` — items have keys `title, url, summary, published_iso, source_id, source_name, tags(list[str]), raw(dict)`. Skips URLs already in `seen_urls`; inserts new ones; returns count newly inserted. Also records each new url into `seen_urls`.
  - `query_items(conn, tags_any=None, tags_all=None, include_sources=None, exclude_sources=None, since_iso=None, limit=200) -> list[dict]` — newest-first by `published_iso`; each row dict includes `title, url, summary, published_iso, source, tags`.
  - `record_egress(conn, *, source_id, target_host, policy, exit_node, exit_ip, status, item_count=0, byte_count=0, duration_ms=0, note="") -> None`.
  - `query_egress(conn, since_iso=None, limit=200, policy=None) -> list[dict]`.
  - `set_source_state(conn, *, source_id, status, error="", stale=False) -> None`.
  - `get_sources_state(conn) -> list[dict]`.

- [ ] **Step 1: Write the failing test** — `tests/test_store.py`

```python
from datahub import store


def test_upsert_dedups_by_url(db):
    items = [
        {"title": "A", "url": "https://x/1", "summary": "s", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "src1", "source_name": "Src One", "tags": ["defense", "world"], "raw": {}},
        {"title": "B", "url": "https://x/2", "summary": "s", "published_iso": "2026-06-28T11:00:00+00:00",
         "source_id": "src1", "source_name": "Src One", "tags": ["markets"], "raw": {}},
    ]
    assert store.upsert_items(db, items) == 2
    # Re-inserting the same urls inserts nothing (seen-url dedup)
    assert store.upsert_items(db, items) == 0


def test_query_items_by_tags_any_newest_first(db):
    store.upsert_items(db, [
        {"title": "old-defense", "url": "https://x/1", "summary": "", "published_iso": "2026-06-20T10:00:00+00:00",
         "source_id": "s", "source_name": "S", "tags": ["defense"], "raw": {}},
        {"title": "new-markets", "url": "https://x/2", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "s", "source_name": "S", "tags": ["markets"], "raw": {}},
        {"title": "new-theater", "url": "https://x/3", "summary": "", "published_iso": "2026-06-29T10:00:00+00:00",
         "source_id": "s", "source_name": "S", "tags": ["theater"], "raw": {}},
    ])
    rows = store.query_items(db, tags_any=["defense", "markets"], limit=10)
    titles = [r["title"] for r in rows]
    assert titles == ["new-markets", "old-defense"]   # theater excluded, newest first
    assert rows[0]["source"] == "S"
    assert "markets" in rows[0]["tags"]


def test_query_items_tags_all_and_exclude_source(db):
    store.upsert_items(db, [
        {"title": "both", "url": "https://x/1", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "keep", "source_name": "Keep", "tags": ["a", "b"], "raw": {}},
        {"title": "onlyA", "url": "https://x/2", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "keep", "source_name": "Keep", "tags": ["a"], "raw": {}},
        {"title": "both-drop", "url": "https://x/3", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "drop", "source_name": "Drop", "tags": ["a", "b"], "raw": {}},
    ])
    rows = store.query_items(db, tags_all=["a", "b"], exclude_sources=["drop"], limit=10)
    assert [r["title"] for r in rows] == ["both"]


def test_egress_roundtrip_and_filter(db):
    store.record_egress(db, source_id="s1", target_host="example.com", policy="vpn",
                        exit_node="us", exit_ip="1.2.3.4", status="ok", item_count=5)
    store.record_egress(db, source_id="s2", target_host="gov.example", policy="direct",
                        exit_node="direct", exit_ip="9.9.9.9", status="ok")
    allrows = store.query_egress(db, limit=10)
    assert len(allrows) == 2
    vpn_only = store.query_egress(db, policy="vpn", limit=10)
    assert len(vpn_only) == 1
    assert vpn_only[0]["source_id"] == "s1"
    assert vpn_only[0]["exit_node"] == "us"


def test_source_state_upsert(db):
    store.set_source_state(db, source_id="s1", status="ok", stale=False)
    store.set_source_state(db, source_id="s1", status="skipped-vpn-down", error="vpn down", stale=True)
    states = {s["source_id"]: s for s in store.get_sources_state(db)}
    assert states["s1"]["status"] == "skipped-vpn-down"
    assert states["s1"]["stale"] == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_store.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.store'`.

- [ ] **Step 3: Implement `src/datahub/store.py`**

```python
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
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
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
    return [dict(r) for r in conn.execute("SELECT * FROM sources_state ORDER BY source_id").fetchall()]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_store.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/src/datahub/store.py tools/data-hub/tests/test_store.py
git commit -m "feat(data-hub): SQLite store (items, datasets, egress, source state, seen-urls)"
```

---

### Task 3: VPN policy resolver + leak guard (fail-closed)

**Files:**
- Create: `tools/data-hub/src/datahub/vpn.py`
- Test: `tools/data-hub/tests/test_vpn.py`

**Interfaces:**
- Consumes: `Settings`, `Source` from `config.py`.
- Produces:
  - `probe_exit_ip(control_url: str, *, client=None, timeout=8) -> str | None` — GET `<control_url>/v1/publicip/ip`, return the `public_ip` field or `None` on failure.
  - `class FetchPlan(BaseModel)`: `allowed: bool`, `proxy: str | None`, `exit_node: str`, `exit_ip: str | None`, `reason: str`.
  - `plan_fetch(source: Source, settings: Settings, *, client=None) -> FetchPlan` — implements fail-closed routing + leak guard:
    - `policy == "direct"` → `allowed=True, proxy=None, exit_node="direct", exit_ip=None`.
    - else pick node by `exit` (`us`/`eu`; `any`→`us`), probe its exit IP. If `None` → `allowed=False, reason="vpn-down"`. If exit IP ∈ `settings.home_ips` → `allowed=False, reason="leak-detected"`. Else `allowed=True, proxy=<node proxy>, exit_ip=<ip>`.

- [ ] **Step 1: Write the failing test** — `tests/test_vpn.py`

```python
import httpx
import pytest
from datahub.config import Source, Settings
from datahub import vpn


def _settings():
    return Settings(
        db_path=":memory:", home_ips={"24.55.143.75"},
        proxy_us="http://h:8181", proxy_eu="http://h:8182",
        control_us="http://h:9281", control_eu="http://h:9282",
        registry_dir="/x",
    )


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_direct_source_is_allowed_without_proxy():
    src = Source(id="fred", type="dataset", fetcher="fred", tags=["economy"], policy="direct", exit="us")
    plan = vpn.plan_fetch(src, _settings(), client=_client(lambda r: httpx.Response(200)))
    assert plan.allowed is True
    assert plan.proxy is None
    assert plan.exit_node == "direct"


def test_vpn_source_allowed_when_exit_ip_is_not_home():
    src = Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="us")

    def handler(req):
        assert req.url.path == "/v1/publicip/ip"
        return httpx.Response(200, json={"public_ip": "185.0.0.9"})

    plan = vpn.plan_fetch(src, _settings(), client=_client(handler))
    assert plan.allowed is True
    assert plan.proxy == "http://h:8181"
    assert plan.exit_node == "us"
    assert plan.exit_ip == "185.0.0.9"


def test_vpn_source_blocked_when_node_down():
    src = Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="eu")

    def handler(req):
        raise httpx.ConnectError("refused")

    plan = vpn.plan_fetch(src, _settings(), client=_client(handler))
    assert plan.allowed is False
    assert plan.reason == "vpn-down"


def test_vpn_source_blocked_on_leak():
    src = Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="us")

    def handler(req):
        return httpx.Response(200, json={"public_ip": "24.55.143.75"})  # home IP

    plan = vpn.plan_fetch(src, _settings(), client=_client(handler))
    assert plan.allowed is False
    assert plan.reason == "leak-detected"
    assert plan.proxy is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_vpn.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.vpn'`.

- [ ] **Step 3: Implement `src/datahub/vpn.py`**

```python
import httpx
from pydantic import BaseModel
from .config import Source, Settings


class FetchPlan(BaseModel):
    allowed: bool
    proxy: str | None = None
    exit_node: str = ""
    exit_ip: str | None = None
    reason: str = ""


def probe_exit_ip(control_url: str, *, client: httpx.Client | None = None, timeout: float = 8) -> str | None:
    owns = client is None
    client = client or httpx.Client(timeout=timeout)
    try:
        r = client.get(f"{control_url}/v1/publicip/ip")
        r.raise_for_status()
        return r.json().get("public_ip") or None
    except Exception:
        return None
    finally:
        if owns:
            client.close()


def _node_for(source: Source, settings: Settings) -> tuple[str, str, str]:
    """Return (exit_node, proxy_url, control_url). 'any' resolves to US."""
    node = "us" if source.exit in ("us", "any") else "eu"
    if node == "us":
        return "us", settings.proxy_us, settings.control_us
    return "eu", settings.proxy_eu, settings.control_eu


def plan_fetch(source: Source, settings: Settings, *, client: httpx.Client | None = None) -> FetchPlan:
    if source.policy == "direct":
        return FetchPlan(allowed=True, proxy=None, exit_node="direct", exit_ip=None, reason="direct-policy")

    node, proxy, control = _node_for(source, settings)
    exit_ip = probe_exit_ip(control, client=client)
    if exit_ip is None:
        return FetchPlan(allowed=False, proxy=None, exit_node=node, exit_ip=None, reason="vpn-down")
    if exit_ip in settings.home_ips:
        return FetchPlan(allowed=False, proxy=None, exit_node=node, exit_ip=exit_ip, reason="leak-detected")
    return FetchPlan(allowed=True, proxy=proxy, exit_node=node, exit_ip=exit_ip, reason="ok")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_vpn.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/src/datahub/vpn.py tools/data-hub/tests/test_vpn.py
git commit -m "feat(data-hub): VPN policy resolver + fail-closed leak guard"
```

---

### Task 4: RSS fetcher + normalizer

**Files:**
- Create: `tools/data-hub/src/datahub/fetch_rss.py`
- Create: `tools/data-hub/tests/fixtures/sample_feed.xml`
- Test: `tools/data-hub/tests/test_fetch_rss.py`

**Interfaces:**
- Consumes: `Source` from `config.py`.
- Produces:
  - `strip_html(text: str) -> str`, `parse_published(entry) -> str` (ISO8601 UTC; falls back to now).
  - `fetch_feed_bytes(url: str, *, proxy: str | None, ua: str, timeout=20, client=None) -> bytes` — httpx GET through optional proxy.
  - `fetch_rss(source: Source, *, proxy: str | None, client=None) -> list[dict]` — returns up to 20 normalized items per feed: keys `title, url, summary, published_iso, source_id, source_name, tags, raw`. `tags` is `source.tags`. Skips entries with no link or no title. Uses `source.fetch.get("user_agent")` or a Firefox default; honors optional `source.fetch["required_pattern"]` regex filter against title+summary.

- [ ] **Step 1: Create `tests/fixtures/sample_feed.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Sample</title>
  <item>
    <title>Carrier transits the strait</title>
    <link>https://example.com/a</link>
    <description>&lt;p&gt;Tensions  rise   in the gulf.&lt;/p&gt;</description>
    <pubDate>Sat, 28 Jun 2026 10:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Markets wobble</title>
    <link>https://example.com/b</link>
    <description>Oil up 3%.</description>
    <pubDate>Sat, 28 Jun 2026 09:00:00 +0000</pubDate>
  </item>
  <item>
    <title></title>
    <link>https://example.com/c</link>
    <description>no title, must be skipped</description>
  </item>
</channel></rss>
```

- [ ] **Step 2: Write the failing test** — `tests/test_fetch_rss.py`

```python
from pathlib import Path
import datahub.fetch_rss as fr
from datahub.config import Source

FIXTURE = (Path(__file__).parent / "fixtures" / "sample_feed.xml").read_bytes()


def test_fetch_rss_normalizes_and_skips_untitled(monkeypatch):
    monkeypatch.setattr(fr, "fetch_feed_bytes", lambda url, **kw: FIXTURE)
    src = Source(id="sample", type="rss", url="https://example.com/feed",
                 tags=["world", "defense"])
    items = fr.fetch_rss(src, proxy="http://h:8181")
    assert len(items) == 2  # untitled item dropped
    first = items[0]
    assert first["title"] == "Carrier transits the strait"
    assert first["url"] == "https://example.com/a"
    assert first["summary"] == "Tensions rise in the gulf."  # html stripped + ws collapsed
    assert first["source_id"] == "sample"
    assert first["tags"] == ["world", "defense"]
    assert first["published_iso"].startswith("2026-06-28T10:00:00")


def test_required_pattern_filters_entries(monkeypatch):
    monkeypatch.setattr(fr, "fetch_feed_bytes", lambda url, **kw: FIXTURE)
    src = Source(id="sample", type="rss", url="https://example.com/feed",
                 tags=["world"], fetch={"required_pattern": "market"})
    items = fr.fetch_rss(src, proxy=None)
    assert [i["title"] for i in items] == ["Markets wobble"]


def test_strip_html_collapses_whitespace():
    assert fr.strip_html("<p>a   b\n c</p>") == "a b c"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_fetch_rss.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.fetch_rss'`.

- [ ] **Step 4: Implement `src/datahub/fetch_rss.py`**

```python
import re
from datetime import datetime, timezone
import feedparser
import httpx
from .config import Source

DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0"


def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", text).strip()


def parse_published(entry) -> str:
    if getattr(entry, "published_parsed", None):
        try:
            return datetime(*entry.published_parsed[:6], tzinfo=timezone.utc).isoformat()
        except Exception:
            pass
    return datetime.now(timezone.utc).isoformat()


def fetch_feed_bytes(url: str, *, proxy: str | None = None, ua: str = DEFAULT_UA,
                     timeout: float = 20, client: httpx.Client | None = None) -> bytes:
    owns = client is None
    client = client or httpx.Client(proxy=proxy, timeout=timeout, follow_redirects=True)
    try:
        r = client.get(url, headers={"User-Agent": ua})
        r.raise_for_status()
        return r.content
    finally:
        if owns:
            client.close()


def fetch_rss(source: Source, *, proxy: str | None = None, client: httpx.Client | None = None) -> list[dict]:
    ua = source.fetch.get("user_agent", DEFAULT_UA)
    raw = fetch_feed_bytes(source.url, proxy=proxy, ua=ua, client=client)
    feed = feedparser.parse(raw)
    pattern = source.fetch.get("required_pattern")
    rx = re.compile(pattern, re.I) if pattern else None

    out: list[dict] = []
    for entry in feed.entries[:20]:
        url = (entry.get("link") or "").strip()
        title = strip_html(entry.get("title") or "")
        if not url or not title:
            continue
        summary = strip_html(entry.get("summary") or entry.get("description") or "")[:500]
        if rx and not rx.search(title + " " + summary):
            continue
        out.append({
            "title": title,
            "url": url,
            "summary": summary,
            "published_iso": parse_published(entry),
            "source_id": source.id,
            "source_name": source.fetch.get("source_name", source.id),
            "tags": list(source.tags),
            "raw": {},
        })
    return out
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_fetch_rss.py -v`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add tools/data-hub/src/datahub/fetch_rss.py tools/data-hub/tests/test_fetch_rss.py \
  tools/data-hub/tests/fixtures/sample_feed.xml
git commit -m "feat(data-hub): RSS fetcher + normalizer (proxy-aware, required-pattern filter)"
```

---

### Task 5: Collector orchestration (per-source isolation, fail-closed skips, egress)

**Files:**
- Create: `tools/data-hub/src/datahub/collector.py`
- Test: `tools/data-hub/tests/test_collector.py`

**Interfaces:**
- Consumes: `Source`, `Settings` (config); `plan_fetch` (vpn); `fetch_rss` (fetch_rss); store functions.
- Produces:
  - `run_cycle(conn, sources: list[Source], settings: Settings, *, control_client=None, rss_client=None) -> dict` — for each source:
    1. `plan = plan_fetch(source, settings, client=control_client)`.
    2. If not `plan.allowed`: `set_source_state(status="skipped-"+reason, stale=True)`, `record_egress(status="skipped", note=reason, exit_node=plan.exit_node)`; continue.
    3. If `source.type == "rss"`: fetch via `fetch_rss`, `upsert_items`, `set_source_state(status="ok")`, `record_egress(status="ok", item_count=new)`.
    4. `type == "dataset"`: skipped in Plan 1 with `status="ok"`, `note="dataset-deferred"` (Plan 2 fills this in).
    5. On any exception: `set_source_state(status="error", error=str, stale=False)`, `record_egress(status="error", note=str)`; continue (isolation).
  - Returns summary dict: `{"fetched": int, "new_items": int, "skipped": int, "errors": int}`.

- [ ] **Step 1: Write the failing test** — `tests/test_collector.py`

```python
import httpx
import datahub.collector as collector
import datahub.fetch_rss as fr
from datahub.config import Source, Settings
from datahub import store


def _settings():
    return Settings(db_path=":memory:", home_ips={"24.55.143.75"},
                    proxy_us="http://h:8181", proxy_eu="http://h:8182",
                    control_us="http://h:9281", control_eu="http://h:9282", registry_dir="/x")


def _control(ip):
    return httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={"public_ip": ip})))


def test_healthy_vpn_fetches_and_stores(db, monkeypatch):
    monkeypatch.setattr(fr, "fetch_rss", lambda src, **kw: [
        {"title": "X", "url": "https://x/1", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": src.id, "source_name": src.id, "tags": src.tags, "raw": {}}])
    sources = [Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="us")]
    summary = collector.run_cycle(db, sources, _settings(), control_client=_control("185.1.1.1"))
    assert summary["new_items"] == 1
    assert summary["skipped"] == 0
    rows = store.query_items(db, tags_any=["world"])
    assert len(rows) == 1
    eg = store.query_egress(db)
    assert eg[0]["status"] == "ok"
    assert eg[0]["exit_ip"] == "185.1.1.1"


def test_vpn_down_skips_fail_closed(db, monkeypatch):
    called = {"n": 0}
    def boom(src, **kw):
        called["n"] += 1
        raise AssertionError("must not fetch when VPN down")
    monkeypatch.setattr(fr, "fetch_rss", boom)
    sources = [Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="us")]
    # control client that errors → node down
    down = httpx.Client(transport=httpx.MockTransport(
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("x"))))
    summary = collector.run_cycle(db, sources, _settings(), control_client=down)
    assert called["n"] == 0
    assert summary["skipped"] == 1
    assert summary["new_items"] == 0
    state = {s["source_id"]: s for s in store.get_sources_state(db)}["reuters"]
    assert state["last_status"] == "skipped-vpn-down"
    assert state["stale"] == 1


def test_source_error_is_isolated(db, monkeypatch):
    def half(src, **kw):
        if src.id == "bad":
            raise RuntimeError("feed exploded")
        return [{"title": "ok", "url": "https://x/ok", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
                 "source_id": src.id, "source_name": src.id, "tags": src.tags, "raw": {}}]
    monkeypatch.setattr(fr, "fetch_rss", half)
    sources = [
        Source(id="bad", type="rss", url="https://e/bad.rss", tags=["world"], exit="us"),
        Source(id="good", type="rss", url="https://e/good.rss", tags=["world"], exit="us"),
    ]
    summary = collector.run_cycle(db, sources, _settings(), control_client=_control("185.1.1.1"))
    assert summary["errors"] == 1
    assert summary["new_items"] == 1   # good source still stored
    assert len(store.query_items(db, tags_any=["world"])) == 1


def test_direct_policy_skips_vpn_probe(db, monkeypatch):
    monkeypatch.setattr(fr, "fetch_rss", lambda src, **kw: [
        {"title": "D", "url": "https://x/d", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": src.id, "source_name": src.id, "tags": src.tags, "raw": {}}])
    sources = [Source(id="govfeed", type="rss", url="https://gov/feed", tags=["economy"], policy="direct")]
    # No control client provided; direct must not need it.
    summary = collector.run_cycle(db, sources, _settings())
    assert summary["new_items"] == 1
    eg = store.query_egress(db)
    assert eg[0]["policy"] == "direct"
    assert eg[0]["exit_node"] == "direct"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_collector.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.collector'`.

- [ ] **Step 3: Implement `src/datahub/collector.py`**

```python
from urllib.parse import urlparse
from . import store
from . import fetch_rss as fr
from .vpn import plan_fetch
from .config import Source, Settings


def _host(url: str | None) -> str:
    try:
        return urlparse(url or "").hostname or ""
    except Exception:
        return ""


def run_cycle(conn, sources: list[Source], settings: Settings, *,
              control_client=None, rss_client=None) -> dict:
    summary = {"fetched": 0, "new_items": 0, "skipped": 0, "errors": 0}

    for source in sources:
        target = _host(source.url)
        plan = plan_fetch(source, settings, client=control_client)

        if not plan.allowed:
            store.set_source_state(conn, source_id=source.id,
                                   status=f"skipped-{plan.reason}", error=plan.reason, stale=True)
            store.record_egress(conn, source_id=source.id, target_host=target,
                                policy=source.policy, exit_node=plan.exit_node,
                                exit_ip=plan.exit_ip, status="skipped", note=plan.reason)
            summary["skipped"] += 1
            continue

        try:
            if source.type == "dataset":
                # Plan 2 implements dataset fetchers; record a benign no-op here.
                store.set_source_state(conn, source_id=source.id, status="ok", stale=False)
                store.record_egress(conn, source_id=source.id, target_host=target,
                                    policy=source.policy, exit_node=plan.exit_node,
                                    exit_ip=plan.exit_ip, status="ok", note="dataset-deferred")
                summary["fetched"] += 1
                continue

            items = fr.fetch_rss(source, proxy=plan.proxy, client=rss_client)
            new = store.upsert_items(conn, items)
            store.set_source_state(conn, source_id=source.id, status="ok", stale=False)
            store.record_egress(conn, source_id=source.id, target_host=target,
                                policy=source.policy, exit_node=plan.exit_node,
                                exit_ip=plan.exit_ip, status="ok", item_count=new)
            summary["fetched"] += 1
            summary["new_items"] += new
        except Exception as exc:  # per-source isolation
            store.set_source_state(conn, source_id=source.id, status="error",
                                   error=str(exc), stale=False)
            store.record_egress(conn, source_id=source.id, target_host=target,
                                policy=source.policy, exit_node=plan.exit_node,
                                exit_ip=plan.exit_ip, status="error", note=str(exc)[:200])
            summary["errors"] += 1

    return summary
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_collector.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/src/datahub/collector.py tools/data-hub/tests/test_collector.py
git commit -m "feat(data-hub): collector orchestration (fail-closed skips, isolation, egress)"
```

---

### Task 6: HTTP API (items, egress, sources, subscriptions, health)

**Files:**
- Create: `tools/data-hub/src/datahub/api.py`
- Create: `tools/data-hub/src/datahub/__main__.py`
- Test: `tools/data-hub/tests/test_api.py`

**Interfaces:**
- Consumes: `Settings`, `load_sources`, `load_subscriptions` (config); store query fns; `probe_exit_ip` (vpn).
- Produces:
  - `create_app(settings: Settings, *, conn=None, sources=None, subscriptions=None, vpn_client=None) -> FastAPI`. Dependency-injectable for tests; in production reads registry from `settings.registry_dir` and opens its own read connection.
  - Endpoints:
    - `GET /items?tags=a,b&match=any|all&sources=&exclude=&since=&limit=` → `{"items":[...]}`.
    - `GET /subscriptions/{site}/items` → resolves the site's subscription query and returns its slice (the shape pullers will call).
    - `GET /egress?since=&limit=&policy=` → `{"events":[...]}`.
    - `GET /sources` → `{"sources":[{id,type,tags,policy,exit,state}]}`.
    - `GET /subscriptions/{site}` → the resolved subscription.
    - `GET /health` → `{"ok":bool,"nodes":{"us":ip|null,"eu":ip|null},"sources":[state...],"counts":{"items":n,"skipped":n},"generated_at":iso}`.
  - `python -m datahub collect` runs one collect cycle; `python -m datahub serve` runs uvicorn.

- [ ] **Step 1: Write the failing test** — `tests/test_api.py`

```python
import httpx
from fastapi.testclient import TestClient
from datahub.config import Source, Settings, Subscription, ItemsQuery
from datahub import store, api


def _settings():
    return Settings(db_path=":memory:", home_ips={"24.55.143.75"},
                    proxy_us="http://h:8181", proxy_eu="http://h:8182",
                    control_us="http://h:9281", control_eu="http://h:9282", registry_dir="/x")


def _client(db):
    sources = [Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world", "defense"], exit="us")]
    subs = {"americastrikes.com": Subscription(site="americastrikes.com",
            items=ItemsQuery(tags_any=["defense"], limit=50))}
    vpn_client = httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={"public_ip": "185.2.2.2"})))
    app = api.create_app(_settings(), conn=db, sources=sources, subscriptions=subs, vpn_client=vpn_client)
    return TestClient(app)


def _seed(db):
    store.upsert_items(db, [
        {"title": "war", "url": "https://x/1", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "reuters", "source_name": "Reuters", "tags": ["defense"], "raw": {}},
        {"title": "weather", "url": "https://x/2", "summary": "", "published_iso": "2026-06-28T09:00:00+00:00",
         "source_id": "reuters", "source_name": "Reuters", "tags": ["nature"], "raw": {}},
    ])


def test_items_filtered_by_tags(db):
    _seed(db)
    c = _client(db)
    r = c.get("/items", params={"tags": "defense", "match": "any"})
    assert r.status_code == 200
    titles = [i["title"] for i in r.json()["items"]]
    assert titles == ["war"]


def test_subscription_items_endpoint(db):
    _seed(db)
    c = _client(db)
    r = c.get("/subscriptions/americastrikes.com/items")
    assert r.status_code == 200
    assert [i["title"] for i in r.json()["items"]] == ["war"]


def test_egress_endpoint(db):
    store.record_egress(db, source_id="reuters", target_host="e", policy="vpn",
                        exit_node="us", exit_ip="185.2.2.2", status="ok", item_count=3)
    c = _client(db)
    r = c.get("/egress")
    assert r.status_code == 200
    ev = r.json()["events"]
    assert ev[0]["exit_node"] == "us"
    assert ev[0]["policy"] == "vpn"


def test_health_reports_nodes_and_counts(db):
    _seed(db)
    store.set_source_state(db, source_id="reuters", status="ok")
    c = _client(db)
    r = c.get("/health")
    body = r.json()
    assert body["nodes"]["us"] == "185.2.2.2"
    assert body["counts"]["items"] == 2
    assert any(s["source_id"] == "reuters" for s in body["sources"])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_api.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.api'`.

- [ ] **Step 3: Implement `src/datahub/api.py`**

```python
import os
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from .config import Settings, Source, Subscription, load_sources, load_subscriptions
from . import store
from .vpn import probe_exit_ip


def _csv(v: str | None) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def create_app(settings: Settings, *, conn=None, sources: list[Source] | None = None,
               subscriptions: dict[str, Subscription] | None = None, vpn_client=None) -> FastAPI:
    app = FastAPI(title="datahub", version="0.1.0")

    if conn is None:
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
    if sources is None:
        sources = load_sources(os.path.join(settings.registry_dir, "sources.yaml"))
    if subscriptions is None:
        subscriptions = load_subscriptions(os.path.join(settings.registry_dir, "subscriptions.yaml"))
    source_by_id = {s.id: s for s in sources}

    @app.get("/items")
    def items(tags: str | None = None, match: str = "any", sources: str | None = None,
              exclude: str | None = None, since: str | None = None, limit: int = 200):
        taglist = _csv(tags)
        rows = store.query_items(
            conn,
            tags_any=taglist if match == "any" else None,
            tags_all=taglist if match == "all" else None,
            include_sources=_csv(sources) or None,
            exclude_sources=_csv(exclude) or None,
            since_iso=since, limit=limit,
        )
        return {"items": rows}

    @app.get("/subscriptions/{site}")
    def subscription(site: str):
        sub = subscriptions.get(site)
        if not sub:
            raise HTTPException(404, f"no subscription for {site}")
        return sub.model_dump()

    @app.get("/subscriptions/{site}/items")
    def subscription_items(site: str):
        sub = subscriptions.get(site)
        if not sub:
            raise HTTPException(404, f"no subscription for {site}")
        q = sub.items
        since = None
        if q.window_hours:
            from datetime import timedelta
            since = (datetime.now(timezone.utc) - timedelta(hours=q.window_hours)).isoformat()
        rows = store.query_items(
            conn,
            tags_any=q.tags_any or None, tags_all=q.tags_all or None,
            include_sources=q.include_sources or None, exclude_sources=q.exclude_sources or None,
            since_iso=since, limit=q.limit,
        )
        return {"items": rows}

    @app.get("/egress")
    def egress(since: str | None = None, limit: int = 200, policy: str | None = None):
        return {"events": store.query_egress(conn, since_iso=since, limit=limit, policy=policy)}

    @app.get("/sources")
    def sources_list():
        state = {s["source_id"]: s for s in store.get_sources_state(conn)}
        return {"sources": [
            {"id": s.id, "type": s.type, "tags": s.tags, "policy": s.policy,
             "exit": s.exit, "state": state.get(s.id)}
            for s in source_by_id.values()
        ]}

    @app.get("/health")
    def health():
        us = probe_exit_ip(settings.control_us, client=vpn_client)
        eu = probe_exit_ip(settings.control_eu, client=vpn_client)
        states = store.get_sources_state(conn)
        item_count = conn.execute("SELECT COUNT(*) AS n FROM items").fetchone()["n"]
        skipped = [s for s in states if (s["last_status"] or "").startswith("skipped")]
        return {
            "ok": bool(us or eu),
            "nodes": {"us": us, "eu": eu},
            "sources": states,
            "counts": {"items": item_count, "skipped": len(skipped)},
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    return app
```

- [ ] **Step 4: Implement `src/datahub/__main__.py`**

```python
import sys
import uvicorn
from .config import Settings, load_sources
from . import store
from .collector import run_cycle
from .api import create_app


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    settings = Settings.from_env()
    if cmd == "collect":
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
        sources = load_sources(f"{settings.registry_dir}/sources.yaml")
        summary = run_cycle(conn, sources, settings)
        print(f"[datahub] cycle: {summary}")
    elif cmd == "serve":
        app = create_app(settings)
        uvicorn.run(app, host="0.0.0.0", port=int(__import__("os").environ.get("DATAHUB_PORT", "4760")))
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Add the test dependency and run the API test**

Run: `cd tools/data-hub && pip install -r requirements.txt httpx && python -m pytest tests/test_api.py -v`
Expected: PASS (4 passed). (`fastapi.testclient` needs `httpx`, already in requirements.)

- [ ] **Step 6: Run the full suite**

Run: `cd tools/data-hub && python -m pytest -q`
Expected: PASS (all tasks' tests green).

- [ ] **Step 7: Commit**

```bash
git add tools/data-hub/src/datahub/api.py tools/data-hub/src/datahub/__main__.py \
  tools/data-hub/tests/test_api.py
git commit -m "feat(data-hub): HTTP API (items, subscriptions, egress, sources, health) + CLI"
```

---

### Task 7: Dockerize, seed registry, schedule, document

**Files:**
- Create: `tools/data-hub/Dockerfile`
- Create: `tools/data-hub/docker-compose.yml`
- Create: `tools/data-hub/crontab.docker`
- Create: `tools/data-hub/registry/sources.yaml` (seeded with the real RSS sources)
- Create: `tools/data-hub/registry/subscriptions.yaml`
- Create: `tools/data-hub/.dockerignore`
- Create: `tools/data-hub/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: two running containers — `datahub-collector` (supercronic, every 15 min) and `datahub-api` (uvicorn on `127.0.0.1:4760`), both reaching the VPN proxy via `host.docker.internal`, sharing a `./data` volume for `data-hub.db`.

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app

# supercronic for the collector schedule (same pattern as site cron containers)
ADD https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-amd64 /usr/local/bin/supercronic
RUN chmod +x /usr/local/bin/supercronic

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY pyproject.toml .
COPY src ./src
COPY registry ./registry
COPY crontab.docker ./crontab.docker
ENV PYTHONPATH=/app/src
```

- [ ] **Step 2: Create `crontab.docker`**

```
# datahub collector — every 15 minutes (tightest cadence any site needs today)
*/15 * * * * cd /app && python -m datahub collect >> /proc/1/fd/1 2>&1
```

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
name: datahub

services:
  collector:
    build: .
    container_name: datahub-collector
    restart: unless-stopped
    command: ["supercronic", "/app/crontab.docker"]
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      DATAHUB_DB_PATH: /data/data-hub.db
      DATAHUB_REGISTRY_DIR: /app/registry
      DATAHUB_PROXY_HOST: host.docker.internal
      DATAHUB_HOME_IPS: ${DATAHUB_HOME_IPS:-24.55.143.75,158.173.25.169}
    volumes:
      - ./data:/data
    logging:
      driver: local
      options: { max-size: "2m", max-file: "1" }

  api:
    build: .
    container_name: datahub-api
    restart: unless-stopped
    command: ["python", "-m", "datahub", "serve"]
    ports:
      - "127.0.0.1:4760:4760"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      DATAHUB_DB_PATH: /data/data-hub.db
      DATAHUB_REGISTRY_DIR: /app/registry
      DATAHUB_PROXY_HOST: host.docker.internal
      DATAHUB_PORT: "4760"
    volumes:
      - ./data:/data
    logging:
      driver: local
      options: { max-size: "2m", max-file: "1" }
```

- [ ] **Step 4: Create `.dockerignore`**

```
data/
tests/
__pycache__/
*.pyc
```

- [ ] **Step 5: Seed `registry/sources.yaml`** — the union of the 4 RSS sites' feeds, deduplicated and multi-tagged. Build it by reading each site's `ops/config/scraper.json` and merging. Concretely:

```bash
# Inspect each site's feeds to copy URLs + sources into the registry:
for s in americastrikes.com aliencouncil.com broadwayshowgirls.com saveusfarms.com; do
  echo "== $s =="; python -c "import json,sys; d=json.load(open('sites/$s/ops/config/scraper.json')); [print(f['url'],'|',f.get('source'),'|',f.get('default_beat')) for f in d['feeds']]"
done
```

Then author `sources.yaml` with one entry per **distinct URL**. A feed used by two sites appears **once** with the union of relevant tags. Tag vocabulary (topic tags, not site beats): `news, world, defense, iran, markets, diplomacy, domestic, uap, disclosure, science, military, theater, musicals, awards, agriculture, food-policy, farm-economy, land, environment, space, weird, nature`. Example shape (fill with the real URLs printed above):

```yaml
sources:
  - id: reuters-world
    type: rss
    url: https://www.reutersagency.com/feed/?best-topics=world
    tags: [news, world, defense, markets, diplomacy]
    policy: vpn
    exit: any
    fetch: { source_name: "Reuters" }

  - id: dod-news
    type: rss
    url: https://www.defense.gov/News/Feed/
    tags: [news, defense, military, domestic]
    policy: vpn
    exit: us
    fetch: { source_name: "DoD News" }

  - id: playbill
    type: rss
    url: https://www.playbill.com/rss/news
    tags: [theater, musicals, awards]
    policy: vpn
    exit: us
    fetch: { source_name: "Playbill" }
  # ... one entry per distinct URL across the 4 sites, multi-tagged where shared
```

(Source IDs are stable kebab-case slugs; `source_name` mirrors the site's existing display name so puller output stays familiar.)

- [ ] **Step 6: Seed `registry/subscriptions.yaml`** — one block per site, tags matching each site's current beats:

```yaml
subscriptions:
  americastrikes.com:
    items: { tags_any: [defense, iran, markets, diplomacy, domestic, world], limit: 200, window_hours: 48 }
    datasets: []
  aliencouncil.com:
    items: { tags_any: [uap, disclosure, science, military], limit: 200, window_hours: 48 }
    datasets: []
  broadwayshowgirls.com:
    items: { tags_any: [theater, musicals, awards], limit: 120, window_hours: 72 }
    datasets: []
  saveusfarms.com:
    items: { tags_any: [agriculture, food-policy, farm-economy, land, environment], limit: 200, window_hours: 48 }
    datasets: []
  sinderella.org:
    items: { tags_any: [space, science, weird, nature], limit: 60, window_hours: 24 }
    datasets: []
```

- [ ] **Step 7: Create `README.md`**

````markdown
# tools/data-hub

Centralized fleet data collection. One collector fetches every registered source
once (behind the PIA VPN, fail-closed), tags + stores it in SQLite, and serves
filtered slices over a loopback HTTP API. Sites pull their slice instead of
scraping (see Plan 4).

## Prerequisites
- `tools/vpn-proxy` running (`cd ../vpn-proxy && docker compose --env-file ../../.env up -d`).

## Run
```bash
cd tools/data-hub
docker compose --env-file ../../.env up -d --build
curl -s http://127.0.0.1:4760/health | python -m json.tool
```

## Endpoints (127.0.0.1:4760)
- `GET /items?tags=defense,iran&match=any&limit=200`
- `GET /subscriptions/<site>/items`   (the shape pullers call)
- `GET /egress?policy=vpn&limit=50`   (outbound connection ledger)
- `GET /sources`, `GET /health`

## Registry
- `registry/sources.yaml` — every source, multi-tagged, `policy: vpn|direct`, `exit: us|eu|any`.
- `registry/subscriptions.yaml` — per-site tag query.

A source shared by multiple sites appears **once**; it is fetched once and stored once.

## VPN policy
Default `policy: vpn` → routed through PIA with the killswitch. If the chosen node
is down or its exit IP equals a known home IP, the source is **skipped** (fail-closed,
never fetched off-VPN). Only mark a source `policy: direct` when the VPN provably
breaks it (e.g. a gov API geoblock); that exception shows up on the dashboard egress
ledger.

## Tests
```bash
pip install -r requirements.txt
python -m pytest -q
```
````

- [ ] **Step 8: Build, start, and smoke-test against the live VPN**

```bash
cd /home/jesse/projects/domains/tools/vpn-proxy && docker compose --env-file ../../.env up -d
cd /home/jesse/projects/domains/tools/data-hub && docker compose --env-file ../../.env up -d --build
sleep 20
docker compose --env-file ../../.env exec -T collector python -m datahub collect
curl -s http://127.0.0.1:4760/health | python -m json.tool
curl -s "http://127.0.0.1:4760/items?tags=defense&limit=3" | python -m json.tool
curl -s "http://127.0.0.1:4760/egress?limit=5" | python -m json.tool
```
Expected: `/health` shows non-home `nodes.us`/`nodes.eu` IPs; `/items` returns stored stories; `/egress` shows `policy: vpn`, an `exit_ip` that is NOT `24.55.143.75`/`158.173.25.169`, and `status: ok`.

- [ ] **Step 9: Verify fail-closed behavior**

```bash
docker stop vpn-us vpn-eu
docker compose --env-file ../../.env exec -T collector python -m datahub collect
curl -s "http://127.0.0.1:4760/egress?limit=5" | python -m json.tool   # expect status: skipped, note: vpn-down
docker start vpn-us vpn-eu
```
Expected: with the VPN down, the cycle records `skipped` / `vpn-down` egress events and stores **no** new items — proving no off-VPN fetch occurred.

- [ ] **Step 10: Commit**

```bash
git add tools/data-hub/Dockerfile tools/data-hub/docker-compose.yml tools/data-hub/crontab.docker \
  tools/data-hub/.dockerignore tools/data-hub/registry/sources.yaml \
  tools/data-hub/registry/subscriptions.yaml tools/data-hub/README.md
git commit -m "feat(data-hub): dockerize collector+api, seed registry, schedule, docs"
```

---

## Self-Review

**Spec coverage:**
- Source registry + multi-tag, single-store invariant → Task 1 (model), Task 2 (dedup by url), Task 7 (seed). ✓
- Subscriptions / tag-query matrix → Task 1 (model), Task 6 (`/subscriptions/{site}/items`), Task 7 (seed). ✓
- Collector behind VPN, fail-closed, leak guard → Task 3 + Task 5. ✓
- SQLite store (items, datasets table, egress, source state, seen-urls) → Task 2. ✓ (datasets table created; rows populated in Plan 2.)
- HTTP API (items, datasets, egress, sources, subscriptions, health) → Task 6. ✓ (`/datasets` endpoint deferred to Plan 2 alongside the data it serves — noted, not a gap for this plan's scope.)
- Egress ledger ("what went where, over which path, when") → Task 2 (`egress_log`) + Task 5 (one event/fetch) + Task 6 (`/egress`). ✓
- VPN reused, not rebuilt → Task 3/7 point at existing `tools/vpn-proxy`. ✓
- Byte-compatible site builds → out of scope for Plan 1 (Plan 4 pullers); item fields preserved (`title,url,published_iso,summary,source`). ✓
- Dataset fetchers, dashboard tab, per-site migration → explicitly Plans 2/3/4. ✓

**Placeholder scan:** No TBD/TODO. Task 7 Step 5 requires authoring real feed URLs from each site's `scraper.json`; the bash command to extract them is provided, and the entry shape is concrete. This is data-entry from a known source, not an unspecified design decision.

**Type consistency:** `Source`, `ItemsQuery`, `Subscription`, `Settings`, `FetchPlan` defined in Tasks 1/3 and used consistently. Store function names (`upsert_items`, `query_items`, `record_egress`, `query_egress`, `set_source_state`, `get_sources_state`) match across Tasks 2/5/6. Item dict keys (`title,url,summary,published_iso,source_id,source_name,tags,raw`) consistent across Tasks 2/4/5. `plan_fetch`/`FetchPlan.allowed/proxy/exit_node/exit_ip/reason` consistent across Tasks 3/5.
