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
        lambda r: httpx.Response(200, content=ip.encode())))


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
    eg = store.query_egress(db)
    assert any(r["source_id"] == "reuters" and r["status"] == "skipped" for r in eg)


def test_disabled_source_is_skipped_without_fetch_or_egress(db, monkeypatch):
    # `enabled: false` must skip the source entirely: no VPN probe, no fetch,
    # state marked "disabled", and NO egress row (nothing went over the wire).
    def boom_fetch(src, **kw):
        raise AssertionError("must not fetch a disabled source")
    def boom_plan(src, settings, **kw):
        raise AssertionError("must not VPN-probe a disabled source")
    monkeypatch.setattr(fr, "fetch_rss", boom_fetch)
    monkeypatch.setattr(collector, "plan_fetch", boom_plan)
    sources = [Source(id="lwj", type="rss", url="https://x/feed",
                      tags=["defense"], enabled=False)]
    summary = collector.run_cycle(db, sources, _settings())
    assert summary["skipped"] == 1
    assert summary["new_items"] == 0
    state = {s["source_id"]: s for s in store.get_sources_state(db)}["lwj"]
    assert state["status"] == "disabled"
    assert state["stale"] == 1
    eg = store.query_egress(db)
    assert not any(r["source_id"] == "lwj" for r in eg)


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
    eg = store.query_egress(db)
    assert any(r["source_id"] == "bad" and r["status"] == "error" for r in eg)


def test_plan_fetch_raise_is_isolated(db, monkeypatch):
    """plan_fetch raising for one source must not abort the cycle."""
    import datahub.collector as _collector
    from datahub.vpn import FetchPlan

    def patched_plan_fetch(src, settings, client=None):
        if src.id == "explode":
            raise RuntimeError("boom")
        return FetchPlan(allowed=True, reason="ok", proxy=None,
                         exit_node="direct", exit_ip=None, policy="direct")

    monkeypatch.setattr(_collector, "plan_fetch", patched_plan_fetch)
    monkeypatch.setattr(fr, "fetch_rss", lambda src, **kw: [
        {"title": "G", "url": "https://x/g", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": src.id, "source_name": src.id, "tags": src.tags, "raw": {}}])

    sources = [
        Source(id="explode", type="rss", url="https://e/bad.rss", tags=["world"], exit="us"),
        Source(id="good", type="rss", url="https://e/good.rss", tags=["world"], exit="us"),
    ]
    summary = collector.run_cycle(db, sources, _settings())
    assert summary["errors"] == 1
    assert summary["new_items"] == 1   # good source stored despite explode failing
    eg = store.query_egress(db)
    assert any(r["source_id"] == "explode" and r["status"] == "error" for r in eg)


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


def test_full_text_fetched_for_new_items_only(db, monkeypatch):
    calls = []

    def fake_extract(url, **kw):
        calls.append(url)
        return f"full text of {url}"

    monkeypatch.setattr(collector.extract, "fetch_article_text", fake_extract)
    monkeypatch.setattr(fr, "fetch_rss", lambda src, **kw: [
        {"title": "X", "url": "https://x/1", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": src.id, "source_name": src.id, "tags": src.tags, "raw": {}}])
    sources = [Source(id="opedge", type="rss", url="https://e/o.rss", tags=["prosthetics"],
                      exit="us", fetch={"full_text": True})]

    collector.run_cycle(db, sources, _settings(), control_client=_control("185.1.1.1"))
    rows = store.query_items(db, tags_any=["prosthetics"])
    assert len(rows) == 1
    assert rows[0]["content"] == "full text of https://x/1"
    assert calls == ["https://x/1"]

    # Second cycle re-returns the same live-feed entry (fetch_rss doesn't know
    # what's already stored) -- it must NOT be re-extracted.
    collector.run_cycle(db, sources, _settings(), control_client=_control("185.1.1.1"))
    assert calls == ["https://x/1"]


def test_full_text_not_attempted_without_flag(db, monkeypatch):
    def boom(url, **kw):
        raise AssertionError("must not extract when full_text isn't set")
    monkeypatch.setattr(collector.extract, "fetch_article_text", boom)
    monkeypatch.setattr(fr, "fetch_rss", lambda src, **kw: [
        {"title": "X", "url": "https://x/1", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": src.id, "source_name": src.id, "tags": src.tags, "raw": {}}])
    sources = [Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="us")]
    collector.run_cycle(db, sources, _settings(), control_client=_control("185.1.1.1"))
    rows = store.query_items(db, tags_any=["world"])
    assert rows[0]["content"] == ""


def test_full_text_records_attempt_counters(db, monkeypatch):
    monkeypatch.setattr(collector.extract, "fetch_article_text", lambda url, **kw: "")
    monkeypatch.setattr(fr, "fetch_rss", lambda src, **kw: [
        {"title": "X", "url": "https://x/1", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": src.id, "source_name": src.id, "tags": src.tags, "raw": {}}])
    sources = [Source(id="paywalled", type="rss", url="https://e/p.rss", tags=["news"],
                      exit="us", fetch={"full_text": True})]
    collector.run_cycle(db, sources, _settings(), control_client=_control("185.1.1.1"))
    state = {s["source_id"]: s for s in store.get_sources_state(db)}["paywalled"]
    assert state["fulltext_attempts"] == 1
    assert state["fulltext_hits"] == 0
