"""Tests for amz_stats.api — uses respx to mock HTTP."""
from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import pytest
import respx

from amz_stats.api import AMZClient, AMZError, DEFAULT_RESOURCES, TOKEN_URL, API_BASE


TOKEN_RESPONSE = {
    "access_token": "test-bearer-token",
    "token_type": "bearer",
    "expires_in": 3600,
}

ITEMS_RESPONSE = {
    "itemsResult": {
        "items": [
            {"asin": "B001234567", "itemInfo": {"title": {"displayValue": "Widget A"}}},
            {"asin": "B007654321", "itemInfo": {"title": {"displayValue": "Widget B"}}},
        ]
    }
}


@pytest.fixture
def cache_file(tmp_path: Path) -> Path:
    return tmp_path / "out" / ".token_cache.json"


@pytest.fixture
def client(cache_file: Path) -> AMZClient:
    return AMZClient(
        key_id="test-key",
        key_secret="test-secret",
        store_id="mystore-20",
        cache_file=cache_file,
    )


@respx.mock
def test_token_cached_between_calls(client: AMZClient, cache_file: Path):
    token_route = respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))
    items_route = respx.post(f"{API_BASE}/catalog/v1/getItems").mock(
        return_value=httpx.Response(200, json=ITEMS_RESPONSE)
    )

    with client:
        client.get_items(["B001234567"])
        assert token_route.call_count == 1
        assert cache_file.exists(), "Cache file should be written after first token fetch"

        data = json.loads(cache_file.read_text())
        assert data["token"] == "test-bearer-token"
        assert data["expires_at"] > time.time()

        client.get_items(["B007654321"])
        assert token_route.call_count == 1, "Token should NOT be re-fetched on second call"

    assert items_route.call_count == 2


@respx.mock
def test_get_items_returns_items(client: AMZClient):
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))
    respx.post(f"{API_BASE}/catalog/v1/getItems").mock(
        return_value=httpx.Response(200, json=ITEMS_RESPONSE)
    )

    with client:
        result = client.get_items(["B001234567", "B007654321"])

    items = result["itemsResult"]["items"]
    assert len(items) == 2
    assert items[0]["asin"] == "B001234567"
    assert items[1]["asin"] == "B007654321"


@respx.mock
def test_get_items_sends_correct_body(client: AMZClient):
    """Verify the request body includes partnerTag, marketplace, resources, and itemIds."""
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))

    captured: list[httpx.Request] = []

    def capture(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json=ITEMS_RESPONSE)

    respx.post(f"{API_BASE}/catalog/v1/getItems").mock(side_effect=capture)

    asins = ["B001234567", "B007654321"]
    with client:
        client.get_items(asins)

    assert len(captured) == 1
    body = json.loads(captured[0].content)
    assert body["itemIds"] == asins
    assert body["partnerTag"] == "mystore-20"
    assert body["marketplace"] == "www.amazon.com"
    assert body["resources"] == DEFAULT_RESOURCES


@respx.mock
def test_429_retried_then_succeeds(client: AMZClient, monkeypatch):
    monkeypatch.setattr("amz_stats.api.time.sleep", lambda _: None)

    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))

    call_count = 0

    def rate_limit_then_ok(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            return httpx.Response(429, json={"message": "Too Many Requests"})
        return httpx.Response(200, json=ITEMS_RESPONSE)

    respx.post(f"{API_BASE}/catalog/v1/getItems").mock(side_effect=rate_limit_then_ok)

    with client:
        result = client.get_items(["B001234567"])

    assert call_count == 3
    assert "itemsResult" in result


@respx.mock
def test_4xx_raises_amzerror(client: AMZClient):
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))
    respx.post(f"{API_BASE}/catalog/v1/getItems").mock(
        return_value=httpx.Response(400, json={"message": "Invalid ASIN"})
    )

    with client:
        with pytest.raises(AMZError) as exc_info:
            client.get_items(["INVALID"])

    assert exc_info.value.status == 400
    assert "Invalid ASIN" in exc_info.value.message


@respx.mock
def test_token_fetch_failure_raises_amzerror(client: AMZClient):
    """Token endpoint returning 401 should raise AMZError before any items call."""
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(401, text="Unauthorized"))

    with client:
        with pytest.raises(AMZError) as exc_info:
            client.get_items(["B001234567"])

    assert exc_info.value.status == 401
