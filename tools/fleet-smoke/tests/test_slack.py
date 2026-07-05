from lib.slack import format_message, post_message


def test_format_message_healthy():
    results = [
        {"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True},
        {"label": "Sitemap", "path": "/sitemap-index.xml", "expect": 200, "actual": "200", "ok": True},
    ]
    msg = format_message("xxxtea.com", results, ":white_check_mark:", "healthy")

    assert msg.startswith(":white_check_mark: *xxxtea.com is healthy — 2/2 checks green*")
    assert "• Homepage (`/`) — 200 👍" in msg
    assert "• Sitemap (`/sitemap-index.xml`) — 200 👍" in msg


def test_format_message_attention_marks_failures():
    results = [
        {"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True},
        {"label": "Redirect", "path": "/go/x", "expect": 302, "actual": "503", "ok": False},
    ]
    msg = format_message("xxxtea.com", results, ":sos:", "attention")

    assert "needs attention — 1/2 check(s) failing" in msg
    assert "• Redirect (`/go/x`) — 503 ⚠️" in msg


def test_format_message_recovered_headline():
    results = [{"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True}]
    msg = format_message("xxxtea.com", results, ":wrench:", "recovered")

    assert "recovered — 1/1 checks green" in msg


def test_post_message_returns_false_without_token():
    assert post_message("chan", "text", "good", token="") is False


def test_post_message_builds_expected_payload():
    captured = {}

    def fake_post_fn(payload, token):
        captured["payload"] = payload
        captured["token"] = token
        return True

    ok = post_message("domain-xxxtea-com", "hello", "good", token="xoxb-fake", post_fn=fake_post_fn)

    assert ok is True
    assert captured["token"] == "xoxb-fake"
    import json
    body = json.loads(captured["payload"])
    assert body["channel"] == "domain-xxxtea-com"
    assert body["attachments"][0]["color"] == "good"
    assert body["attachments"][0]["text"] == "hello"
