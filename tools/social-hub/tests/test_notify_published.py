"""Slack notifications emitted after a public post is recorded as posted."""

from __future__ import annotations

import sys

from social_hub import db, notify, publisher, queue


def test_failure_notification_is_not_gated_by_quiet_mode(monkeypatch):
    calls: list[dict] = []
    monkeypatch.delenv("SLACK_VERBOSE", raising=False)
    monkeypatch.setattr(
        notify,
        "post_message",
        lambda site, text, blocks=None: calls.append(
            {"site": site, "text": text, "blocks": blocks}
        )
        or True,
    )

    notify.notify_failure("alpha.com", "fake", 42, "credential rejected")

    assert len(calls) == 1
    assert "failed" in calls[0]["text"]


def test_slack_notifications_disable_link_and_media_unfurls(monkeypatch):
    calls: list[dict] = []

    class Response:
        def json(self):
            return {"ok": True}

    class FakeHttpx:
        @staticmethod
        def post(url, **kwargs):
            calls.append({"url": url, **kwargs})
            return Response()

    monkeypatch.setitem(sys.modules, "httpx", FakeHttpx)
    monkeypatch.setenv("SLACK_BOT_TOKEN", "token")
    monkeypatch.setenv("SLACK_CHANNEL_ALPHA", "domain-alpha-com")
    monkeypatch.delenv("SOCIAL_HUB_NO_SLACK", raising=False)
    notify._env_loaded = False
    notify._fleet_env = {}

    assert notify.post_message("alpha.com", "hello", [{"type": "section"}]) is True

    payload = calls[0]["json"]
    assert payload["unfurl_links"] is False
    assert payload["unfurl_media"] is False


def test_successful_publish_links_platform_source_and_dashboard(synced, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(
        notify,
        "post_message",
        lambda site, text, blocks=None: calls.append(
            {"site": site, "text": text, "blocks": blocks}
        )
        or True,
    )
    post_id = queue.create_post(
        site="alpha.com",
        platform="fake",
        body="A public update <with markup>.",
        link="https://alpha.com/story",
        status="scheduled",
        scheduled_at=db.utcnow(),
    )

    result = publisher.publish_post(post_id)

    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0]["site"] == "alpha.com"
    assert "https://fake/1" in calls[0]["text"]
    message = calls[0]["blocks"][0]["text"]["text"]
    assert "<https://fake/1|View on Fake>" in message
    assert "<https://alpha.com/story|Open linked page>" in message
    assert "status=posted" in message and "site=alpha.com" in message
    assert "&lt;with markup&gt;" in message


def test_console_previews_and_replies_do_not_create_publish_alerts(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        notify,
        "post_message",
        lambda site, text, blocks=None: calls.append(text) or True,
    )

    assert notify.notify_published({"site": "alpha.com", "platform": "console"}) is False
    assert (
        notify.notify_published(
            {"site": "alpha.com", "platform": "bluesky", "kind": "reply"}
        )
        is False
    )
    assert calls == []
