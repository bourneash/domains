from datahub_images import store


def test_upsert_and_pool(tmp_path):
    conn = store.connect(str(tmp_path / "t.db")); store.init_schema(conn)
    img = dict(id="abc", source_id="wikimedia", source_image_key="k1", blob_path="/b/abc.jpg",
        width=1300, height=800, phash="ff00", score=-4.0, license="cc0",
        credit={"source": "Wikimedia"}, topics=["iran"], tags=["iran"], entropy=6.1, fetched_at="2026-07-04T00:00:00Z")
    assert store.upsert_image(conn, img) is True
    assert store.upsert_image(conn, img) is False           # dedup by id
    assert store.pool_depth(conn, "iran") == 1
    assert store.pool_for_topic(conn, "iran")[0]["id"] == "abc"


def test_reuse_tracking(tmp_path):
    conn = store.connect(str(tmp_path / "t.db")); store.init_schema(conn)
    store.record_assignment(conn, "abc", "americastrikes", "slug-1", "iran", "2026-07-04T00:00:00Z")
    assert store.assignments_for_image(conn, "abc")[0]["site"] == "americastrikes"


def test_prune_keeps_used(tmp_path):
    conn = store.connect(str(tmp_path / "t.db")); store.init_schema(conn)
    old = "2026-01-01T00:00:00Z"
    store.upsert_image(conn, dict(id="u", source_id="s", source_image_key="k", blob_path="/x",
        width=1300, height=800, phash="1", score=0, license="cc0", credit={}, topics=["iran"], tags=[], entropy=6, fetched_at=old))
    store.record_assignment(conn, "u", "site", "sl", "iran", old)          # used → keep
    store.upsert_image(conn, dict(id="v", source_id="s", source_image_key="k2", blob_path="/y",
        width=1300, height=800, phash="2", score=0, license="cc0", credit={}, topics=["iran"], tags=[], entropy=6, fetched_at=old))
    store.prune(conn, pool_ttl_days=45, retention_days=14, now="2026-07-04T00:00:00Z")
    ids = {r["id"] for r in store.pool_for_topic(conn, "iran")}
    assert "u" in ids and "v" not in ids                                    # unused old pruned


def test_seen_source_and_mark_seen(tmp_path):
    conn = store.connect(str(tmp_path / "t.db")); store.init_schema(conn)
    assert store.seen_source(conn, "k1") is None
    store.mark_seen(conn, "k1", "abc", "2026-07-04T00:00:00Z")
    assert store.seen_source(conn, "k1") == "abc"
    # idempotent: second mark_seen for same key doesn't error / doesn't overwrite
    store.mark_seen(conn, "k1", "other", "2026-07-04T01:00:00Z")
    assert store.seen_source(conn, "k1") == "abc"


def test_requests_lifecycle(tmp_path):
    conn = store.connect(str(tmp_path / "t.db")); store.init_schema(conn)
    req_id = store.create_request(conn, "americastrikes", "iran", ["missile", "strike"], 2,
                                   "2026-07-04T00:00:00Z", "1.2.3.4")
    pending = store.pending_requests(conn)
    assert len(pending) == 1
    assert pending[0]["id"] == req_id
    assert pending[0]["keywords"] == ["missile", "strike"]
    store.finish_request(conn, req_id, "done", {"images": ["abc"]}, "2026-07-04T00:05:00Z")
    assert store.pending_requests(conn) == []


def test_blacklist(tmp_path):
    conn = store.connect(str(tmp_path / "t.db")); store.init_schema(conn)
    store.upsert_image(conn, dict(id="bl", source_id="s", source_image_key="kbl", blob_path="/z",
        width=1300, height=800, phash="deadbeef", score=0, license="cc0", credit={}, topics=["iran"], tags=[], entropy=6, fetched_at="2026-07-04T00:00:00Z"))
    assert store.is_blacklisted_phash(conn, "deadbeef") is False
    store.blacklist_image(conn, "bl")
    assert store.is_blacklisted_phash(conn, "deadbeef") is True
    # blacklisted image no longer appears in default active-status pool
    assert store.pool_depth(conn, "iran") == 0
