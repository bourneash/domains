"""Slot allocation — deciding *when* a post goes out.

Everything here is UTC and deterministic: given the same queue and config, the
same slot comes out. That matters because the tick runs from cron and may run
twice; a scheduler that picked "now + jitter" would smear posts unpredictably
across runs.

Four constraints, applied in order:
  quiet hours     a UTC window the site never posts in
  daily cap       per platform, counting anything already posted or scheduled
  minimum gap     spacing between consecutive posts on the same channel
  preferred slots the times of day the site actually wants to post at

Plus a per-site stagger derived from the domain name ([[reference_cron_stagger_map]]
is the same idea for cron): twenty sites sharing a 12:20 slot would otherwise
fire simultaneously and look exactly like the bot network they are.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from social_hub import db
from social_hub.config import SiteConfig, load_site_config

LOOKAHEAD_DAYS = 14
LEAD_MINUTES = 2


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        stamp = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat(timespec="seconds")


def in_quiet_hours(dt: datetime, quiet: list[int] | None) -> bool:
    """quiet is [start_hour, end_hour) in UTC and may wrap midnight."""
    if not quiet or len(quiet) != 2:
        return False
    start, end = int(quiet[0]) % 24, int(quiet[1]) % 24
    hour = dt.astimezone(timezone.utc).hour
    if start == end:
        return False
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def _scheduled_times(site: str, platform: str) -> list[datetime]:
    rows = db.query(
        "SELECT scheduled_at, posted_at FROM posts WHERE site = ? AND platform = ? "
        "AND status IN ('scheduled','publishing','posted','approved')",
        (site, platform),
    )
    stamps = []
    for row in rows:
        stamp = parse(row["posted_at"] or row["scheduled_at"])
        if stamp:
            stamps.append(stamp)
    return sorted(stamps)


def day_count(site: str, platform: str, day: datetime, taken: list[datetime]) -> int:
    target = day.astimezone(timezone.utc).date()
    return sum(1 for t in taken if t.astimezone(timezone.utc).date() == target)


def candidate_times(cfg: SiteConfig, start: datetime) -> list[datetime]:
    slots = cfg.get("cadence.slots") or ["12:20"]
    offset = timedelta(minutes=cfg.stagger_minutes)
    out: list[datetime] = []
    day = start.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    for delta in range(LOOKAHEAD_DAYS):
        base = day + timedelta(days=delta)
        for slot in slots:
            try:
                hour, minute = (int(x) for x in str(slot).split(":"))
            except ValueError:
                continue
            out.append(base.replace(hour=hour % 24, minute=minute % 60) + offset)
    return sorted(out)


def next_slot(
    site: str,
    platform: str,
    cfg: SiteConfig | None = None,
    *,
    after: datetime | None = None,
) -> str:
    """The next free, legal send time for (site, platform), as an ISO string."""
    cfg = (cfg or load_site_config(site) or SiteConfig(site, {})).for_platform(platform)
    start = (after or now_utc()) + timedelta(minutes=LEAD_MINUTES)
    taken = _scheduled_times(site, platform)
    cap = int(cfg.get("cadence.per_platform_per_day", 3))
    gap = timedelta(minutes=int(cfg.get("cadence.min_gap_minutes", 90)))
    quiet = cfg.get("cadence.quiet_hours")

    for candidate in candidate_times(cfg, start):
        if candidate < start:
            continue
        if in_quiet_hours(candidate, quiet):
            continue
        if day_count(site, platform, candidate, taken) >= cap:
            continue
        if any(abs((candidate - t).total_seconds()) < gap.total_seconds() for t in taken):
            continue
        return iso(candidate)

    # Queue is saturated for the whole lookahead — park it just past the last
    # scheduled item rather than dropping it on the floor.
    tail = (taken[-1] if taken else start) + gap
    return iso(max(tail, start))


def due_posts(limit: int = 25, *, at: datetime | None = None) -> list[dict]:
    moment = iso(at or now_utc())
    return db.rows_to_dicts(
        db.query(
            "SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? "
            "ORDER BY scheduled_at ASC LIMIT ?",
            (moment, limit),
        )
    )


def upcoming(site: str | None = None, days: int = 7, limit: int = 200) -> list[dict]:
    horizon = iso(now_utc() + timedelta(days=days))
    sql = (
        "SELECT * FROM posts WHERE status IN ('scheduled','approved','publishing') "
        "AND scheduled_at <= ?"
    )
    params: list = [horizon]
    if site:
        sql += " AND site = ?"
        params.append(site)
    sql += " ORDER BY scheduled_at ASC LIMIT ?"
    params.append(limit)
    return db.rows_to_dicts(db.query(sql, tuple(params)))


def replies_today(site: str) -> int:
    today = now_utc().date().isoformat()
    row = db.one(
        "SELECT COUNT(*) AS n FROM posts WHERE site = ? AND kind = 'reply' "
        "AND status IN ('scheduled','publishing','posted') "
        "AND COALESCE(posted_at, scheduled_at) >= ?",
        (site, today),
    )
    return int(row["n"]) if row else 0
