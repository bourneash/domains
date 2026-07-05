"""Framework-level tests for the shared HTTP layer in sources/__init__.py:
descriptive User-Agent on every request, and bounded 403/429 retry."""
import httpx
import pytest

from datahub_images.sources import USER_AGENT, _get_json


class _FakeResponse:
    def __init__(self, status_code, json_data=None):
        self.status_code = status_code
        self._json_data = json_data or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", "https://example.test/x")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError(
                f"status {self.status_code}", request=request, response=response
            )

    def json(self):
        return self._json_data


class _FakeClient:
    """Records headers seen; returns a queued sequence of responses."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def get(self, url, headers=None, timeout=20):
        self.calls.append({"url": url, "headers": headers or {}})
        return self._responses[len(self.calls) - 1]

    def close(self):
        pass


def test_get_json_sends_descriptive_user_agent():
    client = _FakeClient([_FakeResponse(200, {"ok": True})])
    out = _get_json("https://example.test/x", client=client)
    assert out == {"ok": True}
    assert len(client.calls) == 1
    sent_headers = client.calls[0]["headers"]
    assert sent_headers.get("User-Agent") == USER_AGENT
    assert not USER_AGENT.startswith("python-httpx")


def test_get_json_merges_user_agent_without_clobbering_caller_headers():
    client = _FakeClient([_FakeResponse(200, {"ok": True})])
    out = _get_json("https://example.test/x", client=client, headers={"X-Custom": "1"})
    assert out == {"ok": True}
    sent_headers = client.calls[0]["headers"]
    assert sent_headers.get("User-Agent") == USER_AGENT
    assert sent_headers.get("X-Custom") == "1"


def test_get_json_retries_on_403_then_succeeds(monkeypatch):
    sleeps = []
    monkeypatch.setattr("datahub_images.sources._sleep", lambda s: sleeps.append(s))
    client = _FakeClient([_FakeResponse(403), _FakeResponse(403), _FakeResponse(403), _FakeResponse(200, {"ok": True})])
    out = _get_json("https://example.test/x", client=client)
    assert out == {"ok": True}
    assert len(client.calls) == 4
    assert sleeps == [1, 2, 4]


def test_get_json_retries_on_429_then_succeeds(monkeypatch):
    sleeps = []
    monkeypatch.setattr("datahub_images.sources._sleep", lambda s: sleeps.append(s))
    client = _FakeClient([_FakeResponse(429), _FakeResponse(200, {"ok": True})])
    out = _get_json("https://example.test/x", client=client)
    assert out == {"ok": True}
    assert len(client.calls) == 2


def test_get_json_persistent_403_raises_after_bounded_retries(monkeypatch):
    sleeps = []
    monkeypatch.setattr("datahub_images.sources._sleep", lambda s: sleeps.append(s))
    client = _FakeClient([_FakeResponse(403), _FakeResponse(403), _FakeResponse(403), _FakeResponse(403)])
    with pytest.raises(httpx.HTTPStatusError):
        _get_json("https://example.test/x", client=client)
    # 1 initial attempt + 3 retries = 4 calls total, no more
    assert len(client.calls) == 4
    assert sleeps == [1, 2, 4]


def test_get_json_does_not_retry_on_other_error_status(monkeypatch):
    sleeps = []
    monkeypatch.setattr("datahub_images.sources._sleep", lambda s: sleeps.append(s))
    client = _FakeClient([_FakeResponse(500)])
    with pytest.raises(httpx.HTTPStatusError):
        _get_json("https://example.test/x", client=client)
    assert len(client.calls) == 1
    assert len(sleeps) == 0
