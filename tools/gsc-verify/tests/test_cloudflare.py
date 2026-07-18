import httpx
import pytest

from gsc_verify import cloudflare


def _client(handler):
    return httpx.Client(base_url=cloudflare.BASE, transport=httpx.MockTransport(handler))


def test_zone_id_found():
    def handler(request):
        assert request.url.params["name"] == "example.com"
        return httpx.Response(200, json={"success": True, "result": [{"id": "zone123"}]})

    assert cloudflare.zone_id(_client(handler), "example.com") == "zone123"


def test_zone_id_absent_returns_none():
    def handler(request):
        return httpx.Response(200, json={"success": True, "result": []})

    assert cloudflare.zone_id(_client(handler), "nope.com") is None


def test_upsert_txt_skips_when_identical_record_exists():
    calls = {"post": 0}

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={
                "success": True,
                "result": [{"id": "rec1", "content": "google-site-verification=TOKEN"}],
            })
        calls["post"] += 1
        return httpx.Response(200, json={"success": True, "result": {"id": "rec2"}})

    result = cloudflare.upsert_txt(
        _client(handler), "zone123", "example.com", "google-site-verification=TOKEN"
    )
    assert result == "rec1"
    assert calls["post"] == 0


def test_upsert_txt_creates_when_absent():
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"success": True, "result": []})
        body = request.read().decode()
        assert "google-site-verification=TOKEN" in body
        return httpx.Response(200, json={"success": True, "result": {"id": "rec2"}})

    result = cloudflare.upsert_txt(
        _client(handler), "zone123", "example.com", "google-site-verification=TOKEN"
    )
    assert result == "rec2"


def test_api_error_raises():
    def handler(request):
        return httpx.Response(403, json={"success": False, "errors": [{"message": "bad token"}]})

    with pytest.raises(cloudflare.CloudflareError):
        cloudflare.zone_id(_client(handler), "example.com")
