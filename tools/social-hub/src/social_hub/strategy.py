"""Cheap strategy signals for writers; no model calls and no publishing."""

from __future__ import annotations

from datetime import timedelta

from social_hub import accounts, db, metrics
from social_hub.config import load_all, load_site_config
from social_hub.scheduler import now_utc, parse
from social_hub.platforms import capabilities


def report(site: str | None = None, days: int = 30) -> dict:
    configs = {site: load_site_config(site)} if site else load_all()
    configs = {name: cfg for name, cfg in configs.items() if cfg}
    per_site = {}
    for name, cfg in configs.items():
        rows = db.rows_to_dicts(
            db.query(
                "SELECT * FROM posts WHERE site = ? AND created_at >= ? ORDER BY id DESC",
                (name, (now_utc() - timedelta(days=days)).isoformat(timespec="seconds")),
            )
        )
        formats = {"link": 0, "native": 0, "visual": 0, "reply": 0}
        for post in rows:
            if post.get("kind") == "reply":
                formats["reply"] += 1
            elif post.get("media"):
                formats["visual"] += 1
            elif post.get("link"):
                formats["link"] += 1
            else:
                formats["native"] += 1
        channels = accounts.list_channels(site=name)
        inbox_health = []
        for channel in channels:
            if channel.get("enabled") and capabilities(channel["platform"]).mentions:
                last = parse(channel.get("last_polled_at"))
                inbox_health.append(
                    {
                        "platform": channel["platform"],
                        "last_polled_at": channel.get("last_polled_at"),
                        "healthy": bool(last and now_utc() - last < timedelta(hours=1)),
                    }
                )
        recommendations = []
        total_posts = sum(formats[k] for k in ("link", "native", "visual"))
        if total_posts and formats["link"] / total_posts > 0.8:
            recommendations.append("Add native questions, observations, or visual posts; the mix is over 80% links.")
        if not cfg.get("content_pillars"):
            recommendations.append("Define 3–5 content pillars and target weights in hub.yaml.")
        if not cfg.get("engagement.watch_accounts"):
            recommendations.append("Add a small engagement.watch_accounts list for deliberate relationship building.")
        if any(not item["healthy"] for item in inbox_health):
            recommendations.append("One or more mention-capable inboxes have not polled successfully within an hour.")
        per_site[name] = {
            "formats": formats,
            "pillars": cfg.get("content_pillars") or [],
            "engagement_targets": cfg.get("engagement.watch_accounts") or [],
            "inbox_health": inbox_health,
            "recommendations": recommendations,
        }

    evergreen = db.rows_to_dicts(
        db.query(
            "SELECT * FROM posts WHERE status = 'posted' AND kind = 'post' "
            "AND posted_at <= ? AND (COALESCE(likes,0)+COALESCE(reposts,0)+COALESCE(replies,0)) > 0 "
            + ("AND site = ? " if site else "")
            + "ORDER BY (COALESCE(likes,0)+COALESCE(reposts,0)+COALESCE(replies,0)) DESC LIMIT 25",
            ((now_utc() - timedelta(days=60)).isoformat(timespec="seconds"), site) if site
            else ((now_utc() - timedelta(days=60)).isoformat(timespec="seconds"),),
        )
    )
    return {"days": days, "sites": per_site, "performance": metrics.insights(site, days), "evergreen_candidates": evergreen}
