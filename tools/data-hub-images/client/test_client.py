"""Tests for datahub_images_client. Network-free: spins a local
http.server.ThreadingHTTPServer stub that mimics the broker's /request,
/request/{id}, /image/{id}, /images, /health endpoints. No real broker, no
VPN, no external calls.
"""

from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import pytest

from datahub_images_client import (
    DataHubImagesClient,
    DataHubImagesError,
    ext_for_content_type,
    normalize_keywords,
    validate_request_args,
)

# A 1x1 JPEG-ish byte blob (content-type is what the client checks, not validity).
FAKE_JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46])


class _Stub:
    """Local HTTP stub broker. `routes` maps "METHOD /path" (or a prefix
    ending in "/") to a handler `(handler, ctx) -> None` that must call one
    of the ctx helpers to respond."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # silence
                pass

            def _handle(self, method):
                parsed = urlparse(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                raw_body = self.rfile.read(length) if length else b""
                body = json.loads(raw_body.decode("utf-8")) if raw_body else None
                outer.calls.append({"method": method, "path": parsed.path,
                                     "query": parse_qs(parsed.query), "body": body})
                key = f"{method} {parsed.path}"
                handler = outer.routes.get(key)
                if handler is None:
                    for k, h in outer.routes.items():
                        m, p = k.split(" ", 1)
                        if m == method and parsed.path.startswith(p) and p.endswith("/"):
                            handler = h
                            break
                if handler is None:
                    self.send_response(404)
                    self.end_headers()
                    self.wfile.write(b"no route")
                    return
                handler(self, {"path": parsed.path, "body": body, "query": parse_qs(parsed.query)})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        port = self._server.server_address[1]
        return f"http://127.0.0.1:{port}"

    def close(self):
        self._server.shutdown()
        self._server.server_close()


def send_json(handler: BaseHTTPRequestHandler, obj, status: int = 200):
    data = json.dumps(obj).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.end_headers()
    handler.wfile.write(data)


def send_image(handler: BaseHTTPRequestHandler, content_type: str, data: bytes = FAKE_JPEG,
               status: int = 200):
    handler.send_response(status)
    handler.send_header("content-type", content_type)
    handler.end_headers()
    handler.wfile.write(data)


def send_raw(handler: BaseHTTPRequestHandler, status: int, body: bytes = b""):
    handler.send_response(status)
    handler.end_headers()
    if body:
        handler.wfile.write(body)


@pytest.fixture
def stub_factory():
    stubs = []

    def _make(routes):
        s = _Stub(routes)
        stubs.append(s)
        return s

    yield _make
    for s in stubs:
        s.close()


def no_sleep(_seconds):
    pass


# ── unit tests: pure functions ──────────────────────────────────────────────


def test_normalize_keywords_array_comma_space_junk():
    assert normalize_keywords(["a", " b ", ""]) == ["a", "b"]
    assert normalize_keywords("a, b,c") == ["a", "b", "c"]
    assert normalize_keywords("mount fuji") == ["mount", "fuji"]
    assert normalize_keywords(None) == []
    assert normalize_keywords(42) == []


def test_validate_request_args_marks_errors_non_retryable():
    with pytest.raises(DataHubImagesError) as e1:
        validate_request_args({"keywords": ["x"]})
    assert e1.value.retryable is False

    with pytest.raises(DataHubImagesError) as e2:
        validate_request_args({"site": "d"})
    assert e2.value.retryable is False

    with pytest.raises(DataHubImagesError) as e3:
        validate_request_args({"site": "d", "keywords": ["x"], "count": 0})
    assert e3.value.retryable is False

    result = validate_request_args({"site": "d", "keywords": "a b"})
    assert result == {"site": "d", "keywords": ["a", "b"], "topic": None, "count": 1}


def test_ext_for_content_type_maps_known_falls_back_img():
    assert ext_for_content_type("image/jpeg") == "jpg"
    assert ext_for_content_type("image/png") == "png"
    assert ext_for_content_type("image/webp; charset=binary") == "webp"
    assert ext_for_content_type("image/gif") == "gif"
    assert ext_for_content_type("application/octet-stream") == "img"
    assert ext_for_content_type("") == "img"


# ── sourceImage / request behavior ──────────────────────────────────────────


def test_source_image_invalid_args_throw_immediately_no_fetch_no_sleep():
    calls = {"opener": 0, "sleep": 0}

    def bad_opener(method, url, headers, body, timeout):
        calls["opener"] += 1
        raise RuntimeError("nope")

    def counting_sleep(s):
        calls["sleep"] += 1

    c = DataHubImagesClient(base_url="http://127.0.0.1:1", retries=3,
                             opener=bad_opener, sleep=counting_sleep)
    with pytest.raises(DataHubImagesError) as exc:
        c.source_image(site="x", keywords=[], count=0)
    assert exc.value.retryable is False
    assert calls["opener"] == 0
    assert calls["sleep"] == 0


def test_source_image_download_extension_follows_content_type(stub_factory, tmp_path):
    for ext, ct in {"png": "image/png", "webp": "image/webp"}.items():
        def make_request_handler(ext=ext):
            def handler(h, ctx):
                send_json(h, {"images": [{"id": f"id_{ext}", "url": f"/image/id_{ext}",
                                           "width": 1, "height": 1}]})
            return handler

        def image_handler(h, ctx, ct=ct):
            send_image(h, ct)

        stub = stub_factory({
            "POST /request": make_request_handler(),
            "GET /image/": image_handler,
        })
        d = tmp_path / f"dir_{ext}"
        d.mkdir()
        c = DataHubImagesClient(base_url=stub.base_url)
        r = c.source_image(site="demo", keywords=["x"], dest_dir=str(d))
        assert r["images"][0]["path"].endswith(f".{ext}"), r["images"][0]["path"]
        assert (d / f"id_{ext}.{ext}").exists()


def test_request_sync_happy_path_returns_broker_json_verbatim(stub_factory):
    def handler(h, ctx):
        assert ctx["body"]["site"] == "demo"
        assert ctx["body"]["keywords"] == ["ocean", "waves"]
        assert ctx["body"]["count"] == 2
        send_json(h, {"images": [{"id": "abc", "url": "/image/abc",
                                   "credit": {"source": "Unsplash"}, "width": 10, "height": 5}]})

    stub = stub_factory({"POST /request": handler})
    c = DataHubImagesClient(base_url=stub.base_url)
    r = c.request(site="demo", keywords="ocean, waves", count=2)
    assert r["images"][0]["id"] == "abc"


def test_request_async_passes_json_key_async_true(stub_factory):
    def handler(h, ctx):
        assert ctx["body"]["async"] is True
        assert "async_" not in ctx["body"]
        send_json(h, {"status": "pending", "request_id": 7})

    stub = stub_factory({"POST /request": handler})
    c = DataHubImagesClient(base_url=stub.base_url)
    r = c.request(site="demo", keywords=["x"], async_=True)
    assert r["request_id"] == 7


def test_request_arg_validation_throws_before_any_network_call():
    def bad_opener(method, url, headers, body, timeout):
        raise RuntimeError("should not fetch")

    c = DataHubImagesClient(base_url="http://127.0.0.1:1", opener=bad_opener)
    with pytest.raises(DataHubImagesError, match=r"site.*required"):
        c.request(keywords=["x"])
    with pytest.raises(DataHubImagesError, match=r"keywords.*or a registered.*topic"):
        c.request(site="d")
    with pytest.raises(DataHubImagesError, match=r"positive integer"):
        c.request(site="d", keywords=["x"], count=0)


def test_source_image_sync_hit_downloads_bytes_credit_path(stub_factory, tmp_path):
    def req_handler(h, ctx):
        send_json(h, {"images": [{"id": "img1", "url": "/image/img1",
                                   "credit": {"source": "Pexels", "photographer": "Jo"},
                                   "width": 800, "height": 600}]})

    def img_handler(h, ctx):
        send_image(h, "image/jpeg")

    stub = stub_factory({"POST /request": req_handler, "GET /image/": img_handler})
    c = DataHubImagesClient(base_url=stub.base_url)
    r = c.source_image(site="demo", keywords=["x"], dest_dir=str(tmp_path))
    assert len(r["images"]) == 1
    assert r["images"][0]["credit"]["source"] == "Pexels"
    assert r["images"][0]["bytes"] == len(FAKE_JPEG)
    on_disk = (tmp_path / f"img1.jpg").read_bytes()
    assert on_disk == FAKE_JPEG


def test_source_image_empty_miss_returns_empty_with_note_never_raises(stub_factory):
    def handler(h, ctx):
        send_json(h, {"images": [], "note": "no fetchable image"})

    stub = stub_factory({"POST /request": handler})
    c = DataHubImagesClient(base_url=stub.base_url, retries=0)
    r = c.source_image(site="demo", keywords=["nothing"])
    assert r["images"] == []
    assert "no fetchable" in r["note"]


def test_source_image_retries_on_busy_note_then_succeeds(stub_factory):
    n = {"count": 0}

    def handler(h, ctx):
        n["count"] += 1
        if n["count"] == 1:
            send_json(h, {"images": [], "note": "broker busy — no free fetch slot; retry or use async"})
        else:
            send_json(h, {"images": [{"id": "ok", "url": "/image/ok", "width": 1, "height": 1}]})

    stub = stub_factory({"POST /request": handler})
    c = DataHubImagesClient(base_url=stub.base_url, retries=2, sleep=no_sleep)
    r = c.source_image(site="demo", keywords=["x"])
    assert n["count"] == 2
    assert r["images"][0]["id"] == "ok"


def test_source_image_retries_on_5xx_then_succeeds(stub_factory):
    n = {"count": 0}

    def handler(h, ctx):
        n["count"] += 1
        if n["count"] == 1:
            send_raw(h, 503, b"unavailable")
        else:
            send_json(h, {"images": [{"id": "ok2", "url": "/image/ok2", "width": 1, "height": 1}]})

    stub = stub_factory({"POST /request": handler})
    c = DataHubImagesClient(base_url=stub.base_url, retries=2, sleep=no_sleep)
    r = c.source_image(site="demo", keywords=["x"])
    assert n["count"] == 2
    assert r["images"][0]["id"] == "ok2"


def test_source_image_4xx_not_retried_and_raises(stub_factory):
    n = {"count": 0}

    def handler(h, ctx):
        n["count"] += 1
        send_raw(h, 400, b"bad")

    stub = stub_factory({"POST /request": handler})
    c = DataHubImagesClient(base_url=stub.base_url, retries=3, sleep=no_sleep)
    with pytest.raises(DataHubImagesError):
        c.source_image(site="demo", keywords=["x"])
    assert n["count"] == 1  # no retry on 400


def test_source_image_async_poll_done_enrich_download(stub_factory, tmp_path):
    polls = {"count": 0}

    def req_handler(h, ctx):
        send_json(h, {"status": "pending", "request_id": 42})

    def poll_handler(h, ctx):
        polls["count"] += 1
        if polls["count"] < 2:
            send_json(h, {"status": "pending", "result": {"image_ids": []}})
        else:
            send_json(h, {"status": "done", "result": {"image_ids": ["zz"]}})

    def images_handler(h, ctx):
        send_json(h, {"images": [{"id": "zz", "credit": {"source": "Wikimedia"},
                                   "width": 3, "height": 2}]})

    def img_handler(h, ctx):
        send_image(h, "image/jpeg")

    stub = stub_factory({
        "POST /request": req_handler,
        "GET /request/42": poll_handler,
        "GET /images": images_handler,
        "GET /image/": img_handler,
    })
    c = DataHubImagesClient(base_url=stub.base_url, sleep=no_sleep)
    r = c.source_image(site="demo", keywords=["x"], async_=True, dest_dir=str(tmp_path),
                        wait_opts={"interval": 0.001})
    assert r["request_id"] == 42
    assert r["images"][0]["id"] == "zz"
    assert r["images"][0]["credit"]["source"] == "Wikimedia"
    assert r["images"][0]["path"]


def test_source_image_async_failed_returns_empty_with_note(stub_factory):
    def req_handler(h, ctx):
        send_json(h, {"status": "pending", "request_id": 5})

    def poll_handler(h, ctx):
        send_json(h, {"status": "failed", "note": None,
                       "result": {"image_ids": [], "note": "unknown topic"}})

    stub = stub_factory({"POST /request": req_handler, "GET /request/5": poll_handler})
    c = DataHubImagesClient(base_url=stub.base_url, sleep=no_sleep)
    r = c.source_image(site="demo", topic="nope", async_=True)
    assert r["images"] == []
    assert "unknown topic" in r["note"]


def test_get_image_bytes_rejects_non_image_content_type(stub_factory):
    def handler(h, ctx):
        send_image(h, "text/html", data=b"<h1>nope</h1>")

    stub = stub_factory({"GET /image/": handler})
    c = DataHubImagesClient(base_url=stub.base_url)
    with pytest.raises(DataHubImagesError, match="non-image content-type"):
        c.get_image_bytes("x")


def test_download_image_creates_missing_parent_dirs(stub_factory, tmp_path):
    def handler(h, ctx):
        send_image(h, "image/png")

    stub = stub_factory({"GET /image/": handler})
    dest = tmp_path / "a" / "b" / "c" / "out.png"
    c = DataHubImagesClient(base_url=stub.base_url)
    r = c.download_image("id", str(dest))
    assert r["bytes"] == len(FAKE_JPEG)
    assert r["content_type"] == "image/png"
    assert dest.exists()


def test_timeout_surfaces_as_datahub_images_error(stub_factory):
    event = threading.Event()

    def handler(h, ctx):
        event.wait(2)  # never respond within the test's timeout window

    stub = stub_factory({"GET /health": handler})
    c = DataHubImagesClient(base_url=stub.base_url, meta_timeout=0.05)
    with pytest.raises(DataHubImagesError, match="timed out"):
        c.health()
    event.set()


def test_health_stats_sources_passthrough(stub_factory):
    def handler(h, ctx):
        send_json(h, {"ok": True, "vpn": {"us": "1.2.3.4"}})

    stub = stub_factory({"GET /health": handler})
    c = DataHubImagesClient(base_url=stub.base_url)
    h = c.health()
    assert h["ok"] is True
