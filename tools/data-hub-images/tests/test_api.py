import os

from fastapi.testclient import TestClient

from datahub_images import api, store
from datahub_images.config import Settings


def _settings(tmp_path):
    return Settings(
        db_path=str(tmp_path / "t.db"), blob_dir=str(tmp_path / "b"), proxy_us="", proxy_eu="",
        home_ips=set(), pool_ttl_days=45, retention_days=14, reuse_global_days=30,
        reuse_same_site_days=14, api_host="0.0.0.0", api_port=4770,
    )


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
    c = TestClient(api.create_app(_seeded(tmp_path)))
    r = c.post("/request", json={"site": "americastrikes", "topic": "iran", "count": 1})
    assert r.status_code == 200
    body = r.json()
    assert body["images"][0]["id"] == "abc"
    assert c.get("/image/abc").status_code == 200  # streams the blob


def test_health_shape(tmp_path):
    c = TestClient(api.create_app(_seeded(tmp_path)))
    assert "vpn" in c.get("/health").json()


def test_get_images_logs_pull(tmp_path):
    st = _seeded(tmp_path)
    c = TestClient(api.create_app(st))
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
    c = TestClient(api.create_app(st))
    conn = store.connect(st.db_path)
    before = len(store.query_pulls(conn))

    r = c.get("/image/abc")
    assert r.status_code == 200

    after = store.query_pulls(conn)
    assert len(after) == before + 1
    assert after[0]["endpoint"] == "/image/abc"
    assert after[0]["item_count"] == 1


def test_request_with_slug_stores_it_when_pending(tmp_path):
    st = _settings(tmp_path)
    conn = store.connect(st.db_path)
    store.init_schema(conn)
    conn.close()
    c = TestClient(api.create_app(st))
    r = c.post("/request", json={"site": "americastrikes", "topic": "iran", "count": 1, "slug": "hormuz-tanker"})
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
