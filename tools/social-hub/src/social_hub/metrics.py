"""Engagement — what actually happened to the posts we sent.

Without this the hub is a one-way pipe: it can tell you what it published but
not whether any of it landed. Counts are refreshed on a decaying schedule —
a post is worth checking often on its first day and rarely after that, because
engagement on a news link is essentially over within 48 hours and every refresh
is an API call that competes with publishing for rate limit.

Deliberately shallow: likes, reposts, replies. No follower graphs, no
demographics, nothing needing an analytics-tier API. Enough to answer "which
copy worked" and to notice a channel that has gone silent.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from social_hub import accounts, db
from social_hub.platforms import AdapterError, capabilities, get_adapter
from social_hub.scheduler import now_utc, parse

#: (max age of the post, minimum interval between refreshes)
REFRESH_LADDER = [
    (timedelta(hours=6), timedelta(minutes=45)),
    (timedelta(days=1), timedelta(hours=3)),
    (timedelta(days=3), timedelta(hours=12)),
    (timedelta(days=14), timedelta(days=1)),
]
#: Older than the last rung and we stop refreshing entirely.
MAX_TRACKING_AGE = timedelta(days=14)


def due_for_refresh(post: dict, at: datetime | None = None) -> bool:
    posted = parse(post.get("posted_at"))
    if not posted or not post.get("remote_id"):
        return False
    moment = at or now_utc()
    age = moment - posted
    if age > MAX_TRACKING_AGE:
        return False
    interval = next((iv for limit, iv in REFRESH_LADDER if age <= limit), None)
    if interval is None:
        return False
    last = parse(post.get("metrics_at"))
    return last is None or moment - last >= interval


def refresh_site(site: str, limit: int = 50) -> dict:
    """Refresh engagement counts for one site's recent posts."""
    posts = db.rows_to_dicts(
        db.query(
            "SELECT * FROM posts WHERE site = ? AND status = 'posted' AND remote_id IS NOT NULL "
            "ORDER BY posted_at DESC LIMIT ?",
            (site, limit),
        )
    )
    wanted: dict[str, list[dict]] = {}
    for post in posts:
        if due_for_refresh(post):
            wanted.setdefault(post["platform"], []).append(post)

    updated = 0
    for platform, batch in wanted.items():
        if not capabilities(platform).metrics:
            continue
        channel = accounts.pick_channel(site, platform)
        if not channel:
            continue
        adapter = get_adapter(platform, accounts.read_channel_creds(channel))
        if adapter.missing_creds():
            continue
        try:
            counts = adapter.fetch_metrics([p["remote_id"] for p in batch])
        except AdapterError as exc:
            db.log_event("metrics.error", site=site, message=str(exc)[:300])
            continue
        stamp = db.utcnow()
        for post in batch:
            data = counts.get(post["remote_id"])
            if data is None:
                # The post is gone from the platform (deleted or hidden).
                # Stamp it anyway so it stops being retried every tick.
                db.update("posts", post["id"], {"metrics_at": stamp})
                continue
            db.update(
                "posts",
                post["id"],
                {
                    "likes": data.get("likes", 0),
                    "reposts": data.get("reposts", 0),
                    "replies": data.get("replies", 0),
                    "metrics_at": stamp,
                },
            )
            updated += 1

    return {"checked": sum(len(b) for b in wanted.values()), "updated": updated}


def engagement(post: dict) -> int:
    return int(post.get("likes") or 0) + int(post.get("reposts") or 0) + int(post.get("replies") or 0)


def top_posts(site: str | None = None, days: int = 30, limit: int = 10) -> list[dict]:
    since = (now_utc() - timedelta(days=days)).isoformat(timespec="seconds")
    sql = (
        "SELECT * FROM posts WHERE status = 'posted' AND posted_at >= ? "
        "AND metrics_at IS NOT NULL"
    )
    params: list = [since]
    if site:
        sql += " AND site = ?"
        params.append(site)
    rows = db.rows_to_dicts(db.query(sql, tuple(params)))
    rows.sort(key=engagement, reverse=True)
    return rows[:limit]


def summary(site: str | None = None, days: int = 30) -> dict:
    """Per-platform totals and averages — the "is any of this working" view."""
    since = (now_utc() - timedelta(days=days)).isoformat(timespec="seconds")
    sql = "SELECT * FROM posts WHERE status = 'posted' AND posted_at >= ?"
    params: list = [since]
    if site:
        sql += " AND site = ?"
        params.append(site)
    rows = db.rows_to_dicts(db.query(sql, tuple(params)))

    out: dict[str, dict] = {}
    for row in rows:
        bucket = out.setdefault(
            row["platform"],
            {"posts": 0, "likes": 0, "reposts": 0, "replies": 0, "impressions": 0,
             "clicks": 0, "conversions": 0, "measured": 0},
        )
        bucket["posts"] += 1
        if row.get("metrics_at"):
            bucket["measured"] += 1
            bucket["likes"] += int(row.get("likes") or 0)
            bucket["reposts"] += int(row.get("reposts") or 0)
            bucket["replies"] += int(row.get("replies") or 0)
            bucket["impressions"] += int(row.get("impressions") or 0)
            bucket["clicks"] += int(row.get("clicks") or 0)
            bucket["conversions"] += int(row.get("conversions") or 0)
    for bucket in out.values():
        measured = bucket["measured"] or 1
        total = bucket["likes"] + bucket["reposts"] + bucket["replies"]
        bucket["avg_engagement"] = round(total / measured, 2)
        bucket["ctr"] = round(100 * bucket["clicks"] / (bucket["impressions"] or 1), 2)
    return {"days": days, "platforms": out}


def insights(site: str | None = None, days: int = 30) -> dict:
    """Outcome rollup used by writers and the controller's learning loop."""
    since = (now_utc() - timedelta(days=days)).isoformat(timespec="seconds")
    sql = "SELECT * FROM posts WHERE status = 'posted' AND posted_at >= ?"
    params: list = [since]
    if site:
        sql += " AND site = ?"
        params.append(site)
    rows = db.rows_to_dicts(db.query(sql, tuple(params)))
    pillars: dict[str, dict] = {}
    models: dict[str, dict] = {}
    for row in rows:
        score = engagement(row)
        for buckets, key in ((pillars, row.get("content_pillar") or "unclassified"), (models, row.get("ai_model") or row.get("origin") or "unknown")):
            bucket = buckets.setdefault(key, {"posts": 0, "engagement": 0, "clicks": 0, "conversions": 0})
            bucket["posts"] += 1
            bucket["engagement"] += score
            bucket["clicks"] += int(row.get("clicks") or 0)
            bucket["conversions"] += int(row.get("conversions") or 0)
    for buckets in (pillars, models):
        for bucket in buckets.values():
            bucket["engagement_per_post"] = round(bucket["engagement"] / (bucket["posts"] or 1), 2)
    return {"days": days, "pillars": pillars, "models": models}
