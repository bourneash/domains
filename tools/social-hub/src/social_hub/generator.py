"""Source -> drafts. The AI content step of the pipeline.

One source article fans out to one draft per enabled platform (or
`variants_per_source` drafts, when a site wants a human to pick the best
phrasing). Public AI drafts land in `draft` for the fleet controller. A site's
`approval: auto` remains useful for private console previews; bypassing public
review requires the explicit fleet-level controller exception.

Guard rails that matter here:
  * A platform with no enabled channel never gets drafts generated. Producing
    copy for an account that cannot post is how queues fill with garbage.
  * `queue.already_drafted` makes re-runs idempotent, so a tick that crashes
    halfway never double-queues the same article.
"""

from __future__ import annotations

from social_hub import accounts, ai, db, quality, queue, sources
from social_hub.config import SiteConfig, load_site_config
from social_hub.platforms import capabilities


def _content_pillar(cfg: SiteConfig, source: dict) -> str:
    """Choose a configured pillar from source terms; deterministic and cheap."""
    pillars = cfg.get("content_pillars") or []
    haystack = " ".join(
        [str(source.get("title") or ""), str(source.get("summary") or ""), " ".join(source.get("tags") or [])]
    ).casefold()
    for pillar in pillars:
        if isinstance(pillar, str):
            continue
        if any(str(term).casefold() in haystack for term in pillar.get("keywords") or []):
            return str(pillar.get("name") or "")
    first = pillars[0] if pillars else ""
    return str(first.get("name") if isinstance(first, dict) else first)


def open_queue_depth(site: str, platform: str) -> int:
    """Posts already waiting on this channel (drafted, approved or scheduled)."""
    row = db.one(
        "SELECT COUNT(*) AS n FROM posts WHERE site = ? AND platform = ? AND kind = 'post' "
        "AND status IN ('draft','approved','scheduled')",
        (site, platform),
    )
    return int(row["n"]) if row else 0


def queue_ceiling(cfg: SiteConfig, platform: str) -> int:
    """How deep the queue may get before drafting stops for this platform.

    Two days of sends. Drafting past that is pure waste: the cadence limits how
    much can actually go out, so every extra draft is a model call spent on
    copy that will be stale before its slot comes up. This is the guard that
    keeps a 15-minute tick with a 20-article backlog from turning into 20
    Claude calls an hour.
    """
    platform_cfg = cfg.for_platform(platform)
    return max(2, int(platform_cfg.get("cadence.per_platform_per_day", 3)) * 2)


def platforms_for(site: str, cfg: SiteConfig) -> list[str]:
    """Configured platforms with an enabled, publishable channel and room in
    the queue."""
    live = []
    for platform in cfg.platforms:
        caps = capabilities(platform)
        if not caps.publish:
            continue
        channel = accounts.pick_channel(site, platform)
        if not (channel and channel["enabled"]):
            continue
        required = set(cfg.get("readiness.require_verified_for", []) or [])
        if platform in required and channel.get("readiness") != "ready":
            db.log_event(
                "generate.not_ready", site=site,
                message=f"{platform}: live verification required before drafting",
            )
            continue
        if open_queue_depth(site, platform) >= queue_ceiling(cfg, platform):
            db.log_event(
                "generate.throttled",
                site=site,
                message=f"{platform}: queue at capacity, skipping drafting",
            )
            continue
        live.append(platform)
    return live


def _borrowed_copy(site: str, source_id: str, from_platform: str, caps) -> list[ai.Draft] | None:
    """Reuse another platform's copy for this source, if it exists and fits.

    Two platforms with similar limits rarely need two different sentences, and
    a second draft is a second model call. `platform_overrides.<p>.copy_from`
    says "write this one once, borrow it here" — which is exactly right for a
    mirror channel like `console`, and often right for x/mastodon too.
    """
    row = db.one(
        "SELECT body, ai_model FROM posts WHERE site = ? AND platform = ? AND source_id = ? "
        "AND status NOT IN ('rejected','cancelled') ORDER BY id LIMIT 1",
        (site, from_platform, source_id),
    )
    if not row or len(row["body"]) > caps.max_chars:
        return None
    return [ai.Draft(body=row["body"], model=f"copy:{from_platform}")]


def generate_for_source(site: str, source: dict, cfg: SiteConfig) -> list[int]:
    created: list[int] = []
    count = max(1, int(cfg.get("variants_per_source", 1)))

    # Platforms that borrow copy are generated last, so the platform they
    # borrow from has already been drafted in this same pass.
    ordered = sorted(
        platforms_for(site, cfg),
        key=lambda p: bool(cfg.for_platform(p).get("copy_from")),
    )
    for platform in ordered:
        if queue.already_drafted(site, platform, source["source_id"]):
            continue
        platform_cfg = cfg.for_platform(platform)
        caps = capabilities(platform)
        channel = accounts.pick_channel(site, platform)
        persona = (channel or {}).get("persona") or ""
        drafts = None
        borrow = platform_cfg.get("copy_from")
        if borrow:
            drafts = _borrowed_copy(site, source["source_id"], str(borrow), caps)
        if not drafts:
            drafts = ai.draft_posts(platform_cfg, source, platform, caps, count, persona)
        auto = str(platform_cfg.approval) == "auto" and (
            platform == "console" or not cfg.get("controller.required_for_public", True)
        )

        for index, draft in enumerate(drafts):
            post_id = queue.create_post(
                site=site,
                platform=platform,
                body=draft.body,
                link=source.get("url", ""),
                channel_id=(channel or {}).get("id"),
                source_type=source.get("source_type", "article"),
                source_id=source["source_id"],
                origin="ai",
                ai_model=draft.model,
                status="draft",
            )
            db.update(
                "posts",
                post_id,
                {
                    "content_pillar": _content_pillar(cfg, source) or None,
                    "variant_group": f"{site}:{platform}:{source['source_id']}",
                },
            )
            created.append(post_id)
            problems = quality.inspect_post(post_id, cfg)
            if problems:
                first = problems[0]
                queue.quarantine(
                    post_id,
                    by="quality-gate",
                    category=first["category"],
                    reason=first["reason"],
                )
                continue
            db.update("posts", post_id, {"quality_status": "passed"})
            # Only the first variant is auto-scheduled — the rest are
            # alternatives for a human to swap in, not extra posts.
            if auto and index == 0:
                queue.approve(post_id, by="auto", cfg=cfg)

    sources.mark_source(source["id"], "drafted" if created else "skipped")
    return created


def generate(site: str, cfg: SiteConfig | None = None, limit: int | None = None) -> dict:
    cfg = cfg or load_site_config(site)
    if cfg is None or not cfg.enabled:
        return {"drafted": 0, "sources": 0, "skipped": "site not managed"}

    # Per-tick source budget. Small on purpose: the tick runs every 15 minutes,
    # and drafting is the only part of the pipeline that spends money.
    if limit is None:
        limit = int(cfg.get("max_sources_per_run", 2))
    pending = sources.pending_sources(site, limit=limit)
    total: list[int] = []
    for source in pending:
        total.extend(generate_for_source(site, source, cfg))

    if total:
        db.log_event(
            "posts.generated",
            site=site,
            message=f"{len(total)} drafts from {len(pending)} source(s)",
        )
    return {"sources": len(pending), "drafted": len(total), "post_ids": total}


def compose(
    site: str,
    platform: str,
    *,
    body: str = "",
    link: str = "",
    source_id: str | None = None,
    schedule: bool = False,
    author: str = "human",
) -> dict:
    """Create a one-off post outside the article pipeline.

    With `body`, this is a straight hand-written post. Without one, the model
    drafts from the named source (or the newest known source for the site), so
    "write me something for Bluesky about the latest piece" is one call.
    """
    cfg = load_site_config(site) or SiteConfig(site, {})
    caps = capabilities(platform)
    source = None
    if source_id:
        source = db.row_to_dict(
            db.one(
                "SELECT * FROM sources WHERE site = ? AND source_id = ?", (site, source_id)
            )
        )
    elif not body:
        rows = sources.pending_sources(site, limit=1) or db.rows_to_dicts(
            db.query(
                "SELECT * FROM sources WHERE site = ? ORDER BY published_at DESC LIMIT 1",
                (site,),
            )
        )
        source = rows[0] if rows else None

    model = None
    if not body:
        if not source:
            raise ValueError("nothing to write about: no body and no known source")
        draft = ai.draft_posts(cfg.for_platform(platform), source, platform, caps, 1)[0]
        body, model = draft.body, draft.model

    channel = accounts.pick_channel(site, platform)
    post_id = queue.create_post(
        site=site,
        platform=platform,
        body=body,
        link=link or (source or {}).get("url", ""),
        channel_id=(channel or {}).get("id"),
        source_type=(source or {}).get("source_type"),
        source_id=(source or {}).get("source_id"),
        origin="human" if model is None else "ai",
        ai_model=model,
        status="draft",
    )
    if schedule:
        queue.approve(post_id, by=author, cfg=cfg)
    return queue.get(post_id) or {}
