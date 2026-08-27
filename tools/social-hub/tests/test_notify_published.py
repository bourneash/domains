"""Slack notifications emitted after a public post is recorded as posted."""

from __future__ import annotations

from social_hub import db, notify, publisher, queue


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
