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
        lambda r: httpx.Response(200, content=b"185.2.2.2")))
    app = api.create_app(_settings(), conn=db, sources=sources, subscriptions=subs, vpn_client=vpn_client)
    return TestClient(app)


def _seed(db):
    store.upsert_items(db, [
        {"title": "war", "url": "https://x/1", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "reuters", "source_name": "Reuters", "tags": ["defense"], "raw": {}},
        {"title": "weather", "url": "https://x/2", "summary": "", "published_iso": "2026-06-28T09:00:00+00:00",
         "source_id": "reuters", "source_name": "Reuters", "tags": ["nature"], "raw": {}},
    ])


def test_subscription_and_dataset_pulls_are_logged(db):
    _seed(db)
    c = _client(db)
    r = c.get("/subscriptions/americastrikes.com/items")
    n = len(r.json()["items"])
    pulls = c.get("/pulls").json()["pulls"]
    assert len(pulls) == 1
    assert pulls[0]["site"] == "americastrikes.com"
    assert pulls[0]["endpoint"] == "subscriptions/americastrikes.com/items"
    assert pulls[0]["item_count"] == n
    # read-only endpoints must NOT create pull rows
    c.get("/sources"); c.get("/health"); c.get("/datasets")
    assert len(c.get("/pulls").json()["pulls"]) == 1


def test_sources_reports_enabled_and_toggle_overrides(db):
    c = _client(db)
    src = {s["id"]: s for s in c.get("/sources").json()["sources"]}["reuters"]
    assert src["enabled"] is True and src["overridden"] is False and src["registry_default"] is True
    # toggle off → effective enabled flips, registry default unchanged
    r = c.post("/sources/reuters/enabled", json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False
    src = {s["id"]: s for s in c.get("/sources").json()["sources"]}["reuters"]
    assert src["enabled"] is False and src["overridden"] is True and src["registry_default"] is True
    # toggle back to the registry default (True) → override cleared, not redundant
    back = c.post("/sources/reuters/enabled", json={"enabled": True}).json()
    assert back["enabled"] is True and back["overridden"] is False
    src = {s["id"]: s for s in c.get("/sources").json()["sources"]}["reuters"]
    assert src["enabled"] is True and src["overridden"] is False
    # unknown source → 404
    assert c.post("/sources/nope/enabled", json={"enabled": False}).status_code == 404


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
    store.set_source_state(db, source_id="reuters-vpn", status="skipped-vpn-down", stale=True)
    c = _client(db)
    r = c.get("/health")
    body = r.json()
    assert body["nodes"]["us"] == "185.2.2.2"
    assert body["counts"]["items"] == 2
    assert body["counts"]["skipped"] == 1
    assert any(s["source_id"] == "reuters" for s in body["sources"])


def test_subscription_404_unknown_site(db):
    c = _client(db)
    r = c.get("/subscriptions/nope.com")
    assert r.status_code == 404
    r2 = c.get("/subscriptions/nope.com/items")
    assert r2.status_code == 404


def test_subscription_items_merges_configured_datasets(db):
    # Regression test: `datasets:` on a subscription was parsed but never
    # actually queried by /subscriptions/{site}/items — a site could declare
    # datasets: [cisa-kev] in the registry and never see a single record.
    # No RSS items seeded here on purpose — that path is covered by
    # test_subscription_items_endpoint; this isolates the datasets merge.
    # window_hours set generously wide so the test isn't coupled to wall-clock
    # time vs. the fixed 2026-07-0x fixture dates below (default is 48h).
    subs = {"0daynews.com": Subscription(site="0daynews.com",
            items=ItemsQuery(tags_any=["vuln"], limit=50, window_hours=24 * 365 * 10),
            datasets=["cisa-kev"])}
    vpn_client = httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, content=b"185.2.2.2")))
    app = api.create_app(_settings(), conn=db, sources=[], subscriptions=subs, vpn_client=vpn_client)
    c = TestClient(app)

    store.upsert_datasets(db, "cisa-kev", "cisa-kev", ["vuln", "dataset"], [
        {"observed_at": "2026-07-05T00:00:00+00:00", "payload": {
            "cve_id": "CVE-2026-30001", "vendor_project": "Ivanti", "product": "Connect Secure",
            "vulnerability_name": "Auth Bypass", "short_description": "desc",
            "notes": "https://nvd.nist.gov/vuln/detail/CVE-2026-30001",
        }},
        {"observed_at": "2026-07-04T00:00:00+00:00", "payload": {
            "cve_id": "CVE-2026-29800", "vendor_project": "Fortinet", "product": "FortiOS",
            "vulnerability_name": "Heap Overflow", "short_description": "desc2",
            "notes": "https://nvd.nist.gov/vuln/detail/CVE-2026-29800",
        }},
    ])

    r = c.get("/subscriptions/0daynews.com/items")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 2
    assert items[0]["cve_id"] == "CVE-2026-30001"  # newest (2026-07-05) first
    assert items[0]["source"] == "CISA KEV"
    assert items[0]["title"] == "Ivanti Connect Secure: Auth Bypass"
    assert items[1]["cve_id"] == "CVE-2026-29800"


def test_subscription_items_skips_dataset_keys_without_an_adapter(db):
    # corn-yield/diesel etc. have no item-shape adapter yet — must not crash
    # or emit malformed rows, just contribute nothing until one is added.
    subs = {"saveusfarms.com": Subscription(site="saveusfarms.com",
            items=ItemsQuery(tags_any=["agriculture"], limit=50), datasets=["corn-yield", "diesel"])}
    app = api.create_app(_settings(), conn=db, sources=[], subscriptions=subs,
                         vpn_client=httpx.Client(transport=httpx.MockTransport(
                             lambda r: httpx.Response(200, content=b"185.2.2.2"))))
    c = TestClient(app)
    r = c.get("/subscriptions/saveusfarms.com/items")
    assert r.status_code == 200
    assert r.json()["items"] == []
