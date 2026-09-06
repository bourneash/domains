"""Inbox polling, reply filtering, and reply drafting."""

from __future__ import annotations

from social_hub import ai, db, engagement, publisher, queue
from social_hub.config import SiteConfig, load_site_config
from tests.conftest import mention


def _reply_text(monkeypatch, text: str | None):
    """Force the AI layer to produce (or decline) a specific reply."""
    if text is None:
        monkeypatch.setattr(ai, "draft_reply", lambda *a, **k: None)
    else:
        monkeypatch.setattr(ai, "draft_reply", lambda *a, **k: ai.Draft(body=text, model="test"))


def test_polling_records_mentions_once(synced):
    synced.inbox = [mention(remote_id="m1"), mention(remote_id="m2", text="Second question")]
    first = engagement.poll_site("alpha.com")
    assert first["new"] == 2
    assert engagement.poll_site("alpha.com")["new"] == 0, "same mentions must not duplicate"


def test_self_mentions_are_ignored(synced):
    synced.inbox = [mention(remote_id="own", author_handle="alpha")]
    engagement.poll_site("alpha.com")
    assert engagement.list_mentions(site="alpha.com") == []


def test_keyword_filter_marks_ignored_without_calling_the_model(synced, monkeypatch):
    called = []
    monkeypatch.setattr(ai, "draft_reply", lambda *a, **k: called.append(1))
    synced.inbox = [mention(remote_id="s1", text="cheap spam offer here")]
    engagement.poll_site("alpha.com")

    result = engagement.draft_replies("alpha.com")
    assert result["ignored"] == 1 and result["drafted"] == 0
    assert not called, "filtered mentions must not cost a model call"
    assert engagement.list_mentions(site="alpha.com", status="ignored")


def test_reply_is_queued_as_a_draft_for_review(synced, monkeypatch):
    _reply_text(monkeypatch, "Figure comes from the ministry statement, linked in the piece.")
    synced.inbox = [mention(remote_id="q1")]
    engagement.poll_site("alpha.com")

    assert engagement.draft_replies("alpha.com")["drafted"] == 1
    replies = queue.list_posts(site="alpha.com", kind="reply", status="draft")
    assert len(replies) == 1
    assert replies[0]["reply_to_remote_id"] == "q1"
    assert engagement.list_mentions(site="alpha.com", status="drafted")


def test_model_declining_leaves_no_reply(synced, monkeypatch):
    _reply_text(monkeypatch, None)
    synced.inbox = [mention(remote_id="bait", text="you are all clowns")]
    engagement.poll_site("alpha.com")

    assert engagement.draft_replies("alpha.com")["drafted"] == 0
    assert not queue.list_posts(site="alpha.com", kind="reply")
    assert engagement.list_mentions(site="alpha.com", status="ignored")


def test_daily_reply_cap_is_enforced(synced, monkeypatch):
    _reply_text(monkeypatch, "Thanks — noted.")
    synced.inbox = [mention(remote_id=f"m{i}", text=f"question {i}") for i in range(8)]
    engagement.poll_site("alpha.com")

    result = engagement.draft_replies("alpha.com", limit=20)
    assert result["drafted"] == 5, "config caps replies at 5/day"


def test_publishing_a_reply_answers_the_mention(synced, monkeypatch):
    _reply_text(monkeypatch, "Good catch — corrected.")
    synced.inbox = [mention(remote_id="q9")]
    engagement.poll_site("alpha.com")
    engagement.draft_replies("alpha.com")

    reply = queue.list_posts(site="alpha.com", kind="reply", status="draft")[0]
    queue.approve(reply["id"])
    db.update("posts", reply["id"], {"scheduled_at": db.utcnow()})
    result = publisher.publish_post(reply["id"])

    assert result["ok"] and synced.sent[-1][0] == "reply"
    assert synced.sent[-1][1].reply_to_remote_id == "q9"
    assert engagement.list_mentions(site="alpha.com", status="answered")


def test_replies_can_be_auto_approved_per_site(synced, monkeypatch, fake_fleet):
    from tests.conftest import make_site

    make_site(
        fake_fleet, "alpha.com", articles=1,
        config_yaml="platforms: [fake]\ncontroller:\n  required_for_public: false\nreply:\n  enabled: true\n  approval: auto\n  max_per_day: 3\n",
    )
    _reply_text(monkeypatch, "On it.")
    synced.inbox = [mention(remote_id="auto1")]
    engagement.poll_site("alpha.com")
    engagement.draft_replies("alpha.com")

    assert queue.list_posts(site="alpha.com", kind="reply", status="scheduled")


def test_sanitize_strips_model_tics_and_stray_urls():
    text = "Sure! Here's a post: Refinery hit overnight. https://evil.example/x https://alpha.com/a/1"
    cleaned = ai.sanitize(text, allowed_url="https://alpha.com/a/1")
    assert "evil.example" not in cleaned
    assert "https://alpha.com/a/1" in cleaned
    assert not cleaned.lower().startswith("sure")


def test_fit_trims_on_a_word_boundary_and_keeps_the_link():
    from social_hub.platforms.base import Adapter, Capabilities

    class Tiny(Adapter):
        caps = Capabilities(max_chars=40)

    out = Tiny().fit("word " * 30, "https://x.co/1")
    assert len(out) <= 40 and out.endswith("https://x.co/1")


def test_adult_sites_can_self_label_their_posts(synced, monkeypatch):
    """Bluesky requires the poster to label adult material. The label has to
    reach the adapter as a send option, not be left to tone."""
    from social_hub import publisher
    from social_hub.config import SiteConfig

    post = {
        "id": 1, "site": "alpha.com", "platform": "fake", "kind": "post",
        "body": "A review of a very spicy book.", "link": "https://alpha.com/r/1",
        "media": ["/img/cover.jpg"], "source_id": None, "reply_to_remote_id": "",
    }
    cfg = SiteConfig("alpha.com", {"content_label": "sexual"})
    out = publisher.build_outgoing(post, cfg)

    assert out.options["content_label"] == "sexual"
    assert not out.images, "a labeled post takes the image-free send path"


def test_link_facets_use_utf8_byte_offsets():
    """A self-labeled post is written through create_record, which does not
    build facets — and a character-based offset mislinks any post containing
    a non-ASCII character before the URL."""
    from social_hub.platforms.bluesky import link_facets

    text = "Café — read https://example.com/x now"
    facet = link_facets(text)[0]
    raw = text.encode("utf-8")

    assert raw[facet.index.byte_start : facet.index.byte_end] == b"https://example.com/x"
    assert facet.features[0].uri == "https://example.com/x"
