"""worker._maybe_notify: a once-a-day digest, not a per-tick alert.

Regression coverage for the Slack flood — every 15-min tick used to ping
Slack for any site with a nonzero draft queue, and a manual-approval queue
sits nonzero by design (see queue_ceiling in generator.py). That's a message
every tick, for every site, forever.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from social_hub import db, queue, worker


def _stub_notify(monkeypatch, calls):
    from social_hub import notify

    monkeypatch.setattr(notify, "post_message", lambda site, text, blocks=None: calls.append(site) or True)


def test_maybe_notify_is_silent_with_an_empty_queue(monkeypatch):
    calls: list[str] = []
    _stub_notify(monkeypatch, calls)
    worker._maybe_notify("alpha.com")
    assert calls == []


def test_maybe_notify_fires_once_then_suppresses_same_day(monkeypatch):
    calls: list[str] = []
    _stub_notify(monkeypatch, calls)
    queue.create_post(site="alpha.com", platform="fake", body="x", status="draft")

    worker._maybe_notify("alpha.com")
    worker._maybe_notify("alpha.com")
    worker._maybe_notify("alpha.com")

    assert len(calls) == 1, "a nonzero queue must not re-notify every tick"


def test_maybe_notify_fires_again_after_the_digest_window(monkeypatch):
    calls: list[str] = []
    _stub_notify(monkeypatch, calls)
    queue.create_post(site="alpha.com", platform="fake", body="x", status="draft")

    stale = datetime.now(timezone.utc) - timedelta(hours=worker.NOTIFY_DIGEST_INTERVAL_HOURS + 1)
    db.set_setting("notify_digest:alpha.com", stale.isoformat(timespec="seconds"))

    worker._maybe_notify("alpha.com")
    assert len(calls) == 1


def test_maybe_notify_is_per_site(monkeypatch):
    calls: list[str] = []
    _stub_notify(monkeypatch, calls)
    queue.create_post(site="alpha.com", platform="fake", body="x", status="draft")
    queue.create_post(site="beta.com", platform="fake", body="x", status="draft")

    worker._maybe_notify("alpha.com")
    worker._maybe_notify("beta.com")

    assert sorted(calls) == ["alpha.com", "beta.com"]
