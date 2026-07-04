import io
import random

from PIL import Image

from datahub_images import collector, store
from datahub_images.config import Source, Topic, Settings


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
