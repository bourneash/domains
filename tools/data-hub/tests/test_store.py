from datetime import datetime, timedelta, timezone

from datahub import store


def test_prune_removes_old_rows_keeps_recent(db):
    now = datetime.now(timezone.utc)
    old = (now - timedelta(days=10)).isoformat()
    recent = (now - timedelta(days=1)).isoformat()
    db.execute("INSERT INTO items (source_id, url, title, published_iso, fetched_at, tags) VALUES (?,?,?,?,?,?)",
               ("s", "https://x/old", "old", old, old, "[]"))
    db.execute("INSERT INTO items (source_id, url, title, published_iso, fetched_at, tags) VALUES (?,?,?,?,?,?)",
               ("s", "https://x/new", "new", recent, recent, "[]"))
    db.execute("INSERT INTO egress_log (ts, source_id, status) VALUES (?,?,?)", (old, "s", "ok"))
    db.execute("INSERT INTO egress_log (ts, source_id, status) VALUES (?,?,?)", (recent, "s", "ok"))
    store.record_pull(db, endpoint="items", item_count=1, client_ip="x")  # recent (now)
    db.execute("INSERT INTO pull_log (ts, endpoint, item_count) VALUES (?,?,?)", (old, "items", 9))
    db.execute("INSERT INTO seen_urls (url, first_seen_at) VALUES (?,?)", ("https://x/old", old))
    db.execute("INSERT INTO datasets (source_id, dataset_key, observed_at, payload, tags) VALUES (?,?,?,?,?)",
               ("s", "k", old, "{}", "[]"))
    db.commit()

    deleted = store.prune(db, retention_days=7)
    assert deleted["items"] == 1 and deleted["egress_log"] == 1 and deleted["pull_log"] == 1
    assert deleted["seen_urls"] == 1 and deleted["datasets"] == 1
    assert db.execute("SELECT COUNT(*) c FROM items").fetchone()["c"] == 1
    assert db.execute("SELECT title FROM items").fetchone()["title"] == "new"
    assert len(store.query_egress(db)) == 1
    assert len(store.query_pulls(db)) == 1


def test_source_override_roundtrip(db):
    assert store.get_source_overrides(db) == {}
    store.set_source_override(db, source_id="lwj", enabled=False)
    assert store.get_source_overrides(db) == {"lwj": False}
    # upsert flips an existing override
    store.set_source_override(db, source_id="lwj", enabled=True)
    assert store.get_source_overrides(db) == {"lwj": True}


def test_pull_log_roundtrip(db):
    assert store.query_pulls(db) == []
    store.record_pull(db, site="americastrikes.com",
                      endpoint="subscriptions/americastrikes.com/items", item_count=42, client_ip="172.30.68.8")
    store.record_pull(db, endpoint="datasets/launches", item_count=3, client_ip="172.30.68.5")
    rows = store.query_pulls(db, limit=10)
    assert len(rows) == 2
    assert rows[0]["endpoint"] == "datasets/launches"   # newest first
    only = store.query_pulls(db, site="americastrikes.com")
    assert len(only) == 1 and only[0]["item_count"] == 42 and only[0]["client_ip"] == "172.30.68.8"


def test_upsert_dedups_by_url(db):
    items = [
        {"title": "A", "url": "https://x/1", "summary": "s", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "src1", "source_name": "Src One", "tags": ["defense", "world"], "raw": {}},
        {"title": "B", "url": "https://x/2", "summary": "s", "published_iso": "2026-06-28T11:00:00+00:00",
         "source_id": "src1", "source_name": "Src One", "tags": ["markets"], "raw": {}},
    ]
    assert store.upsert_items(db, items) == 2
    # Re-inserting the same urls inserts nothing (seen-url dedup)
    assert store.upsert_items(db, items) == 0


def test_query_items_by_tags_any_newest_first(db):
    store.upsert_items(db, [
        {"title": "old-defense", "url": "https://x/1", "summary": "", "published_iso": "2026-06-20T10:00:00+00:00",
         "source_id": "s", "source_name": "S", "tags": ["defense"], "raw": {}},
        {"title": "new-markets", "url": "https://x/2", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "s", "source_name": "S", "tags": ["markets"], "raw": {}},
        {"title": "new-theater", "url": "https://x/3", "summary": "", "published_iso": "2026-06-29T10:00:00+00:00",
         "source_id": "s", "source_name": "S", "tags": ["theater"], "raw": {}},
    ])
    rows = store.query_items(db, tags_any=["defense", "markets"], limit=10)
    titles = [r["title"] for r in rows]
    assert titles == ["new-markets", "old-defense"]   # theater excluded, newest first
    assert rows[0]["source"] == "S"
    assert "markets" in rows[0]["tags"]


def test_query_items_tags_all_and_exclude_source(db):
    store.upsert_items(db, [
        {"title": "both", "url": "https://x/1", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "keep", "source_name": "Keep", "tags": ["a", "b"], "raw": {}},
        {"title": "onlyA", "url": "https://x/2", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "keep", "source_name": "Keep", "tags": ["a"], "raw": {}},
        {"title": "both-drop", "url": "https://x/3", "summary": "", "published_iso": "2026-06-28T10:00:00+00:00",
         "source_id": "drop", "source_name": "Drop", "tags": ["a", "b"], "raw": {}},
    ])
    rows = store.query_items(db, tags_all=["a", "b"], exclude_sources=["drop"], limit=10)
    assert [r["title"] for r in rows] == ["both"]


def test_egress_roundtrip_and_filter(db):
    store.record_egress(db, source_id="s1", target_host="example.com", policy="vpn",
                        exit_node="us", exit_ip="1.2.3.4", status="ok", item_count=5)
    store.record_egress(db, source_id="s2", target_host="gov.example", policy="direct",
                        exit_node="direct", exit_ip="9.9.9.9", status="ok")
    allrows = store.query_egress(db, limit=10)
    assert len(allrows) == 2
    vpn_only = store.query_egress(db, policy="vpn", limit=10)
    assert len(vpn_only) == 1
    assert vpn_only[0]["source_id"] == "s1"
    assert vpn_only[0]["exit_node"] == "us"


def test_source_state_upsert(db):
    store.set_source_state(db, source_id="s1", status="ok", stale=False)
    store.set_source_state(db, source_id="s1", status="skipped-vpn-down", error="vpn down", stale=True)
    states = {s["source_id"]: s for s in store.get_sources_state(db)}
    assert states["s1"]["status"] == "skipped-vpn-down"
    assert states["s1"]["stale"] == 1


def test_unseen_urls(db):
    store.upsert_items(db, [
        {"source_id": "s", "source_name": "s", "url": "https://x/old", "title": "old",
         "summary": "", "published_iso": "2026-06-28T10:00:00+00:00", "tags": [], "raw": {}},
    ])
    result = store.unseen_urls(db, ["https://x/old", "https://x/new", ""])
    assert result == {"https://x/new"}


def test_upsert_items_stores_content(db):
    store.upsert_items(db, [
        {"source_id": "s", "source_name": "s", "url": "https://x/1", "title": "t",
         "summary": "sum", "published_iso": "2026-06-28T10:00:00+00:00", "tags": ["a"],
         "raw": {}, "content": "the full article body"},
    ])
    rows = store.query_items(db, tags_any=["a"])
    assert rows[0]["content"] == "the full article body"


def test_upsert_items_content_defaults_empty_string(db):
    store.upsert_items(db, [
        {"source_id": "s", "source_name": "s", "url": "https://x/2", "title": "t",
         "summary": "sum", "published_iso": "2026-06-28T10:00:00+00:00", "tags": ["a"], "raw": {}},
    ])
    rows = store.query_items(db, tags_any=["a"])
    assert rows[0]["content"] == ""
