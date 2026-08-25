"""Image resolution and attachment."""

from __future__ import annotations

import io

import pytest

from social_hub import db, generator, media, publisher, queue, sources
from social_hub.config import load_site_config, site_root


def _write_cover(site: str, rel: str, size=(60, 40)) -> None:
    from PIL import Image as PILImage

    path = site_root(site) / "site" / "public" / rel.lstrip("/")
    path.parent.mkdir(parents=True, exist_ok=True)
    PILImage.new("RGB", size, (10, 40, 90)).save(path, format="JPEG")


def test_load_image_prefers_the_local_checkout(fake_fleet):
    _write_cover("alpha.com", "/articles/story.jpg")
    data = media.load_image("/articles/story.jpg", "alpha.com")
    assert data and data[:2] == b"\xff\xd8", "expected JPEG bytes off disk"


def test_a_site_absolute_url_still_resolves_locally(fake_fleet):
    _write_cover("alpha.com", "/articles/story.jpg")
    assert media.load_image("https://alpha.com/articles/story.jpg", "alpha.com")


def test_missing_image_is_none_not_an_error(fake_fleet):
    assert media.load_image("/articles/nope.jpg", "alpha.com") is None


def test_oversized_images_are_shrunk_under_the_ceiling(fake_fleet, monkeypatch):
    monkeypatch.setattr(media, "MAX_BYTES", 4000)
    _write_cover("alpha.com", "/articles/big.jpg", size=(2400, 1600))
    data = media.load_image("/articles/big.jpg", "alpha.com")
    assert data is not None and len(data) <= 4000


def test_publish_attaches_the_cover_to_a_post(synced):
    _write_cover("alpha.com", "/articles/story.jpg")
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post_id = queue.list_posts(site="alpha.com", status="draft")[0]["id"]
    queue.approve(post_id, cfg=cfg)
    db.update("posts", post_id, {"scheduled_at": db.utcnow()})
    publisher.publish_post(post_id)

    _, outgoing = synced.sent[0]
    assert outgoing.images and outgoing.images[0].data
    assert outgoing.images[0].alt, "cover images must ship alt text"


def test_replies_never_carry_the_article_cover(synced, monkeypatch):
    from social_hub import ai, engagement
    from tests.conftest import mention

    _write_cover("alpha.com", "/articles/story.jpg")
    monkeypatch.setattr(ai, "draft_reply", lambda *a, **k: ai.Draft(body="Noted.", model="t"))
    synced.inbox = [mention(remote_id="img1")]
    engagement.poll_site("alpha.com")
    engagement.draft_replies("alpha.com")

    reply = queue.list_posts(site="alpha.com", kind="reply", status="draft")[0]
    queue.approve(reply["id"])
    db.update("posts", reply["id"], {"scheduled_at": db.utcnow()})
    publisher.publish_post(reply["id"])

    _, outgoing = synced.sent[-1]
    assert not outgoing.images


def test_media_can_be_disabled_wholesale(fake_fleet, monkeypatch):
    monkeypatch.setenv("SOCIAL_HUB_NO_MEDIA", "1")
    _write_cover("alpha.com", "/articles/story.jpg")
    assert media.load_image("/articles/story.jpg", "alpha.com") is None
