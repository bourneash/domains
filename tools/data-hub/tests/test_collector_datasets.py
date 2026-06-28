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
