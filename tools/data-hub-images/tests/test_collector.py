import io
import random

from PIL import Image

from datahub_images import collector, store
from datahub_images.config import Source, Topic, Settings
from datahub_images.sources import USER_AGENT


def _jpg():
    # A flat-color image has near-zero entropy and fails scoring.validate's
    # min_entropy gate, so build a coarse random-block image instead — high
    # enough entropy to pass validate() while staying fast to generate/encode.
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
    return b.getvalue()


def _settings(tmp_path):
    return Settings(
        db_path=str(tmp_path / "t.db"), blob_dir=str(tmp_path / "blobs"),
        proxy_us="http://p", proxy_eu="http://p", home_ips=set(),
        pool_ttl_days=45, retention_days=14, reuse_global_days=30,
        reuse_same_site_days=14, api_host="0.0.0.0", api_port=4770,
    )


def test_pool_fill_and_request_drain(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )
    monkeypatch.setattr(
        "datahub_images.sources.wikimedia.search",
        lambda q, limit, proxy, client=None: [
            dict(
                source_image_key="k1", url="http://img/1.jpg",
                width=1300, height=800, license="cc0",
                credit={"source": "Wikimedia"}, tags=["iran"],
            )
        ],
    )
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]
    tops = [Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])]

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:00:00Z")
    assert out["fetched"] >= 1
    assert store.pool_depth(conn, "iran") == 1

    store.create_request(conn, "americastrikes", "iran", "hormuz", 1, "2026-07-04T00:05:00Z", "127.0.0.1")
    out2 = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:06:00Z")
    assert out2["requests_done"] == 1

    req = [r for r in store.pending_requests(conn)]
    assert req == []


def test_request_drain_records_slug_not_keywords(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )
    monkeypatch.setattr(
        "datahub_images.sources.wikimedia.search",
        lambda q, limit, proxy, client=None: [
            dict(
                source_image_key="k1", url="http://img/1.jpg",
                width=1300, height=800, license="cc0",
                credit={"source": "Wikimedia"}, tags=["iran"],
            )
        ],
    )
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]
    tops = [Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])]

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:00:00Z")
    assert out["fetched"] >= 1
    assert store.pool_depth(conn, "iran") == 1

    # keywords and slug are deliberately distinct so we can tell which one
    # ends up in assignments.slug.
    store.create_request(
        conn, "americastrikes", "iran", ["hormuz", "strait"], 1,
        "2026-07-04T00:05:00Z", "127.0.0.1", slug="strait-of-hormuz-oil-shock",
    )
    out2 = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:06:00Z")
    assert out2["requests_done"] == 1
    assert out2["assigned"] == 1

    images = store.list_images(conn, topic="iran")
    assert len(images) == 1
    rows = store.assignments_for_image(conn, images[0]["id"])
    assert len(rows) == 1
    assert rows[0]["slug"] == "strait-of-hormuz-oil-shock"


def test_source_exception_does_not_abort_cycle(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )

    def _boom(q, limit, proxy, client=None):
        raise RuntimeError("source API blew up")

    monkeypatch.setattr("datahub_images.sources.wikimedia.search", _boom)
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]
    tops = [Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])]

    # Must not raise, and must still return a well-formed counts dict.
    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:00:00Z")
    assert out["fetched"] == 0
    assert store.pool_depth(conn, "iran") == 0
    assert set(out.keys()) == {"fetched", "assigned", "requests_done", "pruned"}


def test_source_unavailable_records_skipped_egress(tmp_path, monkeypatch):
    from datahub_images.sources import SourceUnavailable

    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )

    def _source_unavailable(q, limit, proxy, client=None):
        raise SourceUnavailable("no-api-key")

    monkeypatch.setattr("datahub_images.sources.unsplash.search", _source_unavailable)
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="unsplash", kind="unsplash")]
    tops = [Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])]

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:00:00Z")
    assert out["fetched"] == 0
    assert set(out.keys()) == {"fetched", "assigned", "requests_done", "pruned"}

    # Verify egress_log has a row with status="skipped"
    egress_rows = conn.execute(
        "SELECT * FROM egress_log WHERE source_id = ?", ("unsplash",)
    ).fetchall()
    assert len(egress_rows) == 1
    row = dict(egress_rows[0])
    assert row["status"] == "skipped"
    assert "no-api-key" in row["note"]


def test_fetcher_returning_none_does_not_abort_cycle(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )
    # A misbehaving fetcher returns None instead of a list — iterating this
    # used to raise TypeError and abort the cycle.
    monkeypatch.setattr(
        "datahub_images.sources.wikimedia.search", lambda q, limit, proxy, client=None: None
    )
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]
    tops = [Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])]

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:00:00Z")
    assert out["fetched"] == 0
    assert set(out.keys()) == {"fetched", "assigned", "requests_done", "pruned"}
    assert store.pool_depth(conn, "iran") == 0


def test_fetcher_raising_typeerror_does_not_abort_cycle(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )

    def _boom(q, limit, proxy, client=None):
        raise TypeError("NoneType is not iterable")

    monkeypatch.setattr("datahub_images.sources.wikimedia.search", _boom)
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]
    tops = [Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])]

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:00:00Z")
    assert out["fetched"] == 0
    assert set(out.keys()) == {"fetched", "assigned", "requests_done", "pruned"}
    assert store.pool_depth(conn, "iran") == 0


def test_exception_note_redacts_api_key(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setenv("PIXABAY_API_KEY", "SEKRET123")
    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )

    def _leaky_boom(q, limit, proxy, client=None):
        raise RuntimeError(
            "401 for url: https://pixabay.com/api/?key=SEKRET123&q=Iran"
        )

    monkeypatch.setattr("datahub_images.sources.pixabay.search", _leaky_boom)
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="pixabay", kind="pixabay")]
    tops = [Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])]

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:00:00Z")
    assert out["fetched"] == 0

    egress_rows = conn.execute(
        "SELECT * FROM egress_log WHERE source_id = ?", ("pixabay",)
    ).fetchall()
    assert len(egress_rows) == 1
    note = dict(egress_rows[0])["note"]
    assert "SEKRET123" not in note
    assert "***" in note


def test_vpn_source_threads_planned_proxy_into_fetcher_and_download(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    planned_proxy = "http://vpn-proxy:8181"
    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, planned_proxy, "us", "1.2.3.4", "ok"),
    )

    seen_fetcher_proxy = {}

    def _fetcher(q, limit, proxy, client=None):
        seen_fetcher_proxy["proxy"] = proxy
        return [
            dict(
                source_image_key="k1", url="http://img/1.jpg",
                width=1300, height=800, license="cc0",
                credit={"source": "Wikimedia"}, tags=["iran"],
            )
        ]

    seen_download_proxy = {}

    def _download(url, proxy, http):
        seen_download_proxy["proxy"] = proxy
        return _jpg(), "jpg"

    monkeypatch.setattr("datahub_images.sources.wikimedia.search", _fetcher)
    monkeypatch.setattr("datahub_images.collector._download", _download)

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia", policy="vpn")]
    tops = [Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])]

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-04T00:00:00Z")
    assert out["fetched"] >= 1
    assert seen_fetcher_proxy["proxy"] == planned_proxy
    assert seen_download_proxy["proxy"] == planned_proxy
    assert planned_proxy is not None


class _FakeDownloadClient:
    """Records headers seen on .get(); returns a canned image response."""

    def __init__(self, content=b"fake-bytes"):
        self._content = content
        self.calls = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append({"url": url, "headers": headers or {}})

        class _Resp:
            def __init__(self, content):
                self.content = content
                self.status_code = 200

            def raise_for_status(self):
                pass

        return _Resp(self._content)

    def close(self):
        pass


def test_download_sends_descriptive_user_agent():
    client = _FakeDownloadClient()
    data, ext = collector._download("https://upload.wikimedia.org/x.jpg", None, http=client)
    assert data == b"fake-bytes"
    assert ext == "jpg"
    assert len(client.calls) == 1
    assert client.calls[0]["headers"].get("User-Agent") == USER_AGENT


def test_process_candidate_stores_and_returns_id(tmp_path, monkeypatch):
    from datahub_images.config import Source, Topic, Settings
    from datahub_images import store as store_mod

    conn = store_mod.connect(str(tmp_path / "t.db"))
    store_mod.init_schema(conn)
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    source = Source(id="wikimedia", kind="wikimedia")
    topic = Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])
    plan = __import__("datahub_images.vpn", fromlist=["FetchPlan"]).FetchPlan(
        True, "http://p", "us", "1.2.3.4", "ok"
    )
    cand = dict(
        source_image_key="k1", url="http://img/1.jpg",
        width=1300, height=800, license="cc0",
        credit={"source": "Wikimedia"}, tags=["iran"],
    )
    pool_phashes: list[str] = []

    image_id = collector._process_candidate(
        conn, source, topic, st, "2026-07-05T00:00:00Z", plan, cand, pool_phashes
    )

    assert image_id is not None
    assert len(pool_phashes) == 1
    stored_img = store_mod.get_image(conn, image_id)
    assert stored_img is not None
    assert stored_img["topics"] == ["iran"]

    # Second call with the same source_image_key is a no-op (already seen).
    pool_phashes2 = list(pool_phashes)
    again = collector._process_candidate(
        conn, source, topic, st, "2026-07-05T00:00:10Z", plan, dict(cand), pool_phashes2
    )
    assert again is None
    assert pool_phashes2 == pool_phashes  # unchanged — nothing new stored


def test_process_candidate_records_error_egress_on_exception(tmp_path, monkeypatch):
    from datahub_images.config import Source, Topic

    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    def _boom(url, proxy, http):
        raise RuntimeError("network exploded")

    monkeypatch.setattr("datahub_images.collector._download", _boom)

    st = _settings(tmp_path)
    source = Source(id="wikimedia", kind="wikimedia")
    topic = Topic(id="iran", queries=["Iran"], target_depth=1, tags=["iran"])
    plan = __import__("datahub_images.vpn", fromlist=["FetchPlan"]).FetchPlan(
        True, "http://p", "us", "1.2.3.4", "ok"
    )
    cand = dict(source_image_key="k1", url="http://img/1.jpg", tags=["iran"])

    result = collector._process_candidate(
        conn, source, topic, st, "2026-07-05T00:00:00Z", plan, cand, []
    )

    assert result is None
    rows = conn.execute(
        "SELECT * FROM egress_log WHERE source_id = ?", ("wikimedia",)
    ).fetchall()
    assert len(rows) == 1
    row = dict(rows[0])
    assert row["status"] == "error"
    assert "network exploded" in row["note"]


def test_fetch_on_demand_stores_images_tagged_with_bucket(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
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
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]

    ids = collector.fetch_on_demand(
        conn, ["Strait", "of", "Hormuz"], "strait-of-hormuz", st, srcs,
        "2026-07-05T00:00:00Z", want=1, per_source_limit=4,
    )

    assert len(ids) == 1
    img = store.get_image(conn, ids[0])
    assert img["topics"] == ["strait-of-hormuz"]
    assert store.pool_depth(conn, "strait-of-hormuz") == 1


def test_fetch_on_demand_stops_once_want_reached(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )

    def _many(q, limit, proxy, client=None):
        return [
            dict(source_image_key=f"k{i}", url=f"http://img/{i}.jpg",
                 width=1300, height=800, license="cc0",
                 credit={"source": "Wikimedia"}, tags=["hormuz"])
            for i in range(limit)
        ]

    monkeypatch.setattr("datahub_images.sources.wikimedia.search", _many)

    calls = {"n": 0}

    def _download(url, proxy, http):
        calls["n"] += 1
        return _jpg(), "jpg"

    monkeypatch.setattr("datahub_images.collector._download", _download)

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]

    ids = collector.fetch_on_demand(
        conn, ["hormuz"], "hormuz", st, srcs, "2026-07-05T00:00:00Z",
        want=1, per_source_limit=4,
    )

    assert len(ids) == 1
    assert calls["n"] == 1  # stopped after the first stored candidate


def test_fetch_on_demand_vpn_denied_fetches_nothing(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(False, None, "us", None, "vpn-down"),
    )
    fetcher_called = {"n": 0}

    def _fetcher(q, limit, proxy, client=None):
        fetcher_called["n"] += 1
        return []

    monkeypatch.setattr("datahub_images.sources.wikimedia.search", _fetcher)

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]

    ids = collector.fetch_on_demand(
        conn, ["hormuz"], "hormuz", st, srcs, "2026-07-05T00:00:00Z",
        want=1, per_source_limit=4,
    )

    assert ids == []
    assert fetcher_called["n"] == 0  # denied before the fetcher is ever called

    rows = conn.execute(
        "SELECT * FROM egress_log WHERE source_id = ?", ("wikimedia",)
    ).fetchall()
    assert len(rows) == 1
    assert dict(rows[0])["status"] == "skipped"


def test_fetch_on_demand_source_exception_isolated(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )

    def _boom(q, limit, proxy, client=None):
        raise RuntimeError("source down")

    monkeypatch.setattr("datahub_images.sources.wikimedia.search", _boom)
    monkeypatch.setattr(
        "datahub_images.sources.pexels.search",
        lambda q, limit, proxy, client=None: [
            dict(source_image_key="k1", url="http://img/1.jpg",
                 width=1300, height=800, license="cc0",
                 credit={"source": "Pexels"}, tags=["hormuz"])
        ],
    )
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia"), Source(id="pexels", kind="pexels")]

    # Must not raise, and the second (working) source must still be tried.
    ids = collector.fetch_on_demand(
        conn, ["hormuz"], "hormuz", st, srcs, "2026-07-05T00:00:00Z",
        want=1, per_source_limit=4,
    )

    assert len(ids) == 1


def test_fetch_on_demand_respects_timeout(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )

    fetcher_calls = {"n": 0}

    def _fetcher(q, limit, proxy, client=None):
        fetcher_calls["n"] += 1
        return [
            dict(source_image_key=f"k{fetcher_calls['n']}", url="http://img/1.jpg",
                 width=1300, height=800, license="cc0",
                 credit={"source": "Wikimedia"}, tags=["hormuz"])
        ]

    monkeypatch.setattr("datahub_images.sources.wikimedia.search", _fetcher)
    monkeypatch.setattr("datahub_images.sources.pexels.search", _fetcher)
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia"), Source(id="pexels", kind="pexels")]

    # want=99 (unreachable) + a 0-second timeout ⇒ the loop must bail
    # before exhausting every source, proving the deadline is honored.
    ids = collector.fetch_on_demand(
        conn, ["hormuz"], "hormuz", st, srcs, "2026-07-05T00:00:00Z",
        want=99, per_source_limit=4, timeout_s=0.0,
    )

    assert fetcher_calls["n"] <= 1


def test_request_drain_fetches_on_demand_for_arbitrary_keywords(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
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
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]
    # No registered topics at all — proves the drain no longer needs a
    # topic registry match to satisfy a keyword-only queued request.
    tops = []

    store.create_request(
        conn, "americastrikes", "strait-of-hormuz", ["Strait", "of", "Hormuz"], 1,
        "2026-07-05T00:00:00Z", "127.0.0.1", slug="hormuz-tanker",
    )

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-05T00:00:05Z")

    assert out["requests_done"] == 1
    assert out["assigned"] == 1

    reqs = [r for r in store.pending_requests(conn)]
    assert reqs == []

    images = store.list_images(conn, topic="strait-of-hormuz")
    assert len(images) == 1
    rows = store.assignments_for_image(conn, images[0]["id"])
    assert rows[0]["slug"] == "hormuz-tanker"


def test_request_drain_no_unknown_topic_failure(tmp_path, monkeypatch):
    # A pending request whose bucket has no registered topic and whose
    # sources yield nothing must resolve to status="failed" with no
    # image_ids — never the old "unknown topic: ..." note.
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(False, None, "us", None, "vpn-down"),
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]
    tops = []

    store.create_request(
        conn, "americastrikes", "some-arbitrary-bucket", ["nothing", "findable"], 1,
        "2026-07-05T00:00:00Z", "127.0.0.1",
    )

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-05T00:00:05Z")
    assert out["requests_done"] == 1
    assert out["assigned"] == 0

    req_row = conn.execute("SELECT * FROM requests").fetchone()
    result = __import__("json").loads(req_row["result_json"])
    assert result["image_ids"] == []
    assert req_row["status"] == "failed"
    assert "unknown topic" not in (req_row["note"] or "")


class _RetryDownloadResponse:
    def __init__(self, status_code, content=b"fake-image-bytes"):
        self.status_code = status_code
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")


class _RetryDownloadClient:
    """Minimal stand-in for httpx.Client that returns a scripted sequence
    of status codes from .get(), so _download's 403/429 retry can be
    exercised without any real network I/O."""

    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.calls = 0

    def get(self, url, headers=None, timeout=None):
        self.calls += 1
        status = self.statuses.pop(0)
        return _RetryDownloadResponse(status)


def test_download_retries_on_403_then_succeeds(monkeypatch):
    sleeps = []
    monkeypatch.setattr(collector, "_sleep", lambda s: sleeps.append(s))
    client = _RetryDownloadClient([403, 200])

    data, ext = collector._download("http://img.example/pic.jpg", None, http=client)

    assert data == b"fake-image-bytes"
    assert ext == "jpg"
    assert client.calls == 2
    assert sleeps == [1]  # first step of _DOWNLOAD_RETRY_BACKOFF


def test_download_retries_on_429_exhausted_then_raises(monkeypatch):
    sleeps = []
    monkeypatch.setattr(collector, "_sleep", lambda s: sleeps.append(s))
    # initial attempt + 2 retries, all 429 -> retries exhausted -> raises
    client = _RetryDownloadClient([429, 429, 429])

    import pytest

    with pytest.raises(RuntimeError):
        collector._download("http://img.example/pic.jpg", None, http=client)

    assert client.calls == 3
    assert sleeps == [1, 2]


def test_download_other_error_status_not_retried(monkeypatch):
    sleeps = []
    monkeypatch.setattr(collector, "_sleep", lambda s: sleeps.append(s))
    client = _RetryDownloadClient([500])

    import pytest

    with pytest.raises(RuntimeError):
        collector._download("http://img.example/pic.jpg", None, http=client)

    assert client.calls == 1  # no retry for non-403/429 statuses
    assert sleeps == []


def test_request_drain_increments_fetched_count(tmp_path, monkeypatch):
    # Regression: the drain fetch used to discard fetch_on_demand's return
    # value entirely, so counts["fetched"] stayed 0 even when the drain
    # fetched new images. It must reflect drain fetches too.
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
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
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    srcs = [Source(id="wikimedia", kind="wikimedia")]
    tops = []  # no registered topics -> phase 1 never runs, pool starts empty

    store.create_request(
        conn, "americastrikes", "hormuz", ["hormuz"], 1,
        "2026-07-05T00:00:00Z", "127.0.0.1",
    )

    out = collector.run_cycle(st, conn, srcs, tops, "2026-07-05T00:00:05Z")

    assert out["requests_done"] == 1
    assert out["assigned"] == 1
    assert out["fetched"] == 1


def test_documentary_first_orders_documentary_before_stock():
    # Registry order is stock-first (unsplash, pexels, ...); the helper must
    # reorder so documentary/PD sources are tried first, stable within tiers.
    srcs = [
        Source(id="unsplash", kind="unsplash"),
        Source(id="pexels", kind="pexels"),
        Source(id="dvids", kind="dvids"),
        Source(id="openverse", kind="openverse"),  # CC aggregator = stock, not documentary
        Source(id="wikimedia", kind="wikimedia"),
    ]
    ordered = [s.kind for s in collector._documentary_first(srcs)]
    assert ordered == ["dvids", "wikimedia", "unsplash", "pexels", "openverse"]


def test_fetch_on_demand_prefers_documentary_over_stock(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db"))
    store.init_schema(conn)

    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )
    # Both a stock source (unsplash, listed FIRST) and a documentary source
    # (dvids, listed SECOND) have a usable candidate for these keywords.
    stock_cand = lambda q, limit, proxy, client=None: [dict(
        source_image_key="u1", url="http://img/u.jpg", width=1300, height=800,
        license="unsplash", credit={"source": "Unsplash"}, tags=["carrier"])]
    doc_cand = lambda q, limit, proxy, client=None: [dict(
        source_image_key="d1", url="http://img/d.jpg", width=1300, height=800,
        license="pd", credit={"source": "DVIDS"}, tags=["carrier"])]
    monkeypatch.setattr("datahub_images.sources.unsplash.search", stock_cand)
    monkeypatch.setattr("datahub_images.sources.dvids.search", doc_cand)
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg")
    )

    st = _settings(tmp_path)
    # Stock-first registry order — the fix must still pick documentary.
    srcs = [Source(id="unsplash", kind="unsplash"), Source(id="dvids", kind="dvids")]

    out = collector.fetch_on_demand(
        conn, ["aircraft", "carrier"], "iran", st, srcs,
        "2026-07-04T00:00:00Z", want=1, per_source_limit=5,
    )

    assert len(out) == 1
    row = conn.execute("SELECT source_id FROM images WHERE id = ?", (out[0],)).fetchone()
    assert row["source_id"] == "dvids"  # documentary won despite being listed second
    # Stock was never reached (stopped at want after the documentary hit).
    reached = {r["source_id"] for r in conn.execute(
        "SELECT source_id FROM egress_log").fetchall()}
    assert "unsplash" not in reached


def test_query_ladder_is_strong_queries_only():
    # full join, then first-two join; never a lone single keyword.
    assert collector._query_ladder(["us navy", "strait of hormuz", "centcom"]) == [
        "us navy strait of hormuz centcom", "us navy strait of hormuz"]
    assert collector._query_ladder(["a", "b"]) == ["a b"]       # full == first-two → deduped
    assert collector._query_ladder(["OPEC"]) == ["OPEC"]        # 1 kw: only itself
    assert collector._query_ladder([]) == []


def _allow_plan(monkeypatch):
    monkeypatch.setattr(
        "datahub_images.vpn.plan_fetch",
        lambda s, st, client=None: __import__(
            "datahub_images.vpn", fromlist=["FetchPlan"]
        ).FetchPlan(True, "http://p", "us", "1.2.3.4", "ok"),
    )
    monkeypatch.setattr(
        "datahub_images.collector._download", lambda url, proxy, http: (_jpg(), "jpg"))


def _cand(source):
    return dict(source_image_key=source + "1", url=f"http://img/{source}.jpg",
                width=1300, height=800, license="x", credit={"source": source}, tags=["t"])


def test_documentary_guard_denies_weak_single_keyword_match(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db")); store.init_schema(conn)
    _allow_plan(monkeypatch)
    # dvids ONLY matches the lone keyword "OPEC" — never the full or first-two
    # query. The guard must refuse it and let stock (unsplash) serve instead.
    monkeypatch.setattr("datahub_images.sources.dvids.search",
        lambda q, limit, proxy, client=None: [_cand("dvids")] if q == "OPEC" else [])
    monkeypatch.setattr("datahub_images.sources.unsplash.search",
        lambda q, limit, proxy, client=None: [_cand("unsplash")])

    st = _settings(tmp_path)
    srcs = [Source(id="unsplash", kind="unsplash"), Source(id="dvids", kind="dvids")]
    out = collector.fetch_on_demand(
        conn, ["OPEC", "oil markets", "explainer"], "mkt", st, srcs,
        "2026-07-04T00:00:00Z", want=1, per_source_limit=5)

    assert len(out) == 1
    row = conn.execute("SELECT source_id FROM images WHERE id=?", (out[0],)).fetchone()
    assert row["source_id"] == "unsplash"  # documentary's weak match was denied


def test_documentary_preferred_on_strong_firsttwo_match(tmp_path, monkeypatch):
    conn = store.connect(str(tmp_path / "t.db")); store.init_schema(conn)
    _allow_plan(monkeypatch)
    # dvids has nothing for the full join but hits on the first-two query —
    # a strong match, so documentary should win over stock via the ladder.
    monkeypatch.setattr("datahub_images.sources.dvids.search",
        lambda q, limit, proxy, client=None: [_cand("dvids")] if q == "us navy strait of hormuz" else [])
    monkeypatch.setattr("datahub_images.sources.unsplash.search",
        lambda q, limit, proxy, client=None: [_cand("unsplash")])

    st = _settings(tmp_path)
    srcs = [Source(id="unsplash", kind="unsplash"), Source(id="dvids", kind="dvids")]
    out = collector.fetch_on_demand(
        conn, ["us navy", "strait of hormuz", "centcom"], "mil", st, srcs,
        "2026-07-04T00:00:00Z", want=1, per_source_limit=5)

    assert len(out) == 1
    row = conn.execute("SELECT source_id FROM images WHERE id=?", (out[0],)).fetchone()
    assert row["source_id"] == "dvids"  # strong first-two match preferred
    reached = {r["source_id"] for r in conn.execute("SELECT source_id FROM egress_log").fetchall()}
    assert "unsplash" not in reached  # stopped at want before stock
