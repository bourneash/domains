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
