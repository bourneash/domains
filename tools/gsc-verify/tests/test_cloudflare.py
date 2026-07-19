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


def test_cf_client_missing_token_raises(monkeypatch):
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    monkeypatch.delenv("CF_API_TOKEN", raising=False)

    with pytest.raises(cloudflare.CloudflareError) as excinfo:
        cloudflare.cf_client()

    message = str(excinfo.value)
    assert "Bearer" not in message
    assert "CLOUDFLARE_API_TOKEN" in message


def test_find_txt_matches_quote_wrapped_content():
    def handler(request):
        return httpx.Response(200, json={
            "success": True,
            "result": [{"id": "rec1", "content": '"google-site-verification=TOKEN"'}],
        })

    result = cloudflare.find_txt(
        _client(handler), "zone123", "example.com", "google-site-verification=TOKEN"
    )
    assert result == "rec1"


def test_find_txt_ignores_unrelated_neighbours_and_upsert_skips_post():
    calls = {"post": 0}

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={
                "success": True,
                "result": [
                    {"id": "rec-spf", "content": "v=spf1 include:_spf.example.com ~all"},
                    {"id": "rec-dkim", "content": "v=DKIM1; k=rsa; p=abc123"},
                    {"id": "rec-verify", "content": "google-site-verification=TOKEN"},
                ],
            })
        calls["post"] += 1
        return httpx.Response(200, json={"success": True, "result": {"id": "rec-new"}})

    found = cloudflare.find_txt(
        _client(handler), "zone123", "example.com", "google-site-verification=TOKEN"
    )
    assert found == "rec-verify"

    result = cloudflare.upsert_txt(
        _client(handler), "zone123", "example.com", "google-site-verification=TOKEN"
    )
    assert result == "rec-verify"
    assert calls["post"] == 0


def test_find_txt_paginates_across_multiple_pages():
    def handler(request):
        page = int(request.url.params.get("page", "1"))
        assert request.url.params["per_page"] == "100"
        if page == 1:
            return httpx.Response(200, json={
                "success": True,
                "result": [{"id": "rec-other", "content": "v=spf1 ~all"}],
                "result_info": {"page": 1, "per_page": 100, "total_pages": 2, "count": 1, "total_count": 2},
            })
        return httpx.Response(200, json={
            "success": True,
            "result": [{"id": "rec-target", "content": "google-site-verification=TOKEN"}],
            "result_info": {"page": 2, "per_page": 100, "total_pages": 2, "count": 1, "total_count": 2},
        })

    result = cloudflare.find_txt(
        _client(handler), "zone123", "example.com", "google-site-verification=TOKEN"
    )
    assert result == "rec-target"
