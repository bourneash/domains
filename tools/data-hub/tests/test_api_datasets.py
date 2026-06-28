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
