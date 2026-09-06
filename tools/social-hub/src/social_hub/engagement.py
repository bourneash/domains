"""The reply side: pull mentions in, draft answers, queue them for review.

Replies are the part of social automation most likely to embarrass a brand, so
they are deliberately more conservative than posts:

  * Replies default to manual approval even when posts are on auto.
  * A daily reply cap is enforced per site, separate from the post cap.
  * The model may decline (`SKIP`) and there is no templated fallback — a canned
    reply to a stranger is worse than silence.
  * Filters (author allow/deny, keyword deny) run before the model is ever
    called, so abusive or spammy mentions cost nothing and are marked `ignored`
    rather than quietly left `new` forever.
  * Self-mentions are dropped: a channel replying to its own post is a loop.
"""

from __future__ import annotations

from social_hub import accounts, ai, db, queue, scheduler
from social_hub.config import SiteConfig, load_site_config
from social_hub.platforms import AdapterError, capabilities, get_adapter


# --------------------------------------------------------------------------
# inbox
# --------------------------------------------------------------------------
def _record_mention(site: str, platform: str, channel_id: int, mention) -> int | None:
    existing = db.one(
        "SELECT id FROM mentions WHERE platform = ? AND remote_id = ?",
        (platform, mention.remote_id),
    )
    if existing:
        return None
    return db.insert(
        "mentions",
        {
            "site": site,
            "platform": platform,
            "channel_id": channel_id,
            "remote_id": mention.remote_id,
            "kind": mention.kind,
            "author": mention.author,
            "author_handle": mention.author_handle,
            "text": mention.text,
            "url": mention.url,
            "parent_remote_id": mention.parent_remote_id,
            "remote_created_at": mention.created_at,
            "fetched_at": db.utcnow(),
            "status": "new",
        },
    )


def poll_site(site: str, cfg: SiteConfig | None = None) -> dict:
    """Fetch new mentions for every enabled channel that supports an inbox."""
    cfg = cfg or load_site_config(site) or SiteConfig(site, {})
    if not cfg.get("reply.enabled", True):
        return {"polled": 0, "new": 0, "skipped": "replies disabled"}

    limit = int(cfg.get("reply.poll_limit", 25))
    polled = new = 0
    site_channels = accounts.list_channels(site=site)
    # Every handle this site posts under — a persona's inbox surfaces the brand
    # account's own posts too, so the self-check has to span the whole site,
    # not just the channel being polled.
    own_handles = {
        (c.get("handle") or "").lower().lstrip("@") for c in site_channels if c.get("handle")
    }
    for channel in site_channels:
        if not channel["enabled"] or channel["platform"] not in cfg.platforms:
            continue
        if not capabilities(channel["platform"]).mentions:
            continue
        creds = accounts.read_channel_creds(channel)
        try:
            adapter = get_adapter(channel["platform"], creds)
        except KeyError:
            continue
        if adapter.missing_creds():
            continue
        try:
            mentions = adapter.fetch_mentions(limit=limit, since=channel.get("last_polled_at"))
        except AdapterError as exc:
            db.log_event(
                "inbox.error",
                site=site,
                ref_type="channel",
                ref_id=channel["id"],
                message=str(exc)[:300],
            )
            continue
        polled += 1
        for mention in mentions:
            if mention.author_handle.lower().lstrip("@") in own_handles:
                continue  # our own post — never reply to ourselves
            if _record_mention(site, channel["platform"], channel["id"], mention):
                new += 1
        db.update("channels", channel["id"], {"last_polled_at": db.utcnow()})

    if new:
        db.log_event("inbox.polled", site=site, message=f"{new} new mentions")
    return {"polled": polled, "new": new}


# --------------------------------------------------------------------------
# filtering
# --------------------------------------------------------------------------
# Always applied, on every site, regardless of config. These are not spam
# filtering — they are the cheapest layer of prompt-injection defence, running
# before draft_reply() so a hostile mention never reaches the model at all.
#
# Deliberately NOT part of `reply.ignore_keywords`: a per-site config REPLACES
# that list rather than extending it, so the first site to add its own spam word
# would silently switch injection defence off for itself and nobody would
# notice. Site config tunes spam; this is not tunable.
INJECTION_MARKERS = (
    "ignore previous",
    "ignore all previous",
    "ignore the above",
    "disregard previous",
    "disregard the above",
    "system prompt",
    "your instructions",
    "you are now",
    "jailbreak",
    "prompt injection",
    "reveal your",
    "repeat the words above",
    "--dangerously",
    "rm -rf",
    "<script",
)


def should_ignore(mention: dict, cfg: SiteConfig) -> str | None:
    """Reason to ignore this mention, or None to proceed."""
    handle = (mention.get("author_handle") or "").lower()
    deny = {str(a).lower().lstrip("@") for a in (cfg.get("reply.ignore_authors") or [])}
    if handle and handle.lstrip("@") in deny:
        return "author on ignore list"
    allow = [str(a).lower().lstrip("@") for a in (cfg.get("reply.only_authors") or [])]
    if allow and handle.lstrip("@") not in allow:
        return "author not on allow list"
    text = (mention.get("text") or "").lower()
    for marker in INJECTION_MARKERS:
        if marker in text:
            return f"matched injection marker '{marker}'"
    for word in cfg.get("reply.ignore_keywords") or []:
        if str(word).lower() in text:
            return f"matched ignore keyword '{word}'"
    if len(text.strip()) < 3:
        return "empty mention"
    return None


# --------------------------------------------------------------------------
# drafting
# --------------------------------------------------------------------------
def list_mentions(
    site: str | None = None, status: str | list[str] | None = None, limit: int = 100
) -> list[dict]:
    sql = "SELECT * FROM mentions WHERE 1=1"
    params: list = []
    if site:
        sql += " AND site = ?"
        params.append(site)
    if status:
        statuses = [status] if isinstance(status, str) else list(status)
        sql += " AND status IN (%s)" % ",".join("?" * len(statuses))
        params.extend(statuses)
    sql += " ORDER BY COALESCE(remote_created_at, fetched_at) DESC LIMIT ?"
    params.append(limit)
    return db.rows_to_dicts(db.query(sql, tuple(params)))


def set_mention_status(mention_id: int, status: str) -> dict | None:
    db.update("mentions", mention_id, {"status": status})
    return db.row_to_dict(db.one("SELECT * FROM mentions WHERE id = ?", (mention_id,)))


def draft_reply_for(mention: dict, cfg: SiteConfig) -> int | None:
    """Draft (and queue) a reply to one mention. Returns the new post id."""
    platform = mention["platform"]
    caps = capabilities(platform)
    if not caps.reply:
        set_mention_status(mention["id"], "ignored")
        return None

    channel = accounts.pick_channel(mention["site"], platform)
    persona = (channel or {}).get("persona") or ""
    draft = ai.draft_reply(cfg.for_platform(platform), mention, platform, caps, persona)
    if draft is None:
        set_mention_status(mention["id"], "ignored")
        db.log_event(
            "reply.declined",
            site=mention["site"],
            ref_type="mention",
            ref_id=mention["id"],
            message="model declined or unavailable",
        )
        return None

    platform_cfg = cfg.for_platform(platform)
    auto = str(platform_cfg.get("reply.approval", "manual")) == "auto" and (
        mention["platform"] == "console" or not cfg.get("controller.required_for_public", True)
    )
    post_id = queue.create_post(
        site=mention["site"],
        platform=platform,
        body=draft.body,
        channel_id=(channel or {}).get("id"),
        kind="reply",
        mention_id=mention["id"],
        reply_to_remote_id=mention["remote_id"],
        origin="ai",
        ai_model=draft.model,
        status="draft",
    )
    if auto:
        queue.approve(post_id, by="auto", cfg=cfg)
    set_mention_status(mention["id"], "drafted")
    return post_id


def draft_replies(site: str, cfg: SiteConfig | None = None, limit: int = 10) -> dict:
    cfg = cfg or load_site_config(site) or SiteConfig(site, {})
    if not cfg.get("reply.enabled", True):
        return {"drafted": 0, "ignored": 0}

    cap = int(cfg.get("reply.max_per_day", 12))
    used = scheduler.replies_today(site)
    budget = max(0, cap - used)
    drafted = ignored = 0

    for mention in list_mentions(site=site, status="new", limit=limit):
        reason = should_ignore(mention, cfg)
        if reason:
            set_mention_status(mention["id"], "ignored")
            db.log_event(
                "reply.filtered",
                site=site,
                ref_type="mention",
                ref_id=mention["id"],
                message=reason,
            )
            ignored += 1
            continue
        if budget <= 0:
            break
        if draft_reply_for(mention, cfg):
            drafted += 1
            budget -= 1
        else:
            ignored += 1

    return {"drafted": drafted, "ignored": ignored, "cap_remaining": budget}
