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
    assert state["status"] == "skipped-vpn-down"
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
