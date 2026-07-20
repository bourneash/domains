# Fleet Analytics Pipeline — Plan 2: Metrics Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the daily GA4 + Search Console metrics collector on top of `tools/data-hub`, so every live
site's traffic and search data lands in permanent, queryable storage instead of nowhere.

**Architecture:** Two typed fetchers (`src/datahub/metrics/ga4.py`, `src/datahub/metrics/gsc.py`) each pull one
site's trailing 7-day window from Google's APIs using the scoped clients Plan 1 already built
(`google_auth_fleet.clients.ga4_data()` / `.search_console()`). A new orchestrator
(`src/datahub/metrics_collector.py`) loops every site in the registry Plan 1 wrote
(`registry/sites-analytics.yaml`), isolates failures per site exactly like `collector.py` isolates them per
source, and upserts into two new typed tables via `store.py`. A second `__main__.py` command
(`collect-metrics`) runs this on its own daily cron line, separate from the existing `*/30` RSS/dataset cycle.
New `/metrics/*` endpoints in `api.py` expose the data to the Fleet Dashboard and cron roles.

**Tech Stack:** Python 3.11, `googleapiclient` (via `google-auth-fleet`, already a dependency of Plan 1's tools —
not yet a `data-hub` dependency, added here), SQLite (existing `store.py` connection), FastAPI (existing
`api.py`), pytest.

## Global Constraints

- **Upsert, never append.** Both APIs restate and revise recent data. Every write goes through
  `ON CONFLICT(...) DO UPDATE`, keyed on `(site, date, grain, dim_key)`. Re-pulling the same window twice must
  produce zero duplicate rows.
- **Trailing 7-day window**, re-pulled every cycle: `start = today - 7`, `end = today - 1` (yesterday — GA4 and
  GSC both lag and finalize over the following 1-3 days, so today's own data is worthless to pull yet).
- **VPN policy: `direct`.** Authenticated Google API calls do not route through the PIA proxy — call the
  googleapiclient clients directly. This mirrors the sanctioned direct-path carve-out already documented for
  gov APIs in the data-hub design; it is not a new policy, just a new consumer of an existing one.
- **Metrics tables are exempt from the 7-day retention prune.** `store.prune()`'s `_PRUNE_COLUMNS` dict must
  NOT gain `ga4_metrics`/`gsc_metrics` entries — GSC's 16-month rolling window is the only place this data
  exists once it ages out there, so anything we drop is gone forever.
- **Absence is not zero.** A site with no row for a given date must come back as absent from a query, never as
  a fabricated `0`. This applies to fetchers (an empty API response yields zero records, not zero-valued
  records) and to `/metrics/summary` (a site with no data in the window is flagged, not silently averaged as 0).
- **Consent-gated sites are marked, not corrected.** `saveusfarms.com` and `weapontester.com` load GA4 only
  after consent and therefore undercount. The collector pulls them exactly like every other site — the
  `consent_gated` flag already sits in `registry/sites-analytics.yaml` from Plan 1, and `/metrics/health`
  surfaces it so a consumer can choose not to rank them against ungated sites. No correction factor exists.
- **One failure never aborts the run.** Every site is isolated in its own try/except, matching
  `collector.py:77-85`'s existing per-source isolation. A dead property or a 403 on one site must not skip the
  other 16.
- **GSC row cap, not grain reduction.** `searchanalytics.query` is called with `rowLimit: 25000` and no
  pagination. If a site's per-day query volume exceeds that, later rows are silently dropped for that day
  rather than falling back to a coarser grain — acceptable for now, and logged (see Task 4).
- **Out of scope for this plan** (tracked as follow-on work, see the summary at the end): the Fleet Dashboard
  "Analytics" tab, the `seo-analyst` cron-role rewire, and deletion of the dead `tools/auth-google/` scaffold
  and `search_consoles.py` stub. This plan ends at working, tested, queryable metrics — Plan 3 builds on top
  of it. Also out of scope: `page_query` combined grain (GA4 gets `site` + `page`; GSC gets `site` + `query`) —
  nothing downstream needs the cross product yet, and adding it later is a new fetcher function, not a
  schema change (the `grain` column already reserves `page_query` as a valid value).

---

## File Structure

| File | Responsibility |
|---|---|
| `tools/data-hub/requirements.txt` | Add `google-api-python-client`, `google-auth` (already used by Plan 1's packages; data-hub doesn't yet depend on them) |
| `tools/data-hub/pyproject.toml` | Add a path dependency on `google-auth-fleet` (Plan 1's package) so `from google_auth_fleet import clients` resolves |
| `tools/data-hub/src/datahub/store.py` | Modify: add `ga4_metrics`/`gsc_metrics` tables to `SCHEMA`, add upsert/query functions, keep `_PRUNE_COLUMNS` untouched (exemption) |
| `tools/data-hub/src/datahub/config.py` | Modify: add `AnalyticsSite` model + `load_analytics_registry()`, add 4 new `Settings` fields |
| `tools/data-hub/src/datahub/metrics/__init__.py` | Create: package marker only |
| `tools/data-hub/src/datahub/metrics/ga4.py` | Create: GA4 Data API fetcher — site + page grain |
| `tools/data-hub/src/datahub/metrics/gsc.py` | Create: Search Console fetcher — site + query grain |
| `tools/data-hub/src/datahub/metrics_collector.py` | Create: per-site orchestrator, mirrors `collector.py`'s isolation pattern |
| `tools/data-hub/src/datahub/backfill_ga4.py` | Create: one-shot 16-month chunked GA4 backfill command |
| `tools/data-hub/src/datahub/__main__.py` | Modify: add `collect-metrics` and `backfill-ga4` commands |
| `tools/data-hub/src/datahub/api.py` | Modify: add `/metrics/ga4`, `/metrics/gsc`, `/metrics/summary`, `/metrics/top`, `/metrics/health` |
| `tools/data-hub/crontab.docker` | Modify: add the daily `collect-metrics` line |
| `tools/data-hub/docker-compose.yml` | Modify: bind-mount `.gcp/service-account.json` into both `collector` and `api` services |
| `tools/data-hub/tests/test_store_metrics.py` | Create |
| `tools/data-hub/tests/test_config_analytics_registry.py` | Create |
| `tools/data-hub/tests/test_metrics_ga4.py` | Create |
| `tools/data-hub/tests/test_metrics_gsc.py` | Create |
| `tools/data-hub/tests/test_metrics_collector.py` | Create |
| `tools/data-hub/tests/test_api_metrics.py` | Create |
| `tools/data-hub/tests/test_backfill_ga4.py` | Create |

---

### Task 1: Store schema — `ga4_metrics` / `gsc_metrics` tables

**Files:**
- Modify: `tools/data-hub/src/datahub/store.py`
- Test: `tools/data-hub/tests/test_store_metrics.py`

**Interfaces:**
- Produces: `store.upsert_ga4_metrics(conn, site: str, records: list[dict]) -> int`,
  `store.upsert_gsc_metrics(conn, site: str, records: list[dict]) -> int`,
  `store.query_ga4_metrics(conn, site: str, *, grain: str = "site", dim_key: str | None = None, since: str | None = None, until: str | None = None, limit: int = 400) -> list[dict]`,
  `store.query_gsc_metrics(conn, site: str, *, grain: str = "site", dim_key: str | None = None, since: str | None = None, until: str | None = None, limit: int = 400) -> list[dict]`.
  A `records` dict has keys: `date, grain, dim_key, sessions, users, new_users, views, engaged_sessions,
  engagement_rate, avg_session_duration, conversions` (GA4) or `date, grain, dim_key, clicks, impressions, ctr,
  position` (GSC).

- [ ] **Step 1: Write the failing tests**

```python
# tools/data-hub/tests/test_store_metrics.py
from datahub import store


def _ga4_record(date="2026-07-10", grain="site", dim_key=""):
    return {
        "date": date, "grain": grain, "dim_key": dim_key,
        "sessions": 100, "users": 80, "new_users": 20, "views": 300,
        "engaged_sessions": 60, "engagement_rate": 0.6,
        "avg_session_duration": 45.2, "conversions": 3,
    }


def _gsc_record(date="2026-07-10", grain="site", dim_key=""):
    return {
        "date": date, "grain": grain, "dim_key": dim_key,
        "clicks": 12, "impressions": 400, "ctr": 0.03, "position": 8.4,
    }


def test_upsert_ga4_metrics_inserts_and_returns_count(db):
    n = store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_record()])
    assert n == 1
    rows = store.query_ga4_metrics(db, "xxxtea.com")
    assert rows[0]["sessions"] == 100
    assert rows[0]["site"] == "xxxtea.com"


def test_upsert_ga4_metrics_revises_not_duplicates(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_record()])
    revised = _ga4_record()
    revised["sessions"] = 150
    store.upsert_ga4_metrics(db, "xxxtea.com", [revised])
    rows = store.query_ga4_metrics(db, "xxxtea.com")
    assert len(rows) == 1
    assert rows[0]["sessions"] == 150


def test_upsert_gsc_metrics_inserts_and_revises(db):
    store.upsert_gsc_metrics(db, "xxxtea.com", [_gsc_record()])
    revised = _gsc_record()
    revised["clicks"] = 99
    store.upsert_gsc_metrics(db, "xxxtea.com", [revised])
    rows = store.query_gsc_metrics(db, "xxxtea.com")
    assert len(rows) == 1
    assert rows[0]["clicks"] == 99


def test_query_ga4_metrics_filters_by_grain_and_dim_key(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [
        _ga4_record(grain="site", dim_key=""),
        _ga4_record(grain="page", dim_key="/tea/oolong"),
    ])
    site_rows = store.query_ga4_metrics(db, "xxxtea.com", grain="site")
    assert len(site_rows) == 1 and site_rows[0]["dim_key"] == ""
    page_rows = store.query_ga4_metrics(db, "xxxtea.com", grain="page", dim_key="/tea/oolong")
    assert len(page_rows) == 1 and page_rows[0]["dim_key"] == "/tea/oolong"


def test_query_ga4_metrics_since_until_bounds(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [
        _ga4_record(date="2026-07-01"), _ga4_record(date="2026-07-10"), _ga4_record(date="2026-07-20"),
    ])
    rows = store.query_ga4_metrics(db, "xxxtea.com", since="2026-07-05", until="2026-07-15")
    assert [r["date"] for r in rows] == ["2026-07-10"]


def test_query_metrics_isolated_per_site(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_record()])
    store.upsert_ga4_metrics(db, "sinderella.org", [_ga4_record()])
    assert len(store.query_ga4_metrics(db, "xxxtea.com")) == 1
    assert len(store.query_ga4_metrics(db, "sinderella.org")) == 1


def test_metrics_tables_exempt_from_retention_prune(db):
    old_record = _ga4_record(date="2020-01-01")
    store.upsert_ga4_metrics(db, "xxxtea.com", [old_record])
    store.upsert_gsc_metrics(db, "xxxtea.com", [_gsc_record(date="2020-01-01")])
    deleted = store.prune(db, retention_days=7)
    assert "ga4_metrics" not in deleted
    assert "gsc_metrics" not in deleted
    assert len(store.query_ga4_metrics(db, "xxxtea.com")) == 1
    assert len(store.query_gsc_metrics(db, "xxxtea.com")) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/data-hub && python -m pytest tests/test_store_metrics.py -v`
Expected: FAIL — `AttributeError: module 'datahub.store' has no attribute 'upsert_ga4_metrics'`

- [ ] **Step 3: Add the schema and functions**

Add to `SCHEMA` in `store.py`, after the `pull_log` table (before the closing `"""`):

```sql
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
```

Do **not** add either table to `_PRUNE_COLUMNS` — that dict staying untouched is the retention exemption.

Append these functions to `store.py` (after `dataset_keys`):

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/data-hub && python -m pytest tests/test_store_metrics.py -v`
Expected: 7 passed

- [ ] **Step 5: Run the full existing suite to confirm nothing else broke**

Run: `cd tools/data-hub && python -m pytest -q`
Expected: all prior tests still pass (schema change is additive-only)

- [ ] **Step 6: Commit**

```bash
git add tools/data-hub/src/datahub/store.py tools/data-hub/tests/test_store_metrics.py
git commit -m "feat(data-hub): ga4_metrics/gsc_metrics tables, upsert-not-append, retention-exempt"
```

---

### Task 2: Analytics registry loader

**Files:**
- Modify: `tools/data-hub/src/datahub/config.py`
- Test: `tools/data-hub/tests/test_config_analytics_registry.py`

**Interfaces:**
- Consumes: nothing new (reads `registry/sites-analytics.yaml`, the exact file
  `tools/ga4-provision/src/ga4_provision/registry.py:write_registry` produces).
- Produces: `class AnalyticsSite(BaseModel)` with fields `ga4_property_id: str`,
  `ga4_measurement_id: str | None`, `gsc_property: str`, `consent_gated: bool`.
  `load_analytics_registry(path: str) -> dict[str, AnalyticsSite]` keyed by domain.
  `Settings.registry_dir` already exists (`config.py:48`) — the new loader takes a path the same way
  `load_sources`/`load_subscriptions` do, not a new Settings field.

- [ ] **Step 1: Write the failing test**

```python
# tools/data-hub/tests/test_config_analytics_registry.py
from datahub.config import load_analytics_registry


def test_load_analytics_registry_parses_all_fields(tmp_path):
    path = tmp_path / "sites-analytics.yaml"
    path.write_text(
        "sites:\n"
        "  xxxtea.com:\n"
        "    ga4_property_id: '539743210'\n"
        "    ga4_measurement_id: G-P889LLFBNK\n"
        "    gsc_property: sc-domain:xxxtea.com\n"
        "    consent_gated: false\n"
        "  saveusfarms.com:\n"
        "    ga4_property_id: '542493246'\n"
        "    ga4_measurement_id: G-GDYX2GPMMJ\n"
        "    gsc_property: sc-domain:saveusfarms.com\n"
        "    consent_gated: true\n"
    )
    sites = load_analytics_registry(str(path))
    assert set(sites) == {"xxxtea.com", "saveusfarms.com"}
    assert sites["xxxtea.com"].ga4_property_id == "539743210"
    assert sites["xxxtea.com"].consent_gated is False
    assert sites["saveusfarms.com"].consent_gated is True


def test_load_analytics_registry_handles_null_measurement_id(tmp_path):
    path = tmp_path / "sites-analytics.yaml"
    path.write_text(
        "sites:\n"
        "  3boobs.com:\n"
        "    ga4_property_id: '540969570'\n"
        "    ga4_measurement_id: null\n"
        "    gsc_property: sc-domain:3boobs.com\n"
        "    consent_gated: false\n"
    )
    sites = load_analytics_registry(str(path))
    assert sites["3boobs.com"].ga4_measurement_id is None


def test_load_analytics_registry_missing_file_returns_empty(tmp_path):
    sites = load_analytics_registry(str(tmp_path / "nope.yaml"))
    assert sites == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_config_analytics_registry.py -v`
Expected: FAIL — `ImportError: cannot import name 'load_analytics_registry'`

- [ ] **Step 3: Implement**

Add to `config.py`, after the `Subscription` class:

```python
class AnalyticsSite(BaseModel):
    ga4_property_id: str
    ga4_measurement_id: str | None = None
    gsc_property: str
    consent_gated: bool = False
```

Add after `load_subscriptions`:

```python
def load_analytics_registry(path: str) -> dict[str, "AnalyticsSite"]:
    """Read registry/sites-analytics.yaml (written by tools/ga4-provision).

    Missing file returns {} rather than raising — this registry only exists
    after ga4-provision has run at least once, and the collector must not
    crash before that one-time step has happened.
    """
    if not os.path.exists(path):
        return {}
    data = yaml.safe_load(open(path, encoding="utf-8").read()) or {}
    return {domain: AnalyticsSite(**body) for domain, body in (data.get("sites") or {}).items()}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_config_analytics_registry.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/src/datahub/config.py tools/data-hub/tests/test_config_analytics_registry.py
git commit -m "feat(data-hub): load the ga4-provision sites-analytics registry"
```

---

### Task 3: GA4 metrics fetcher

**Files:**
- Create: `tools/data-hub/src/datahub/metrics/__init__.py`
- Create: `tools/data-hub/src/datahub/metrics/ga4.py`
- Test: `tools/data-hub/tests/test_metrics_ga4.py`

**Interfaces:**
- Consumes: a `googleapiclient` Resource shaped like `google_auth_fleet.clients.ga4_data()` returns
  (`client.properties().runReport(property=..., body=...).execute()`).
- Produces: `fetch_site(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]`
  and `fetch_pages(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]`.
  Each returns `(records, quota)` — `records` match `store.upsert_ga4_metrics`'s record shape with
  `grain="site"`/`"page"` set, `quota` is GA4's `propertyQuota` block verbatim (or `{}` if absent) for the
  caller to log. `trailing_window(today: date, days: int = 7) -> tuple[str, str]` is also exported — Task 5's
  backfill command reuses it as the single source of truth for date-math.

- [ ] **Step 1: Write the failing test**

```python
# tools/data-hub/tests/test_metrics_ga4.py
from datetime import date
from datahub.metrics import ga4


class FakeRunReport:
    def __init__(self, response):
        self._response = response
    def execute(self):
        return self._response


class FakeProperties:
    def __init__(self, response):
        self._response = response
        self.calls = []
    def runReport(self, property=None, body=None):
        self.calls.append((property, body))
        return FakeRunReport(self._response)


class FakeClient:
    def __init__(self, response):
        self._properties = FakeProperties(response)
    def properties(self):
        return self._properties


def _response(rows):
    return {
        "dimensionHeaders": [{"name": "date"}],
        "metricHeaders": [{"name": n} for n, _ in ga4.METRIC_MAP],
        "rows": rows,
        "propertyQuota": {"tokensPerDay": {"consumed": 12, "remaining": 199988}},
    }


def test_trailing_window_ends_yesterday():
    start, end = ga4.trailing_window(date(2026, 7, 19), days=7)
    assert start == "2026-07-12"
    assert end == "2026-07-18"


def test_fetch_site_maps_metrics_by_name_not_position():
    row = {
        "dimensionValues": [{"value": "20260718"}],
        "metricValues": [{"value": str(i)} for i in range(len(ga4.METRIC_MAP))],
    }
    client = FakeClient(_response([row]))
    records, quota = ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    assert len(records) == 1
    r = records[0]
    assert r["grain"] == "site"
    assert r["dim_key"] == ""
    assert r["date"] == "2026-07-18"
    assert r["sessions"] == 0    # position 0 in METRIC_MAP
    assert r["conversions"] == len(ga4.METRIC_MAP) - 1  # last metric, last value
    assert quota["tokensPerDay"]["consumed"] == 12


def test_fetch_site_empty_response_is_empty_list_not_zero_rows():
    client = FakeClient(_response([]))
    records, _ = ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    assert records == []


def test_fetch_pages_sets_page_grain_and_dim_key():
    row = {
        "dimensionValues": [{"value": "20260718"}, {"value": "/tea/oolong"}],
        "metricValues": [{"value": "5"} for _ in ga4.METRIC_MAP],
    }
    client = FakeClient(_response([row]))
    records, _ = ga4.fetch_pages(client, "539743210", today=date(2026, 7, 19))
    assert records[0]["grain"] == "page"
    assert records[0]["dim_key"] == "/tea/oolong"


def test_fetch_site_calls_runreport_with_correct_property_and_window():
    client = FakeClient(_response([]))
    ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    prop, body = client.properties().calls[0]
    assert prop == "properties/539743210"
    assert body["dateRanges"] == [{"startDate": "2026-07-12", "endDate": "2026-07-18"}]
    assert body["dimensions"] == [{"name": "date"}]
    assert body["returnPropertyQuota"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_metrics_ga4.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.metrics'`

- [ ] **Step 3: Implement**

```python
# tools/data-hub/src/datahub/metrics/__init__.py
```
(empty — package marker)

```python
# tools/data-hub/src/datahub/metrics/ga4.py
"""GA4 Data API fetcher — one site's trailing window, site and page grain."""
from __future__ import annotations

from datetime import date, timedelta

# (GA4 API metric name, our column name) — order defines dimensionValues/metricValues
# index alignment, so records are built by NAME via metricHeaders, never by position,
# in case Google ever reorders a response.
METRIC_MAP = [
    ("sessions", "sessions"),
    ("totalUsers", "users"),
    ("newUsers", "new_users"),
    ("screenPageViews", "views"),
    ("engagedSessions", "engaged_sessions"),
    ("engagementRate", "engagement_rate"),
    ("averageSessionDuration", "avg_session_duration"),
    ("conversions", "conversions"),
]
_API_TO_COLUMN = dict(METRIC_MAP)


def trailing_window(today: date, days: int = 7) -> tuple[str, str]:
    """(start, end) as ISO date strings. end = yesterday; both APIs finalize
    with a lag, so today's own data is not worth pulling yet."""
    end = today - timedelta(days=1)
    start = today - timedelta(days=days)
    return start.isoformat(), end.isoformat()


def _run_report(client, property_id: str, start: str, end: str, dimension_names: list[str]) -> dict:
    body = {
        "dateRanges": [{"startDate": start, "endDate": end}],
        "dimensions": [{"name": n} for n in dimension_names],
        "metrics": [{"name": n} for n, _ in METRIC_MAP],
        "returnPropertyQuota": True,
    }
    return client.properties().runReport(property=f"properties/{property_id}", body=body).execute()


def _rows_to_records(response: dict, grain: str, has_dim_key: bool) -> list[dict]:
    headers = [h["name"] for h in response.get("metricHeaders", [])]
    records = []
    for row in response.get("rows", []):
        dim_values = [d["value"] for d in row.get("dimensionValues", [])]
        raw_date = dim_values[0]  # GA4 returns YYYYMMDD
        iso_date = f"{raw_date[0:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
        dim_key = dim_values[1] if has_dim_key and len(dim_values) > 1 else ""
        metric_values = {h: v["value"] for h, v in zip(headers, row.get("metricValues", []))}
        record = {"date": iso_date, "grain": grain, "dim_key": dim_key}
        for api_name, column in METRIC_MAP:
            raw = metric_values.get(api_name)
            record[column] = float(raw) if column in ("engagement_rate", "avg_session_duration") else int(float(raw)) if raw is not None else None
        records.append(record)
    return records


def fetch_site(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]:
    start, end = trailing_window(today or date.today())
    response = _run_report(client, property_id, start, end, ["date"])
    return _rows_to_records(response, grain="site", has_dim_key=False), response.get("propertyQuota", {})


def fetch_pages(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]:
    start, end = trailing_window(today or date.today())
    response = _run_report(client, property_id, start, end, ["date", "pagePath"])
    return _rows_to_records(response, grain="page", has_dim_key=True), response.get("propertyQuota", {})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_metrics_ga4.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/src/datahub/metrics/__init__.py tools/data-hub/src/datahub/metrics/ga4.py \
        tools/data-hub/tests/test_metrics_ga4.py
git commit -m "feat(data-hub): GA4 Data API fetcher, site and page grain"
```

---

### Task 4: GSC metrics fetcher

**Files:**
- Create: `tools/data-hub/src/datahub/metrics/gsc.py`
- Test: `tools/data-hub/tests/test_metrics_gsc.py`

**Interfaces:**
- Consumes: a `googleapiclient` Resource shaped like `google_auth_fleet.clients.search_console()` returns
  (`client.searchanalytics().query(siteUrl=..., body=...).execute()`).
- Produces: `fetch_site(client, gsc_property: str, *, today: date | None = None) -> list[dict]` and
  `fetch_queries(client, gsc_property: str, *, today: date | None = None) -> list[dict]`, records matching
  `store.upsert_gsc_metrics`'s shape with `grain="site"`/`"query"`.

- [ ] **Step 1: Write the failing test**

```python
# tools/data-hub/tests/test_metrics_gsc.py
from datetime import date
from datahub.metrics import gsc


class FakeQuery:
    def __init__(self, response):
        self._response = response
    def execute(self):
        return self._response


class FakeSearchAnalytics:
    def __init__(self, response):
        self._response = response
        self.calls = []
    def query(self, siteUrl=None, body=None):
        self.calls.append((siteUrl, body))
        return FakeQuery(self._response)


class FakeClient:
    def __init__(self, response):
        self._sa = FakeSearchAnalytics(response)
    def searchanalytics(self):
        return self._sa


def test_fetch_site_maps_row_keys_and_metrics():
    response = {"rows": [{"keys": ["2026-07-18"], "clicks": 12, "impressions": 400,
                          "ctr": 0.03, "position": 8.4}]}
    client = FakeClient(response)
    records = gsc.fetch_site(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19))
    assert len(records) == 1
    r = records[0]
    assert r == {"date": "2026-07-18", "grain": "site", "dim_key": "",
                 "clicks": 12, "impressions": 400, "ctr": 0.03, "position": 8.4}


def test_fetch_site_empty_response_is_empty_list():
    client = FakeClient({"rows": []})
    assert gsc.fetch_site(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19)) == []


def test_fetch_site_missing_rows_key_is_empty_list():
    client = FakeClient({})
    assert gsc.fetch_site(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19)) == []


def test_fetch_queries_sets_query_grain_and_dim_key():
    response = {"rows": [{"keys": ["2026-07-18", "loose leaf oolong"], "clicks": 3,
                          "impressions": 40, "ctr": 0.075, "position": 4.2}]}
    client = FakeClient(response)
    records = gsc.fetch_queries(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19))
    assert records[0]["grain"] == "query"
    assert records[0]["dim_key"] == "loose leaf oolong"


def test_fetch_site_calls_query_with_correct_site_and_window_and_row_cap():
    client = FakeClient({"rows": []})
    gsc.fetch_site(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19))
    site_url, body = client.searchanalytics().calls[0]
    assert site_url == "sc-domain:xxxtea.com"
    assert body["startDate"] == "2026-07-12"
    assert body["endDate"] == "2026-07-18"
    assert body["dimensions"] == ["date"]
    assert body["rowLimit"] == gsc.ROW_LIMIT
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_metrics_gsc.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.metrics.gsc'`

- [ ] **Step 3: Implement**

```python
# tools/data-hub/src/datahub/metrics/gsc.py
"""Search Console fetcher — one site's trailing window, site and query grain."""
from __future__ import annotations

from datetime import date, timedelta

ROW_LIMIT = 25000  # per-day-per-grain cap; later rows silently dropped rather than
                    # falling back to a coarser grain (see plan's Global Constraints)


def trailing_window(today: date, days: int = 7) -> tuple[str, str]:
    end = today - timedelta(days=1)
    start = today - timedelta(days=days)
    return start.isoformat(), end.isoformat()


def _query(client, site_url: str, start: str, end: str, dimensions: list[str]) -> dict:
    body = {"startDate": start, "endDate": end, "dimensions": dimensions, "rowLimit": ROW_LIMIT}
    return client.searchanalytics().query(siteUrl=site_url, body=body).execute()


def _rows_to_records(response: dict, grain: str, has_dim_key: bool) -> list[dict]:
    records = []
    for row in response.get("rows") or []:
        keys = row.get("keys", [])
        dim_key = keys[1] if has_dim_key and len(keys) > 1 else ""
        records.append({
            "date": keys[0], "grain": grain, "dim_key": dim_key,
            "clicks": row.get("clicks"), "impressions": row.get("impressions"),
            "ctr": row.get("ctr"), "position": row.get("position"),
        })
    return records


def fetch_site(client, gsc_property: str, *, today: date | None = None) -> list[dict]:
    start, end = trailing_window(today or date.today())
    response = _query(client, gsc_property, start, end, ["date"])
    return _rows_to_records(response, grain="site", has_dim_key=False)


def fetch_queries(client, gsc_property: str, *, today: date | None = None) -> list[dict]:
    start, end = trailing_window(today or date.today())
    response = _query(client, gsc_property, start, end, ["date", "query"])
    return _rows_to_records(response, grain="query", has_dim_key=True)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_metrics_gsc.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/src/datahub/metrics/gsc.py tools/data-hub/tests/test_metrics_gsc.py
git commit -m "feat(data-hub): Search Console fetcher, site and query grain"
```

---

### Task 5: Metrics collector orchestrator + `collect-metrics` command

**Files:**
- Create: `tools/data-hub/src/datahub/metrics_collector.py`
- Modify: `tools/data-hub/src/datahub/__main__.py`
- Modify: `tools/data-hub/pyproject.toml` (dependency on `google-auth-fleet`)
- Modify: `tools/data-hub/requirements.txt` (add `google-api-python-client`, `google-auth`)
- Modify: `tools/data-hub/crontab.docker`
- Modify: `tools/data-hub/docker-compose.yml`
- Test: `tools/data-hub/tests/test_metrics_collector.py`

**Interfaces:**
- Consumes: `config.load_analytics_registry`, `metrics.ga4.fetch_site/fetch_pages`,
  `metrics.gsc.fetch_site/fetch_queries`, `store.upsert_ga4_metrics/upsert_gsc_metrics`,
  `store.record_egress/set_source_state` (existing, generic `source_id`-keyed functions — no changes needed).
- Produces: `run_metrics_cycle(conn, sites: dict[str, AnalyticsSite], *, ga4_client, gsc_client) -> dict`
  returning `{"sites": N, "ga4_ok": N, "gsc_ok": N, "errors": N}`.

- [ ] **Step 1: Write the failing tests**

```python
# tools/data-hub/tests/test_metrics_collector.py
from datahub import store, metrics_collector as mc
from datahub.config import AnalyticsSite


def _sites():
    return {
        "xxxtea.com": AnalyticsSite(ga4_property_id="1", ga4_measurement_id="G-A",
                                    gsc_property="sc-domain:xxxtea.com", consent_gated=False),
        "saveusfarms.com": AnalyticsSite(ga4_property_id="2", ga4_measurement_id="G-B",
                                         gsc_property="sc-domain:saveusfarms.com", consent_gated=True),
    }


class FakeGA4Client:
    def __init__(self, fail_for=()):
        self.fail_for = set(fail_for)
        self.calls = []
    def properties(self):
        return self
    def runReport(self, property=None, body=None):
        self.calls.append(property)
        if property.split("/")[-1] in self.fail_for:
            raise RuntimeError("403 forbidden")
        return self
    def execute(self):
        return {"rows": [], "propertyQuota": {}}


class FakeGSCClient:
    def __init__(self, fail_for=()):
        self.fail_for = set(fail_for)
        self.calls = []
    def searchanalytics(self):
        return self
    def query(self, siteUrl=None, body=None):
        self.calls.append(siteUrl)
        if siteUrl in self.fail_for:
            raise RuntimeError("403 forbidden")
        return self
    def execute(self):
        return {"rows": []}


def test_run_metrics_cycle_calls_both_apis_for_every_site(db):
    ga4c, gscc = FakeGA4Client(), FakeGSCClient()
    summary = mc.run_metrics_cycle(db, _sites(), ga4_client=ga4c, gsc_client=gscc)
    assert summary["sites"] == 2
    assert summary["ga4_ok"] == 2
    assert summary["gsc_ok"] == 2
    assert summary["errors"] == 0
    # each site: fetch_site + fetch_pages = 2 GA4 calls; fetch_site + fetch_queries = 2 GSC calls
    assert len(ga4c.calls) == 4
    assert len(gscc.calls) == 4


def test_run_metrics_cycle_isolates_one_site_ga4_failure(db):
    ga4c = FakeGA4Client(fail_for={"1"})
    gscc = FakeGSCClient()
    summary = mc.run_metrics_cycle(db, _sites(), ga4_client=ga4c, gsc_client=gscc)
    assert summary["errors"] == 1
    assert summary["ga4_ok"] == 1          # saveusfarms.com's GA4 pull still ran
    assert summary["gsc_ok"] == 2          # xxxtea.com's GSC pull still ran despite its GA4 failure
    states = {s["source_id"]: s for s in store.get_sources_state(db)}
    assert states["ga4:xxxtea.com"]["status"] == "error"
    assert states["gsc:xxxtea.com"]["status"] == "ok"


def test_run_metrics_cycle_writes_direct_policy_egress(db):
    mc.run_metrics_cycle(db, _sites(), ga4_client=FakeGA4Client(), gsc_client=FakeGSCClient())
    egress = store.query_egress(db)
    assert all(e["policy"] == "direct" for e in egress)
    assert all(e["exit_node"] == "direct" for e in egress)


def test_run_metrics_cycle_upserts_into_typed_tables(db):
    class OneRowGA4(FakeGA4Client):
        def execute(self):
            return {"rows": [{"dimensionValues": [{"value": "20260718"}],
                              "metricValues": [{"value": "1"}] * 8}],
                    "propertyQuota": {}}
    mc.run_metrics_cycle(db, {"xxxtea.com": _sites()["xxxtea.com"]},
                         ga4_client=OneRowGA4(), gsc_client=FakeGSCClient())
    rows = store.query_ga4_metrics(db, "xxxtea.com", grain="site")
    assert len(rows) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/data-hub && python -m pytest tests/test_metrics_collector.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.metrics_collector'`

- [ ] **Step 3: Implement**

```python
# tools/data-hub/src/datahub/metrics_collector.py
"""Daily per-site GA4 + Search Console pull. Separate cadence from collector.py's
RSS/dataset cycle — see crontab.docker. Every site is isolated: one dead property
or a 403 must not skip the rest of the fleet (mirrors collector.py's per-source
isolation, keyed by source_id="ga4:<site>" / "gsc:<site>" in the same egress_log /
sources_state tables collector.py already writes to)."""
from __future__ import annotations

from . import store
from .config import AnalyticsSite
from .metrics import ga4, gsc


def _pull_ga4(conn, site: str, cfg: AnalyticsSite, client) -> str:
    site_records, quota = ga4.fetch_site(client, cfg.ga4_property_id)
    page_records, _ = ga4.fetch_pages(client, cfg.ga4_property_id)
    n = store.upsert_ga4_metrics(conn, site, site_records + page_records)
    quota_note = f"quota:{quota}" if quota else ""
    store.record_egress(conn, source_id=f"ga4:{site}", target_host="analyticsdata.googleapis.com",
                        policy="direct", exit_node="direct", exit_ip=None,
                        status="ok", item_count=n, note=quota_note)
    store.set_source_state(conn, source_id=f"ga4:{site}", status="ok")
    return "ok"


def _pull_gsc(conn, site: str, cfg: AnalyticsSite, client) -> str:
    site_records = gsc.fetch_site(client, cfg.gsc_property)
    query_records = gsc.fetch_queries(client, cfg.gsc_property)
    n = store.upsert_gsc_metrics(conn, site, site_records + query_records)
    store.record_egress(conn, source_id=f"gsc:{site}", target_host="searchconsole.googleapis.com",
                        policy="direct", exit_node="direct", exit_ip=None,
                        status="ok", item_count=n)
    store.set_source_state(conn, source_id=f"gsc:{site}", status="ok")
    return "ok"


def run_metrics_cycle(conn, sites: dict[str, AnalyticsSite], *, ga4_client, gsc_client) -> dict:
    summary = {"sites": len(sites), "ga4_ok": 0, "gsc_ok": 0, "errors": 0}
    for site, cfg in sites.items():
        try:
            _pull_ga4(conn, site, cfg, ga4_client)
            summary["ga4_ok"] += 1
        except Exception as exc:
            store.set_source_state(conn, source_id=f"ga4:{site}", status="error", error=str(exc))
            store.record_egress(conn, source_id=f"ga4:{site}", target_host="analyticsdata.googleapis.com",
                                policy="direct", exit_node="direct", exit_ip=None,
                                status="error", note=str(exc)[:200])
            summary["errors"] += 1

        try:
            _pull_gsc(conn, site, cfg, gsc_client)
            summary["gsc_ok"] += 1
        except Exception as exc:
            store.set_source_state(conn, source_id=f"gsc:{site}", status="error", error=str(exc))
            store.record_egress(conn, source_id=f"gsc:{site}", target_host="searchconsole.googleapis.com",
                                policy="direct", exit_node="direct", exit_ip=None,
                                status="error", note=str(exc)[:200])
            summary["errors"] += 1

    return summary
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/data-hub && python -m pytest tests/test_metrics_collector.py -v`
Expected: 4 passed

- [ ] **Step 5: Wire the `collect-metrics` command**

Modify `tools/data-hub/src/datahub/__main__.py` — add after the existing `collect` branch (before `elif cmd == "serve":`):

```python
    elif cmd == "collect-metrics":
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
        from .config import load_analytics_registry
        from . import metrics_collector
        from google_auth_fleet import clients
        sites = load_analytics_registry(f"{settings.registry_dir}/sites-analytics.yaml")
        if not sites:
            print("[datahub] collect-metrics: sites-analytics.yaml empty or missing, nothing to do")
            return
        summary = metrics_collector.run_metrics_cycle(
            conn, sites, ga4_client=clients.ga4_data(), gsc_client=clients.search_console())
        print(f"[datahub] metrics cycle: {summary}")
```

- [ ] **Step 6: Add the dependency and cron line**

In `tools/data-hub/requirements.txt`, add:
```
google-api-python-client
google-auth
```

In `tools/data-hub/pyproject.toml`, add under `[project]`:
```toml
dependencies = [
    "google-auth-fleet @ file:///app/vendor/google-auth-fleet",
]
```

In `tools/data-hub/Dockerfile`, add before the `pip install --no-cache-dir -e .` line (so the vendored
package is present when data-hub installs its own dependency on it):
```dockerfile
COPY vendor/google-auth-fleet/ vendor/google-auth-fleet/
```

Create `tools/data-hub/vendor/` by copying Plan 1's package at build-prep time — this is a manual one-time
step, not a plan task (the package doesn't change often): `cp -r tools/google-auth tools/data-hub/vendor/google-auth-fleet`. Note in a comment atop `tools/data-hub/vendor/.gitkeep` (create this empty file) that
`vendor/` holds a build-time copy of `tools/google-auth`, refreshed manually when that package changes,
since Docker cannot `COPY` a path outside its build context.

Modify `tools/data-hub/crontab.docker`:
```
# data-hub collector crontab — runs inside the collector container via supercronic.
# Collection every 30 minutes; output goes to stdout (captured by Docker logging).
*/30 * * * * python -m datahub collect

# Fleet analytics — GA4 + Search Console, once daily. Separate cadence from the
# RSS/dataset cycle above: these are authenticated, quota-metered Google API
# calls, not a light RSS poll. Staggered off the hour so it never races collect.
17 6 * * * python -m datahub collect-metrics
```

- [ ] **Step 7: Mount the service-account key**

Modify `tools/data-hub/docker-compose.yml` — add to both the `collector` and `api` services' `volumes:` list
(the API needs it too, for the `/metrics/health` freshness check to eventually call live quota — not required
by this plan, but keeping both services symmetric avoids a footgun later):

```yaml
    volumes:
      - datahub-data:/data
      - /home/jesse/projects/domains/.gcp/service-account.json:/home/jesse/projects/domains/.gcp/service-account.json:ro
```

This mounts at the exact same absolute host path `google_auth_fleet.creds.DEFAULT_KEY_PATH` already hardcodes
— no code change needed in the vendored package for this to resolve inside the container.

- [ ] **Step 8: Run the full suite**

Run: `cd tools/data-hub && python -m pytest -q`
Expected: all tests pass

- [ ] **Step 9: Commit**

```bash
git add tools/data-hub/src/datahub/metrics_collector.py tools/data-hub/src/datahub/__main__.py \
        tools/data-hub/tests/test_metrics_collector.py tools/data-hub/requirements.txt \
        tools/data-hub/pyproject.toml tools/data-hub/Dockerfile tools/data-hub/crontab.docker \
        tools/data-hub/docker-compose.yml tools/data-hub/vendor/.gitkeep
git commit -m "feat(data-hub): daily collect-metrics command, per-site isolation, SA key mount"
```

---

### Task 6: `/metrics/*` API endpoints

**Files:**
- Modify: `tools/data-hub/src/datahub/api.py`
- Test: `tools/data-hub/tests/test_api_metrics.py`

**Interfaces:**
- Consumes: `store.query_ga4_metrics`, `store.query_gsc_metrics`, `store.get_sources_state`,
  `config.load_analytics_registry` (called once at app startup, same pattern as `sources`/`subscriptions` in
  `create_app`).
- Produces: `GET /metrics/ga4?site=&since=&until=&grain=&limit=`,
  `GET /metrics/gsc?site=&since=&until=&grain=&limit=`,
  `GET /metrics/summary?site=&window=28`,
  `GET /metrics/top?site=&source=ga4|gsc&metric=&window=28&limit=10`,
  `GET /metrics/health`.

- [ ] **Step 1: Write the failing tests**

```python
# tools/data-hub/tests/test_api_metrics.py
from fastapi.testclient import TestClient
from datahub.api import create_app
from datahub.config import Settings, AnalyticsSite
from datahub import store


def _app(db, sites=None):
    settings = Settings(db_path=":memory:", home_ips=set(), proxy_us="http://h:8181",
                        proxy_eu="http://h:8182", control_us="http://h:9281",
                        control_eu="http://h:9282", registry_dir="/x")
    app = create_app(settings, conn=db, sources=[], subscriptions={},
                     analytics_sites=sites or {})
    return TestClient(app)


def _ga4_row(date, sessions=10):
    return {"date": date, "grain": "site", "dim_key": "", "sessions": sessions, "users": 8,
            "new_users": 2, "views": 30, "engaged_sessions": 6, "engagement_rate": 0.6,
            "avg_session_duration": 40.0, "conversions": 1}


def test_metrics_ga4_endpoint_returns_site_rows(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_row("2026-07-18")])
    client = _app(db)
    r = client.get("/metrics/ga4?site=xxxtea.com")
    assert r.status_code == 200
    assert r.json()["records"][0]["sessions"] == 10


def test_metrics_ga4_endpoint_requires_site(db):
    client = _app(db)
    r = client.get("/metrics/ga4")
    assert r.status_code == 422


def test_metrics_gsc_endpoint_returns_rows(db):
    store.upsert_gsc_metrics(db, "xxxtea.com", [{"date": "2026-07-18", "grain": "site", "dim_key": "",
                                                 "clicks": 5, "impressions": 100, "ctr": 0.05, "position": 6.0}])
    client = _app(db)
    r = client.get("/metrics/gsc?site=xxxtea.com")
    assert r.json()["records"][0]["clicks"] == 5


def test_metrics_summary_flags_site_with_no_data_as_absent_not_zero(db):
    client = _app(db)
    r = client.get("/metrics/summary?site=nosuchsite.com")
    body = r.json()
    assert body["has_data"] is False
    assert "sessions" not in body or body.get("sessions") is None


def test_metrics_summary_totals_sessions_over_window(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_row("2026-07-17", 10), _ga4_row("2026-07-18", 20)])
    client = _app(db)
    r = client.get("/metrics/summary?site=xxxtea.com&window=28")
    body = r.json()
    assert body["has_data"] is True
    assert body["sessions"] == 30


def test_metrics_top_returns_pages_sorted_by_metric(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [
        {**_ga4_row("2026-07-18"), "grain": "page", "dim_key": "/a", "sessions": 5},
        {**_ga4_row("2026-07-18"), "grain": "page", "dim_key": "/b", "sessions": 50},
    ])
    client = _app(db)
    r = client.get("/metrics/top?site=xxxtea.com&source=ga4&metric=sessions&limit=1")
    top = r.json()["top"]
    assert len(top) == 1
    assert top[0]["dim_key"] == "/b"


def test_metrics_health_marks_consent_gated_sites(db):
    sites = {"saveusfarms.com": AnalyticsSite(ga4_property_id="1", gsc_property="sc-domain:saveusfarms.com",
                                              consent_gated=True)}
    client = _app(db, sites=sites)
    r = client.get("/metrics/health")
    body = r.json()
    assert body["sites"]["saveusfarms.com"]["consent_gated"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/data-hub && python -m pytest tests/test_api_metrics.py -v`
Expected: FAIL — `TypeError: create_app() got an unexpected keyword argument 'analytics_sites'`

- [ ] **Step 3: Implement**

Modify `create_app`'s signature in `api.py`:

```python
def create_app(settings: Settings, *, conn=None, sources: list[Source] | None = None,
               subscriptions: dict[str, Subscription] | None = None, vpn_client=None,
               analytics_sites: dict | None = None) -> FastAPI:
```

After the existing `source_by_id = {s.id: s for s in sources}` line, add:

```python
    if analytics_sites is None:
        from .config import load_analytics_registry
        analytics_sites = load_analytics_registry(os.path.join(settings.registry_dir, "sites-analytics.yaml"))
```

Add these routes (anywhere after `/health`, before `return app`):

```python
    @app.get("/metrics/ga4")
    def metrics_ga4(request: Request, site: str, since: str | None = None, until: str | None = None,
                    grain: str = "site", limit: int = 400):
        rows = store.query_ga4_metrics(conn, site, grain=grain, since=since, until=until, limit=limit)
        store.record_pull(conn, site=site, endpoint="metrics/ga4", item_count=len(rows),
                          client_ip=_client_ip(request))
        return {"records": rows}

    @app.get("/metrics/gsc")
    def metrics_gsc(request: Request, site: str, since: str | None = None, until: str | None = None,
                    grain: str = "site", limit: int = 400):
        rows = store.query_gsc_metrics(conn, site, grain=grain, since=since, until=until, limit=limit)
        store.record_pull(conn, site=site, endpoint="metrics/gsc", item_count=len(rows),
                          client_ip=_client_ip(request))
        return {"records": rows}

    @app.get("/metrics/summary")
    def metrics_summary(site: str, window: int = 28):
        since = (datetime.now(timezone.utc) - timedelta(days=window)).date().isoformat()
        ga4_rows = store.query_ga4_metrics(conn, site, grain="site", since=since, limit=window + 1)
        gsc_rows = store.query_gsc_metrics(conn, site, grain="site", since=since, limit=window + 1)
        if not ga4_rows and not gsc_rows:
            return {"site": site, "window_days": window, "has_data": False}
        out = {"site": site, "window_days": window, "has_data": True}
        for key in ("sessions", "users", "new_users", "views", "conversions"):
            out[key] = sum(r[key] or 0 for r in ga4_rows)
        for key in ("clicks", "impressions"):
            out[key] = sum(r[key] or 0 for r in gsc_rows)
        return out

    @app.get("/metrics/top")
    def metrics_top(site: str, source: str, metric: str, window: int = 28, limit: int = 10):
        since = (datetime.now(timezone.utc) - timedelta(days=window)).date().isoformat()
        if source == "ga4":
            rows = store.query_ga4_metrics(conn, site, grain="page", since=since, limit=5000)
        elif source == "gsc":
            rows = store.query_gsc_metrics(conn, site, grain="query", since=since, limit=5000)
        else:
            raise HTTPException(422, "source must be 'ga4' or 'gsc'")
        totals: dict[str, float] = {}
        for r in rows:
            totals[r["dim_key"]] = totals.get(r["dim_key"], 0) + (r.get(metric) or 0)
        ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:limit]
        return {"top": [{"dim_key": k, metric: v} for k, v in ranked]}

    @app.get("/metrics/health")
    def metrics_health():
        states = {s["source_id"]: s for s in store.get_sources_state(conn)}
        out = {}
        for site, cfg in analytics_sites.items():
            out[site] = {
                "consent_gated": cfg.consent_gated,
                "ga4": states.get(f"ga4:{site}"),
                "gsc": states.get(f"gsc:{site}"),
            }
        return {"sites": out, "generated_at": datetime.now(timezone.utc).isoformat()}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/data-hub && python -m pytest tests/test_api_metrics.py -v`
Expected: 7 passed

- [ ] **Step 5: Run the full suite**

Run: `cd tools/data-hub && python -m pytest -q`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add tools/data-hub/src/datahub/api.py tools/data-hub/tests/test_api_metrics.py
git commit -m "feat(data-hub): /metrics/ga4, /gsc, /summary, /top, /health endpoints"
```

---

### Task 7: GA4 backfill command

**Files:**
- Create: `tools/data-hub/src/datahub/backfill_ga4.py`
- Modify: `tools/data-hub/src/datahub/__main__.py`
- Test: `tools/data-hub/tests/test_backfill_ga4.py`

**Interfaces:**
- Consumes: `metrics.ga4._run_report`/`_rows_to_records` internals via a new site-grain chunked fetch,
  `store.upsert_ga4_metrics`.
- Produces: `backfill_site(client, property_id: str, *, months: int = 16, chunk_months: int = 3,
  today: date | None = None) -> list[dict]` (site grain only — GSC has nothing to backfill, per the spec: its
  data does not exist for us until the day verification happened).

- [ ] **Step 1: Write the failing test**

```python
# tools/data-hub/tests/test_backfill_ga4.py
from datetime import date
from datahub import backfill_ga4


class FakeRunReport:
    def __init__(self, response):
        self._response = response
    def execute(self):
        return self._response


class FakeProperties:
    def __init__(self):
        self.calls = []
    def runReport(self, property=None, body=None):
        self.calls.append(body["dateRanges"][0])
        return FakeRunReport({"rows": [], "propertyQuota": {}})


class FakeClient:
    def __init__(self):
        self._p = FakeProperties()
    def properties(self):
        return self._p


def test_backfill_chunks_16_months_into_3_month_calls():
    client = FakeClient()
    backfill_ga4.backfill_site(client, "539743210", months=16, chunk_months=3, today=date(2026, 7, 19))
    assert len(client.properties().calls) == 6  # ceil(16/3)


def test_backfill_chunks_do_not_overlap_or_gap():
    client = FakeClient()
    backfill_ga4.backfill_site(client, "539743210", months=6, chunk_months=3, today=date(2026, 7, 19))
    ranges = client.properties().calls
    assert len(ranges) == 2
    from datetime import date as d, timedelta
    end0 = d.fromisoformat(ranges[0]["endDate"])
    start1 = d.fromisoformat(ranges[1]["startDate"])
    assert start1 == end0 + timedelta(days=1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/data-hub && python -m pytest tests/test_backfill_ga4.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.backfill_ga4'`

- [ ] **Step 3: Implement**

```python
# tools/data-hub/src/datahub/backfill_ga4.py
"""One-shot GA4 backfill: ~16 months, chunked ~3 months per call (date as a
dimension gets one row per day per call — this is 6 calls, not 487). GSC has
no equivalent: its data does not exist for us until the day the domain was
verified, so there is nothing to backfill (see the pipeline design spec)."""
from __future__ import annotations

from datetime import date, timedelta

from .metrics.ga4 import _rows_to_records, METRIC_MAP


def _chunk_ranges(months: int, chunk_months: int, today: date) -> list[tuple[str, str]]:
    chunk_end = today - timedelta(days=1)
    chunks = []
    remaining = months
    while remaining > 0:
        span = min(chunk_months, remaining)
        chunk_start = chunk_end.replace(day=1)
        for _ in range(span - 1):
            prev_month_end = chunk_start - timedelta(days=1)
            chunk_start = prev_month_end.replace(day=1)
        chunks.append((chunk_start.isoformat(), chunk_end.isoformat()))
        chunk_end = chunk_start - timedelta(days=1)
        remaining -= span
    return list(reversed(chunks))


def backfill_site(client, property_id: str, *, months: int = 16, chunk_months: int = 3,
                  today: date | None = None) -> list[dict]:
    all_records: list[dict] = []
    for start, end in _chunk_ranges(months, chunk_months, today or date.today()):
        body = {
            "dateRanges": [{"startDate": start, "endDate": end}],
            "dimensions": [{"name": "date"}],
            "metrics": [{"name": n} for n, _ in METRIC_MAP],
            "returnPropertyQuota": True,
        }
        response = client.properties().runReport(property=f"properties/{property_id}", body=body).execute()
        all_records.extend(_rows_to_records(response, grain="site", has_dim_key=False))
    return all_records
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/data-hub && python -m pytest tests/test_backfill_ga4.py -v`
Expected: 2 passed

- [ ] **Step 5: Wire the command**

Modify `tools/data-hub/src/datahub/__main__.py`, add after the `collect-metrics` branch:

```python
    elif cmd == "backfill-ga4":
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
        from .config import load_analytics_registry
        from . import backfill_ga4
        from google_auth_fleet import clients
        sites = load_analytics_registry(f"{settings.registry_dir}/sites-analytics.yaml")
        client = clients.ga4_data()
        for site, cfg in sites.items():
            records = backfill_ga4.backfill_site(client, cfg.ga4_property_id)
            n = store.upsert_ga4_metrics(conn, site, records)
            print(f"[datahub] backfill {site}: {n} rows")
```

- [ ] **Step 6: Run the full suite**

Run: `cd tools/data-hub && python -m pytest -q`
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add tools/data-hub/src/datahub/backfill_ga4.py tools/data-hub/src/datahub/__main__.py \
        tools/data-hub/tests/test_backfill_ga4.py
git commit -m "feat(data-hub): one-shot GA4 16-month chunked backfill command"
```

---

## After This Plan Ships

Run once, manually, in order — not part of any task above because they mutate the live Docker deployment,
not the repo:

1. `cp -r tools/google-auth tools/data-hub/vendor/google-auth-fleet` (Task 5, Step 6's vendoring step).
2. `cd tools/data-hub && docker compose build && docker compose up -d` — picks up the new dependency, the
   vendored package, the SA key mount, and (critically) the `registry/sites-analytics.yaml` file Plan 1
   already wrote on the host, which only reaches the container image at build time (`Dockerfile:19` `COPY
   registry/`).
3. Watch the first `collect-metrics` cron fire (`docker logs -f datahub-collector`, next `:17` past the hour
   in `America/New_York` per `crontab.docker`), or trigger it once by hand:
   `docker exec datahub-collector python -m datahub collect-metrics`.
4. Run the backfill once: `docker exec datahub-collector python -m datahub backfill-ga4`.
5. Spot-check: `curl http://127.0.0.1:4760/metrics/summary?site=xxxtea.com&window=7`.

**Explicitly not built by this plan** (Plan 3, once this proves out live):
- Fleet Dashboard "Analytics" tab (`server/analytics.js` + `index.html`/`app.js` wiring).
- `seo-analyst` cron-role rewire off the "Blocked on Jesse" escape hatch, re-enabling it on the 6 disabled
  sites.
- Deleting `tools/auth-google/` (dead scaffold) and `tools/site-tracker/src/site_tracker/collectors/search_consoles.py` (dead stub) — the design spec's own Build Order sequences this last, after 1-7 prove out.
