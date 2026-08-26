"""Slot allocation rules: quiet hours, daily caps, spacing, stagger."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from social_hub import db, queue, scheduler
from social_hub.config import SiteConfig, load_site_config


def at(hour: int, minute: int = 0, day_offset: int = 0) -> datetime:
    base = datetime.now(timezone.utc).replace(hour=hour, minute=minute, second=0, microsecond=0)
    return base + timedelta(days=day_offset)


def test_quiet_hours_wrap_midnight():
    quiet = [22, 6]
    assert scheduler.in_quiet_hours(at(23), quiet) is True
    assert scheduler.in_quiet_hours(at(2), quiet) is True
    assert scheduler.in_quiet_hours(at(6), quiet) is False
    assert scheduler.in_quiet_hours(at(12), quiet) is False


def test_next_slot_avoids_quiet_hours():
    cfg = SiteConfig("alpha.com", {"cadence": {"slots": ["04:00", "13:00"], "quiet_hours": [3, 5],
                                               "per_platform_per_day": 5, "min_gap_minutes": 10,
                                               "stagger": False}})
    chosen = scheduler.parse(scheduler.next_slot("alpha.com", "fake", cfg, after=at(0)))
    assert chosen.hour == 13, "the 04:00 slot is inside the quiet window"


def test_next_slot_respects_the_daily_cap(synced):
    cfg = load_site_config("alpha.com")  # cap 2/day, slots 06/12/18
    today = at(0)
    for hour in (6, 12):
        queue.create_post(
            site="alpha.com", platform="fake", body="already scheduled", status="scheduled",
            scheduled_at=scheduler.iso(today.replace(hour=hour) + timedelta(minutes=cfg.stagger_minutes)),
        )
    chosen = scheduler.parse(scheduler.next_slot("alpha.com", "fake", cfg, after=today))
    assert chosen.date() > today.date(), "day is full — must roll to tomorrow"


def test_next_slot_respects_minimum_gap():
    cfg = SiteConfig("alpha.com", {"cadence": {"slots": ["10:00", "10:30", "14:00"],
                                               "per_platform_per_day": 9, "min_gap_minutes": 120,
                                               "quiet_hours": [], "stagger": False}})
    queue.create_post(site="alpha.com", platform="fake", body="x", status="scheduled",
                      scheduled_at=scheduler.iso(at(10)))
    chosen = scheduler.parse(scheduler.next_slot("alpha.com", "fake", cfg, after=at(9)))
    assert chosen.hour == 14, "10:30 is inside the 2h gap from the 10:00 post"


def test_stagger_is_deterministic_and_differs_per_site():
    alpha = SiteConfig("alpha.com", {}).stagger_minutes
    beta = SiteConfig("beta.com", {}).stagger_minutes
    assert alpha == SiteConfig("alpha.com", {}).stagger_minutes
    assert 0 <= alpha < 30 and 0 <= beta < 30
    assert alpha != beta


def test_due_posts_only_returns_scheduled_and_past_due(synced):
    past = queue.create_post(site="alpha.com", platform="fake", body="due", status="scheduled",
                             scheduled_at=scheduler.iso(scheduler.now_utc() - timedelta(minutes=1)))
    future = queue.create_post(site="alpha.com", platform="fake", body="later", status="scheduled",
                               scheduled_at=scheduler.iso(scheduler.now_utc() + timedelta(hours=2)))
    draft = queue.create_post(site="alpha.com", platform="fake", body="draft", status="draft")

    ids = {p["id"] for p in scheduler.due_posts()}
    assert past in ids and future not in ids and draft not in ids


def test_immediate_skips_fixed_slots():
    """Breaking-news sites (cadence.immediate) post as soon as cap/gap/quiet
    hours allow, not on the next fixed calendar slot."""
    cfg = SiteConfig("alpha.com", {"cadence": {"slots": ["23:59"], "per_platform_per_day": 9,
                                               "min_gap_minutes": 10, "quiet_hours": [],
                                               "stagger": False, "immediate": True}})
    chosen = scheduler.parse(scheduler.next_slot("alpha.com", "fake", cfg, after=at(9)))
    assert chosen.hour == 9, "immediate mode must not wait for the 23:59 slot"


def test_immediate_still_respects_quiet_hours_and_gap():
    cfg = SiteConfig("alpha.com", {"cadence": {"slots": ["12:00"], "per_platform_per_day": 9,
                                               "min_gap_minutes": 30, "quiet_hours": [9, 11],
                                               "stagger": False, "immediate": True}})
    chosen = scheduler.parse(scheduler.next_slot("alpha.com", "fake", cfg, after=at(9)))
    assert chosen.hour == 11, "immediate mode still may not land inside quiet hours"


def test_saturated_queue_still_gets_a_slot():
    """With every lookahead slot taken, a post must still be placed rather than
    dropped."""
    cfg = SiteConfig("alpha.com", {"cadence": {"slots": ["10:00"], "per_platform_per_day": 1,
                                               "min_gap_minutes": 60, "quiet_hours": [],
                                               "stagger": False}})
    for day in range(scheduler.LOOKAHEAD_DAYS + 1):
        queue.create_post(site="alpha.com", platform="fake", body="x", status="scheduled",
                          scheduled_at=scheduler.iso(at(10, day_offset=day)))
    chosen = scheduler.next_slot("alpha.com", "fake", cfg)
    assert scheduler.parse(chosen) is not None
