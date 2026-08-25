"""Engagement refresh cadence and reporting."""

from __future__ import annotations

from datetime import timedelta

from social_hub import db, metrics, queue
from social_hub.scheduler import iso, now_utc


def _posted(site="alpha.com", platform="fake", remote="r1", age_hours=1, metrics_age=None, **counts):
    post_id = queue.create_post(site=site, platform=platform, body="published copy", status="draft")
    db.update(
        "posts",
        post_id,
        {
            "status": "posted",
            "remote_id": remote,
            "remote_url": f"https://fake/{remote}",
            "posted_at": iso(now_utc() - timedelta(hours=age_hours)),
            "metrics_at": None if metrics_age is None else iso(now_utc() - timedelta(hours=metrics_age)),
            **counts,
        },
    )
    return queue.get(post_id)


def test_fresh_posts_are_checked_often_and_old_ones_rarely():
    brand_new = _posted(age_hours=1, metrics_age=1)      # 45-min cadence -> due
    settled = _posted(remote="r2", age_hours=48, metrics_age=1)  # 12h cadence -> not due
    ancient = _posted(remote="r3", age_hours=24 * 40)    # past tracking window

    assert metrics.due_for_refresh(brand_new) is True
    assert metrics.due_for_refresh(settled) is False
    assert metrics.due_for_refresh(ancient) is False


def test_a_post_with_no_remote_id_is_never_checked():
    post_id = queue.create_post(site="alpha.com", platform="fake", body="x", status="draft")
    db.update("posts", post_id, {"status": "posted", "posted_at": iso(now_utc())})
    assert metrics.due_for_refresh(queue.get(post_id)) is False


def test_refresh_stores_counts_from_the_adapter(synced, monkeypatch):
    post = _posted(remote="rA")
    monkeypatch.setattr(
        synced, "fetch_metrics",
        lambda self=None, remote_ids=None, **kw: {"rA": {"likes": 7, "reposts": 2, "replies": 1}},
        raising=False,
    )
    result = metrics.refresh_site("alpha.com")
    assert result["updated"] == 1

    refreshed = queue.get(post["id"])
    assert (refreshed["likes"], refreshed["reposts"], refreshed["replies"]) == (7, 2, 1)
    assert refreshed["metrics_at"]


def test_a_deleted_post_is_stamped_so_it_stops_being_retried(synced, monkeypatch):
    post = _posted(remote="gone")
    monkeypatch.setattr(synced, "fetch_metrics", lambda *a, **k: {}, raising=False)
    metrics.refresh_site("alpha.com")

    refreshed = queue.get(post["id"])
    assert refreshed["metrics_at"] and refreshed["likes"] is None
    assert metrics.due_for_refresh(refreshed) is False


def test_summary_and_top_posts_rank_by_total_engagement():
    _posted(remote="low", metrics_age=0, likes=1, reposts=0, replies=0)
    _posted(remote="high", metrics_age=0, likes=5, reposts=3, replies=2)

    top = metrics.top_posts("alpha.com", days=30, limit=5)
    assert metrics.engagement(top[0]) == 10

    summary = metrics.summary("alpha.com", days=30)["platforms"]["fake"]
    assert summary["posts"] == 2 and summary["measured"] == 2
    assert summary["avg_engagement"] == 5.5


def test_metrics_are_skipped_for_platforms_that_cannot_report(synced, monkeypatch):
    from social_hub.platforms import Capabilities

    monkeypatch.setattr(synced, "caps", Capabilities(publish=True, metrics=False))
    _posted(remote="rB")
    assert metrics.refresh_site("alpha.com")["updated"] == 0
