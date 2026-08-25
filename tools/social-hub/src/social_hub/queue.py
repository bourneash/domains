"""The content queue — every post's lifecycle in one place.

    draft ──approve──> approved ──schedule──> scheduled ──tick──> posted
      │                                           │
      └──reject──> rejected                       └──fail(n)──> failed

`draft` is the human-review state: nothing leaves it without an explicit
approve, unless the site's config says `approval: auto`, in which case drafts
are born approved. That switch is per-site and per-platform, so a site can let
Bluesky run itself while still hand-checking anything going to X.

Edits are allowed in any pre-publish state and are always recorded as events —
"who changed the copy after the model wrote it" is exactly the question you
want answered when a post reads oddly three weeks later.
"""

from __future__ import annotations

import json
from typing import Any

from social_hub import db
from social_hub.config import SiteConfig

OPEN_STATUSES = ("draft", "approved", "scheduled")
TERMINAL_STATUSES = ("posted", "rejected", "cancelled")
MAX_ATTEMPTS = 4


def create_post(
    *,
    site: str,
    platform: str,
    body: str,
    link: str = "",
    channel_id: int | None = None,
    kind: str = "post",
    source_type: str | None = None,
    source_id: str | None = None,
    mention_id: int | None = None,
    reply_to_remote_id: str = "",
    media: list[str] | None = None,
    origin: str = "ai",
    ai_model: str | None = None,
    status: str = "draft",
    scheduled_at: str | None = None,
) -> int:
    now = db.utcnow()
    post_id = db.insert(
        "posts",
        {
            "site": site,
            "platform": platform,
            "channel_id": channel_id,
            "kind": kind,
            "status": status,
            "body": body,
            "link": link,
            "media": json.dumps(media or []),
            "source_type": source_type,
            "source_id": source_id,
            "mention_id": mention_id,
            "reply_to_remote_id": reply_to_remote_id,
            "scheduled_at": scheduled_at,
            "origin": origin,
            "ai_model": ai_model,
            "created_at": now,
            "updated_at": now,
        },
    )
    db.log_event(
        "post.created",
        site=site,
        ref_type="post",
        ref_id=post_id,
        message=f"{platform} {kind} ({origin})",
    )
    return post_id


def get(post_id: int) -> dict | None:
    return db.row_to_dict(db.one("SELECT * FROM posts WHERE id = ?", (post_id,)))


def list_posts(
    *,
    site: str | None = None,
    platform: str | None = None,
    status: str | list[str] | None = None,
    kind: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    sql = "SELECT * FROM posts WHERE 1=1"
    params: list[Any] = []
    if site:
        sql += " AND site = ?"
        params.append(site)
    if platform:
        sql += " AND platform = ?"
        params.append(platform)
    if kind:
        sql += " AND kind = ?"
        params.append(kind)
    if status:
        statuses = [status] if isinstance(status, str) else list(status)
        sql += " AND status IN (%s)" % ",".join("?" * len(statuses))
        params.extend(statuses)
    sql += (
        " ORDER BY COALESCE(scheduled_at, created_at) ASC, id ASC LIMIT ? OFFSET ?"
    )
    params.extend([limit, offset])
    return db.rows_to_dicts(db.query(sql, tuple(params)))


def counts_by_status(site: str | None = None) -> dict[str, int]:
    sql = "SELECT status, COUNT(*) AS n FROM posts"
    params: tuple = ()
    if site:
        sql += " WHERE site = ?"
        params = (site,)
    sql += " GROUP BY status"
    return {r["status"]: r["n"] for r in db.query(sql, params)}


def edit(post_id: int, *, body: str | None = None, link: str | None = None,
         scheduled_at: str | None = None, editor: str = "human") -> dict | None:
    post = get(post_id)
    if not post:
        return None
    if post["status"] in TERMINAL_STATUSES or post["status"] == "publishing":
        raise ValueError(f"cannot edit a post in status '{post['status']}'")
    payload: dict[str, Any] = {}
    if body is not None and body != post["body"]:
        payload["body"] = body
    if link is not None:
        payload["link"] = link
    if scheduled_at is not None:
        payload["scheduled_at"] = scheduled_at
        if post["status"] == "approved":
            payload["status"] = "scheduled"
    if not payload:
        return post
    payload["origin"] = "human" if "body" in payload else post["origin"]
    db.update("posts", post_id, payload)
    db.log_event(
        "post.edited",
        site=post["site"],
        ref_type="post",
        ref_id=post_id,
        message=f"edited by {editor}",
        data={"fields": sorted(payload), "before": post["body"] if "body" in payload else None},
    )
    return get(post_id)


def approve(post_id: int, *, by: str = "human", cfg: SiteConfig | None = None) -> dict | None:
    """Approve and immediately place the post on the calendar."""
    from social_hub import scheduler

    post = get(post_id)
    if not post:
        return None
    if post["status"] not in ("draft", "rejected", "failed"):
        return post
    when = post["scheduled_at"] or scheduler.next_slot(post["site"], post["platform"], cfg)
    db.update(
        "posts",
        post_id,
        {
            "status": "scheduled",
            "approved_by": by,
            "approved_at": db.utcnow(),
            "scheduled_at": when,
            "error": None,
            "attempts": 0,
        },
    )
    db.log_event(
        "post.approved",
        site=post["site"],
        ref_type="post",
        ref_id=post_id,
        message=f"approved by {by} for {when}",
    )
    return get(post_id)


def reject(post_id: int, *, by: str = "human", reason: str = "") -> dict | None:
    post = get(post_id)
    if not post:
        return None
    db.update("posts", post_id, {"status": "rejected", "error": reason or None, "approved_by": by})
    if post.get("source_id"):
        _release_source(post)
    db.log_event(
        "post.rejected",
        site=post["site"],
        ref_type="post",
        ref_id=post_id,
        message=reason or f"rejected by {by}",
    )
    return get(post_id)


def cancel(post_id: int, *, by: str = "human") -> dict | None:
    post = get(post_id)
    if not post:
        return None
    if post["status"] in TERMINAL_STATUSES:
        return post
    db.update("posts", post_id, {"status": "cancelled", "approved_by": by})
    db.log_event("post.cancelled", site=post["site"], ref_type="post", ref_id=post_id)
    return get(post_id)


def _release_source(post: dict) -> None:
    """If no open post remains for a source, put it back in play so a future
    run can draft it again — otherwise rejecting the only draft would silently
    retire the article."""
    remaining = db.one(
        "SELECT COUNT(*) AS n FROM posts WHERE site = ? AND source_id = ? "
        "AND status IN ('draft','approved','scheduled','publishing','posted')",
        (post["site"], post["source_id"]),
    )
    if remaining and remaining["n"] == 0:
        db.execute(
            "UPDATE sources SET state = 'new' WHERE site = ? AND source_id = ?",
            (post["site"], post["source_id"]),
        )


def mark_publishing(post_id: int) -> bool:
    """Claim a post for publishing. Returns False if another worker got it —
    this is the concurrency guard that keeps a slow tick overlapping the next
    one from double-posting."""
    cur = db.execute(
        "UPDATE posts SET status = 'publishing', updated_at = ? "
        "WHERE id = ? AND status = 'scheduled'",
        (db.utcnow(), post_id),
    )
    return cur.rowcount == 1


def mark_posted(post_id: int, remote_id: str, remote_url: str) -> dict | None:
    post = get(post_id)
    if not post:
        return None
    db.update(
        "posts",
        post_id,
        {
            "status": "posted",
            "posted_at": db.utcnow(),
            "remote_id": remote_id,
            "remote_url": remote_url,
            "error": None,
        },
    )
    if post.get("channel_id"):
        db.update("channels", post["channel_id"], {"last_posted_at": db.utcnow()})
    db.log_event(
        "post.published",
        site=post["site"],
        ref_type="post",
        ref_id=post_id,
        message=remote_url or remote_id,
    )
    return get(post_id)


def mark_failed(post_id: int, error: str, *, retryable: bool = True) -> dict | None:
    """Back off and retry, or park the post as failed once it has burned its
    attempts. Retry delay grows 5/20/80 minutes so a flapping API doesn't get
    hammered and a genuinely broken post stops eating slots."""
    from datetime import datetime, timedelta, timezone

    post = get(post_id)
    if not post:
        return None
    attempts = int(post["attempts"]) + 1
    payload: dict[str, Any] = {"attempts": attempts, "error": error[:500]}
    if retryable and attempts < MAX_ATTEMPTS:
        delay = 5 * (4 ** (attempts - 1))
        payload["status"] = "scheduled"
        payload["scheduled_at"] = (
            datetime.now(timezone.utc) + timedelta(minutes=delay)
        ).isoformat(timespec="seconds")
    else:
        payload["status"] = "failed"
    db.update("posts", post_id, payload)
    db.log_event(
        "post.failed",
        site=post["site"],
        ref_type="post",
        ref_id=post_id,
        message=error[:300],
        data={"attempts": attempts, "status": payload["status"]},
    )
    return get(post_id)


def already_drafted(site: str, platform: str, source_id: str) -> bool:
    """Has this source already produced a post for this platform in any state
    that isn't a rejection? Keeps re-ingestion from duplicating the queue."""
    row = db.one(
        "SELECT 1 FROM posts WHERE site = ? AND platform = ? AND source_id = ? "
        "AND status NOT IN ('rejected','cancelled') LIMIT 1",
        (site, platform, source_id),
    )
    return row is not None
