# Data Hub — Plan 2: Dataset Fetchers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed structured-data collection to the hub — local ephemeris plus keyless gov/space JSON APIs (NOAA SWPC, NOAA alerts/tides, USGS quakes, Launch Library) live now, and keyed APIs (FRED, EIA, NASS, GNews) built but gracefully auto-skipping until keys are supplied — stored in the `datasets` table and served at `/datasets`.

**Architecture:** A `datasets/` subpackage holds one module per fetcher and a `FETCHERS` dispatch registry. Each fetcher takes a `Source` (+ proxy + settings) and returns a list of `{observed_at, payload}` records; the collector wraps them with the source's `dataset_key`/`tags` and upserts. Keyed fetchers raise `DatasetUnavailable` when their key is absent, which the collector records as a `skipped` egress (not an error). HTTP fetchers route through the VPN proxy under the same fail-closed policy as RSS; the ephemeris fetcher is pure local compute (`policy: direct`).

**Tech Stack:** Python 3.11, httpx, ephem (PyEphem), SQLite, FastAPI, pytest. Builds on Plan 1 (`tools/data-hub`, merged).

## Global Constraints

- Builds on the merged Plan 1 hub at `tools/data-hub`. Do NOT change Plan 1 behavior except the explicitly-listed edits (collector dataset branch, store dataset functions, config keys, api dataset routes).
- The collector's dataset branch was a deliberate no-op in Plan 1 (`note="dataset-deferred"`). This plan replaces it.
- All HTTP dataset fetchers honor the source's VPN policy: when `policy: vpn`, the collector passes `plan.proxy` and the fetcher MUST route its HTTP through it. Fail-closed is already enforced upstream by `plan_fetch` (an un-probable VPN node skips the source before any fetch).
- The ephemeris fetcher makes NO network call → its registry source uses `policy: direct` (so `plan_fetch` allows it with `proxy=None`).
- Keyed fetchers (fred/eia/nass/gnews) read their key from `Settings`; if the key is empty they raise `DatasetUnavailable("no-api-key")` — the collector records `status="skipped-no-api-key"` + a `skipped` egress and continues. They must NEVER fetch with an empty key.
- API keys come from the shared `/home/jesse/projects/domains/.env`: `FRED_API_KEY`, `NASS_API_KEY`, `EIA_API_KEY`, `GNEWS_API_KEY`. As of this writing ALL FOUR ARE ABSENT — so keyed sources will auto-skip until Jesse supplies them. Build for that reality; do not hardcode keys.
- Dataset record shape returned by every fetcher: `list[dict]`, each `{"observed_at": <ISO8601 UTC str>, "payload": <JSON-serializable dict>}`. The collector adds `dataset_key` (from `source.dataset_key`) and `tags` (from `source.tags`).
- Datasets dedup on `UNIQUE(source_id, dataset_key, observed_at)` (table already exists from Plan 1).
- Gov APIs (NOAA/USGS) prefer `exit: us`. If the live smoke shows a gov API blocks the PIA IP, flip that source to `policy: direct` in the registry (documented escape hatch) — note it, don't silently work around it.
- Tests mock HTTP via `httpx.MockTransport` or by monkeypatching the fetcher's module-level HTTP helper; no real network in unit tests. Run tests with `.venv/bin/python -m pytest`.

---

## File Structure

```
tools/data-hub/
  requirements.txt                      # MODIFY: add ephem==4.2.1
  src/datahub/
    config.py                           # MODIFY: Settings gains fred_key/nass_key/eia_key/gnews_key
    store.py                            # MODIFY: add upsert_datasets, query_datasets, dataset_keys
    collector.py                        # MODIFY: dataset branch → dispatch + upsert (+ DatasetUnavailable→skip)
    api.py                              # MODIFY: add /datasets and /datasets/{key}
    datasets/
      __init__.py                       # FETCHERS registry + DatasetUnavailable + _get_json helper
      ephemeris.py                      # local PyEphem compute (no network)
      usgs.py                           # earthquakes significant_week.geojson
      noaa_alerts.py                    # api.weather.gov active alerts
      noaa_swpc.py                      # SWPC space weather (k-index / xrays / solar-wind) by params
      noaa_tides.py                     # tidesandcurrents datagetter
      launchlib.py                      # thespacedevs upcoming launches
      fred.py                           # FRED series latest observation (keyed)
      eia.py                            # EIA v2 series (keyed)
      nass.py                           # USDA NASS Quick Stats (keyed)
  tests/
    fixtures/
      usgs_quakes.json  noaa_alerts.json  swpc_kindex.json
      noaa_tides.json   launchlib.json    fred_obs.json  eia_diesel.json  nass_corn.json
    test_datasets_ephemeris.py
    test_datasets_keyless.py            # usgs, noaa_alerts, noaa_swpc, noaa_tides, launchlib
    test_datasets_keyed.py             # fred, eia, nass incl. no-key skip
    test_store_datasets.py
    test_collector_datasets.py
    test_api_datasets.py
```

**Responsibilities:** each fetcher module = one source family, one `fetch(source, *, proxy, settings, client=None)` function, pure (no storage). `datasets/__init__.py` = registry + shared JSON-GET helper + the `DatasetUnavailable` signal. Store/collector/api changes are additive.

---

### Task 1: Store dataset persistence + config API keys

**Files:**
- Modify: `tools/data-hub/src/datahub/store.py`
- Modify: `tools/data-hub/src/datahub/config.py`
- Modify: `tools/data-hub/requirements.txt`
- Test: `tools/data-hub/tests/test_store_datasets.py`

**Interfaces:**
- Produces:
  - `store.upsert_datasets(conn, source_id: str, dataset_key: str, tags: list[str], records: list[dict]) -> int` — each record `{"observed_at", "payload"}`; insert-or-ignore on `UNIQUE(source_id,dataset_key,observed_at)`; returns newly inserted count.
  - `store.query_datasets(conn, dataset_key: str, since_iso=None, limit=50) -> list[dict]` — rows newest-first by `observed_at`; each `{source_id, dataset_key, observed_at, payload(dict), tags(list)}`.
  - `store.dataset_keys(conn) -> list[dict]` — distinct keys with `{dataset_key, count, latest_observed_at}`.
  - `Settings` gains `fred_key: str`, `nass_key: str`, `eia_key: str`, `gnews_key: str`; `Settings.from_env()` reads `FRED_API_KEY`/`NASS_API_KEY`/`EIA_API_KEY`/`GNEWS_API_KEY` (default `""`).

- [ ] **Step 1: Add ephem to requirements.txt**

Append to `tools/data-hub/requirements.txt`:
```
ephem==4.2.1
```

- [ ] **Step 2: Write the failing test** — `tests/test_store_datasets.py`

```python
from datahub import store
from datahub.config import Settings


def test_upsert_datasets_dedups_on_observed_at(db):
    recs = [
        {"observed_at": "2026-06-28T10:00:00+00:00", "payload": {"v": 1}},
        {"observed_at": "2026-06-28T11:00:00+00:00", "payload": {"v": 2}},
    ]
    assert store.upsert_datasets(db, "fred-gdp", "gdp", ["economy"], recs) == 2
    assert store.upsert_datasets(db, "fred-gdp", "gdp", ["economy"], recs) == 0  # same keys


def test_query_datasets_newest_first_and_payload_roundtrip(db):
    store.upsert_datasets(db, "usgs", "quakes", ["nature", "science"], [
        {"observed_at": "2026-06-27T00:00:00+00:00", "payload": {"mag": 5.1}},
        {"observed_at": "2026-06-28T00:00:00+00:00", "payload": {"mag": 6.2}},
    ])
    rows = store.query_datasets(db, "quakes", limit=10)
    assert [r["observed_at"] for r in rows] == ["2026-06-28T00:00:00+00:00", "2026-06-27T00:00:00+00:00"]
    assert rows[0]["payload"] == {"mag": 6.2}
    assert rows[0]["tags"] == ["nature", "science"]
    assert rows[0]["source_id"] == "usgs"


def test_dataset_keys_summary(db):
    store.upsert_datasets(db, "usgs", "quakes", [], [
        {"observed_at": "2026-06-28T00:00:00+00:00", "payload": {}}])
    store.upsert_datasets(db, "ll", "launches", [], [
        {"observed_at": "2026-06-28T01:00:00+00:00", "payload": {}},
        {"observed_at": "2026-06-28T02:00:00+00:00", "payload": {}}])
    keys = {k["dataset_key"]: k for k in store.dataset_keys(db)}
    assert keys["quakes"]["count"] == 1
    assert keys["launches"]["count"] == 2
    assert keys["launches"]["latest_observed_at"] == "2026-06-28T02:00:00+00:00"


def test_settings_reads_api_keys(monkeypatch):
    monkeypatch.setenv("FRED_API_KEY", "abc")
    monkeypatch.delenv("NASS_API_KEY", raising=False)
    s = Settings.from_env()
    assert s.fred_key == "abc"
    assert s.nass_key == ""
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_store_datasets.py -v`
Expected: FAIL — `AttributeError: module 'datahub.store' has no attribute 'upsert_datasets'`.

- [ ] **Step 4: Implement store functions** — append to `src/datahub/store.py`

```python
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
```

- [ ] **Step 5: Add API-key fields to `Settings`** — in `src/datahub/config.py`

In the `Settings` class add fields:
```python
    fred_key: str = ""
    nass_key: str = ""
    eia_key: str = ""
    gnews_key: str = ""
```
In `Settings.from_env()`, add to the `cls(...)` call:
```python
            fred_key=os.environ.get("FRED_API_KEY", ""),
            nass_key=os.environ.get("NASS_API_KEY", ""),
            eia_key=os.environ.get("EIA_API_KEY", ""),
            gnews_key=os.environ.get("GNEWS_API_KEY", ""),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd tools/data-hub && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m pytest tests/test_store_datasets.py -v`
Expected: PASS (4 passed).

- [ ] **Step 7: Commit**

```bash
git add tools/data-hub/src/datahub/store.py tools/data-hub/src/datahub/config.py \
  tools/data-hub/requirements.txt tools/data-hub/tests/test_store_datasets.py
git commit -m "feat(data-hub): dataset persistence (upsert/query/keys) + API-key settings"
```

---

### Task 2: Dataset dispatch registry + keyless HTTP fetchers

**Files:**
- Create: `tools/data-hub/src/datahub/datasets/__init__.py`
- Create: `tools/data-hub/src/datahub/datasets/usgs.py`, `noaa_alerts.py`, `noaa_swpc.py`, `noaa_tides.py`, `launchlib.py`
- Create fixtures: `tests/fixtures/usgs_quakes.json`, `noaa_alerts.json`, `swpc_kindex.json`, `noaa_tides.json`, `launchlib.json`
- Test: `tools/data-hub/tests/test_datasets_keyless.py`

**Interfaces:**
- Consumes: `Source`, `Settings` from config.
- Produces:
  - `datasets.DatasetUnavailable(Exception)` — carries a `reason: str`.
  - `datasets._get_json(url, *, proxy, params=None, ua=DEFAULT_UA, client=None, timeout=20) -> dict` — httpx GET JSON through optional proxy (same ownership rule: close only a self-created client).
  - `datasets.FETCHERS: dict[str, callable]` — maps fetcher name → `fetch(source, *, proxy, settings, client=None) -> list[dict]`.
  - Fetchers (each returns `[{observed_at, payload}, ...]`):
    - `usgs.fetch` — GET `source.params["url"]` (default significant_week.geojson); one record per feature: `observed_at` from `properties.time` (ms epoch → ISO), `payload={mag, place, type, url}`.
    - `noaa_alerts.fetch` — GET active alerts; one record per feature: `observed_at` from `properties.sent`, `payload={event, severity, area, headline}`.
    - `noaa_swpc.fetch` — GET `source.params["url"]`; SWPC returns a JSON array-of-arrays (header row + rows) for k-index/xrays, or array-of-objects for solar-wind. Take the LATEST row; `observed_at` = its time field; `payload` = the row mapped to header names (or the object).
    - `noaa_tides.fetch` — GET datagetter with `source.params` (station, product, etc.); one record per prediction/observation with its `t` time and value.
    - `launchlib.fetch` — GET upcoming launches; one record per launch: `observed_at` from `net` (launch time), `payload={name, status, provider, pad, window_start}`.

- [ ] **Step 1: Create fixtures** (minimal, shape-accurate)

`tests/fixtures/usgs_quakes.json`:
```json
{"type":"FeatureCollection","features":[
 {"properties":{"mag":6.2,"place":"South Pacific","time":1782950400000,"type":"earthquake","url":"https://eq/1"},"id":"a1"},
 {"properties":{"mag":5.1,"place":"Aleutians","time":1782864000000,"type":"earthquake","url":"https://eq/2"},"id":"a2"}
]}
```

`tests/fixtures/noaa_alerts.json`:
```json
{"features":[
 {"properties":{"event":"Tornado Warning","severity":"Extreme","areaDesc":"Cook, IL","headline":"Tornado near Chicago","sent":"2026-06-28T14:00:00-05:00"}}
]}
```

`tests/fixtures/swpc_kindex.json`:
```json
[["time_tag","Kp","a_running","station_count"],
 ["2026-06-28 09:00:00","2","4","8"],
 ["2026-06-28 12:00:00","5","27","8"]]
```

`tests/fixtures/noaa_tides.json`:
```json
{"predictions":[{"t":"2026-06-28 10:30","v":"4.812"},{"t":"2026-06-28 16:45","v":"0.231"}]}
```

`tests/fixtures/launchlib.json`:
```json
{"results":[
 {"name":"Falcon 9 | Starlink","net":"2026-06-29T03:21:00Z","status":{"name":"Go"},
  "launch_service_provider":{"name":"SpaceX"},"pad":{"name":"SLC-40"},"window_start":"2026-06-29T03:21:00Z"}
]}
```

- [ ] **Step 2: Write the failing test** — `tests/test_datasets_keyless.py`

```python
import json
from pathlib import Path
import datahub.datasets as ds
from datahub.datasets import usgs, noaa_alerts, noaa_swpc, noaa_tides, launchlib
from datahub.config import Source, Settings

FX = Path(__file__).parent / "fixtures"
S = Settings(db_path=":memory:", home_ips=set(), proxy_us="", proxy_eu="",
             control_us="", control_eu="", registry_dir="/x")


def _patch(monkeypatch, payload):
    monkeypatch.setattr(ds, "_get_json", lambda *a, **k: payload)


def test_usgs_maps_features_to_records(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "usgs_quakes.json").read_text()))
    src = Source(id="usgs", type="dataset", fetcher="usgs", dataset_key="quakes", tags=["nature"])
    recs = usgs.fetch(src, proxy=None, settings=S)
    assert len(recs) == 2
    assert recs[0]["payload"]["mag"] == 6.2
    assert recs[0]["observed_at"].startswith("2026-")  # epoch-ms converted to ISO


def test_noaa_alerts_maps_sent_time(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "noaa_alerts.json").read_text()))
    src = Source(id="al", type="dataset", fetcher="noaa-alerts", dataset_key="alerts", tags=["weather"])
    recs = noaa_alerts.fetch(src, proxy=None, settings=S)
    assert recs[0]["payload"]["severity"] == "Extreme"
    assert recs[0]["observed_at"].startswith("2026-06-28T14:00")


def test_noaa_swpc_takes_latest_row(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "swpc_kindex.json").read_text()))
    src = Source(id="kp", type="dataset", fetcher="noaa-swpc", dataset_key="kindex",
                 tags=["space"], params={"url": "https://services.swpc.noaa.gov/x.json"})
    recs = noaa_swpc.fetch(src, proxy=None, settings=S)
    assert len(recs) == 1
    assert recs[0]["payload"]["Kp"] == "5"        # latest row, header-mapped
    assert recs[0]["observed_at"].startswith("2026-06-28")


def test_noaa_tides_maps_predictions(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "noaa_tides.json").read_text()))
    src = Source(id="td", type="dataset", fetcher="noaa-tides", dataset_key="tides", tags=["nature"])
    recs = noaa_tides.fetch(src, proxy=None, settings=S)
    assert len(recs) == 2
    assert recs[0]["payload"]["v"] == "4.812"


def test_launchlib_maps_launches(monkeypatch):
    _patch(monkeypatch, json.loads((FX / "launchlib.json").read_text()))
    src = Source(id="ll", type="dataset", fetcher="launchlib", dataset_key="launches", tags=["space"])
    recs = launchlib.fetch(src, proxy=None, settings=S)
    assert recs[0]["payload"]["provider"] == "SpaceX"
    assert recs[0]["observed_at"] == "2026-06-29T03:21:00Z"


def test_registry_has_keyless_fetchers():
    for name in ("usgs", "noaa-alerts", "noaa-swpc", "noaa-tides", "launchlib"):
        assert name in ds.FETCHERS
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_datasets_keyless.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'datahub.datasets'`.

- [ ] **Step 4: Implement `datasets/__init__.py`**

```python
"""Dataset fetchers + dispatch registry."""
import httpx

DEFAULT_UA = "datahub/1.0 (+https://github.com/bourneash) contact@datahub"


class DatasetUnavailable(Exception):
    """Raised when a dataset cannot be fetched for a non-error reason (e.g. missing key).
    The collector records this as a 'skipped' egress, not an 'error'."""
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def _get_json(url: str, *, proxy: str | None = None, params: dict | None = None,
              ua: str = DEFAULT_UA, client: httpx.Client | None = None, timeout: float = 20) -> dict:
    owns = client is None
    client = client or httpx.Client(proxy=proxy, timeout=timeout, follow_redirects=True)
    try:
        r = client.get(url, params=params, headers={"User-Agent": ua, "Accept": "application/json"})
        r.raise_for_status()
        return r.json()
    finally:
        if owns:
            client.close()


# Built after fetcher modules are imported (bottom of file) to avoid circular imports.
from . import usgs, noaa_alerts, noaa_swpc, noaa_tides, launchlib  # noqa: E402
from . import ephemeris  # noqa: E402  (Task 3)
from . import fred, eia, nass  # noqa: E402  (Task 4)

FETCHERS = {
    "usgs": usgs.fetch,
    "noaa-alerts": noaa_alerts.fetch,
    "noaa-swpc": noaa_swpc.fetch,
    "noaa-tides": noaa_tides.fetch,
    "launchlib": launchlib.fetch,
    "ephemeris": ephemeris.fetch,
    "fred": fred.fetch,
    "eia": eia.fetch,
    "nass": nass.fetch,
}
```

> NOTE to implementer: the bottom imports reference modules created in Tasks 3 & 4. To keep THIS task's tests green before those exist, first create stub modules `ephemeris.py`, `fred.py`, `eia.py`, `nass.py` each containing only `def fetch(source, *, proxy, settings, client=None): raise NotImplementedError`. Tasks 3 & 4 replace the stubs. The keyless tests don't call the stubs, so they pass.

- [ ] **Step 5: Implement the 5 keyless fetchers**

`datasets/usgs.py`:
```python
from datetime import datetime, timezone
from . import _get_json

DEFAULT_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url", DEFAULT_URL)
    data = _get_json(url, proxy=proxy, client=client)
    out = []
    for feat in data.get("features", []):
        p = feat.get("properties", {})
        t = p.get("time")
        observed = (datetime.fromtimestamp(t / 1000, tz=timezone.utc).isoformat()
                    if isinstance(t, (int, float)) else datetime.now(timezone.utc).isoformat())
        out.append({"observed_at": observed, "payload": {
            "mag": p.get("mag"), "place": p.get("place"),
            "type": p.get("type"), "url": p.get("url")}})
    return out
```

`datasets/noaa_alerts.py`:
```python
from datetime import datetime, timezone
from . import _get_json

DEFAULT_URL = ("https://api.weather.gov/alerts/active"
               "?status=actual&message_type=alert&severity=Extreme,Severe")


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url", DEFAULT_URL)
    data = _get_json(url, proxy=proxy, client=client)
    out = []
    for feat in data.get("features", []):
        p = feat.get("properties", {})
        out.append({"observed_at": p.get("sent") or datetime.now(timezone.utc).isoformat(),
                    "payload": {"event": p.get("event"), "severity": p.get("severity"),
                                "area": p.get("areaDesc"), "headline": p.get("headline")}})
    return out
```

`datasets/noaa_swpc.py`:
```python
from datetime import datetime, timezone
from . import _get_json


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params["url"]
    data = _get_json(url, proxy=proxy, client=client)
    if isinstance(data, list) and data and isinstance(data[0], list):
        # array-of-arrays: first row is the header
        header, *rows = data
        if not rows:
            return []
        latest = rows[-1]
        payload = dict(zip(header, latest))
        observed = payload.get(header[0]) or datetime.now(timezone.utc).isoformat()
        return [{"observed_at": str(observed).replace(" ", "T"), "payload": payload}]
    if isinstance(data, list) and data:  # array-of-objects
        latest = data[-1]
        observed = latest.get("time_tag") or latest.get("time") or datetime.now(timezone.utc).isoformat()
        return [{"observed_at": str(observed).replace(" ", "T"), "payload": latest}]
    return []
```

`datasets/noaa_tides.py`:
```python
from datetime import datetime, timezone
from . import _get_json

DEFAULT_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url", DEFAULT_URL)
    params = {k: v for k, v in source.params.items() if k != "url"}
    data = _get_json(url, proxy=proxy, params=params or None, client=client)
    rows = data.get("predictions") or data.get("data") or []
    out = []
    for row in rows:
        t = row.get("t") or datetime.now(timezone.utc).isoformat()
        out.append({"observed_at": str(t).replace(" ", "T"), "payload": row})
    return out
```

`datasets/launchlib.py`:
```python
from datetime import datetime, timezone
from . import _get_json

DEFAULT_URL = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url", DEFAULT_URL)
    params = {"limit": source.params.get("limit", 5)}
    data = _get_json(url, proxy=proxy, params=params, client=client)
    out = []
    for ln in data.get("results", []):
        out.append({"observed_at": ln.get("net") or datetime.now(timezone.utc).isoformat(),
                    "payload": {
                        "name": ln.get("name"),
                        "status": (ln.get("status") or {}).get("name"),
                        "provider": (ln.get("launch_service_provider") or {}).get("name"),
                        "pad": (ln.get("pad") or {}).get("name"),
                        "window_start": ln.get("window_start")}})
    return out
```

- [ ] **Step 6: Create the Task 3/4 stub modules** (so `datasets/__init__.py` imports cleanly)

Create `datasets/ephemeris.py`, `datasets/fred.py`, `datasets/eia.py`, `datasets/nass.py`, each:
```python
def fetch(source, *, proxy=None, settings=None, client=None):
    raise NotImplementedError
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_datasets_keyless.py -v`
Expected: PASS (6 passed).

- [ ] **Step 8: Commit**

```bash
git add tools/data-hub/src/datahub/datasets/ tools/data-hub/tests/test_datasets_keyless.py \
  tools/data-hub/tests/fixtures/usgs_quakes.json tools/data-hub/tests/fixtures/noaa_alerts.json \
  tools/data-hub/tests/fixtures/swpc_kindex.json tools/data-hub/tests/fixtures/noaa_tides.json \
  tools/data-hub/tests/fixtures/launchlib.json
git commit -m "feat(data-hub): dataset dispatch registry + keyless fetchers (usgs/noaa/launchlib)"
```

---

### Task 3: Ephemeris fetcher (local PyEphem compute)

**Files:**
- Modify (replace stub): `tools/data-hub/src/datahub/datasets/ephemeris.py`
- Test: `tools/data-hub/tests/test_datasets_ephemeris.py`

**Interfaces:**
- Consumes: `Source`. Makes NO network call (ignores `proxy`).
- Produces: `ephemeris.fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]` — a single record `{"observed_at": now_iso, "payload": {...}}` with the current moon phase (% illuminated), moon zodiac sign, sun zodiac sign, and ecliptic longitudes for the classical planets.

- [ ] **Step 1: Write the failing test** — `tests/test_datasets_ephemeris.py`

```python
from datahub.datasets import ephemeris
from datahub.config import Source


def test_ephemeris_returns_one_record_with_signs():
    src = Source(id="eph", type="dataset", fetcher="ephemeris", dataset_key="ephemeris",
                 tags=["astro"], policy="direct")
    recs = ephemeris.fetch(src, proxy=None)
    assert len(recs) == 1
    p = recs[0]["payload"]
    # moon phase is a 0..100 illumination percentage
    assert 0.0 <= p["moon_phase_pct"] <= 100.0
    # zodiac signs are among the 12
    ZODIAC = {"Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra",
              "Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"}
    assert p["moon_sign"] in ZODIAC
    assert p["sun_sign"] in ZODIAC
    assert "Mars" in p["planet_longitudes"]
    assert recs[0]["observed_at"].endswith("+00:00") or recs[0]["observed_at"].endswith("Z")


def test_ephemeris_ignores_proxy_no_network():
    # proxy points at an unroutable address; fetch must still succeed (pure local compute)
    src = Source(id="eph", type="dataset", fetcher="ephemeris", dataset_key="ephemeris",
                 tags=["astro"], policy="direct")
    recs = ephemeris.fetch(src, proxy="http://10.255.255.1:9", settings=None)
    assert len(recs) == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_datasets_ephemeris.py -v`
Expected: FAIL — `NotImplementedError` (the stub).

- [ ] **Step 3: Implement `datasets/ephemeris.py`** (replace the stub)

```python
"""Local astronomical ephemeris via PyEphem — no network."""
import math
from datetime import datetime, timezone
import ephem

ZODIAC = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra",
          "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"]


def _sign(body) -> str:
    # Ecliptic longitude → 30°-wide zodiac sign.
    lon_deg = math.degrees(float(ephem.Ecliptic(body).lon)) % 360
    return ZODIAC[int(lon_deg // 30)]


def _lon(body) -> float:
    return round(math.degrees(float(ephem.Ecliptic(body).lon)) % 360, 2)


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    now = datetime.now(timezone.utc)
    obs_date = ephem.Date(now)
    sun = ephem.Sun(obs_date)
    moon = ephem.Moon(obs_date)
    planets = {
        "Mercury": ephem.Mercury(obs_date), "Venus": ephem.Venus(obs_date),
        "Mars": ephem.Mars(obs_date), "Jupiter": ephem.Jupiter(obs_date),
        "Saturn": ephem.Saturn(obs_date),
    }
    payload = {
        "moon_phase_pct": round(float(moon.phase), 2),   # 0..100 illuminated
        "moon_sign": _sign(moon),
        "sun_sign": _sign(sun),
        "planet_longitudes": {name: _lon(b) for name, b in planets.items()},
    }
    return [{"observed_at": now.isoformat(), "payload": payload}]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_datasets_ephemeris.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/src/datahub/datasets/ephemeris.py tools/data-hub/tests/test_datasets_ephemeris.py
git commit -m "feat(data-hub): local ephemeris fetcher (moon phase, zodiac signs, planet longitudes)"
```

---

### Task 4: Keyed fetchers (FRED, EIA, NASS) with graceful no-key skip

**Files:**
- Modify (replace stubs): `tools/data-hub/src/datahub/datasets/fred.py`, `eia.py`, `nass.py`
- Create fixtures: `tests/fixtures/fred_obs.json`, `eia_diesel.json`, `nass_corn.json`
- Test: `tools/data-hub/tests/test_datasets_keyed.py`

**Interfaces:**
- Consumes: `Source`, `Settings` (for the keys). Each raises `DatasetUnavailable("no-api-key")` when its key is empty.
- Produces (each `fetch(source, *, proxy, settings, client=None) -> list[dict]`):
  - `fred.fetch` — `https://api.stlouisfed.org/fred/series/observations` with `series_id=source.params["series_id"]`, `api_key=settings.fred_key`, `file_type=json`, `sort_order=desc`, `limit=1`; one record from the latest observation (`observed_at` from `date`, `payload={series_id, value, date}`).
  - `eia.fetch` — EIA v2 URL from `source.params["path"]` + facets; `api_key=settings.eia_key`; one record per row in `response.data` (`observed_at` from `period`, `payload=row`).
  - `nass.fetch` — `https://quickstats.nass.usda.gov/api/api_GET/` with `source.params` + `key=settings.nass_key` + `format=JSON`; one record per row in `data` (`observed_at` from `year` → `YYYY-01-01T00:00:00+00:00`, `payload=row`).

- [ ] **Step 1: Create fixtures**

`tests/fixtures/fred_obs.json`:
```json
{"observations":[{"date":"2026-04-01","value":"23120.5"}]}
```
`tests/fixtures/eia_diesel.json`:
```json
{"response":{"data":[{"period":"2026-06-22","value":3.812,"duoarea":"NAT","product":"EPD2D"}]}}
```
`tests/fixtures/nass_corn.json`:
```json
{"data":[{"commodity_desc":"CORN","Value":"15.1","year":"2025","unit_desc":"BU / ACRE"}]}
```

- [ ] **Step 2: Write the failing test** — `tests/test_datasets_keyed.py`

```python
import json
from pathlib import Path
import pytest
import datahub.datasets as ds
from datahub.datasets import fred, eia, nass, DatasetUnavailable
from datahub.config import Source, Settings

FX = Path(__file__).parent / "fixtures"


def _settings(**keys):
    base = dict(db_path=":memory:", home_ips=set(), proxy_us="", proxy_eu="",
                control_us="", control_eu="", registry_dir="/x")
    base.update(keys)
    return Settings(**base)


def test_fred_skips_without_key():
    src = Source(id="fred", type="dataset", fetcher="fred", dataset_key="gdp",
                 params={"series_id": "GDPC1"}, tags=["economy"])
    with pytest.raises(DatasetUnavailable) as e:
        fred.fetch(src, proxy=None, settings=_settings(fred_key=""))
    assert e.value.reason == "no-api-key"


def test_fred_maps_latest_observation(monkeypatch):
    monkeypatch.setattr(ds, "_get_json", lambda *a, **k: json.loads((FX / "fred_obs.json").read_text()))
    src = Source(id="fred", type="dataset", fetcher="fred", dataset_key="gdp",
                 params={"series_id": "GDPC1"}, tags=["economy"])
    recs = fred.fetch(src, proxy=None, settings=_settings(fred_key="abc"))
    assert recs[0]["payload"]["value"] == "23120.5"
    assert recs[0]["observed_at"].startswith("2026-04-01")


def test_eia_skips_without_key():
    src = Source(id="eia", type="dataset", fetcher="eia", dataset_key="diesel",
                 params={"path": "petroleum/pri/gnd/data/"}, tags=["economy"])
    with pytest.raises(DatasetUnavailable):
        eia.fetch(src, proxy=None, settings=_settings(eia_key=""))


def test_eia_maps_rows(monkeypatch):
    monkeypatch.setattr(ds, "_get_json", lambda *a, **k: json.loads((FX / "eia_diesel.json").read_text()))
    src = Source(id="eia", type="dataset", fetcher="eia", dataset_key="diesel",
                 params={"path": "petroleum/pri/gnd/data/"}, tags=["economy"])
    recs = eia.fetch(src, proxy=None, settings=_settings(eia_key="abc"))
    assert recs[0]["payload"]["value"] == 3.812
    assert recs[0]["observed_at"].startswith("2026-06-22")


def test_nass_skips_without_key():
    src = Source(id="nass", type="dataset", fetcher="nass", dataset_key="corn", tags=["agriculture"])
    with pytest.raises(DatasetUnavailable):
        nass.fetch(src, proxy=None, settings=_settings(nass_key=""))


def test_nass_maps_year_to_observed_at(monkeypatch):
    monkeypatch.setattr(ds, "_get_json", lambda *a, **k: json.loads((FX / "nass_corn.json").read_text()))
    src = Source(id="nass", type="dataset", fetcher="nass", dataset_key="corn",
                 params={"commodity_desc": "CORN"}, tags=["agriculture"])
    recs = nass.fetch(src, proxy=None, settings=_settings(nass_key="abc"))
    assert recs[0]["payload"]["Value"] == "15.1"
    assert recs[0]["observed_at"] == "2025-01-01T00:00:00+00:00"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_datasets_keyed.py -v`
Expected: FAIL — `NotImplementedError` (stubs).

- [ ] **Step 4: Implement the 3 keyed fetchers** (replace stubs)

`datasets/fred.py`:
```python
import datahub.datasets as _ds
from . import DatasetUnavailable
# NOTE: call _ds._get_json(...) (module-level lookup) so tests that monkeypatch
# datahub.datasets._get_json actually intercept the call. A `from . import _get_json`
# local binding would NOT be patchable.

URL = "https://api.stlouisfed.org/fred/series/observations"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    if not (settings and settings.fred_key):
        raise DatasetUnavailable("no-api-key")
    series_id = source.params["series_id"]
    data = _ds._get_json(URL, proxy=proxy, client=client, params={
        "series_id": series_id, "api_key": settings.fred_key,
        "file_type": "json", "sort_order": "desc", "limit": 1})
    obs = data.get("observations", [])
    if not obs:
        return []
    o = obs[0]
    return [{"observed_at": o.get("date", ""), "payload": {
        "series_id": series_id, "value": o.get("value"), "date": o.get("date")}}]
```

`datasets/eia.py`:
```python
import datahub.datasets as _ds
from . import DatasetUnavailable
# NOTE: call _ds._get_json(...) (module-level lookup) so tests that monkeypatch
# datahub.datasets._get_json actually intercept the call. A `from . import _get_json`
# local binding would NOT be patchable.

BASE = "https://api.eia.gov/v2/"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    if not (settings and settings.eia_key):
        raise DatasetUnavailable("no-api-key")
    url = BASE + source.params["path"].lstrip("/")
    params = {k: v for k, v in source.params.items() if k != "path"}
    params["api_key"] = settings.eia_key
    data = _ds._get_json(url, proxy=proxy, client=client, params=params)
    rows = (data.get("response") or {}).get("data", [])
    return [{"observed_at": str(r.get("period", "")), "payload": r} for r in rows]
```

`datasets/nass.py`:
```python
import datahub.datasets as _ds
from . import DatasetUnavailable
# NOTE: call _ds._get_json(...) (module-level lookup) so tests that monkeypatch
# datahub.datasets._get_json actually intercept the call. A `from . import _get_json`
# local binding would NOT be patchable.

URL = "https://quickstats.nass.usda.gov/api/api_GET/"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    if not (settings and settings.nass_key):
        raise DatasetUnavailable("no-api-key")
    params = dict(source.params)
    params["key"] = settings.nass_key
    params["format"] = "JSON"
    data = _ds._get_json(URL, proxy=proxy, client=client, params=params)
    out = []
    for r in data.get("data", []):
        year = str(r.get("year", "")).strip()
        observed = f"{year}-01-01T00:00:00+00:00" if year else ""
        if observed:
            out.append({"observed_at": observed, "payload": r})
    return out
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_datasets_keyed.py -v`
Expected: PASS (6 passed).

- [ ] **Step 6: Commit**

```bash
git add tools/data-hub/src/datahub/datasets/fred.py tools/data-hub/src/datahub/datasets/eia.py \
  tools/data-hub/src/datahub/datasets/nass.py tools/data-hub/tests/test_datasets_keyed.py \
  tools/data-hub/tests/fixtures/fred_obs.json tools/data-hub/tests/fixtures/eia_diesel.json \
  tools/data-hub/tests/fixtures/nass_corn.json
git commit -m "feat(data-hub): keyed dataset fetchers (fred/eia/nass) with graceful no-key skip"
```

---

### Task 5: Wire the collector dataset branch to the dispatch

**Files:**
- Modify: `tools/data-hub/src/datahub/collector.py`
- Test: `tools/data-hub/tests/test_collector_datasets.py`

**Interfaces:**
- Consumes: `datasets.FETCHERS`, `datasets.DatasetUnavailable`, `store.upsert_datasets`.
- Modifies `run_cycle`'s dataset branch (currently the no-op): dispatch the fetcher, upsert, record egress with the new-record count. `DatasetUnavailable` → `skipped` (state `skipped-<reason>`, egress `skipped`, `summary["skipped"]+=1`). Unknown fetcher or other exception → the existing per-source `error` path. `summary["new_items"]` continues to count RSS items only; add `summary["new_datasets"]` for dataset rows.

- [ ] **Step 1: Write the failing test** — `tests/test_collector_datasets.py`

```python
import httpx
import datahub.collector as collector
import datahub.datasets as ds
from datahub.config import Source, Settings
from datahub import store


def _settings():
    return Settings(db_path=":memory:", home_ips={"24.55.143.75"},
                    proxy_us="http://h:8181", proxy_eu="http://h:8182",
                    control_us="http://h:9281", control_eu="http://h:9282", registry_dir="/x")


def _control(ip):
    return httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=ip)))


def test_dataset_source_fetched_and_stored(db, monkeypatch):
    monkeypatch.setitem(ds.FETCHERS, "fake", lambda src, **kw: [
        {"observed_at": "2026-06-28T10:00:00+00:00", "payload": {"x": 1}}])
    src = Source(id="fakesrc", type="dataset", fetcher="fake", dataset_key="fk",
                 tags=["space"], exit="us")
    summary = collector.run_cycle(db, [src], _settings(), control_client=_control("185.1.1.1"))
    assert summary["new_datasets"] == 1
    rows = store.query_datasets(db, "fk")
    assert rows[0]["payload"] == {"x": 1}
    eg = store.query_egress(db)
    assert eg[0]["status"] == "ok"


def test_dataset_unavailable_is_skipped_not_error(db, monkeypatch):
    def raiser(src, **kw):
        raise ds.DatasetUnavailable("no-api-key")
    monkeypatch.setitem(ds.FETCHERS, "keyed", raiser)
    src = Source(id="k", type="dataset", fetcher="keyed", dataset_key="kd", tags=["economy"], exit="us")
    summary = collector.run_cycle(db, [src], _settings(), control_client=_control("185.1.1.1"))
    assert summary["skipped"] == 1
    assert summary["errors"] == 0
    st = {s["source_id"]: s for s in store.get_sources_state(db)}["k"]
    assert st["status"] == "skipped-no-api-key"
    eg = store.query_egress(db)
    assert eg[0]["status"] == "skipped"
    assert eg[0]["note"] == "no-api-key"


def test_unknown_fetcher_is_error(db):
    src = Source(id="bad", type="dataset", fetcher="nope", dataset_key="x", tags=["space"], exit="us")
    summary = collector.run_cycle(db, [src], _settings(), control_client=_control("185.1.1.1"))
    assert summary["errors"] == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_collector_datasets.py -v`
Expected: FAIL — `KeyError: 'new_datasets'` (or the dataset branch still no-ops).

- [ ] **Step 3: Modify `collector.py`**

At the top of `collector.py`, add: `from . import datasets as ds_pkg`.

In `run_cycle`, change the summary init to include datasets:
```python
    summary = {"fetched": 0, "new_items": 0, "new_datasets": 0, "skipped": 0, "errors": 0}
```

Replace the dataset branch (the `if source.type == "dataset":` block that currently records `note="dataset-deferred"`) with:
```python
            if source.type == "dataset":
                try:
                    fetcher = ds_pkg.FETCHERS.get(source.fetcher)
                    if fetcher is None:
                        raise ValueError(f"unknown dataset fetcher: {source.fetcher}")
                    records = fetcher(source, proxy=plan.proxy, settings=settings, client=rss_client)
                except ds_pkg.DatasetUnavailable as ux:
                    store.set_source_state(conn, source_id=source.id,
                                           status=f"skipped-{ux.reason}", error=ux.reason, stale=True)
                    store.record_egress(conn, source_id=source.id, target_host=target,
                                        policy=source.policy, exit_node=plan.exit_node,
                                        exit_ip=plan.exit_ip, status="skipped", note=ux.reason)
                    summary["skipped"] += 1
                    continue
                new = store.upsert_datasets(conn, source.id, source.dataset_key, source.tags, records)
                store.set_source_state(conn, source_id=source.id, status="ok", stale=False)
                store.record_egress(conn, source_id=source.id, target_host=target,
                                    policy=source.policy, exit_node=plan.exit_node,
                                    exit_ip=plan.exit_ip, status="ok", item_count=new)
                summary["fetched"] += 1
                summary["new_datasets"] += new
                continue
```
(The outer per-source `try/except Exception` still catches a `ValueError`/unknown-fetcher or any fetcher crash as an `error`.)

For dataset sources, `target` should reflect the dataset endpoint, not `source.url` (which is None). Set, near the top of the loop where `target` is computed, a dataset-aware host: leave `_host(source.url)` for rss; for datasets use `source.fetcher` as the target label if `source.url` is None. Concretely change `target = _host(source.url)` to:
```python
        target = _host(source.url) or (source.fetcher or "")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_collector_datasets.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Run the full suite**

Run: `cd tools/data-hub && .venv/bin/python -m pytest -q`
Expected: PASS (all Plan 1 + Plan 2 tests green).

- [ ] **Step 6: Commit**

```bash
git add tools/data-hub/src/datahub/collector.py tools/data-hub/tests/test_collector_datasets.py
git commit -m "feat(data-hub): wire collector dataset branch to fetcher dispatch (no-key→skip)"
```

---

### Task 6: `/datasets` API endpoints

**Files:**
- Modify: `tools/data-hub/src/datahub/api.py`
- Test: `tools/data-hub/tests/test_api_datasets.py`

**Interfaces:**
- Produces:
  - `GET /datasets` → `{"datasets": [{dataset_key, count, latest_observed_at}, ...]}` (from `store.dataset_keys`).
  - `GET /datasets/{key}?since=&limit=` → `{"records": [{source_id, dataset_key, observed_at, payload, tags}, ...]}` (from `store.query_datasets`).

- [ ] **Step 1: Write the failing test** — `tests/test_api_datasets.py`

```python
import httpx
from fastapi.testclient import TestClient
from datahub.config import Source, Settings
from datahub import store, api


def _settings():
    return Settings(db_path=":memory:", home_ips=set(), proxy_us="http://h:8181", proxy_eu="http://h:8182",
                    control_us="http://h:9281", control_eu="http://h:9282", registry_dir="/x")


def _client(db):
    vpn_client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text="185.2.2.2")))
    app = api.create_app(_settings(), conn=db, sources=[], subscriptions={}, vpn_client=vpn_client)
    return TestClient(app)


def test_datasets_index_and_detail(db):
    store.upsert_datasets(db, "usgs", "quakes", ["nature"], [
        {"observed_at": "2026-06-28T00:00:00+00:00", "payload": {"mag": 6.2}},
        {"observed_at": "2026-06-27T00:00:00+00:00", "payload": {"mag": 5.0}}])
    c = _client(db)
    idx = c.get("/datasets").json()["datasets"]
    assert any(d["dataset_key"] == "quakes" and d["count"] == 2 for d in idx)
    rows = c.get("/datasets/quakes", params={"limit": 1}).json()["records"]
    assert rows[0]["payload"]["mag"] == 6.2          # newest first
    assert rows[0]["tags"] == ["nature"]


def test_datasets_detail_empty_key(db):
    c = _client(db)
    assert c.get("/datasets/nope").json()["records"] == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_api_datasets.py -v`
Expected: FAIL — 404 (routes don't exist).

- [ ] **Step 3: Add the routes in `api.py`** (alongside the other route definitions in `create_app`)

```python
    @app.get("/datasets")
    def datasets_index():
        return {"datasets": store.dataset_keys(conn)}

    @app.get("/datasets/{key}")
    def datasets_detail(key: str, since: str | None = None, limit: int = 50):
        return {"records": store.query_datasets(conn, key, since_iso=since, limit=limit)}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/data-hub && .venv/bin/python -m pytest tests/test_api_datasets.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/src/datahub/api.py tools/data-hub/tests/test_api_datasets.py
git commit -m "feat(data-hub): /datasets index + /datasets/{key} detail endpoints"
```

---

### Task 7: Seed dataset sources + subscriptions, live smoke

**Files:**
- Modify: `tools/data-hub/registry/sources.yaml` (append dataset sources)
- Modify: `tools/data-hub/registry/subscriptions.yaml` (sinderella + saveusfarms datasets)
- Modify: `tools/data-hub/README.md` (datasets section)

**Interfaces:** Consumes everything above. Produces live, scheduled structured-data collection.

- [ ] **Step 1: Append dataset sources to `registry/sources.yaml`**

Add these entries (keyless ones are live now; keyed ones auto-skip until keys exist). Ephemeris is `policy: direct` (local compute). Gov APIs use `exit: us`.

```yaml
  # ── datasets ──────────────────────────────────────────────────────────────
  - id: ephemeris
    type: dataset
    fetcher: ephemeris
    dataset_key: ephemeris
    tags: [astro, dataset]
    policy: direct          # pure local compute, no network

  - id: usgs-quakes
    type: dataset
    fetcher: usgs
    dataset_key: quakes
    tags: [nature, science, dataset]
    policy: vpn
    exit: us

  - id: noaa-alerts
    type: dataset
    fetcher: noaa-alerts
    dataset_key: weather-alerts
    tags: [weather, nature, dataset]
    policy: vpn
    exit: us

  - id: swpc-kindex
    type: dataset
    fetcher: noaa-swpc
    dataset_key: kindex
    tags: [space, science, astro, dataset]
    policy: vpn
    exit: us
    params: { url: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json" }

  - id: swpc-xrays
    type: dataset
    fetcher: noaa-swpc
    dataset_key: solar-xrays
    tags: [space, science, astro, dataset]
    policy: vpn
    exit: us
    params: { url: "https://services.swpc.noaa.gov/json/goes/primary/xrays-7-day.json" }

  - id: launchlib
    type: dataset
    fetcher: launchlib
    dataset_key: launches
    tags: [space, science, dataset]
    policy: vpn
    exit: any
    params: { limit: 8 }

  # keyed — auto-skip (status skipped-no-api-key) until the key is added to .env
  - id: fred-gdp
    type: dataset
    fetcher: fred
    dataset_key: gdp
    tags: [economy, markets, dataset]
    policy: vpn
    exit: us
    params: { series_id: GDPC1 }

  - id: eia-diesel
    type: dataset
    fetcher: eia
    dataset_key: diesel
    tags: [economy, farm-economy, dataset]
    policy: vpn
    exit: us
    params:
      path: "petroleum/pri/gnd/data/"
      frequency: weekly
      "data[0]": value
      "facets[duoarea][]": NAT
      "facets[product][]": EPD2D
      "sort[0][column]": period
      "sort[0][direction]": desc
      length: 2

  - id: nass-corn
    type: dataset
    fetcher: nass
    dataset_key: corn-yield
    tags: [agriculture, farm-economy, dataset]
    policy: vpn
    exit: us
    params:
      commodity_desc: CORN
      statisticcat_desc: YIELD
      agg_level_desc: NATIONAL
      year__GE: "2023"
```

- [ ] **Step 2: Add dataset subscriptions** in `registry/subscriptions.yaml`

Update sinderella and saveusfarms `datasets:` lists:
```yaml
  sinderella.org:
    items: { tags_any: [space, science, weird, nature], limit: 60, window_hours: 24 }
    datasets: [ephemeris, kindex, solar-xrays, weather-alerts, quakes, launches]
  saveusfarms.com:
    items: { tags_any: [agriculture, food-policy, farm-economy, land, environment], limit: 200, window_hours: 48 }
    datasets: [corn-yield, diesel]
```

- [ ] **Step 3: Document datasets in `README.md`** — add a section:

````markdown
## Datasets (structured data)

Beyond RSS items, the hub collects typed datasets via `type: dataset` sources:

| dataset_key | source | keyless? |
|-------------|--------|----------|
| ephemeris | local PyEphem (moon phase, zodiac, planets) | yes (local) |
| quakes | USGS significant earthquakes | yes |
| weather-alerts | NOAA active alerts | yes |
| kindex / solar-xrays | NOAA SWPC space weather | yes |
| launches | Launch Library 2 upcoming | yes |
| gdp | FRED (needs FRED_API_KEY) | no |
| diesel | EIA v2 (needs EIA_API_KEY) | no |
| corn-yield | USDA NASS (needs NASS_API_KEY) | no |

Served at `GET /datasets` (index) and `GET /datasets/<key>?limit=&since=`.

**Keyed sources auto-skip** with `status=skipped-no-api-key` (visible on `/sources` and the
egress ledger) until the matching key is added to `/home/jesse/projects/domains/.env`. No restart
logic needed — add the key, the next cycle picks it up.
````

- [ ] **Step 4: Rebuild + live smoke** (keyless datasets через the live VPN)

```bash
cd /home/jesse/projects/domains/tools/data-hub
docker compose --env-file ../../.env up -d --build
sleep 20
docker compose --env-file ../../.env exec -T collector python -m datahub collect
# datasets index
curl -s http://127.0.0.1:4760/datasets | python3 -m json.tool
# ephemeris (local — must always be present)
curl -s "http://127.0.0.1:4760/datasets/ephemeris" | python3 -m json.tool
# a VPN-routed gov dataset
curl -s "http://127.0.0.1:4760/datasets/quakes?limit=3" | python3 -m json.tool
curl -s "http://127.0.0.1:4760/datasets/launches?limit=3" | python3 -m json.tool
# keyed sources should show skipped-no-api-key, NOT error
curl -s "http://127.0.0.1:4760/sources" | python3 -c "import sys,json; [print(s['id'], (s.get('state') or {}).get('status')) for s in json.load(sys.stdin)['sources'] if s['type']=='dataset']"
```
Expected: `/datasets` lists ephemeris + quakes + kindex + solar-xrays + weather-alerts + launches with counts; ephemeris payload has moon_phase_pct/moon_sign/sun_sign; quakes/launches populated; fred-gdp/eia-diesel/nass-corn show `skipped-no-api-key`.

**If a NOAA/USGS source shows `error` with a 403/connection issue through the VPN** (gov geoblock of the PIA IP), flip that source to `policy: direct` in `sources.yaml`, rebuild, re-collect, and note the change in the report.

- [ ] **Step 5: Commit**

```bash
git add tools/data-hub/registry/sources.yaml tools/data-hub/registry/subscriptions.yaml tools/data-hub/README.md
git commit -m "feat(data-hub): seed dataset sources + subscriptions; live-smoke keyless datasets"
```

---

## Self-Review

**Spec coverage (vs design doc structured-data goals):**
- Typed dataset fetchers (FRED/NASS/EIA/NOAA/USGS/ephemeris/Launch Library) → Tasks 2/3/4. ✓ (NOAA expanded to SWPC space-weather + alerts + tides per sinderella's actual usage.)
- Datasets stored + served (`datasets` table, `/datasets`) → Task 1 (store) + Task 6 (API). ✓
- VPN policy applies to dataset HTTP fetches; ephemeris is local/direct → Tasks 2/3 + Task 5 wiring. ✓
- Keyed sources degrade gracefully (no key present today) → `DatasetUnavailable`→skip, Tasks 4/5. ✓
- sinderella + saveusfarms dataset subscriptions → Task 7. ✓

**Placeholder scan:** No TBD/TODO. Task 7 Step 4 may require flipping a gov source to `policy: direct` based on live behavior — that's a documented conditional with an explicit instruction, not an open placeholder.

**Type consistency:** Fetcher contract `fetch(source, *, proxy, settings, client=None) -> list[{observed_at, payload}]` is uniform across Tasks 2/3/4 and consumed identically in Task 5. `store.upsert_datasets(conn, source_id, dataset_key, tags, records)` / `query_datasets` / `dataset_keys` names match across Tasks 1/5/6. `DatasetUnavailable.reason` consistent across Tasks 2/4/5. `summary` gains `new_datasets` (Task 5) without disturbing `new_items`.

**Note for the controller:** keyed datasets (fred/eia/nass/gnews) cannot be live-verified — all four API keys are absent from `.env`. Surface this to Jesse: supplying `FRED_API_KEY`, `NASS_API_KEY`, `EIA_API_KEY` (and optionally `GNEWS_API_KEY`) makes the economy/farm datasets and saveusfarms' War Room migration (Plan 4) work with no code change.
```
