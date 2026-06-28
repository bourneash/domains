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
