"""HTTP API.

The API is the only product surface — social-hub ships no UI of its own. The
Fleet Dashboard's Social Hub tab (tools/fleet-dashboard/server/socialhub.js +
public/app.js) is the client, alongside cron jobs and skills. That's a
deliberate choice, not a gap: one control plane for the fleet, not two
differently-styled apps (see [[project_social_hub]] 2026-08-26 for why the
standalone UI was retired).

Security posture matches the rest of the fleet's local control planes: bind
loopback only, and require a bearer token when `SOCIAL_HUB_TOKEN` is set (so
the same service can safely sit behind a tunnel). Writes are POST/PATCH only —
no state-changing GETs — so a stray browser prefetch can't publish anything.
"""

from __future__ import annotations

import hmac
import os
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from social_hub import (
    accounts,
    db,
    engagement,
    generator,
    metrics,
    oversight,
    publisher,
    queue,
    scheduler,
    sources,
    strategy,
    worker,
)
from social_hub.config import load_all, load_site_config, managed_sites
from social_hub.platforms import capabilities, platform_names

app = FastAPI(title="Social Hub", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.middleware("http")
async def auth_guard(request: Request, call_next):
    token = os.environ.get("SOCIAL_HUB_TOKEN")
    if token and request.url.path.startswith("/api"):
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        # Header only. The old `?token=` fallback put a live credential in a
        # place that leaks by default — access logs, proxy logs, shell history,
        # and the Referer header of any outbound link. No caller ever used it.
        #
        # compare_digest rather than `!=` so the comparison does not return
        # early on the first wrong byte.
        if not hmac.compare_digest(supplied, token):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    response = await call_next(request)
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


# --------------------------------------------------------------------------
# meta
# --------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "db": str(db.db_path()), "sites": managed_sites()}


@app.get("/healthz")
def healthz() -> dict:
    """Container liveness endpoint; intentionally outside the bearer gate."""
    db.connect()
    return {"ok": True}


@app.get("/api/status")
def status(site: str | None = None) -> dict:
    return worker.status(site)


@app.get("/api/sites")
def list_sites() -> dict:
    out = []
    for name, cfg in load_all().items():
        out.append(
            {
                "site": name,
                "platforms": cfg.platforms,
                "approval": cfg.approval,
                "reply_enabled": bool(cfg.get("reply.enabled", True)),
                "slots": cfg.get("cadence.slots"),
                "stagger_minutes": cfg.stagger_minutes,
                "counts": queue.counts_by_status(name),
            }
        )
    return {"sites": out, "unmanaged_hint": "add ops/social/hub.yaml to opt a site in"}


@app.get("/api/platforms")
def list_platforms() -> dict:
    return {
        "platforms": [
            {"name": name, **vars(capabilities(name))} for name in platform_names()
        ]
    }


# --------------------------------------------------------------------------
# channels
# --------------------------------------------------------------------------
@app.get("/api/channels")
def get_channels(site: str | None = None, platform: str | None = None) -> dict:
    return {"channels": accounts.list_channels(site=site, platform=platform)}


@app.post("/api/channels/sync")
def sync_channels(payload: dict = Body(default={})) -> dict:
    sites = payload.get("sites")
    return accounts.sync_channels(sites)


@app.patch("/api/channels/{channel_id}")
def patch_channel(channel_id: int, payload: dict = Body(...)) -> dict:
    row = db.one("SELECT * FROM channels WHERE id = ?", (channel_id,))
    if not row:
        raise HTTPException(404, "channel not found")
    updates: dict[str, Any] = {}
    if "enabled" in payload:
        updates["enabled"] = 1 if payload["enabled"] else 0
    if "handle" in payload:
        updates["handle"] = str(payload["handle"])[:200]
    if "note" in payload:
        updates["note"] = str(payload["note"])[:400]
    db.update("channels", channel_id, updates)
    db.log_event(
        "channel.updated", site=row["site"], ref_type="channel", ref_id=channel_id,
        data=updates,
    )
    return db.row_to_dict(db.one("SELECT * FROM channels WHERE id = ?", (channel_id,))) or {}


@app.post("/api/channels/{channel_id}/verify")
def verify_channel(channel_id: int) -> dict:
    channel = db.row_to_dict(db.one("SELECT * FROM channels WHERE id = ?", (channel_id,)))
    if not channel:
        raise HTTPException(404, "channel not found")
    return accounts.verify_channel(channel)


# --------------------------------------------------------------------------
# sources
# --------------------------------------------------------------------------
@app.get("/api/sources")
def get_sources(site: str | None = None, state: str | None = None, limit: int = 100) -> dict:
    sql = "SELECT * FROM sources WHERE 1=1"
    params: list = []
    if site:
        sql += " AND site = ?"
        params.append(site)
    if state:
        sql += " AND state = ?"
        params.append(state)
    sql += " ORDER BY published_at DESC LIMIT ?"
    params.append(limit)
    return {"sources": db.rows_to_dicts(db.query(sql, tuple(params)))}


@app.post("/api/sources/ingest")
def ingest_sources(payload: dict = Body(default={})) -> dict:
    site = payload.get("site")
    targets = [site] if site else managed_sites()
    out = {}
    for name in targets:
        cfg = load_site_config(name)
        if cfg:
            out[name] = sources.ingest(name, cfg)
    return out


# --------------------------------------------------------------------------
# posts / queue
# --------------------------------------------------------------------------
@app.get("/api/posts")
def get_posts(
    site: str | None = None,
    platform: str | None = None,
    kind: str | None = None,
    status: str | None = Query(default=None, description="comma-separated"),
    limit: int = 200,
    offset: int = 0,
) -> dict:
    statuses = [s.strip() for s in status.split(",")] if status else None
    return {
        "posts": queue.list_posts(
            site=site, platform=platform, kind=kind, status=statuses, limit=limit, offset=offset
        )
    }


@app.get("/api/posts/{post_id}")
def get_post(post_id: int) -> dict:
    post = queue.get(post_id)
    if not post:
        raise HTTPException(404, "post not found")
    return post


@app.post("/api/posts")
def create_post(payload: dict = Body(...)) -> dict:
    site = payload.get("site")
    platform = payload.get("platform")
    if not site or not platform:
        raise HTTPException(400, "site and platform are required")
    try:
        return generator.compose(
            site,
            platform,
            body=payload.get("body", ""),
            link=payload.get("link", ""),
            source_id=payload.get("source_id"),
            schedule=bool(payload.get("schedule")),
            author=payload.get("author", "human"),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.patch("/api/posts/{post_id}")
def patch_post(post_id: int, payload: dict = Body(...)) -> dict:
    try:
        post = queue.edit(
            post_id,
            body=payload.get("body"),
            link=payload.get("link"),
            scheduled_at=payload.get("scheduled_at"),
            editor=payload.get("editor", "human"),
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if not post:
        raise HTTPException(404, "post not found")
    return post


@app.post("/api/posts/{post_id}/approve")
def approve_post(post_id: int, payload: dict = Body(default={})) -> dict:
    # Default attribution is the interface, never a person's name. Who approved
    # a post is an audit fact — an automated caller must not be able to leave a
    # human's name on it by omission.
    post = queue.approve(post_id, by=str(payload.get("by") or "ui"))
    if not post:
        raise HTTPException(404, "post not found")
    return post


@app.post("/api/posts/{post_id}/reject")
def reject_post(post_id: int, payload: dict = Body(default={})) -> dict:
    post = queue.quarantine(
        post_id,
        by=str(payload.get("by") or "ui"),
        category=str(payload.get("category") or "other"),
        reason=str(payload.get("reason") or "Needs an editorial rewrite."),
    )
    if not post:
        raise HTTPException(404, "post not found")
    return post


@app.post("/api/posts/{post_id}/cancel")
def cancel_post(post_id: int) -> dict:
    post = queue.cancel(post_id)
    if not post:
        raise HTTPException(404, "post not found")
    return post


@app.post("/api/posts/{post_id}/publish")
def publish_now(post_id: int) -> dict:
    """Send immediately, bypassing the schedule (still respects credentials
    and channel state). Used by the UI's "post now" action."""
    post = queue.get(post_id)
    if not post:
        raise HTTPException(404, "post not found")
    if post["status"] in ("draft", "approved", "failed"):
        db.update("posts", post_id, {"status": "scheduled", "scheduled_at": db.utcnow()})
    return publisher.publish_post(post_id)


@app.get("/api/calendar")
def calendar(site: str | None = None, days: int = 7) -> dict:
    return {"posts": scheduler.upcoming(site, days=days, limit=500)}


# --------------------------------------------------------------------------
# inbox / replies
# --------------------------------------------------------------------------
@app.get("/api/inbox")
def inbox(site: str | None = None, status: str | None = None, limit: int = 100) -> dict:
    statuses = [s.strip() for s in status.split(",")] if status else None
    mentions = engagement.list_mentions(site=site, status=statuses, limit=limit)
    for mention in mentions:
        if mention.get("reply_post_id"):
            mention["reply"] = queue.get(mention["reply_post_id"])
        else:
            draft = db.one(
                "SELECT * FROM posts WHERE mention_id = ? ORDER BY id DESC LIMIT 1",
                (mention["id"],),
            )
            mention["reply"] = db.row_to_dict(draft)
    return {"mentions": mentions}


@app.post("/api/inbox/poll")
def poll_inbox(payload: dict = Body(default={})) -> dict:
    site = payload.get("site")
    targets = [site] if site else managed_sites()
    return {name: engagement.poll_site(name) for name in targets}


@app.post("/api/inbox/{mention_id}/draft")
def draft_reply(mention_id: int) -> dict:
    mention = db.row_to_dict(db.one("SELECT * FROM mentions WHERE id = ?", (mention_id,)))
    if not mention:
        raise HTTPException(404, "mention not found")
    cfg = load_site_config(mention["site"])
    if not cfg:
        raise HTTPException(400, f"{mention['site']} is not managed by the hub")
    post_id = engagement.draft_reply_for(mention, cfg)
    if not post_id:
        return {"ok": False, "reason": "declined"}
    return {"ok": True, "post": queue.get(post_id)}


@app.post("/api/inbox/{mention_id}/status")
def set_mention_status(mention_id: int, payload: dict = Body(...)) -> dict:
    status = payload.get("status")
    if status not in ("new", "drafted", "answered", "ignored", "blocked"):
        raise HTTPException(400, "bad status")
    mention = engagement.set_mention_status(mention_id, status)
    if not mention:
        raise HTTPException(404, "mention not found")
    return mention


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------
@app.post("/api/tick")
def run_tick(payload: dict = Body(default={})) -> dict:
    return worker.tick(
        payload.get("site"),
        publish=bool(payload.get("publish", True)),
        notify_review=bool(payload.get("notify", False)),
    )


@app.get("/api/metrics")
def get_metrics(site: str | None = None, days: int = 30, limit: int = 10) -> dict:
    return {
        "summary": metrics.summary(site, days=days),
        "top": metrics.top_posts(site, days=days, limit=limit),
        "insights": metrics.insights(site, days=days),
    }


@app.post("/api/posts/{post_id}/outcomes")
def update_outcomes(post_id: int, payload: dict = Body(...)) -> dict:
    post = queue.get(post_id)
    if not post:
        raise HTTPException(404, "post not found")
    updates = {}
    for field in ("impressions", "clicks", "conversions"):
        if field in payload:
            value = int(payload[field])
            if value < 0:
                raise HTTPException(400, f"{field} cannot be negative")
            updates[field] = value
    db.update("posts", post_id, updates)
    db.log_event("post.outcomes_updated", site=post["site"], ref_type="post", ref_id=post_id, data=updates)
    return queue.get(post_id) or {}


@app.post("/api/metrics/refresh")
def refresh_metrics(payload: dict = Body(default={})) -> dict:
    site = payload.get("site")
    targets = [site] if site else managed_sites()
    return {name: metrics.refresh_site(name) for name in targets}


@app.get("/api/runs")
def runs(limit: int = 25) -> dict:
    return {"runs": db.rows_to_dicts(db.query("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,)))}


@app.get("/api/events")
def events(site: str | None = None, limit: int = 100) -> dict:
    sql = "SELECT * FROM events WHERE 1=1"
    params: list = []
    if site:
        sql += " AND site = ?"
        params.append(site)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    return {"events": db.rows_to_dicts(db.query(sql, tuple(params)))}


@app.get("/api/oversight")
def get_oversight() -> dict:
    return oversight.status()


@app.get("/api/strategy")
def get_strategy(site: str | None = None, days: int = 30) -> dict:
    return strategy.report(site, days=max(1, min(days, 365)))


@app.post("/api/oversight/controller")
def set_controller(payload: dict = Body(...)) -> dict:
    return oversight.set_enabled(bool(payload.get("enabled")))


@app.get("/api/feedback")
def get_feedback(site: str | None = None, state: str = "open", limit: int = 200) -> dict:
    sql = "SELECT * FROM feedback WHERE state = ?"
    params: list = [state]
    if site:
        sql += " AND site = ?"
        params.append(site)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(min(500, max(1, limit)))
    return {"feedback": db.rows_to_dicts(db.query(sql, tuple(params)))}


@app.post("/api/learning-proposals")
def create_learning_proposal(payload: dict = Body(...)) -> dict:
    try:
        return oversight.propose(
            site=payload.get("site"), scope=str(payload.get("scope") or "site"),
            target_path=str(payload.get("target_path") or ""),
            instruction=str(payload.get("instruction") or ""),
            evidence=list(payload.get("evidence") or []), actor=str(payload.get("actor") or "api"),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/learning-proposals/{proposal_id}/review")
def review_learning_proposal(proposal_id: int, payload: dict = Body(...)) -> dict:
    try:
        return oversight.review_proposal(
            proposal_id, state=str(payload.get("state") or ""), actor=str(payload.get("actor") or "api")
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def serve(host: str = "127.0.0.1", port: int = 4772, reload: bool = False) -> None:
    import uvicorn

    uvicorn.run("social_hub.api:app", host=host, port=port, reload=reload)
