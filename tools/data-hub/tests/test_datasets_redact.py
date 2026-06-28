"""Tests: _get_json redacts secret query params from HTTP error messages."""
import httpx
import pytest
import datahub.datasets as ds


def test_get_json_redacts_api_key_on_http_error():
    """api_key value must not appear in the raised RuntimeError or its chain."""
    def handler(req):
        return httpx.Response(403, text="forbidden")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError) as exc_info:
        ds._get_json(
            "https://api.example.com/v1/data",
            proxy=None,
            params={"api_key": "SUPERSECRET", "series_id": "X"},
            client=client,
        )
    msg = str(exc_info.value)
    assert "SUPERSECRET" not in msg, f"Secret leaked in message: {msg!r}"
    assert "api_key=***" in msg, f"Expected redacted api_key in message: {msg!r}"
    # Chain must also be clean (from None suppresses it, but double-check)
    assert exc_info.value.__cause__ is None, "Exception chain should be suppressed (from None)"


def test_get_json_redacts_key_param_on_http_error():
    """bare 'key=' param (NASS style) value must be scrubbed."""
    def handler(req):
        return httpx.Response(401, text="unauthorized")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError) as exc_info:
        ds._get_json(
            "https://quickstats.nass.usda.gov/api/",
            proxy=None,
            params={"key": "NASSSECRET", "commodity_desc": "CORN"},
            client=client,
        )
    msg = str(exc_info.value)
    assert "NASSSECRET" not in msg, f"Secret leaked in message: {msg!r}"
    assert "key=***" in msg, f"Expected redacted key in message: {msg!r}"


def test_get_json_redacts_token_param_on_http_error():
    """'token=' value must be scrubbed."""
    def handler(req):
        return httpx.Response(500, text="server error")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError) as exc_info:
        ds._get_json(
            "https://api.example.com/data",
            proxy=None,
            params={"token": "TOKENSECRET", "param": "val"},
            client=client,
        )
    msg = str(exc_info.value)
    assert "TOKENSECRET" not in msg, f"Secret leaked in message: {msg!r}"
    assert "token=***" in msg, f"Expected redacted token in message: {msg!r}"


def test_redact_handles_multiple_params():
    """_redact must scrub api_key, key, and token in one pass."""
    raw = "?api_key=AAAA&series_id=X&key=BBBB&token=CCCC&other=ok"
    result = ds._redact(raw)
    assert "AAAA" not in result
    assert "BBBB" not in result
    assert "CCCC" not in result
    assert "other=ok" in result
    assert "api_key=***" in result
    assert "key=***" in result
    assert "token=***" in result


def test_redact_does_not_corrupt_api_key_into_api_star():
    """api_key= must be matched by the api_key branch, not partially by 'key'."""
    result = ds._redact("api_key=MYSECRET")
    assert result == "api_key=***", f"Unexpected redaction result: {result!r}"


def test_get_json_success_still_works():
    """Happy path: valid JSON response passes through unchanged."""
    def handler(req):
        return httpx.Response(200, json={"value": 42})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = ds._get_json(
        "https://api.example.com/data",
        proxy=None,
        params={"api_key": "SUPERSECRET"},
        client=client,
    )
    assert result == {"value": 42}
