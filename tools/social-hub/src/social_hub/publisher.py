"""Publishing — take a due post and actually send it.

The one place that talks to adapters with real credentials. Everything it does
is guarded by a claim (`queue.mark_publishing`) so two overlapping ticks cannot
double-post, and every success is mirrored into the site's own
`ops/social/post-log.jsonl` — the file `social-poster` already writes and the
site repo already owns. That mirror is why losing the hub DB loses schedule
state but never publication history.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from social_hub import accounts, attribution, db, media, notify, queue
from social_hub.config import SiteConfig, load_site_config, site_root
from social_hub.platforms import AdapterError, Image, Outgoing, capabilities, get_adapter


def _site_post_log(site: str) -> Path:
    return site_root(site) / "ops" / "social" / "post-log.jsonl"


def mirror_to_site_log(post: dict) -> None:
    """Append to the site's own post log. Best-effort: a read-only or missing
    site checkout must not fail a publish that already happened remotely."""
    try:
        path = _site_post_log(post["site"])
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "article_slug": post.get("source_id") or "",
            "platform": post["platform"],
            "post_url": post.get("remote_url") or "",
            "posted_at": post.get("posted_at") or db.utcnow(),
            "kind": post.get("kind", "post"),
            "hub_post_id": post["id"],
            "body": post["body"],
        }
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except OSError as exc:
        db.log_event(
            "mirror.error",
            site=post["site"],
            ref_type="post",
            ref_id=post["id"],
            message=str(exc),
        )


def _source_for(post: dict) -> dict | None:
    if not post.get("source_id"):
        return None
    return db.row_to_dict(
        db.one(
            "SELECT * FROM sources WHERE site = ? AND source_id = ?",
            (post["site"], post["source_id"]),
        )
    )


def _generate_missing_image(post: dict, source: dict, cfg: SiteConfig) -> Image | None:
    """Generate a cover when the source has no usable image, if opted in."""
    settings = cfg.get("media") or {}
    if not settings.get("generate_missing"):
        return None

    client_dir = Path(os.environ.get(
        "MEDIA_GEN_CLIENT_DIR",
        Path(__file__).resolve().parents[3] / "media-gen" / "client",
    ))
    if str(client_dir) not in sys.path:
        sys.path.insert(0, str(client_dir))

    try:
        from media_gen_client import MediaGenClient

        title = str(source.get("title") or "tattoo guidance")
        summary = str(source.get("summary") or "")
        prompt = str(settings.get("prompt") or (
            "Editorial social image for a tattoo review and discovery desk. "
            "Topic: {title}. Context: {summary}. "
            "Warm documentary tattoo-studio photography, tactile ink and paper, "
            "natural light, tasteful composition, no words, no logos, no watermark."
        )).format(title=title, summary=summary)
        site_slug = str(settings.get("site") or post["site"].split(".", 1)[0])
        with tempfile.TemporaryDirectory(prefix="social-hub-media-") as tmp:
            dest = Path(tmp) / f"{post.get('source_id') or 'post'}.jpg"
            MediaGenClient(
                base_url=settings.get("api") or None,
                timeout=float(settings.get("timeout", 720)),
            ).generate(
                site=site_slug,
                prompt=prompt,
                backend=str(settings.get("backend") or "comfyui"),
                profile=str(settings.get("profile") or "fast"),
                slug=str(post.get("source_id") or "social-post"),
                width=int(settings.get("width", 1216)),
                height=int(settings.get("height", 832)),
                aspect_ratio=str(settings.get("aspect_ratio") or "3:2"),
                dest_path=dest,
            )
            data = dest.read_bytes()
        if not data:
            return None
        return Image(
            data=data,
            alt=title[:290],
            url=f"generated://media-gen/{post.get('source_id') or 'social-post'}",
        )
    except Exception as exc:
        db.log_event(
            "media.generate_failed", site=post["site"], ref_type="post",
            ref_id=post.get("id"), message=str(exc),
        )
        return None


def build_outgoing(post: dict, cfg: SiteConfig) -> Outgoing:
    platform_cfg = cfg.for_platform(post["platform"])
    source = _source_for(post)
    options = dict(platform_cfg.get("options") or {})
    for key in ("subreddit", "board_id", "content_label"):
        value = platform_cfg.get(key)
        if value:
            options[key] = value
    link = post.get("link") or (source or {}).get("url") or ""
    if platform_cfg.get("link_style") == "none":
        link = ""
    else:
        link = attribution.attributed_link(post, link, cfg)
    media_refs = list(post.get("media") or [])
    if not media_refs and source and source.get("image_url"):
        # Keep the site-absolute path as-is: media.load_image prefers the local
        # checkout, which works even before the image has deployed.
        media_refs = [source["image_url"]]
    # Replies never carry the article's cover — it belongs to the original
    # post, and re-attaching it to an answer reads like a bot.
    images: list[Image] = []
    # A self-labeled (adult) post takes a different, image-free send path —
    # see BlueskyAdapter._send_labeled.
    if (
        media_refs
        and post["kind"] != "reply"
        and not options.get("content_label")
        and capabilities(post["platform"]).media
    ):
        for ref in media_refs[:1]:
            data = media.load_image(ref, post["site"])
            if data:
                images.append(
                    Image(data=data, alt=media.alt_text((source or {}).get("title", "")), url=ref)
                )

    if (
        not images and source and post["kind"] != "reply"
        and not options.get("content_label")
        and capabilities(post["platform"]).media
    ):
        generated = _generate_missing_image(post, source, cfg)
        if generated:
            images.append(generated)

    return Outgoing(
        body=post["body"],
        link="" if post["kind"] == "reply" else link,
        title=(source or {}).get("title", "") or post["body"][:120],
        media=media_refs,
        images=images,
        reply_to_remote_id=post.get("reply_to_remote_id") or "",
        options=options,
    )


def publish_post(post_id: int, *, cfg: SiteConfig | None = None, claim: bool = True) -> dict:
    """Publish one post. Returns a result dict; never raises for adapter
    failures — those are recorded on the post and retried by the scheduler."""
    post = queue.get(post_id)
    if not post:
        return {"ok": False, "error": "not found"}
    if claim and not queue.mark_publishing(post_id):
        return {"ok": False, "skipped": True, "error": "not claimable"}

    cfg = cfg or load_site_config(post["site"]) or SiteConfig(post["site"], {})
    channel = (
        db.row_to_dict(db.one("SELECT * FROM channels WHERE id = ?", (post["channel_id"],)))
        if post.get("channel_id")
        else accounts.pick_channel(post["site"], post["platform"])
    )
    if not channel or not channel.get("enabled"):
        queue.mark_failed(post_id, "no enabled channel for this platform", retryable=False)
        return {"ok": False, "error": "no channel"}
    if not accounts.is_available(channel):
        queue.mark_failed(post_id, "channel is in automatic cooldown", retryable=True)
        return {"ok": False, "error": "channel cooldown", "retryable": True}

    creds = accounts.read_channel_creds(channel)
    try:
        adapter = get_adapter(post["platform"], creds)
    except KeyError as exc:
        queue.mark_failed(post_id, str(exc), retryable=False)
        return {"ok": False, "error": str(exc)}

    missing = adapter.missing_creds()
    if missing:
        queue.mark_failed(
            post_id, f"missing credentials: {', '.join(missing)}", retryable=False
        )
        return {"ok": False, "error": "missing creds"}

    out = build_outgoing(post, cfg)
    try:
        ref = adapter.reply(out) if post["kind"] == "reply" else adapter.publish(out)
    except AdapterError as exc:
        if post.get("channel_id"):
            accounts.record_publish_result(post["channel_id"], ok=False, error=str(exc))
        updated = queue.mark_failed(post_id, str(exc), retryable=exc.retryable)
        if updated and updated["status"] == "failed":
            notify.notify_failure(post["site"], post["platform"], post_id, str(exc))
        return {"ok": False, "error": str(exc), "retryable": exc.retryable}
    except Exception as exc:  # unexpected SDK explosion — treat as retryable
        if post.get("channel_id"):
            accounts.record_publish_result(post["channel_id"], ok=False, error=str(exc))
        queue.mark_failed(post_id, f"{type(exc).__name__}: {exc}")
        return {"ok": False, "error": str(exc), "retryable": True}

    final = queue.mark_posted(post_id, ref.remote_id, ref.url)
    if post.get("channel_id"):
        accounts.record_publish_result(post["channel_id"], ok=True)
    if final:
        mirror_to_site_log(final)
        if final.get("mention_id"):
            db.execute(
                "UPDATE mentions SET status = 'answered', reply_post_id = ? WHERE id = ?",
                (post_id, final["mention_id"]),
            )
        if final.get("source_id"):
            db.execute(
                "UPDATE sources SET state = 'done' WHERE site = ? AND source_id = ?",
                (final["site"], final["source_id"]),
            )
        notify.notify_published(final)
    return {"ok": True, "post": final, "url": ref.url, "remote_id": ref.remote_id}


def publish_due(limit: int = 25) -> list[dict]:
    from social_hub import scheduler

    results = []
    for post in scheduler.due_posts(limit=limit):
        results.append({"id": post["id"], **publish_post(post["id"])})
    return results
