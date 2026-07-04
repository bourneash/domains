from datahub_images import store, reuse
from datahub_images.config import Topic, Settings


def _s():
    return Settings(
        db_path=":memory:",
        blob_dir="/b",
        proxy_us="",
        proxy_eu="",
        home_ips=set(),
        pool_ttl_days=45,
        retention_days=14,
        reuse_global_days=30,
        reuse_same_site_days=14,
        api_host="0.0.0.0",
        api_port=4770,
    )


def _img(conn, id, score):
    store.upsert_image(
        conn,
        dict(
            id=id,
            source_id="s",
            source_image_key=id,
            blob_path="/x",
            width=1300,
            height=800,
            phash=id,
            score=score,
            license="cc0",
            credit={},
            topics=["iran"],
            tags=[],
            entropy=6,
            fetched_at="2026-07-04T00:00:00Z",
        ),
    )


def test_prefers_unused_best_score(tmp_path):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)
    _img(conn, "a", -5)
    _img(conn, "b", -1)
    got = reuse.select_image(
        conn, Topic(id="iran", queries=["Iran"]), "americastrikes", "slug-1", _s(), "2026-07-04T00:00:00Z"
    )
    assert got["id"] == "a"  # lower score = better, unused


def test_blocks_reuse_within_global_window(tmp_path):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)
    _img(conn, "a", -5)
    store.record_assignment(conn, "a", "othersite", "s0", "iran", "2026-06-25T00:00:00Z")  # 9 days ago
    store.set_last_used(conn, "a", "2026-06-25T00:00:00Z")
    got = reuse.select_image(
        conn, Topic(id="iran", queries=["Iran"]), "americastrikes", "slug-1", _s(), "2026-07-04T00:00:00Z"
    )
    assert got is None  # <30d since last use → ineligible
