# site-tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tools/site-tracker` — a portfolio maintenance dashboard at `localhost:4742` that shows per-site verification/wiring state in a status matrix, ingests facts from multiple sources (filesystem, HTTP scrape, Cloudflare, GitHub, user-supplied), and lets you edit manual facts in-place.

**Architecture:** Five layers — registry (`sites.yml`), collectors (one module per source), SQLite store, FastAPI app, HTMX frontend. All run in one Docker container with three processes (FastAPI + supercronic + sites.yml watcher). Mirrors `tools/cf-stats` container pattern.

**Tech Stack:** Python 3.12, FastAPI, Jinja2, HTMX, SQLite (stdlib), httpx, click, python-dotenv, PyYAML, pytest, respx (for httpx mocking).

**Spec:** `docs/superpowers/specs/2026-05-19-site-tracker-design.md`

---

## File Structure (locked in)

> **Refinement from spec:** the spec sketch put `store.py` + `registry.py` under `app/`. They're imported by collectors too, so they belong one level up. Final layout:

```
tools/site-tracker/
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── crontab.docker
├── entrypoint.sh
├── README.md
├── .gitignore
├── sites.yml                              # registry, in git
├── src/
│   └── site_tracker/
│       ├── __init__.py
│       ├── cli.py                         # click CLI: collect, serve, render-domains-index
│       ├── fact_keys.py                   # registry of v1 fact keys + state rules
│       ├── store.py                       # SQLite helpers, used everywhere
│       ├── registry.py                    # sites.yml load/save, used everywhere
│       ├── collectors/
│       │   ├── __init__.py
│       │   ├── base.py
│       │   ├── filesystem.py
│       │   ├── http_scrape.py
│       │   ├── cloudflare.py
│       │   ├── github.py
│       │   └── search_consoles.py         # v2 stub (exits 0)
│       ├── app/
│       │   ├── __init__.py
│       │   ├── main.py                    # FastAPI app + all routes
│       │   ├── git_ops.py                 # commit helper for /edit POST
│       │   ├── templates/
│       │   │   ├── base.html
│       │   │   ├── matrix.html
│       │   │   ├── site_detail.html
│       │   │   ├── collectors.html
│       │   │   └── fragments/
│       │   │       ├── cell.html
│       │   │       └── edit_form.html
│       │   └── static/
│       │       └── style.css
│       └── scripts/
│           └── render_domains_index.py
├── tests/
│   ├── __init__.py
│   ├── conftest.py
│   ├── test_store.py
│   ├── test_registry.py
│   ├── test_collect_filesystem.py
│   ├── test_collect_http.py
│   ├── test_collect_cloudflare.py
│   ├── test_collect_github.py
│   ├── test_cli.py
│   ├── test_api_matrix.py
│   ├── test_api_site_detail.py
│   ├── test_api_edit.py
│   ├── test_api_collectors.py
│   ├── test_render_domains_index.py
│   └── fixtures/
│       ├── sites.yml                      # 3 toy sites for tests
│       └── site_repo/                     # toy bind-mount layout
├── data/                                  # gitignored
└── out/                                   # gitignored
```

---

## Task 1: Scaffold project + fact-keys registry

**Files:**
- Create: `tools/site-tracker/pyproject.toml`
- Create: `tools/site-tracker/.gitignore`
- Create: `tools/site-tracker/sites.yml`
- Create: `tools/site-tracker/src/site_tracker/__init__.py`
- Create: `tools/site-tracker/src/site_tracker/fact_keys.py`
- Create: `tools/site-tracker/README.md`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p tools/site-tracker/src/site_tracker/{collectors,app/templates/fragments,app/static,scripts}
mkdir -p tools/site-tracker/tests/fixtures/site_repo
mkdir -p tools/site-tracker/{data,out}
touch tools/site-tracker/src/site_tracker/__init__.py
touch tools/site-tracker/src/site_tracker/collectors/__init__.py
touch tools/site-tracker/src/site_tracker/app/__init__.py
touch tools/site-tracker/tests/__init__.py
```

- [ ] **Step 2: Write `pyproject.toml`**

```toml
[project]
name = "site-tracker"
version = "0.1.0"
description = "Portfolio maintenance dashboard — per-site verification/wiring state across the domains portfolio"
requires-python = ">=3.10"
dependencies = [
    "fastapi>=0.110",
    "uvicorn[standard]>=0.27",
    "jinja2>=3.1",
    "httpx>=0.27",
    "click>=8.1",
    "python-dotenv>=1.0",
    "PyYAML>=6.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "respx>=0.21",
    "freezegun>=1.4",
]

[project.scripts]
site-tracker = "site_tracker.cli:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/site_tracker"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
```

- [ ] **Step 3: Write `.gitignore`**

```gitignore
.venv/
__pycache__/
*.pyc
*.egg-info/
data/
out/
.pytest_cache/
```

- [ ] **Step 4: Write `sites.yml` with the 7 active sites + a parked-site example**

```yaml
# Site registry — source of truth for tools/site-tracker.
# DOMAINS_INDEX.md is regenerated from this file (see scripts/render_domains_index.py).

config:
  auto_commit: true       # /edit POSTs git commit. Default off for push.
  auto_push: false
  domains_root: /work     # parent domains repo inside the container

sites:
  aliencouncil.com:
    active: true
    cf_zone: aliencouncil.com
    github: bourneash/aliencouncil.com
    applies_to: [cf, http, sitemap, tls, git, ops, github, manual]
    manual: {}

  americastrikes.com:
    active: true
    cf_zone: americastrikes.com
    github: bourneash/americastrikes.com
    applies_to: [cf, http, sitemap, tls, git, ops, github, manual]
    manual: {}

  rc-9.com:
    active: true
    cf_zone: rc-9.com
    github: bourneash/rc-9.com
    applies_to: [cf, http, sitemap, tls, git, github, manual]
    manual: {}

  reviewtattoo.com:
    active: true
    cf_zone: reviewtattoo.com
    github: bourneash/reviewtattoo.com
    applies_to: [cf, http, sitemap, tls, git, ops, github, manual]
    manual: {}

  sinderella.org:
    active: true
    cf_zone: sinderella.org
    github: bourneash/sinderella.org
    applies_to: [cf, http, sitemap, tls, git, ops, github, manual]
    manual: {}

  ultrarough.com:
    active: true
    cf_zone: ultrarough.com
    github: bourneash/ultrarough.com
    applies_to: [cf, http, sitemap, tls, git, ops, github, manual]
    manual: {}

  weapontester.com:
    active: true
    cf_zone: weapontester.com
    github: bourneash/weapontester.com
    applies_to: [cf, http, sitemap, tls, git, github, manual]
    manual: {}

  xxxtea.com:
    active: true
    cf_zone: xxxtea.com
    github: bourneash/xxxtea.com
    applies_to: [cf, http, sitemap, tls, git, ops, github, manual]
    manual: {}
```

- [ ] **Step 5: Write `src/site_tracker/__init__.py`**

```python
__version__ = "0.1.0"
```

- [ ] **Step 6: Write `src/site_tracker/fact_keys.py` — the v1 fact registry**

```python
"""Registry of v1 fact keys, their families (for applies_to gating), source, and TTL.

A fact's `family` controls whether a site's row in the matrix renders that cell:
the cell shows iff the family appears in the site's `applies_to` list.

Each fact's `state_from_value(value, site)` returns 'green' | 'yellow' | 'red'
| 'unknown' | 'n_a'. Collectors call this AFTER they have a value; manual edits
bypass it and accept the human's verdict (always 'green' on save).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class FactSpec:
    key: str
    family: str
    source: str
    ttl_hours: int
    describe: str
    state_from_value: Callable[[Any, dict], str]


def _bool_green_red(v: Any, _site: dict) -> str:
    if v is True:
        return "green"
    if v is False:
        return "red"
    return "unknown"


def _bool_green_yellow(v: Any, _site: dict) -> str:
    """For optional-but-recommended facts: missing = yellow, not red."""
    if v is True:
        return "green"
    if v is False:
        return "yellow"
    return "unknown"


def _tls_expiry(days: Any, _site: dict) -> str:
    if days is None:
        return "unknown"
    if days < 7:
        return "red"
    if days < 30:
        return "yellow"
    return "green"


def _commit_age(hours: Any, site: dict) -> str:
    if hours is None:
        return "unknown"
    # Active sites should ship at least weekly; parked sites are static.
    if not site.get("active", False):
        return "green"
    if hours < 24 * 7:
        return "green"
    if hours < 24 * 30:
        return "yellow"
    return "red"


def _ops_board_age(hours: Any, _site: dict) -> str:
    if hours is None:
        return "unknown"
    if hours < 25:
        return "green"
    if hours < 24 * 3:
        return "yellow"
    return "red"


def _commits_ahead(n: Any, _site: dict) -> str:
    if n is None:
        return "unknown"
    if n == 0:
        return "green"
    if n < 5:
        return "yellow"
    return "red"


FACTS: dict[str, FactSpec] = {
    # Cloudflare
    "cf.zone_active":         FactSpec("cf.zone_active",         "cf",      "cf_api",      6,  "Zone active in Cloudflare",              _bool_green_red),
    "cf.worker_bound":        FactSpec("cf.worker_bound",        "cf",      "cf_api",      6,  "Worker bound to zone",                   _bool_green_yellow),
    "cf.email_routing":       FactSpec("cf.email_routing",       "cf",      "cf_api",      24, "Email routing configured",               _bool_green_yellow),

    # HTTP scrape
    "http.ga4_present":       FactSpec("http.ga4_present",       "http",    "http_scrape", 24, "GA4 tag in <head>",                      _bool_green_yellow),
    "http.adsense_present":   FactSpec("http.adsense_present",   "http",    "http_scrape", 24, "AdSense tag in <head>",                  _bool_green_yellow),
    "http.meta_pixel_present":FactSpec("http.meta_pixel_present","http",    "http_scrape", 24, "Meta Pixel in <head>",                   _bool_green_yellow),
    "http.gtm_present":       FactSpec("http.gtm_present",       "http",    "http_scrape", 24, "GTM tag in <head>",                      _bool_green_yellow),
    "http.sitemap_200":       FactSpec("http.sitemap_200",       "sitemap", "http_scrape", 24, "GET /sitemap.xml returns 200",           _bool_green_red),
    "http.robots_present":    FactSpec("http.robots_present",    "sitemap", "http_scrape", 24, "GET /robots.txt returns 200",            _bool_green_yellow),
    "http.tls_expiry_days":   FactSpec("http.tls_expiry_days",   "tls",     "http_scrape", 24, "Days until TLS cert expires",            _tls_expiry),

    # Filesystem
    "fs.last_commit_age_hours":FactSpec("fs.last_commit_age_hours","git",   "filesystem",  1,  "Hours since last commit on main",        _commit_age),
    "fs.ops_board_last_run_age_hours":FactSpec("fs.ops_board_last_run_age_hours","ops","filesystem",1,"Hours since latest ops/board/last-run.json",_ops_board_age),

    # GitHub
    "github.commits_ahead":   FactSpec("github.commits_ahead",   "github",  "github_api",  24, "Local commits not on origin",            _commits_ahead),
    "github.last_push_age_hours":FactSpec("github.last_push_age_hours","github","github_api",24,"Hours since last push to origin",        _commit_age),
}


def keys_for_family(family: str) -> list[str]:
    return [k for k, spec in FACTS.items() if spec.family == family]


def families() -> list[str]:
    """Canonical column order for the matrix."""
    return ["cf", "http", "sitemap", "tls", "git", "ops", "github", "manual"]
```

- [ ] **Step 7: Write a one-paragraph `README.md`**

```markdown
# site-tracker

Portfolio maintenance dashboard — per-site verification/wiring state across
the domains portfolio. Five-layer architecture (registry, collectors, store,
API, frontend) running in a single Docker container at `localhost:4742`.

Design: [docs/superpowers/specs/2026-05-19-site-tracker-design.md](../../docs/superpowers/specs/2026-05-19-site-tracker-design.md)

## Quickstart

```bash
cd tools/site-tracker
docker compose up -d
open http://localhost:4742
```

See `docker compose logs -f` for collector cron output.
```

- [ ] **Step 8: Commit**

```bash
git add tools/site-tracker/
git commit -m "site-tracker: project scaffold + fact-keys registry"
```

---

## Task 2: SQLite store module (TDD)

**Files:**
- Create: `tools/site-tracker/src/site_tracker/store.py`
- Create: `tools/site-tracker/tests/conftest.py`
- Create: `tools/site-tracker/tests/test_store.py`

- [ ] **Step 1: Write `tests/conftest.py`**

```python
"""Shared pytest fixtures for site-tracker tests."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "facts.db"


@pytest.fixture
def db(db_path: Path):
    from site_tracker import store
    store.init_db(db_path)
    conn = store.connect(db_path)
    try:
        yield conn
    finally:
        conn.close()
```

- [ ] **Step 2: Write failing tests in `tests/test_store.py`**

```python
"""Tests for site_tracker.store."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from site_tracker import store


def test_init_db_creates_tables(db_path: Path):
    store.init_db(db_path)
    conn = sqlite3.connect(db_path)
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    assert "facts" in tables
    assert "audit" in tables


def test_upsert_fact_inserts_new(db):
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    row = db.execute(
        "SELECT site, key, value, source, state, ttl_hours FROM facts"
    ).fetchone()
    assert row == ("x.com", "http.ga4_present", "true", "http_scrape", "green", 24)


def test_upsert_fact_updates_existing(db):
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=False, source="http_scrape", state="yellow", ttl_hours=24)
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    rows = db.execute("SELECT value, state FROM facts WHERE site=? AND key=?",
                      ("x.com", "http.ga4_present")).fetchall()
    assert rows == [("true", "green")]


def test_upsert_fact_appends_audit_on_change(db):
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=False, source="http_scrape", state="yellow", ttl_hours=24)
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    audits = db.execute("SELECT old_value, new_value, source FROM audit").fetchall()
    assert audits == [
        (None,     "false", "http_scrape"),
        ("false",  "true",  "http_scrape"),
    ]


def test_upsert_fact_no_audit_when_value_unchanged(db):
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=True, source="http_scrape", state="green", ttl_hours=24)
    n = db.execute("SELECT COUNT(*) FROM audit").fetchone()[0]
    assert n == 1   # only the initial insert


def test_get_site_facts_returns_keyed_dict(db):
    store.upsert_fact(db, site="x.com", key="cf.zone_active",
                      value=True, source="cf_api", state="green", ttl_hours=6)
    store.upsert_fact(db, site="x.com", key="http.ga4_present",
                      value=False, source="http_scrape", state="yellow", ttl_hours=24)
    facts = store.get_site_facts(db, "x.com")
    assert set(facts.keys()) == {"cf.zone_active", "http.ga4_present"}
    assert facts["cf.zone_active"]["value"] is True
    assert facts["cf.zone_active"]["state"] == "green"


def test_stale_state_when_past_ttl(db):
    from freezegun import freeze_time
    with freeze_time("2026-05-19T00:00:00Z"):
        store.upsert_fact(db, site="x.com", key="cf.zone_active",
                          value=True, source="cf_api", state="green", ttl_hours=6)
    with freeze_time("2026-05-19T07:00:00Z"):
        facts = store.get_site_facts(db, "x.com")
    assert facts["cf.zone_active"]["state"] == "stale"
```

- [ ] **Step 3: Run tests to verify they fail**

Run from `tools/site-tracker/`:
```bash
pip install -e ".[dev]"
pytest tests/test_store.py -v
```
Expected: ImportError or AttributeError on `site_tracker.store`.

- [ ] **Step 4: Implement `src/site_tracker/store.py`**

```python
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
        conn.executescript(_SCHEMA)
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pytest tests/test_store.py -v
```
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add tools/site-tracker/src/site_tracker/store.py tools/site-tracker/tests/
git commit -m "site-tracker: SQLite store (facts + audit, TTL stale degrade)"
```

---

## Task 3: Registry module — sites.yml load/save (TDD)

**Files:**
- Create: `tools/site-tracker/src/site_tracker/registry.py`
- Create: `tools/site-tracker/tests/test_registry.py`
- Create: `tools/site-tracker/tests/fixtures/sites.yml`

- [ ] **Step 1: Write `tests/fixtures/sites.yml` — 3 toy sites for tests**

```yaml
config:
  auto_commit: true
  auto_push: false
  domains_root: /work

sites:
  alpha.test:
    active: true
    cf_zone: alpha.test
    github: org/alpha
    applies_to: [cf, http, git, manual]
    manual:
      amazon_associates_id: alpha-20

  beta.test:
    active: true
    cf_zone: beta.test
    github: org/beta
    applies_to: [cf, http, sitemap, tls, git, ops, github, manual]
    manual: {}

  parked.test:
    active: false
    cf_zone: parked.test
    applies_to: [cf]
    manual: {}
```

- [ ] **Step 2: Write failing tests in `tests/test_registry.py`**

```python
"""Tests for site_tracker.registry."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from site_tracker import registry


@pytest.fixture
def sites_yml(tmp_path: Path) -> Path:
    src = Path(__file__).parent / "fixtures" / "sites.yml"
    dst = tmp_path / "sites.yml"
    shutil.copy(src, dst)
    return dst


def test_load_returns_sites_dict(sites_yml: Path):
    reg = registry.load(sites_yml)
    assert set(reg.sites.keys()) == {"alpha.test", "beta.test", "parked.test"}
    assert reg.sites["alpha.test"]["active"] is True


def test_load_returns_config(sites_yml: Path):
    reg = registry.load(sites_yml)
    assert reg.config["auto_commit"] is True
    assert reg.config["auto_push"] is False


def test_set_manual_fact_writes_value_and_set_at(sites_yml: Path):
    reg = registry.load(sites_yml)
    registry.set_manual_fact(reg, sites_yml, "beta.test", "adsense_status", "approved")
    reloaded = registry.load(sites_yml)
    val = reloaded.sites["beta.test"]["manual"]["adsense_status"]
    assert val["value"] == "approved"
    assert "set_at" in val


def test_set_manual_fact_overwrites_existing(sites_yml: Path):
    reg = registry.load(sites_yml)
    registry.set_manual_fact(reg, sites_yml, "alpha.test", "amazon_associates_id", "alpha-30")
    reloaded = registry.load(sites_yml)
    val = reloaded.sites["alpha.test"]["manual"]["amazon_associates_id"]
    assert val == "alpha-30" or val.get("value") == "alpha-30"


def test_set_manual_fact_raises_unknown_site(sites_yml: Path):
    reg = registry.load(sites_yml)
    with pytest.raises(KeyError):
        registry.set_manual_fact(reg, sites_yml, "doesnotexist.com", "x", "y")


def test_active_sites_filter(sites_yml: Path):
    reg = registry.load(sites_yml)
    active = registry.active_sites(reg)
    assert set(active.keys()) == {"alpha.test", "beta.test"}


def test_applies_to_includes(sites_yml: Path):
    reg = registry.load(sites_yml)
    assert registry.site_applies_to(reg, "alpha.test", "cf") is True
    assert registry.site_applies_to(reg, "alpha.test", "ops") is False
    assert registry.site_applies_to(reg, "beta.test", "ops") is True
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pytest tests/test_registry.py -v
```
Expected: ImportError on `site_tracker.registry`.

- [ ] **Step 4: Implement `src/site_tracker/registry.py`**

```python
"""sites.yml load + save + manual-fact write."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


@dataclass
class Registry:
    config: dict[str, Any] = field(default_factory=dict)
    sites: dict[str, dict[str, Any]] = field(default_factory=dict)


def load(path: Path) -> Registry:
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    return Registry(
        config=data.get("config", {}),
        sites=data.get("sites", {}),
    )


def _dump(reg: Registry, path: Path) -> None:
    out = {"config": reg.config, "sites": reg.sites}
    with open(path, "w") as f:
        yaml.safe_dump(out, f, sort_keys=False, default_flow_style=False)


def set_manual_fact(reg: Registry, path: Path, site: str, key: str, value: Any) -> None:
    if site not in reg.sites:
        raise KeyError(f"unknown site: {site}")
    manual = reg.sites[site].setdefault("manual", {})
    manual[key] = {
        "value": value,
        "set_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    _dump(reg, path)


def active_sites(reg: Registry) -> dict[str, dict[str, Any]]:
    return {k: v for k, v in reg.sites.items() if v.get("active")}


def site_applies_to(reg: Registry, site: str, family: str) -> bool:
    if site not in reg.sites:
        return False
    return family in reg.sites[site].get("applies_to", [])
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pytest tests/test_registry.py -v
```
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add tools/site-tracker/src/site_tracker/registry.py tools/site-tracker/tests/test_registry.py tools/site-tracker/tests/fixtures/sites.yml
git commit -m "site-tracker: registry (sites.yml load/save + manual facts)"
```

---

## Task 4: Filesystem collector (TDD)

**Files:**
- Create: `tools/site-tracker/src/site_tracker/collectors/base.py`
- Create: `tools/site-tracker/src/site_tracker/collectors/filesystem.py`
- Create: `tools/site-tracker/tests/test_collect_filesystem.py`

- [ ] **Step 1: Write `src/site_tracker/collectors/base.py`**

```python
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
```

- [ ] **Step 2: Build the toy site-repo fixture for filesystem tests**

```bash
mkdir -p tools/site-tracker/tests/fixtures/site_repo/sites/alpha.test/ops/board
mkdir -p tools/site-tracker/tests/fixtures/site_repo/sites/beta.test/ops/board
```

We'll create the actual file contents inside the tests using `tmp_path` so the fixtures stay minimal.

- [ ] **Step 3: Write failing tests in `tests/test_collect_filesystem.py`**

```python
"""Tests for collectors.filesystem."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from freezegun import freeze_time

from site_tracker import registry, store
from site_tracker.collectors import filesystem as fs_collector


@pytest.fixture
def domains_root(tmp_path: Path) -> Path:
    """A minimal /work-style layout with two site repos."""
    root = tmp_path / "domains"
    for site in ("alpha.test", "beta.test"):
        d = root / "sites" / site
        d.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=d, check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=d, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=d, check=True)
        (d / "README.md").write_text("x\n")
        subprocess.run(["git", "add", "."], cwd=d, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=d, check=True)
    return root


@pytest.fixture
def reg(domains_root: Path) -> registry.Registry:
    return registry.Registry(
        config={"domains_root": str(domains_root)},
        sites={
            "alpha.test": {"active": True, "applies_to": ["git", "ops"]},
            "beta.test":  {"active": True, "applies_to": ["git", "ops"]},
        },
    )


def test_collects_last_commit_age(db, reg, domains_root):
    with freeze_time("2026-05-19T12:00:00Z"):
        fs_collector.run(reg, db)
    row = store.get_site_facts(db, "alpha.test")
    assert "fs.last_commit_age_hours" in row
    assert row["fs.last_commit_age_hours"]["state"] == "green"
    assert row["fs.last_commit_age_hours"]["source"] == "filesystem"
    assert isinstance(row["fs.last_commit_age_hours"]["value"], (int, float))


def test_collects_ops_board_last_run(db, reg, domains_root):
    board = domains_root / "sites" / "beta.test" / "ops" / "board"
    board.mkdir(parents=True, exist_ok=True)
    (board / "last-run.json").write_text(json.dumps({"role": "x", "exit": 0}))
    with freeze_time("2026-05-19T12:00:00Z"):
        fs_collector.run(reg, db)
    facts = store.get_site_facts(db, "beta.test")
    assert "fs.ops_board_last_run_age_hours" in facts
    assert facts["fs.ops_board_last_run_age_hours"]["state"] == "green"


def test_missing_repo_marks_unknown(db, reg, domains_root):
    # nuke alpha.test's .git
    import shutil
    shutil.rmtree(domains_root / "sites" / "alpha.test" / ".git")
    fs_collector.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["fs.last_commit_age_hours"]["state"] == "unknown"


def test_skips_sites_without_git_family(db, domains_root):
    reg_no_git = registry.Registry(
        config={"domains_root": str(domains_root)},
        sites={"alpha.test": {"active": True, "applies_to": ["cf"]}},
    )
    fs_collector.run(reg_no_git, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert "fs.last_commit_age_hours" not in facts
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
pytest tests/test_collect_filesystem.py -v
```
Expected: ImportError on `site_tracker.collectors.filesystem`.

- [ ] **Step 5: Implement `src/site_tracker/collectors/filesystem.py`**

```python
"""Filesystem / git collector.

Reads each site's repo for:
  - last commit timestamp on HEAD     -> fs.last_commit_age_hours
  - ops/board/last-run.json mtime     -> fs.ops_board_last_run_age_hours

Skips a fact when the site's applies_to does not include its family.
Marks 'unknown' when the data source is missing (no .git, no board file).
"""
from __future__ import annotations

import logging
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _last_commit_age_hours(repo: Path) -> float | None:
    if not (repo / ".git").exists():
        return None
    try:
        out = subprocess.check_output(
            ["git", "log", "-1", "--format=%cI"],
            cwd=repo, stderr=subprocess.DEVNULL, text=True,
        ).strip()
    except subprocess.CalledProcessError:
        return None
    ts = datetime.fromisoformat(out)
    return (_now() - ts).total_seconds() / 3600


def _ops_board_age_hours(repo: Path) -> float | None:
    f = repo / "ops" / "board" / "last-run.json"
    if not f.exists():
        return None
    mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
    return (_now() - mtime).total_seconds() / 3600


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    domains_root = Path(reg.config["domains_root"])
    for site_name, site_cfg in reg.sites.items():
        applies = site_cfg.get("applies_to", [])
        repo = domains_root / "sites" / site_name

        if "git" in applies:
            age = _last_commit_age_hours(repo)
            if age is None:
                emit_unknown(conn, site_name, site_cfg, "fs.last_commit_age_hours")
            else:
                emit(conn, site_name, site_cfg, "fs.last_commit_age_hours", round(age, 2))

        if "ops" in applies:
            age = _ops_board_age_hours(repo)
            if age is None:
                emit_unknown(conn, site_name, site_cfg, "fs.ops_board_last_run_age_hours")
            else:
                emit(conn, site_name, site_cfg, "fs.ops_board_last_run_age_hours", round(age, 2))
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
pytest tests/test_collect_filesystem.py -v
```
Expected: 4 passed.

- [ ] **Step 7: Commit**

```bash
git add tools/site-tracker/src/site_tracker/collectors/ tools/site-tracker/tests/test_collect_filesystem.py
git commit -m "site-tracker: filesystem collector (git age + ops board mtime)"
```

---

## Task 5: HTTP scrape collector (TDD)

**Files:**
- Create: `tools/site-tracker/src/site_tracker/collectors/http_scrape.py`
- Create: `tools/site-tracker/tests/test_collect_http.py`

- [ ] **Step 1: Write failing tests in `tests/test_collect_http.py`**

```python
"""Tests for collectors.http_scrape."""
from __future__ import annotations

import respx
import httpx
import pytest

from site_tracker import registry, store
from site_tracker.collectors import http_scrape


@pytest.fixture
def reg() -> registry.Registry:
    return registry.Registry(
        config={},
        sites={
            "alpha.test": {
                "active": True,
                "applies_to": ["http", "sitemap", "tls"],
            },
        },
    )


HEAD_WITH_PIXELS = """
<!doctype html>
<html><head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890"></script>
<script>!function(f,b,e,v,n,t,s){...}('init', '987654321');</script>
<script>(function(w,d,s,l,i){...})(window,document,'script','dataLayer','GTM-AAA111');</script>
</head><body></body></html>
"""

HEAD_BARE = "<!doctype html><html><head></head><body></body></html>"


@respx.mock
def test_detects_pixels_in_head(db, reg):
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_WITH_PIXELS))
    respx.get("https://alpha.test/sitemap.xml").mock(return_value=httpx.Response(200, text="<urlset/>"))
    respx.get("https://alpha.test/robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *"))
    http_scrape.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.ga4_present"]["value"] is True
    assert facts["http.adsense_present"]["value"] is True
    assert facts["http.meta_pixel_present"]["value"] is True
    assert facts["http.gtm_present"]["value"] is True


@respx.mock
def test_missing_pixels_marked_false(db, reg):
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_BARE))
    respx.get("https://alpha.test/sitemap.xml").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/robots.txt").mock(return_value=httpx.Response(404))
    http_scrape.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.ga4_present"]["value"] is False
    assert facts["http.sitemap_200"]["value"] is False
    assert facts["http.robots_present"]["value"] is False


@respx.mock
def test_homepage_timeout_marks_unknown(db, reg):
    respx.get("https://alpha.test/").mock(side_effect=httpx.ConnectTimeout("boom"))
    respx.get("https://alpha.test/sitemap.xml").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/robots.txt").mock(return_value=httpx.Response(404))
    http_scrape.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.ga4_present"]["state"] == "unknown"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_collect_http.py -v
```
Expected: ImportError on `site_tracker.collectors.http_scrape`.

- [ ] **Step 3: Implement `src/site_tracker/collectors/http_scrape.py`**

```python
"""HTTP-scrape collector — looks at the live site.

Detects analytics/ads pixels in <head>, sitemap + robots presence, TLS
expiry. All anonymous GETs. Per-site ~3 requests.
"""
from __future__ import annotations

import logging
import re
import socket
import ssl
import sqlite3
from datetime import datetime, timezone

import httpx

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)

_GA4_RE     = re.compile(r"gtag/js\?id=G-[A-Z0-9]+|G-[A-Z0-9]{6,}", re.I)
_ADSENSE_RE = re.compile(r"adsbygoogle\.js|ca-pub-\d+", re.I)
_META_RE    = re.compile(r"fbq\s*\(\s*['\"]init['\"]|connect\.facebook\.net", re.I)
_GTM_RE     = re.compile(r"GTM-[A-Z0-9]+|googletagmanager\.com/gtm\.js", re.I)

TIMEOUT = httpx.Timeout(8.0, connect=5.0)


def _fetch(client: httpx.Client, url: str) -> httpx.Response | None:
    try:
        return client.get(url, follow_redirects=True)
    except httpx.HTTPError as e:
        log.warning("http fetch %s failed: %s", url, e)
        return None


def _tls_expiry_days(host: str) -> int | None:
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((host, 443), timeout=5) as sock, \
             ctx.wrap_socket(sock, server_hostname=host) as ssock:
            cert = ssock.getpeercert()
    except (OSError, ssl.SSLError) as e:
        log.warning("tls probe %s failed: %s", host, e)
        return None
    not_after = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    return int((not_after - datetime.now(timezone.utc)).total_seconds() // 86400)


def _scrape_site(client: httpx.Client, conn: sqlite3.Connection, site_name: str, site_cfg: dict) -> None:
    applies = site_cfg.get("applies_to", [])
    base = f"https://{site_name}"

    home = _fetch(client, f"{base}/")
    if home is None or home.status_code >= 500:
        if "http" in applies:
            for k in ("http.ga4_present", "http.adsense_present",
                      "http.meta_pixel_present", "http.gtm_present"):
                emit_unknown(conn, site_name, site_cfg, k)
    elif "http" in applies:
        head = home.text[: 200_000].split("</head>", 1)[0]
        emit(conn, site_name, site_cfg, "http.ga4_present",        bool(_GA4_RE.search(head)))
        emit(conn, site_name, site_cfg, "http.adsense_present",    bool(_ADSENSE_RE.search(head)))
        emit(conn, site_name, site_cfg, "http.meta_pixel_present", bool(_META_RE.search(head)))
        emit(conn, site_name, site_cfg, "http.gtm_present",        bool(_GTM_RE.search(head)))

    if "sitemap" in applies:
        sm = _fetch(client, f"{base}/sitemap.xml")
        emit(conn, site_name, site_cfg, "http.sitemap_200", sm is not None and sm.status_code == 200)
        rb = _fetch(client, f"{base}/robots.txt")
        emit(conn, site_name, site_cfg, "http.robots_present", rb is not None and rb.status_code == 200)

    if "tls" in applies:
        days = _tls_expiry_days(site_name)
        if days is None:
            emit_unknown(conn, site_name, site_cfg, "http.tls_expiry_days")
        else:
            emit(conn, site_name, site_cfg, "http.tls_expiry_days", days)


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": "site-tracker/0.1"}) as client:
        for site_name, site_cfg in reg.sites.items():
            if not site_cfg.get("active"):
                continue
            try:
                _scrape_site(client, conn, site_name, site_cfg)
            except Exception:
                log.exception("scrape %s crashed", site_name)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/test_collect_http.py -v
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/site-tracker/src/site_tracker/collectors/http_scrape.py tools/site-tracker/tests/test_collect_http.py
git commit -m "site-tracker: http-scrape collector (pixels, sitemap, robots, TLS)"
```

---

## Task 6: Cloudflare collector (TDD)

**Files:**
- Create: `tools/site-tracker/src/site_tracker/collectors/cloudflare.py`
- Create: `tools/site-tracker/tests/test_collect_cloudflare.py`

- [ ] **Step 1: Write failing tests in `tests/test_collect_cloudflare.py`**

```python
"""Tests for collectors.cloudflare."""
from __future__ import annotations

import os

import httpx
import pytest
import respx

from site_tracker import registry, store
from site_tracker.collectors import cloudflare as cf


@pytest.fixture(autouse=True)
def _cf_env(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "test-token")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct-id")


@pytest.fixture
def reg() -> registry.Registry:
    return registry.Registry(
        config={},
        sites={
            "alpha.test": {"active": True, "cf_zone": "alpha.test", "applies_to": ["cf"]},
        },
    )


def _zone_response(active: bool, has_worker: bool, has_email: bool):
    return {
        "result": [{
            "id": "zone-id",
            "name": "alpha.test",
            "status": "active" if active else "pending",
        }],
        "success": True,
    }


@respx.mock
def test_collects_zone_active(db, reg):
    respx.get("https://api.cloudflare.com/client/v4/zones",
              params={"name": "alpha.test"}).mock(
        return_value=httpx.Response(200, json=_zone_response(True, True, True))
    )
    respx.get("https://api.cloudflare.com/client/v4/zones/zone-id/workers/routes").mock(
        return_value=httpx.Response(200, json={"result": [{"pattern": "alpha.test/*"}], "success": True})
    )
    respx.get("https://api.cloudflare.com/client/v4/zones/zone-id/email/routing").mock(
        return_value=httpx.Response(200, json={"result": {"enabled": True}, "success": True})
    )
    cf.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["cf.zone_active"]["value"] is True
    assert facts["cf.worker_bound"]["value"] is True
    assert facts["cf.email_routing"]["value"] is True


@respx.mock
def test_zone_pending_marks_red(db, reg):
    respx.get("https://api.cloudflare.com/client/v4/zones",
              params={"name": "alpha.test"}).mock(
        return_value=httpx.Response(200, json=_zone_response(False, False, False))
    )
    respx.get("https://api.cloudflare.com/client/v4/zones/zone-id/workers/routes").mock(
        return_value=httpx.Response(200, json={"result": [], "success": True})
    )
    respx.get("https://api.cloudflare.com/client/v4/zones/zone-id/email/routing").mock(
        return_value=httpx.Response(200, json={"result": {"enabled": False}, "success": True})
    )
    cf.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["cf.zone_active"]["state"] == "red"


@respx.mock
def test_api_error_marks_unknown(db, reg):
    respx.get("https://api.cloudflare.com/client/v4/zones",
              params={"name": "alpha.test"}).mock(
        return_value=httpx.Response(500, json={"success": False})
    )
    cf.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["cf.zone_active"]["state"] == "unknown"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_collect_cloudflare.py -v
```
Expected: ImportError.

- [ ] **Step 3: Implement `src/site_tracker/collectors/cloudflare.py`**

```python
"""Cloudflare collector — zone status, worker binding, email routing.

Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from env (already
loaded from /work/.env.shared by the container entrypoint).
"""
from __future__ import annotations

import logging
import os
import sqlite3

import httpx

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)

BASE = "https://api.cloudflare.com/client/v4"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _client() -> httpx.Client:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    return httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=TIMEOUT,
    )


def _get_zone_id(client: httpx.Client, zone_name: str) -> tuple[str | None, bool | None]:
    """Return (zone_id, active_flag) or (None, None) on error."""
    r = client.get("/zones", params={"name": zone_name})
    if r.status_code != 200 or not r.json().get("success"):
        return None, None
    result = r.json().get("result", [])
    if not result:
        return None, False  # zone not in CF
    z = result[0]
    return z["id"], z.get("status") == "active"


def _worker_bound(client: httpx.Client, zone_id: str) -> bool | None:
    r = client.get(f"/zones/{zone_id}/workers/routes")
    if r.status_code != 200:
        return None
    return bool(r.json().get("result"))


def _email_routing(client: httpx.Client, zone_id: str) -> bool | None:
    r = client.get(f"/zones/{zone_id}/email/routing")
    if r.status_code != 200:
        return None
    return bool(r.json().get("result", {}).get("enabled"))


def _collect_site(client: httpx.Client, conn: sqlite3.Connection, site_name: str, site_cfg: dict) -> None:
    zone_name = site_cfg.get("cf_zone")
    if not zone_name:
        return

    zone_id, active = _get_zone_id(client, zone_name)
    if zone_id is None and active is None:
        for k in ("cf.zone_active", "cf.worker_bound", "cf.email_routing"):
            emit_unknown(conn, site_name, site_cfg, k)
        return

    if zone_id is None:
        emit(conn, site_name, site_cfg, "cf.zone_active", False)
        emit(conn, site_name, site_cfg, "cf.worker_bound", False)
        emit(conn, site_name, site_cfg, "cf.email_routing", False)
        return

    emit(conn, site_name, site_cfg, "cf.zone_active", active)

    worker = _worker_bound(client, zone_id)
    if worker is None:
        emit_unknown(conn, site_name, site_cfg, "cf.worker_bound")
    else:
        emit(conn, site_name, site_cfg, "cf.worker_bound", worker)

    email = _email_routing(client, zone_id)
    if email is None:
        emit_unknown(conn, site_name, site_cfg, "cf.email_routing")
    else:
        emit(conn, site_name, site_cfg, "cf.email_routing", email)


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        log.warning("CLOUDFLARE_API_TOKEN missing — cf collector skipped")
        return
    with _client() as client:
        for site_name, site_cfg in reg.sites.items():
            if "cf" not in site_cfg.get("applies_to", []):
                continue
            try:
                _collect_site(client, conn, site_name, site_cfg)
            except Exception:
                log.exception("cf collect %s crashed", site_name)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/test_collect_cloudflare.py -v
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/site-tracker/src/site_tracker/collectors/cloudflare.py tools/site-tracker/tests/test_collect_cloudflare.py
git commit -m "site-tracker: cloudflare collector (zone, worker, email routing)"
```

---

## Task 7: GitHub collector (TDD)

**Files:**
- Create: `tools/site-tracker/src/site_tracker/collectors/github.py`
- Create: `tools/site-tracker/tests/test_collect_github.py`

- [ ] **Step 1: Write failing tests**

```python
"""Tests for collectors.github."""
from __future__ import annotations

import httpx
import pytest
import respx
from freezegun import freeze_time

from site_tracker import registry, store
from site_tracker.collectors import github as gh


@pytest.fixture(autouse=True)
def _gh_env(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "test-pat")


@pytest.fixture
def reg() -> registry.Registry:
    return registry.Registry(
        config={},
        sites={
            "alpha.test": {"active": True, "github": "org/alpha", "applies_to": ["github"]},
        },
    )


@respx.mock
def test_collects_last_push(db, reg):
    with freeze_time("2026-05-19T12:00:00Z"):
        respx.get("https://api.github.com/repos/org/alpha").mock(
            return_value=httpx.Response(200, json={
                "pushed_at": "2026-05-18T12:00:00Z",
                "default_branch": "main",
            })
        )
        respx.get("https://api.github.com/repos/org/alpha/branches/main").mock(
            return_value=httpx.Response(200, json={"commit": {"sha": "abc123"}})
        )
        gh.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["github.last_push_age_hours"]["value"] == 24.0
    assert facts["github.last_push_age_hours"]["state"] == "green"


@respx.mock
def test_404_marks_unknown(db, reg):
    respx.get("https://api.github.com/repos/org/alpha").mock(
        return_value=httpx.Response(404)
    )
    gh.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["github.last_push_age_hours"]["state"] == "unknown"
```

- [ ] **Step 2: Run tests, see fail**

```bash
pytest tests/test_collect_github.py -v
```

- [ ] **Step 3: Implement `src/site_tracker/collectors/github.py`**

```python
"""GitHub collector — last push age + (placeholder) commits-ahead.

commits_ahead requires a local working copy to compare against; we set it
'unknown' here and let the filesystem collector compute it in a future
revision (or leave it for v2).
"""
from __future__ import annotations

import logging
import os
import sqlite3
from datetime import datetime, timezone

import httpx

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)

BASE = "https://api.github.com"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _client() -> httpx.Client:
    token = os.environ.get("GITHUB_TOKEN", "")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(base_url=BASE, headers=headers, timeout=TIMEOUT)


def _collect_site(client: httpx.Client, conn: sqlite3.Connection, site_name: str, site_cfg: dict) -> None:
    repo = site_cfg.get("github")
    if not repo:
        return
    r = client.get(f"/repos/{repo}")
    if r.status_code != 200:
        emit_unknown(conn, site_name, site_cfg, "github.last_push_age_hours")
        emit_unknown(conn, site_name, site_cfg, "github.commits_ahead")
        return
    pushed = r.json().get("pushed_at")
    if not pushed:
        emit_unknown(conn, site_name, site_cfg, "github.last_push_age_hours")
    else:
        ts = datetime.fromisoformat(pushed.replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
        emit(conn, site_name, site_cfg, "github.last_push_age_hours", round(age, 2))

    # commits_ahead is local vs origin; we don't compute it remotely.
    emit_unknown(conn, site_name, site_cfg, "github.commits_ahead")


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    with _client() as client:
        for site_name, site_cfg in reg.sites.items():
            if "github" not in site_cfg.get("applies_to", []):
                continue
            try:
                _collect_site(client, conn, site_name, site_cfg)
            except Exception:
                log.exception("github collect %s crashed", site_name)
```

- [ ] **Step 4: Run tests, see pass**

```bash
pytest tests/test_collect_github.py -v
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/site-tracker/src/site_tracker/collectors/github.py tools/site-tracker/tests/test_collect_github.py
git commit -m "site-tracker: github collector (last push age)"
```

---

## Task 8: CLI runner (TDD)

**Files:**
- Create: `tools/site-tracker/src/site_tracker/cli.py`
- Create: `tools/site-tracker/src/site_tracker/collectors/search_consoles.py` (v2 stub)
- Create: `tools/site-tracker/tests/test_cli.py`

- [ ] **Step 1: Write `src/site_tracker/collectors/search_consoles.py` — v2 stub**

```python
"""Search Console (Google + Bing) collector — v2 stub. Exits cleanly."""
from __future__ import annotations

import logging
import sqlite3

from site_tracker import registry

log = logging.getLogger(__name__)


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    log.info("search_consoles collector is a v2 stub; no facts emitted.")
```

- [ ] **Step 2: Write failing tests in `tests/test_cli.py`**

```python
"""Tests for the click CLI."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from click.testing import CliRunner

from site_tracker.cli import main


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    fixt = Path(__file__).parent / "fixtures" / "sites.yml"
    (tmp_path / "tools" / "site-tracker").mkdir(parents=True)
    shutil.copy(fixt, tmp_path / "tools" / "site-tracker" / "sites.yml")
    (tmp_path / "data").mkdir()
    return tmp_path


def test_init_db_creates_facts_db(workdir: Path, monkeypatch):
    monkeypatch.chdir(workdir / "tools" / "site-tracker")
    runner = CliRunner()
    res = runner.invoke(main, ["init-db", "--data-dir", str(workdir / "data")])
    assert res.exit_code == 0, res.output
    assert (workdir / "data" / "facts.db").exists()


def test_collect_unknown_collector_errors(workdir: Path, monkeypatch):
    monkeypatch.chdir(workdir / "tools" / "site-tracker")
    runner = CliRunner()
    res = runner.invoke(main, ["collect", "doesnotexist",
                               "--data-dir", str(workdir / "data")])
    assert res.exit_code != 0
    assert "unknown collector" in res.output.lower()


def test_collect_all_runs_each_collector(workdir: Path, monkeypatch):
    monkeypatch.chdir(workdir / "tools" / "site-tracker")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "")  # cf collector will skip
    runner = CliRunner()
    res = runner.invoke(main, ["collect-all", "--data-dir", str(workdir / "data")])
    # not asserting exit==0 because http_scrape will fail DNS on toy hosts,
    # but the CLI must catch exceptions per-collector and continue.
    assert "filesystem" in res.output
    assert "cloudflare" in res.output
```

- [ ] **Step 3: Run tests, see fail**

```bash
pytest tests/test_cli.py -v
```

- [ ] **Step 4: Implement `src/site_tracker/cli.py`**

```python
"""site-tracker CLI: collect, collect-all, init-db, serve, render-domains-index."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import click
from dotenv import load_dotenv

from site_tracker import store, registry
from site_tracker.collectors import (
    cloudflare,
    filesystem,
    github,
    http_scrape,
    search_consoles,
)

COLLECTORS = {
    "filesystem":      filesystem,
    "http_scrape":     http_scrape,
    "cloudflare":      cloudflare,
    "github":          github,
    "search_consoles": search_consoles,
}


def _load_env() -> None:
    for cand in (
        Path.cwd() / ".env",
        Path("/work/.env.shared"),
        Path("/home/jesse/projects/domains/.env"),
    ):
        if cand.exists():
            load_dotenv(cand, override=False)
            return


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )


@click.group()
@click.option("-v", "--verbose", is_flag=True)
def main(verbose: bool) -> None:
    _setup_logging(verbose)
    _load_env()


def _resolve_paths(data_dir: Path | None, sites_yml: Path | None) -> tuple[Path, Path]:
    here = Path.cwd()
    sites = sites_yml or (here / "sites.yml")
    data = data_dir or (here / "data")
    return sites, data


@main.command("init-db")
@click.option("--data-dir", type=click.Path(path_type=Path), default=None)
def init_db(data_dir: Path | None) -> None:
    _, data = _resolve_paths(data_dir, None)
    data.mkdir(parents=True, exist_ok=True)
    store.init_db(data / "facts.db")
    click.echo(f"initialized {data / 'facts.db'}")


def _run_collector(name: str, reg: registry.Registry, db_path: Path) -> int:
    mod = COLLECTORS.get(name)
    if mod is None:
        click.echo(f"unknown collector: {name}", err=True)
        return 2
    store.init_db(db_path)
    conn = store.connect(db_path)
    try:
        click.echo(f"[{name}] start")
        mod.run(reg, conn)
        click.echo(f"[{name}] done")
        return 0
    except Exception as e:
        click.echo(f"[{name}] FAILED: {e}", err=True)
        return 1
    finally:
        conn.close()


@main.command()
@click.argument("name")
@click.option("--data-dir", type=click.Path(path_type=Path), default=None)
@click.option("--sites-yml", type=click.Path(path_type=Path), default=None)
def collect(name: str, data_dir: Path | None, sites_yml: Path | None) -> None:
    sites_path, data = _resolve_paths(data_dir, sites_yml)
    reg = registry.load(sites_path)
    rc = _run_collector(name, reg, data / "facts.db")
    sys.exit(rc)


@main.command("collect-all")
@click.option("--data-dir", type=click.Path(path_type=Path), default=None)
@click.option("--sites-yml", type=click.Path(path_type=Path), default=None)
def collect_all(data_dir: Path | None, sites_yml: Path | None) -> None:
    sites_path, data = _resolve_paths(data_dir, sites_yml)
    reg = registry.load(sites_path)
    overall = 0
    for name in COLLECTORS:
        rc = _run_collector(name, reg, data / "facts.db")
        overall = max(overall, rc)
    sys.exit(overall)


@main.command()
@click.option("--host", default="0.0.0.0")
@click.option("--port", default=4742, type=int)
def serve(host: str, port: int) -> None:
    """Start the FastAPI app."""
    import uvicorn
    uvicorn.run("site_tracker.app.main:app", host=host, port=port, log_level="info")


@main.command("render-domains-index")
@click.option("--sites-yml", type=click.Path(path_type=Path), default=None)
@click.option("--out", type=click.Path(path_type=Path), default=Path("DOMAINS_INDEX.md"))
def render_domains_index(sites_yml: Path | None, out: Path) -> None:
    from site_tracker.scripts import render_domains_index as r
    r.render(sites_yml or Path.cwd() / "sites.yml", out)
    click.echo(f"wrote {out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run tests, see pass**

```bash
pytest tests/test_cli.py -v
```
Expected: 3 passed (the third may report stderr noise; assert is on output substrings only).

- [ ] **Step 6: Commit**

```bash
git add tools/site-tracker/src/site_tracker/cli.py tools/site-tracker/src/site_tracker/collectors/search_consoles.py tools/site-tracker/tests/test_cli.py
git commit -m "site-tracker: click CLI (init-db, collect, collect-all, serve)"
```

---

## Task 9: FastAPI scaffold — healthz + base template + CSS

**Files:**
- Create: `tools/site-tracker/src/site_tracker/app/main.py`
- Create: `tools/site-tracker/src/site_tracker/app/git_ops.py`
- Create: `tools/site-tracker/src/site_tracker/app/templates/base.html`
- Create: `tools/site-tracker/src/site_tracker/app/static/style.css`
- Create: `tools/site-tracker/tests/test_api_matrix.py` (initial healthz test)

- [ ] **Step 1: Write `tests/test_api_matrix.py` with healthz only for now**

```python
"""Tests for the FastAPI app — healthz first."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from site_tracker.app.main import build_app


@pytest.fixture
def appdir(tmp_path: Path) -> Path:
    """A working directory with sites.yml + data/facts.db."""
    fx = Path(__file__).parent / "fixtures" / "sites.yml"
    shutil.copy(fx, tmp_path / "sites.yml")
    (tmp_path / "data").mkdir()
    return tmp_path


@pytest.fixture
def client(appdir: Path, monkeypatch):
    monkeypatch.chdir(appdir)
    app = build_app(sites_yml=appdir / "sites.yml", db_path=appdir / "data" / "facts.db")
    return TestClient(app)


def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
```

- [ ] **Step 2: Run, see fail**

```bash
pytest tests/test_api_matrix.py -v
```

- [ ] **Step 3: Write `src/site_tracker/app/git_ops.py`**

```python
"""Git commit helper for /edit POSTs."""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


def commit_paths(repo_root: Path, paths: list[Path], message: str, *, push: bool) -> None:
    """Stage `paths`, commit, optionally push. Quiet — raises on git failure."""
    for p in paths:
        subprocess.check_call(["git", "add", str(p)], cwd=repo_root)
    subprocess.check_call(["git", "commit", "-m", message], cwd=repo_root)
    if push:
        subprocess.check_call(["git", "push"], cwd=repo_root)
```

- [ ] **Step 4: Write `src/site_tracker/app/templates/base.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>site-tracker</title>
  <link rel="stylesheet" href="/static/style.css">
  <script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
</head>
<body>
  <header>
    <h1><a href="/">site-tracker</a></h1>
    <nav>
      <a href="/">matrix</a> ·
      <a href="/collectors">collectors</a>
    </nav>
  </header>
  <main>{% block body %}{% endblock %}</main>
</body>
</html>
```

- [ ] **Step 5: Write `src/site_tracker/app/static/style.css`**

```css
:root {
  --bg: #0e1116;
  --fg: #e6edf3;
  --muted: #8b949e;
  --grid: #21262d;
  --green: #3fb950;
  --yellow: #d29922;
  --red: #f85149;
  --unknown: #58626c;
  --stale: #a371f7;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 0; }
header { display: flex; justify-content: space-between; align-items: baseline; padding: 1rem 2rem; border-bottom: 1px solid var(--grid); }
header h1 { font-size: 1.1rem; margin: 0; }
header a { color: var(--fg); text-decoration: none; }
header nav a { color: var(--muted); margin-left: 1rem; }
main { padding: 2rem; }
table { border-collapse: collapse; font-size: 0.85rem; }
th, td { border: 1px solid var(--grid); padding: 0.4rem 0.6rem; text-align: center; }
th { background: #161b22; font-weight: 500; }
td.site { text-align: left; font-weight: 500; }
.cell { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-weight: 600; cursor: pointer; }
.cell.green   { background: rgba(63, 185, 80, 0.18);  color: var(--green); }
.cell.yellow  { background: rgba(210, 153, 34, 0.18); color: var(--yellow); }
.cell.red     { background: rgba(248, 81, 73, 0.18);  color: var(--red); }
.cell.unknown { background: rgba(88, 98, 108, 0.25);  color: var(--unknown); }
.cell.stale   { background: rgba(163, 113, 247, 0.18); color: var(--stale); }
.cell.n_a     { color: var(--muted); }
.edit-form input { background: #0e1116; color: var(--fg); border: 1px solid var(--grid); padding: 0.2rem 0.4rem; }
```

- [ ] **Step 6: Write `src/site_tracker/app/main.py`**

```python
"""FastAPI app — matrix, drill-down, edit, collectors."""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from site_tracker import registry, store
from site_tracker.fact_keys import FACTS, families, keys_for_family
from site_tracker.app import git_ops

log = logging.getLogger(__name__)

_HERE = Path(__file__).parent
_TEMPLATES = Jinja2Templates(directory=str(_HERE / "templates"))
_STATIC = _HERE / "static"


def build_app(*, sites_yml: Path, db_path: Path) -> FastAPI:
    app = FastAPI()
    app.mount("/static", StaticFiles(directory=str(_STATIC)), name="static")
    app.state.sites_yml = sites_yml
    app.state.db_path = db_path

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    return app


# Module-level singleton used when uvicorn imports `app`.
def _default_paths() -> tuple[Path, Path]:
    sy = Path(os.environ.get("SITE_TRACKER_SITES_YML", "/work/tools/site-tracker/sites.yml"))
    db = Path(os.environ.get("SITE_TRACKER_DB", "/work/tools/site-tracker/data/facts.db"))
    return sy, db


sites_yml, db_path = _default_paths()
app = build_app(sites_yml=sites_yml, db_path=db_path)
```

- [ ] **Step 7: Run tests, see pass**

```bash
pytest tests/test_api_matrix.py::test_healthz_ok -v
```
Expected: 1 passed.

- [ ] **Step 8: Commit**

```bash
git add tools/site-tracker/src/site_tracker/app/ tools/site-tracker/tests/test_api_matrix.py
git commit -m "site-tracker: FastAPI scaffold + base template + CSS + /healthz"
```

---

## Task 10: GET / — status matrix (TDD)

**Files:**
- Modify: `tools/site-tracker/src/site_tracker/app/main.py` (add `/` route)
- Create: `tools/site-tracker/src/site_tracker/app/templates/matrix.html`
- Modify: `tools/site-tracker/tests/test_api_matrix.py` (add matrix tests)

- [ ] **Step 1: Add failing matrix tests to `tests/test_api_matrix.py`**

Append:

```python
from site_tracker import store


def _seed_facts(db_path: Path):
    store.init_db(db_path)
    conn = store.connect(db_path)
    try:
        store.upsert_fact(conn, site="alpha.test", key="cf.zone_active",
                          value=True, source="cf_api", state="green", ttl_hours=6)
        store.upsert_fact(conn, site="alpha.test", key="http.ga4_present",
                          value=True, source="http_scrape", state="green", ttl_hours=24)
        store.upsert_fact(conn, site="beta.test", key="http.ga4_present",
                          value=False, source="http_scrape", state="yellow", ttl_hours=24)
    finally:
        conn.close()


def test_matrix_renders_sites_and_columns(client, appdir):
    _seed_facts(appdir / "data" / "facts.db")
    r = client.get("/")
    assert r.status_code == 200
    html = r.text
    assert "alpha.test" in html
    assert "beta.test" in html
    # parked.test is in fixtures sites.yml and should also render
    assert "parked.test" in html
    # Column headers (families) — at least these
    assert ">cf<" in html
    assert ">http<" in html


def test_matrix_cell_state_class_present(client, appdir):
    _seed_facts(appdir / "data" / "facts.db")
    r = client.get("/")
    html = r.text
    assert "cell green" in html
    assert "cell yellow" in html


def test_matrix_n_a_for_families_site_doesnt_apply_to(client, appdir):
    _seed_facts(appdir / "data" / "facts.db")
    r = client.get("/")
    html = r.text
    # parked.test only applies_to [cf], so its sitemap/http cells should be n_a
    assert "cell n_a" in html
```

- [ ] **Step 2: Add the `/` route to `src/site_tracker/app/main.py`**

Inside `build_app()`, after `/healthz`:

```python
    @app.get("/", response_class=HTMLResponse)
    def matrix(request: Request):
        reg = registry.load(app.state.sites_yml)
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            rows = []
            for site_name, site_cfg in reg.sites.items():
                facts = store.get_site_facts(conn, site_name)
                row = {"site": site_name, "cells": {}}
                applies = set(site_cfg.get("applies_to", []))
                for fam in families():
                    if fam not in applies:
                        row["cells"][fam] = {"state": "n_a", "summary": "—"}
                        continue
                    keys = keys_for_family(fam) if fam != "manual" else []
                    if fam == "manual":
                        man = site_cfg.get("manual", {}) or {}
                        if man:
                            row["cells"][fam] = {"state": "green", "summary": f"{len(man)}"}
                        else:
                            row["cells"][fam] = {"state": "yellow", "summary": "?"}
                        continue
                    states = [facts.get(k, {}).get("state", "unknown") for k in keys]
                    summary_state = _rollup(states)
                    row["cells"][fam] = {"state": summary_state, "summary": _short(summary_state)}
                rows.append(row)
        finally:
            conn.close()
        return _TEMPLATES.TemplateResponse(
            "matrix.html",
            {"request": request, "rows": rows, "families": families()},
        )
```

Below `build_app`, add helpers:

```python
def _rollup(states: list[str]) -> str:
    order = ["red", "stale", "yellow", "unknown", "green", "n_a"]
    if not states:
        return "unknown"
    for s in order:
        if s in states:
            return s
    return "unknown"


def _short(state: str) -> str:
    return {"green": "✓", "yellow": "?", "red": "✗",
            "stale": "·", "unknown": "?", "n_a": "—"}.get(state, "?")
```

- [ ] **Step 3: Write `src/site_tracker/app/templates/matrix.html`**

```html
{% extends "base.html" %}
{% block body %}
<table>
  <thead>
    <tr>
      <th class="site">site</th>
      {% for fam in families %}<th>{{ fam }}</th>{% endfor %}
    </tr>
  </thead>
  <tbody>
    {% for row in rows %}
    <tr>
      <td class="site"><a href="/site/{{ row.site }}">{{ row.site }}</a></td>
      {% for fam in families %}
        {% set cell = row.cells[fam] %}
        <td>
          <span class="cell {{ cell.state }}">{{ cell.summary }}</span>
        </td>
      {% endfor %}
    </tr>
    {% endfor %}
  </tbody>
</table>
{% endblock %}
```

- [ ] **Step 4: Run tests, see pass**

```bash
pytest tests/test_api_matrix.py -v
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/site-tracker/src/site_tracker/app/main.py tools/site-tracker/src/site_tracker/app/templates/matrix.html tools/site-tracker/tests/test_api_matrix.py
git commit -m "site-tracker: status matrix at GET /"
```

---

## Task 11: GET /site/{site} — drill-down (TDD)

**Files:**
- Modify: `tools/site-tracker/src/site_tracker/app/main.py`
- Create: `tools/site-tracker/src/site_tracker/app/templates/site_detail.html`
- Create: `tools/site-tracker/tests/test_api_site_detail.py`

- [ ] **Step 1: Write failing tests**

```python
"""Tests for GET /site/{site}."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from site_tracker import store
from site_tracker.app.main import build_app


@pytest.fixture
def appdir(tmp_path: Path) -> Path:
    fx = Path(__file__).parent / "fixtures" / "sites.yml"
    shutil.copy(fx, tmp_path / "sites.yml")
    (tmp_path / "data").mkdir()
    return tmp_path


@pytest.fixture
def client(appdir: Path, monkeypatch):
    monkeypatch.chdir(appdir)
    app = build_app(sites_yml=appdir / "sites.yml", db_path=appdir / "data" / "facts.db")
    return TestClient(app)


def _seed(db_path: Path):
    store.init_db(db_path)
    conn = store.connect(db_path)
    try:
        store.upsert_fact(conn, site="alpha.test", key="cf.zone_active",
                          value=True, source="cf_api", state="green", ttl_hours=6)
        store.upsert_fact(conn, site="alpha.test", key="http.ga4_present",
                          value=True, source="http_scrape", state="green", ttl_hours=24)
    finally:
        conn.close()


def test_drilldown_lists_every_applicable_fact(client, appdir):
    _seed(appdir / "data" / "facts.db")
    r = client.get("/site/alpha.test")
    assert r.status_code == 200
    html = r.text
    assert "cf.zone_active" in html
    assert "http.ga4_present" in html
    # alpha.test applies_to manual but has manual.amazon_associates_id seeded in fixtures
    assert "amazon_associates_id" in html


def test_drilldown_unknown_site_404(client):
    r = client.get("/site/doesnotexist.com")
    assert r.status_code == 404
```

- [ ] **Step 2: Run, see fail**

```bash
pytest tests/test_api_site_detail.py -v
```

- [ ] **Step 3: Add the `/site/{site}` route in `app/main.py`**

```python
    @app.get("/site/{site}", response_class=HTMLResponse)
    def site_detail(request: Request, site: str):
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise HTTPException(status_code=404, detail="site not found")
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            site_cfg = reg.sites[site]
            applies = set(site_cfg.get("applies_to", []))
            facts = store.get_site_facts(conn, site)
            rows = []
            for key, spec in FACTS.items():
                if spec.family not in applies:
                    continue
                f = facts.get(key, {})
                rows.append({
                    "key": key,
                    "describe": spec.describe,
                    "family": spec.family,
                    "value": f.get("value"),
                    "source": f.get("source") or spec.source,
                    "state": f.get("state", "unknown"),
                    "verified_at": f.get("verified_at"),
                    "age_hours": f.get("age_hours"),
                })
            manual_rows = []
            if "manual" in applies:
                for k, v in (site_cfg.get("manual") or {}).items():
                    if isinstance(v, dict):
                        manual_rows.append({"key": k, "value": v.get("value"), "set_at": v.get("set_at")})
                    else:
                        manual_rows.append({"key": k, "value": v, "set_at": None})
        finally:
            conn.close()
        return _TEMPLATES.TemplateResponse(
            "site_detail.html",
            {"request": request, "site": site, "rows": rows, "manual_rows": manual_rows},
        )
```

- [ ] **Step 4: Write `src/site_tracker/app/templates/site_detail.html`**

```html
{% extends "base.html" %}
{% block body %}
<h2>{{ site }}</h2>

<h3>Auto-detected facts</h3>
<table>
  <thead><tr><th>key</th><th>describe</th><th>value</th><th>state</th><th>source</th><th>age (h)</th></tr></thead>
  <tbody>
    {% for r in rows %}
    <tr>
      <td class="site">{{ r.key }}</td>
      <td>{{ r.describe }}</td>
      <td>{{ r.value if r.value is not none else '—' }}</td>
      <td><span class="cell {{ r.state }}">{{ r.state }}</span></td>
      <td>{{ r.source }}</td>
      <td>{{ r.age_hours if r.age_hours is not none else '—' }}</td>
    </tr>
    {% endfor %}
  </tbody>
</table>

<h3>Manual facts</h3>
<table>
  <thead><tr><th>key</th><th>value</th><th>set_at</th></tr></thead>
  <tbody>
    {% for m in manual_rows %}
    <tr>
      <td class="site">{{ m.key }}</td>
      <td id="manual-{{ m.key }}"
          hx-get="/site/{{ site }}/edit/manual.{{ m.key }}"
          hx-target="this" hx-swap="outerHTML"
          style="cursor: pointer">
        {{ m.value }}
      </td>
      <td>{{ m.set_at or '—' }}</td>
    </tr>
    {% endfor %}
    <tr>
      <td class="site"><em>+ add</em></td>
      <td colspan="2"
          hx-get="/site/{{ site }}/edit/manual.new"
          hx-target="this" hx-swap="outerHTML">
        click to add a manual fact
      </td>
    </tr>
  </tbody>
</table>
{% endblock %}
```

- [ ] **Step 5: Run tests, see pass**

```bash
pytest tests/test_api_site_detail.py -v
```
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add tools/site-tracker/src/site_tracker/app/ tools/site-tracker/tests/test_api_site_detail.py
git commit -m "site-tracker: per-site drill-down at GET /site/{site}"
```

---

## Task 12: Edit cell — GET + POST /site/{site}/edit/{key} (TDD)

**Files:**
- Modify: `tools/site-tracker/src/site_tracker/app/main.py`
- Create: `tools/site-tracker/src/site_tracker/app/templates/fragments/edit_form.html`
- Create: `tools/site-tracker/src/site_tracker/app/templates/fragments/cell.html`
- Create: `tools/site-tracker/tests/test_api_edit.py`

- [ ] **Step 1: Write failing tests**

```python
"""Tests for GET + POST /site/{site}/edit/{key}."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from site_tracker.app.main import build_app


@pytest.fixture
def appdir(tmp_path: Path) -> Path:
    fx = Path(__file__).parent / "fixtures" / "sites.yml"
    repo = tmp_path / "domains"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    (repo / "tools" / "site-tracker").mkdir(parents=True)
    shutil.copy(fx, repo / "tools" / "site-tracker" / "sites.yml")
    (repo / "data").mkdir()
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    return repo


@pytest.fixture
def client(appdir: Path, monkeypatch):
    monkeypatch.chdir(appdir / "tools" / "site-tracker")
    app = build_app(
        sites_yml=appdir / "tools" / "site-tracker" / "sites.yml",
        db_path=appdir / "data" / "facts.db",
    )
    app.state.git_root = appdir
    return TestClient(app)


def test_get_edit_form_returns_input_fragment(client):
    r = client.get("/site/alpha.test/edit/manual.amazon_associates_id")
    assert r.status_code == 200
    assert "<input" in r.text or "<form" in r.text
    assert "amazon_associates_id" in r.text


def test_post_edit_writes_sites_yml_and_commits(client, appdir):
    r = client.post(
        "/site/alpha.test/edit/manual.adsense_status",
        data={"value": "approved"},
    )
    assert r.status_code == 200
    reloaded = yaml.safe_load((appdir / "tools" / "site-tracker" / "sites.yml").read_text())
    val = reloaded["sites"]["alpha.test"]["manual"]["adsense_status"]
    assert (val == "approved") or val.get("value") == "approved"
    log = subprocess.check_output(["git", "log", "-1", "--format=%s"], cwd=appdir, text=True).strip()
    assert "alpha.test" in log
    assert "adsense_status" in log


def test_post_edit_unknown_site_404(client):
    r = client.post("/site/doesnotexist.com/edit/manual.x", data={"value": "y"})
    assert r.status_code == 404
```

- [ ] **Step 2: Run, see fail**

```bash
pytest tests/test_api_edit.py -v
```

- [ ] **Step 3: Add edit routes to `app/main.py`**

Add this import near the top of `main.py`:

```python
import subprocess
```

Add these two routes inside `build_app()`:

```python
    @app.get("/site/{site}/edit/{key}", response_class=HTMLResponse)
    def edit_form(request: Request, site: str, key: str):
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise HTTPException(status_code=404, detail="site not found")
        current = ""
        if key.startswith("manual."):
            sub = key[len("manual."):]
            man = reg.sites[site].get("manual", {}) or {}
            v = man.get(sub)
            current = (v.get("value") if isinstance(v, dict) else v) or ""
        return _TEMPLATES.TemplateResponse(
            "fragments/edit_form.html",
            {"request": request, "site": site, "key": key, "current": current},
        )

    @app.post("/site/{site}/edit/{key}", response_class=HTMLResponse)
    async def edit_submit(request: Request, site: str, key: str):
        form = dict(await request.form())
        new_value = (form.get("value") or "").strip()
        custom_key = (form.get("key") or "").strip()
        reg = registry.load(app.state.sites_yml)
        if site not in reg.sites:
            raise HTTPException(status_code=404, detail="site not found")
        if key == "manual.new":
            if not custom_key:
                raise HTTPException(status_code=400, detail="missing 'key' in form")
            sub = custom_key
        elif key.startswith("manual."):
            sub = key[len("manual."):]
        else:
            raise HTTPException(status_code=400, detail="only manual.* keys are editable")
        registry.set_manual_fact(reg, app.state.sites_yml, site, sub, new_value)
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            store.upsert_fact(
                conn, site=site, key=f"manual.{sub}",
                value=new_value, source="manual", state="green", ttl_hours=None,
            )
        finally:
            conn.close()
        cfg = reg.config
        if cfg.get("auto_commit", True):
            try:
                git_root = getattr(app.state, "git_root", None) or Path(cfg.get("domains_root", "/work"))
                git_ops.commit_paths(
                    git_root,
                    [app.state.sites_yml],
                    f"site-tracker: {site} manual.{sub} = {new_value}",
                    push=cfg.get("auto_push", False),
                )
            except subprocess.CalledProcessError:
                log.exception("git commit failed")
                raise HTTPException(status_code=500, detail="commit failed")
        return _TEMPLATES.TemplateResponse(
            "fragments/cell.html",
            {"request": request, "site": site, "key": f"manual.{sub}",
             "value": new_value, "state": "green"},
        )
```

- [ ] **Step 4: Write `app/templates/fragments/edit_form.html`**

```html
<td colspan="2" class="edit-form">
  <form hx-post="/site/{{ site }}/edit/{{ key }}" hx-target="closest tr" hx-swap="outerHTML">
    {% if key == "manual.new" %}
      <input type="text" name="key" placeholder="key (e.g. adsense_status)" required>
    {% endif %}
    <input type="text" name="value" value="{{ current }}" autofocus required>
    <button type="submit">save</button>
  </form>
</td>
```

- [ ] **Step 5: Write `app/templates/fragments/cell.html`**

```html
<tr>
  <td class="site">{{ key.replace('manual.', '') }}</td>
  <td><span class="cell {{ state }}">{{ value }}</span></td>
  <td>just now</td>
</tr>
```

- [ ] **Step 6: Run tests, see pass**

```bash
pytest tests/test_api_edit.py -v
```
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add tools/site-tracker/src/site_tracker/app/ tools/site-tracker/tests/test_api_edit.py
git commit -m "site-tracker: edit-cell flow (GET form, POST writes sites.yml + commits)"
```

---

## Task 13: GET /collectors + POST /collectors/{name}/run (TDD)

**Files:**
- Modify: `tools/site-tracker/src/site_tracker/app/main.py`
- Create: `tools/site-tracker/src/site_tracker/app/templates/collectors.html`
- Create: `tools/site-tracker/tests/test_api_collectors.py`

- [ ] **Step 1: Write failing tests**

```python
"""Tests for /collectors."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from site_tracker.app.main import build_app


@pytest.fixture
def appdir(tmp_path: Path) -> Path:
    fx = Path(__file__).parent / "fixtures" / "sites.yml"
    shutil.copy(fx, tmp_path / "sites.yml")
    (tmp_path / "data").mkdir()
    return tmp_path


@pytest.fixture
def client(appdir: Path, monkeypatch):
    monkeypatch.chdir(appdir)
    app = build_app(sites_yml=appdir / "sites.yml", db_path=appdir / "data" / "facts.db")
    return TestClient(app)


def test_collectors_page_lists_all_known(client):
    r = client.get("/collectors")
    assert r.status_code == 200
    for name in ("filesystem", "http_scrape", "cloudflare", "github", "search_consoles"):
        assert name in r.text


def test_post_run_unknown_404(client):
    r = client.post("/collectors/doesnotexist/run")
    assert r.status_code == 404


def test_post_run_returns_200_and_starts(client, monkeypatch):
    called = {}
    def fake_run(reg, conn):
        called["yes"] = True
    monkeypatch.setattr("site_tracker.collectors.search_consoles.run", fake_run)
    r = client.post("/collectors/search_consoles/run")
    assert r.status_code == 200
    assert called == {"yes": True}
```

- [ ] **Step 2: Run, see fail**

```bash
pytest tests/test_api_collectors.py -v
```

- [ ] **Step 3: Add collector routes to `app/main.py`**

Add this import near the top:

```python
from site_tracker.cli import COLLECTORS
```

Inside `build_app()`:

```python
    @app.get("/collectors", response_class=HTMLResponse)
    def collectors_page(request: Request):
        return _TEMPLATES.TemplateResponse(
            "collectors.html",
            {"request": request, "collectors": list(COLLECTORS.keys())},
        )

    @app.post("/collectors/{name}/run", response_class=HTMLResponse)
    def collectors_run(name: str):
        if name not in COLLECTORS:
            raise HTTPException(status_code=404, detail="unknown collector")
        reg = registry.load(app.state.sites_yml)
        store.init_db(app.state.db_path)
        conn = store.connect(app.state.db_path)
        try:
            COLLECTORS[name].run(reg, conn)
        finally:
            conn.close()
        return HTMLResponse(f'<div class="cell green">{name} done</div>')
```

- [ ] **Step 4: Write `app/templates/collectors.html`**

```html
{% extends "base.html" %}
{% block body %}
<h2>Collectors</h2>
<table>
  <thead><tr><th>name</th><th>action</th></tr></thead>
  <tbody>
    {% for c in collectors %}
    <tr>
      <td class="site">{{ c }}</td>
      <td>
        <button hx-post="/collectors/{{ c }}/run" hx-target="this" hx-swap="outerHTML">run</button>
      </td>
    </tr>
    {% endfor %}
  </tbody>
</table>
{% endblock %}
```

- [ ] **Step 5: Run tests, see pass**

```bash
pytest tests/test_api_collectors.py -v
```
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add tools/site-tracker/src/site_tracker/app/ tools/site-tracker/tests/test_api_collectors.py
git commit -m "site-tracker: /collectors page + force-run endpoint"
```

---

## Task 14: Dockerfile + entrypoint + crontab

**Files:**
- Create: `tools/site-tracker/Dockerfile`
- Create: `tools/site-tracker/entrypoint.sh`
- Create: `tools/site-tracker/crontab.docker`

- [ ] **Step 1: Write `Dockerfile`** (modeled on `tools/cf-stats/Dockerfile`)

```dockerfile
# site-tracker — long-running container.
# Two processes:
#   1. FastAPI app via uvicorn (bound to :4742)
#   2. supercronic running the collector schedule
# entrypoint.sh starts both; uvicorn in background, supercronic in foreground.

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tzdata git \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/supercronic \
       https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && chmod +x /usr/local/bin/supercronic

ENV TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SITE_TRACKER_SITES_YML=/work/tools/site-tracker/sites.yml \
    SITE_TRACKER_DB=/work/tools/site-tracker/data/facts.db

RUN groupadd -g 1000 ops && \
    useradd -u 1000 -g ops -m -s /bin/sh ops

WORKDIR /opt/site-tracker
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY crontab.docker /etc/crontab.docker
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 4742

USER ops
WORKDIR /work/tools/site-tracker
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 2: Write `entrypoint.sh`**

```sh
#!/bin/sh
# site-tracker container entrypoint.
# 1. Source /work/.env.shared so CF + GitHub creds are available to collectors.
# 2. Ensure data/ + out/ exist.
# 3. init-db (idempotent).
# 4. Start uvicorn in background, supercronic in foreground.
set -e

echo "[$(date -Iseconds)] site-tracker container starting"

ENV_SHARED="/work/.env.shared"
if [ -f "$ENV_SHARED" ]; then
  set -a; . "$ENV_SHARED"; set +a
  echo "[$(date -Iseconds)] loaded .env.shared"
else
  echo "[$(date -Iseconds)] WARNING: $ENV_SHARED missing — CF + GitHub collectors will skip"
fi

mkdir -p /work/tools/site-tracker/data /work/tools/site-tracker/out

site-tracker init-db --data-dir /work/tools/site-tracker/data

# uvicorn in background
site-tracker serve --host 0.0.0.0 --port 4742 &
echo "[$(date -Iseconds)] uvicorn started on :4742 (pid $!)"

# supercronic in foreground — absolute path required (see cf-stats entrypoint for why)
exec /usr/local/bin/supercronic -passthrough-logs /etc/crontab.docker
```

- [ ] **Step 3: Write `crontab.docker`**

```cron
# site-tracker schedule (supercronic, TZ=UTC).
# Offsets chosen so this container doesn't bunch up with cf-stats (:23) or
# americastrikes/sinderella ops crons.

*/15 * * * * cd /work/tools/site-tracker && site-tracker collect filesystem      2>&1 | tee -a /work/tools/site-tracker/out/cron.log
17   * * * * cd /work/tools/site-tracker && site-tracker collect http_scrape     2>&1 | tee -a /work/tools/site-tracker/out/cron.log
33   * * * * cd /work/tools/site-tracker && site-tracker collect cloudflare      2>&1 | tee -a /work/tools/site-tracker/out/cron.log
0    4 * * * cd /work/tools/site-tracker && site-tracker collect github          2>&1 | tee -a /work/tools/site-tracker/out/cron.log
```

- [ ] **Step 4: Commit**

```bash
git add tools/site-tracker/Dockerfile tools/site-tracker/entrypoint.sh tools/site-tracker/crontab.docker
git commit -m "site-tracker: Dockerfile + entrypoint + supercronic schedule"
```

---

## Task 15: docker-compose.yml + smoke test

**Files:**
- Create: `tools/site-tracker/docker-compose.yml`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
# site-tracker — portfolio maintenance dashboard.
#
# Bring up:    docker compose up -d --build
# Open:        http://localhost:4742
# Watch logs:  docker compose logs -f
# Force run:   docker compose exec site-tracker site-tracker collect <name>
# Stop:        docker compose down

name: site-tracker

services:
  site-tracker:
    build:
      context: .
      dockerfile: Dockerfile
    image: site-tracker:latest
    container_name: site-tracker
    restart: unless-stopped
    user: "1000:1000"
    environment:
      TZ: UTC
    ports:
      - "4742:4742"
    volumes:
      # Parent domains repo, read-write — collectors read /work/sites/* and
      # the edit-cell POST commits sites.yml inside /work.
      - ${HOME:-/home/jesse}/projects/domains:/work
      # The shared .env (CF token, GitHub PAT) bind-mounted at the spot
      # entrypoint.sh sources.
      - ${HOME:-/home/jesse}/projects/domains/.env:/work/.env.shared:ro
```

- [ ] **Step 2: Bring up and smoke-test**

```bash
cd tools/site-tracker
docker compose up -d --build
sleep 3
curl -fsS http://localhost:4742/healthz
docker compose exec site-tracker site-tracker collect filesystem
curl -fsS http://localhost:4742/ | head -40
docker compose logs --tail=40
```

Expected:
- `healthz` returns `{"ok":true}`
- filesystem collector exits 0
- `/` returns HTML containing `aliencouncil.com`, `cf`, `http`, etc.

- [ ] **Step 3: Take down**

```bash
docker compose down
```

- [ ] **Step 4: Commit**

```bash
git add tools/site-tracker/docker-compose.yml
git commit -m "site-tracker: docker-compose.yml (localhost:4742)"
```

---

## Task 16: render_domains_index + README + tools/README.md update

**Files:**
- Create: `tools/site-tracker/src/site_tracker/scripts/__init__.py`
- Create: `tools/site-tracker/src/site_tracker/scripts/render_domains_index.py`
- Create: `tools/site-tracker/tests/test_render_domains_index.py`
- Modify: `tools/site-tracker/README.md`
- Modify: `tools/README.md`

- [ ] **Step 1: Create scripts package**

```bash
touch tools/site-tracker/src/site_tracker/scripts/__init__.py
```

- [ ] **Step 2: Write failing test**

```python
"""Tests for scripts.render_domains_index."""
from __future__ import annotations

import shutil
from pathlib import Path

from site_tracker.scripts import render_domains_index


def test_renders_active_and_parked_sections(tmp_path: Path):
    src = Path(__file__).parent / "fixtures" / "sites.yml"
    sy = tmp_path / "sites.yml"
    out = tmp_path / "DOMAINS_INDEX.md"
    shutil.copy(src, sy)
    render_domains_index.render(sy, out)
    text = out.read_text()
    assert "Active sites" in text
    assert "alpha.test" in text
    assert "Parked" in text
    assert "parked.test" in text
```

- [ ] **Step 3: Run, see fail**

```bash
pytest tests/test_render_domains_index.py -v
```

- [ ] **Step 4: Implement `src/site_tracker/scripts/render_domains_index.py`**

```python
"""Regenerate the human-readable DOMAINS_INDEX.md from sites.yml."""
from __future__ import annotations

from pathlib import Path

from site_tracker import registry


def render(sites_yml: Path, out: Path) -> None:
    reg = registry.load(sites_yml)
    lines = ["# Domains Index", ""]

    lines.append("## Active sites (built / operating)")
    lines.append("")
    lines.append("| Domain | TLDR |")
    lines.append("|--------|------|")
    for name, cfg in sorted(reg.sites.items()):
        if not cfg.get("active"):
            continue
        tldr = (cfg.get("manual", {}) or {}).get("tldr") or ""
        if isinstance(tldr, dict):
            tldr = tldr.get("value", "")
        lines.append(f"| {name} | {tldr} |")

    lines.append("")
    lines.append("## Parked / empty (registered, no site yet)")
    lines.append("")
    lines.append("| Domain | TLDR |")
    lines.append("|--------|------|")
    for name, cfg in sorted(reg.sites.items()):
        if cfg.get("active"):
            continue
        tldr = (cfg.get("manual", {}) or {}).get("tldr") or ""
        if isinstance(tldr, dict):
            tldr = tldr.get("value", "")
        lines.append(f"| {name} | {tldr} |")

    lines.append("")
    out.write_text("\n".join(lines))
```

- [ ] **Step 5: Run tests, see pass**

```bash
pytest tests/test_render_domains_index.py -v
```
Expected: 1 passed.

- [ ] **Step 6: Expand `tools/site-tracker/README.md`**

```markdown
# site-tracker

Portfolio maintenance dashboard — per-site verification/wiring state across
the domains portfolio. Status matrix view at `localhost:4742`, click-to-edit
manual facts, collectors run on cron inside the container.

Design: [`docs/superpowers/specs/2026-05-19-site-tracker-design.md`](../../docs/superpowers/specs/2026-05-19-site-tracker-design.md)

## Quickstart

```bash
cd tools/site-tracker
docker compose up -d --build
open http://localhost:4742
```

## What you see

- **Matrix (`/`)** — one row per site, one column per fact family. Each cell is a rollup of all facts in that family. Green/yellow/red/stale/unknown/n_a.
- **Drill-down (`/site/<site>`)** — every individual fact with value, source, age, state. Manual facts at the bottom; click any value to edit inline.
- **Collectors (`/collectors`)** — list and force-run each collector.

## Fact sources

| Source       | What it produces                                                  | Cadence |
|--------------|-------------------------------------------------------------------|---------|
| filesystem   | last commit age, ops/board last-run age                           | 15 min  |
| http_scrape  | GA4/AdSense/Meta Pixel/GTM in `<head>`, sitemap.xml, robots.txt, TLS expiry | hourly :17 |
| cloudflare   | zone active, worker bound, email routing                          | hourly :33 |
| github       | last push age                                                     | daily 04:00 |
| manual       | anything you type into a cell (writes sites.yml, commits)         | on edit |
| site_push    | (reserved) per-site cron writes ops/board/facts.json              | n/a v1  |

## Files

| File | Purpose |
|------|---------|
| `sites.yml` | Site registry — source of truth. Hand-edited; `manual:` block is written by the edit-cell POST. |
| `src/site_tracker/fact_keys.py` | The v1 fact registry (key → family, source, TTL, state rule). |
| `src/site_tracker/collectors/` | One module per source type. |
| `src/site_tracker/app/main.py` | FastAPI app. |
| `data/facts.db` | SQLite store (gitignored). |
| `out/cron.log` | supercronic output (gitignored). |

## Operations

```bash
# Bring up
docker compose up -d --build

# Watch
docker compose logs -f

# Force one collector
docker compose exec site-tracker site-tracker collect cloudflare

# Force all
docker compose exec site-tracker site-tracker collect-all

# Regenerate DOMAINS_INDEX.md from sites.yml
docker compose exec site-tracker site-tracker render-domains-index --out /work/DOMAINS_INDEX.md

# Take down
docker compose down
```

## What it does NOT do (v1)

- Google Search Console / Bing Webmaster — `collect_search_consoles` is a v2 stub.
- Active collection for parked sites — they're in `sites.yml` but collectors skip them.
- Time-series view — use `cf-grafana` for that.
- Hosted on the public internet — local-only by design.
```

- [ ] **Step 7: Update `tools/README.md`** — add a row to the Tools table

In `tools/README.md`, find the table under `## Tools` and add:

```markdown
| [`site-tracker/`](./site-tracker/) | Portfolio maintenance dashboard at `localhost:4742` — per-site verification/wiring state in a status matrix (CF, GA4, AdSense, sitemap, TLS, git, GitHub, manual facts). Containerized FastAPI + HTMX + SQLite. Click any cell to edit manual facts; writes back to `sites.yml` and commits. |
```

- [ ] **Step 8: Commit**

```bash
git add tools/site-tracker/src/site_tracker/scripts/ tools/site-tracker/tests/test_render_domains_index.py tools/site-tracker/README.md tools/README.md
git commit -m "site-tracker: render_domains_index + README + register in tools/"
```

---

## Final Verification

- [ ] **Run the full test suite**

```bash
cd tools/site-tracker
pytest -v
```
Expected: all tests pass.

- [ ] **Bring up the container and click around**

```bash
docker compose up -d --build
open http://localhost:4742
```

Verify:
- Matrix renders with the 7 active sites
- Clicking a site row navigates to `/site/<site>`
- Drill-down lists all applicable facts
- A `manual.x` cell can be added and the page reflects the edit
- `sites.yml` in the git repo has a fresh commit
- `/collectors` lists 5 collectors and `run` succeeds for filesystem

- [ ] **Wait for the first scheduled cron tick (or force it)**

```bash
docker compose exec site-tracker site-tracker collect-all
curl -fsS http://localhost:4742/ | grep -E "(green|yellow|red)" | head
```

Expected: facts populated from filesystem + http + cloudflare + github collectors.

- [ ] **Take it down**

```bash
docker compose down
```

---

## Self-Review notes (already applied)

1. **Spec coverage:** Each component named in the spec maps to one or more tasks: registry → T3, collectors → T4–T7 + T8 stub, store → T2, API+frontend → T9–T13, container → T14–T15, scripts → T16. v2 deferrals (GSC OAuth, hosted, time-series) explicitly carried into README's "does NOT do (v1)" section.

2. **Type consistency:** `emit(conn, site, site_cfg, key, value)` signature is consistent across `base.py` and every collector. `store.upsert_fact(conn, *, site, key, value, source, state, ttl_hours)` is consistent across `store.py`, `base.py`, and the edit POST. Fact-key strings (e.g., `fs.last_commit_age_hours`, `cf.zone_active`) match between `fact_keys.py`, the collectors that emit them, and the tests that assert them.

3. **State rules:** Defined once in `fact_keys.py`'s `state_from_value` callables. No collector hard-codes thresholds.

4. **Refinement from spec acknowledged at top:** `store.py` and `registry.py` moved up one level from `app/` since collectors import them. Reflected in the File Structure section.
