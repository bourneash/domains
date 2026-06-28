import pytest
import respx
import httpx
from social_lib.email_client import EmailClient


MAILBOX = "jessetamburino@hotmail.com"
API = "http://localhost:9200"


@respx.mock
def test_wait_for_message_returns_message():
    respx.post(f"{API}/mailbox/{MAILBOX}/wait").mock(
        return_value=httpx.Response(200, json={"message": {"id": 1, "body_text": "Your code is 123456", "to": "jane@test.com"}})
    )
    client = EmailClient(MAILBOX)
    msg = client.wait_for_message("jane@test.com", timeout=5)
    assert msg["body_text"] == "Your code is 123456"


@respx.mock
def test_wait_for_message_sends_correct_payload():
    route = respx.post(f"{API}/mailbox/{MAILBOX}/wait").mock(
        return_value=httpx.Response(200, json={"message": {"id": 1, "to": "jane@test.com", "body_text": "code"}})
    )
    client = EmailClient(MAILBOX)
    client.wait_for_message("jane@test.com", subject_contains="verify", timeout=30)
    sent = route.calls[0].request
    import json
    body = json.loads(sent.content)
    assert body["match"]["to"] == "jane@test.com"
    assert body["match"]["subject"] == "verify"
    assert body["timeout_seconds"] == 30


@respx.mock
def test_wait_for_message_raises_on_error():
    respx.post(f"{API}/mailbox/{MAILBOX}/wait").mock(
        return_value=httpx.Response(504, json={"detail": "timeout"})
    )
    client = EmailClient(MAILBOX)
    with pytest.raises(httpx.HTTPStatusError):
        client.wait_for_message("jane@test.com", timeout=1)


@respx.mock
def test_api_key_sent_as_header():
    route = respx.post(f"{API}/mailbox/{MAILBOX}/wait").mock(
        return_value=httpx.Response(200, json={"message": {"id": 1, "to": "x@y.com", "body_text": ""}})
    )
    client = EmailClient(MAILBOX, api_key="secret-key")
    client.wait_for_message("x@y.com", timeout=5)
    assert route.calls[0].request.headers["x-api-key"] == "secret-key"


@respx.mock
def test_ensure_alias_creates_when_absent():
    CF_TOKEN = "tok"
    CF_ZONE = "zone123"
    domain = "example.com"
    local_part = "hello"

    respx.get(f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE}/email/routing/rules").mock(
        return_value=httpx.Response(200, json={"result": []})
    )
    respx.post(f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE}/email/routing/rules").mock(
        return_value=httpx.Response(200, json={"result": {"id": "new-rule"}})
    )
    client = EmailClient(MAILBOX)
    result = client.ensure_alias(domain, local_part, CF_TOKEN, CF_ZONE)
    assert result is True


@respx.mock
def test_ensure_alias_returns_false_when_exists():
    CF_TOKEN = "tok"
    CF_ZONE = "zone123"
    domain = "example.com"
    local_part = "hello"
    address = f"{local_part}@{domain}"

    respx.get(f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE}/email/routing/rules").mock(
        return_value=httpx.Response(200, json={
            "result": [
                {"matchers": [{"field": "to", "type": "literal", "value": address}]}
            ]
        })
    )
    client = EmailClient(MAILBOX)
    result = client.ensure_alias(domain, local_part, CF_TOKEN, CF_ZONE)
    assert result is False
