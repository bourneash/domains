import os
import threading
import time

from fastapi.testclient import TestClient

from datahub_images import api, collector, store
from datahub_images.config import Settings, Source, Topic


def _settings(tmp_path, **overrides):
    kwargs = dict(
        db_path=str(tmp_path / "t.db"), blob_dir=str(tmp_path / "b"), proxy_us="", proxy_eu="",
        home_ips=set(), pool_ttl_days=45, retention_days=14, reuse_global_days=30,
        reuse_same_site_days=14, api_host="0.0.0.0", api_port=4770,
    )
    kwargs.update(overrides)
    return Settings(**kwargs)


def _seeded(tmp_path):
    st = _settings(tmp_path)
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    os.makedirs(str(tmp_path / "b/ab"), exist_ok=True)
    open(str(tmp_path / "b/ab/abc.jpg"), "wb").write(b"x")
    store.upsert_image(conn, dict(
        id="abc", source_id="wikimedia", source_image_key="k", blob_path=str(tmp_path / "b/ab/abc.jpg"),
        width=1300, height=800, phash="ff", score=-4, license="cc0", credit={"source": "Wikimedia"},
        topics=["iran"], tags=["iran"], entropy=6, fetched_at="2026-07-04T00:00:00Z",
    ))
    conn.close()
    return st


def test_request_serves_from_pool(tmp_path):
    c = TestClient(api.create_app(_seeded(tmp_path), sources=[]))
    r = c.post("/request", json={"site": "americastrikes", "topic": "iran", "count": 1})
    assert r.status_code == 200
    body = r.json()
    assert body["images"][0]["id"] == "abc"
    assert c.get("/image/abc").status_code == 200  # streams the blob


def test_health_shape(tmp_path):
    c = TestClient(api.create_app(_seeded(tmp_path), sources=[]))
    assert "vpn" in c.get("/health").json()


def test_get_images_logs_pull(tmp_path):
    st = _seeded(tmp_path)
    c = TestClient(api.create_app(st, sources=[]))
    conn = store.connect(st.db_path)
    before = len(store.query_pulls(conn))

    r = c.get("/images")
    assert r.status_code == 200

    after = store.query_pulls(conn)
    assert len(after) == before + 1
    assert after[0]["endpoint"] == "/images"
    assert after[0]["item_count"] == len(r.json()["images"])


def test_get_image_by_id_logs_pull(tmp_path):
    st = _seeded(tmp_path)
    c = TestClient(api.create_app(st, sources=[]))
    conn = store.connect(st.db_path)
    before = len(store.query_pulls(conn))

    r = c.get("/image/abc")
    assert r.status_code == 200

    after = store.query_pulls(conn)
    assert len(after) == before + 1
    assert after[0]["endpoint"] == "/image/abc"
    assert after[0]["item_count"] == 1


def test_request_with_slug_and_async_stores_pending(tmp_path):
    # Renamed/updated from the old
    # test_request_with_slug_stores_it_when_pending: under the new
    # default (async defaults to False ⇒ sync fetch-on-miss), a cache
    # miss only queues a pending request when the caller explicitly asks
    # for async.
    st = _settings(tmp_path)
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    conn.close()
    c = TestClient(api.create_app(st, sources=[]))
    r = c.post("/request", json={
        "site": "americastrikes", "topic": "iran", "count": 1,
        "slug": "hormuz-tanker", "async": True,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "pending"
    req_id = body["request_id"]

    conn2 = store.connect(st.db_path)
    req = store.get_request(conn2, req_id)
    assert req is not None
    assert req["slug"] == "hormuz-tanker"

    status_body = c.get(f"/request/{req_id}").json()
    assert status_body["slug"] == "hormuz-tanker"


def test_request_default_sync_miss_returns_clean_empty_with_note(tmp_path, monkeypatch):
    # Default call (no "async" key at all): pool is empty, no sources
    # configured ⇒ fetch_on_demand finds nothing ⇒ a clean 200 with an
    # empty list and a note, never a pending request and never a 500.
    st = _settings(tmp_path)
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    conn.close()
    c = TestClient(api.create_app(st, sources=[]))

    r = c.post("/request", json={"site": "americastrikes", "keywords": ["hormuz", "tanker"], "count": 1})

    assert r.status_code == 200
    body = r.json()
    assert body["images"] == []
    assert "note" in body


def test_request_sync_miss_fetches_on_demand_and_returns_images(tmp_path, monkeypatch):
    st = _settings(tmp_path)
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    conn.close()

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st_, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )
    monkeypatch.setattr(
        "datahub_images.sources.wikimedia.search",
        lambda q, limit, proxy, client=None: [
            dict(
                source_image_key="k1", url="http://img/1.jpg",
                width=1300, height=800, license="cc0",
                credit={"source": "Wikimedia"}, tags=["hormuz"],
            )
        ],
    )

    def _download(url, proxy, http):
        # avoid a real Pillow-encoded JPEG dependency in api tests —
        # reuse collector's own test fixture image if available, else
        # build a minimal valid one inline.
        import io
        import random

        from PIL import Image

        rng = random.Random(1)
        im = Image.new("RGB", (1300, 800))
        px = im.load()
        block = 8
        for x in range(0, 1300, block):
            color = (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for y in range(0, 800, block):
                for dx in range(block):
                    for dy in range(block):
                        if x + dx < 1300 and y + dy < 800:
                            px[x + dx, y + dy] = color
        b = io.BytesIO()
        im.save(b, "JPEG")
        return b.getvalue(), "jpg"

    monkeypatch.setattr("datahub_images.collector._download", _download)

    srcs = [Source(id="wikimedia", kind="wikimedia")]
    c = TestClient(api.create_app(st, sources=srcs))

    r = c.post("/request", json={"site": "americastrikes", "keywords": ["Strait", "of", "Hormuz"], "count": 1})

    assert r.status_code == 200
    body = r.json()
    assert len(body["images"]) == 1

    conn2 = store.connect(st.db_path)
    assert store.pool_depth(conn2, "strait-of-hormuz") == 1


def test_request_topic_only_backward_compatible(tmp_path):
    # A topic-only request (no keywords) with an empty pool and no
    # sources still returns a clean 200, not a crash — proves the
    # "topic → queries" fallback and the "no registered topic needed"
    # path both degrade safely.
    st = _settings(tmp_path)
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    conn.close()
    topics = [Topic(id="iran", queries=["Iran Persian Gulf"], target_depth=12, tags=["iran"])]
    c = TestClient(api.create_app(st, sources=[], topics=topics))

    r = c.post("/request", json={"site": "americastrikes", "topic": "iran", "count": 1})

    assert r.status_code == 200
    body = r.json()
    assert body["images"] == []
    assert "note" in body


def test_sync_miss_second_concurrent_request_gets_busy_note(tmp_path, monkeypatch):
    # on_demand_max_concurrent=1: a slow fetch holds the only slot, so a
    # second concurrent sync-miss request must NOT call fetch_on_demand at
    # all — it should skip straight to a busy note with whatever the pool
    # (empty here) already produced, and never a 500 / unbounded pile-up.
    st = _settings(tmp_path, on_demand_max_concurrent=1, on_demand_acquire_timeout_s=0.3)
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    conn.close()

    calls = []
    release_event = threading.Event()

    def _slow_fetch(*a, **k):
        calls.append(1)
        release_event.wait(2)
        return []

    monkeypatch.setattr(collector, "fetch_on_demand", _slow_fetch)
    c = TestClient(api.create_app(st, sources=[]))

    results = {}

    def _first():
        results["first"] = c.post(
            "/request", json={"site": "americastrikes", "keywords": ["a"], "count": 1}
        )

    t = threading.Thread(target=_first)
    t.start()
    time.sleep(0.1)  # let the first request acquire the only slot and block in _slow_fetch

    r2 = c.post("/request", json={"site": "americastrikes", "keywords": ["a"], "count": 1})
    release_event.set()
    t.join(2)

    assert r2.status_code == 200
    assert "busy" in r2.json().get("note", "")
    assert results["first"].status_code == 200
    assert len(calls) == 1  # the second request never called fetch_on_demand


def test_sync_miss_free_slot_still_fetches(tmp_path, monkeypatch):
    st = _settings(tmp_path, on_demand_max_concurrent=3)
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    conn.close()

    calls = []

    def _fake_fetch(*a, **k):
        calls.append(1)
        return []

    monkeypatch.setattr(collector, "fetch_on_demand", _fake_fetch)
    c = TestClient(api.create_app(st, sources=[]))

    r = c.post("/request", json={"site": "americastrikes", "keywords": ["a"], "count": 1})

    assert r.status_code == 200
    assert len(calls) == 1
    assert "busy" not in r.json().get("note", "")
