from datetime import datetime, timedelta
from .config import Topic, Settings
from . import store


def _parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def select_image(conn, topic: Topic, site: str, slug: str, settings: Settings, now: str):
    now_dt = _parse(now)
    global_days = topic.reuse_global_days or settings.reuse_global_days
    same_site_cut = (now_dt - timedelta(days=settings.reuse_same_site_days)).isoformat()
    recent_site = {a["image_id"] for a in store.site_recent_assignments(conn, site, same_site_cut)}
    for img in store.pool_for_topic(conn, topic.id):  # ordered by score asc
        assigns = store.assignments_for_image(conn, img["id"])
        if not assigns:
            return img  # never used → best eligible
        last = max(_parse(a["assigned_at"]) for a in assigns)
        if (now_dt - last) < timedelta(days=global_days):
            continue  # too soon globally
        if img["id"] in recent_site:
            continue  # this site used it recently
        if any(a["slug"] == slug for a in assigns):
            continue
        return img
    return None
