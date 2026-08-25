"""End-to-end behaviour of the ingest -> draft -> approve -> publish pipeline."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from social_hub import accounts, db, generator, publisher, queue, sources, worker
from social_hub.config import load_site_config, site_root
from tests.conftest import make_site


def test_ingest_is_idempotent_and_ages_out_old_content(fake_fleet):
    cfg = load_site_config("alpha.com")
    first = sources.ingest("alpha.com", cfg)
    assert first["new"] == 3

    again = sources.ingest("alpha.com", cfg)
    assert again["new"] == 0, "re-ingesting must not duplicate sources"

    stale = fake_fleet / "sites" / "alpha.com" / "site" / "src" / "content" / "articles" / "old.md"
    old_date = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    stale.write_text(
        f"---\ntitle: Ancient history that should not be posted\npublished: '{old_date}'\n---\n",
        encoding="utf-8",
    )
    third = sources.ingest("alpha.com", cfg)
    assert third["new"] == 0 and third["skipped"] == 1
    rows = {r["source_id"]: r["state"] for r in sources.discover("alpha.com", cfg) and db.rows_to_dicts(
        db.query("SELECT source_id, state FROM sources WHERE site = 'alpha.com'")
    )}
    assert rows["old"] == "skipped"


def test_generate_creates_one_draft_per_platform_and_never_duplicates(synced):
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    result = generator.generate("alpha.com", cfg, limit=5)

    assert result["drafted"] == 3, "three pending sources, one platform each"
    drafts = queue.list_posts(site="alpha.com", status="draft")
    assert all(d["status"] == "draft" for d in drafts)
    assert all(d["platform"] == "fake" for d in drafts)

    # A second pass must not re-draft the same sources.
    assert generator.generate("alpha.com", cfg, limit=5)["drafted"] == 0


def test_approve_schedules_and_publish_sends_and_mirrors(synced):
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post = queue.list_posts(site="alpha.com", status="draft")[0]

    approved = queue.approve(post["id"], by="tester", cfg=cfg)
    assert approved["status"] == "scheduled" and approved["scheduled_at"]

    # Force it due, then publish.
    db.update("posts", post["id"], {"scheduled_at": db.utcnow()})
    result = publisher.publish_post(post["id"])
    assert result["ok"], result
    assert synced.sent and synced.sent[0][0] == "post"

    final = queue.get(post["id"])
    assert final["status"] == "posted" and final["remote_url"].startswith("https://fake/")

    log = site_root("alpha.com") / "ops" / "social" / "post-log.jsonl"
    entry = json.loads(log.read_text().splitlines()[0])
    assert entry["platform"] == "fake" and entry["hub_post_id"] == post["id"]

    source_state = db.one(
        "SELECT state FROM sources WHERE site = 'alpha.com' AND source_id = ?",
        (final["source_id"],),
    )["state"]
    assert source_state == "done"


def test_publish_appends_the_article_link(synced):
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post = queue.list_posts(site="alpha.com", status="draft")[0]
    queue.approve(post["id"], cfg=cfg)
    db.update("posts", post["id"], {"scheduled_at": db.utcnow()})
    publisher.publish_post(post["id"])

    _, outgoing = synced.sent[0]
    assert outgoing.link.startswith("https://alpha.com/")


def test_failed_publish_retries_then_parks(synced):
    from social_hub.platforms import AdapterError

    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post_id = queue.list_posts(site="alpha.com", status="draft")[0]["id"]
    queue.approve(post_id, cfg=cfg)

    synced.fail_with = AdapterError("rate limited")
    for _ in range(queue.MAX_ATTEMPTS):
        db.update("posts", post_id, {"status": "scheduled", "scheduled_at": db.utcnow()})
        publisher.publish_post(post_id)

    parked = queue.get(post_id)
    assert parked["status"] == "failed"
    assert parked["attempts"] == queue.MAX_ATTEMPTS
    assert "rate limited" in parked["error"]


def test_non_retryable_failure_parks_immediately(synced):
    from social_hub.platforms import AdapterError

    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post_id = queue.list_posts(site="alpha.com", status="draft")[0]["id"]
    queue.approve(post_id, cfg=cfg)
    db.update("posts", post_id, {"scheduled_at": db.utcnow()})

    synced.fail_with = AdapterError("account suspended", retryable=False)
    publisher.publish_post(post_id)
    assert queue.get(post_id)["status"] == "failed"


def test_a_post_can_only_be_claimed_once(synced):
    """Two overlapping ticks must not both publish the same post."""
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post_id = queue.list_posts(site="alpha.com", status="draft")[0]["id"]
    queue.approve(post_id, cfg=cfg)
    db.update("posts", post_id, {"scheduled_at": db.utcnow()})

    assert queue.mark_publishing(post_id) is True
    assert queue.mark_publishing(post_id) is False


def test_rejecting_the_only_draft_puts_the_source_back_in_play(synced):
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post = queue.list_posts(site="alpha.com", status="draft")[0]

    queue.reject(post["id"], reason="off voice")
    state = db.one(
        "SELECT state FROM sources WHERE site = 'alpha.com' AND source_id = ?",
        (post["source_id"],),
    )["state"]
    assert state == "new", "a rejected draft must not silently retire the article"


def test_editing_records_the_change_and_marks_it_human(synced):
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post = queue.list_posts(site="alpha.com", status="draft")[0]

    edited = queue.edit(post["id"], body="A hand-written replacement line.", editor="jesse")
    assert edited["body"] == "A hand-written replacement line."
    assert edited["origin"] == "human"

    events = db.rows_to_dicts(db.query("SELECT * FROM events WHERE kind = 'post.edited'"))
    assert events and events[0]["data"]["before"] == post["body"]


def test_posted_content_cannot_be_edited(synced):
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)
    post_id = queue.list_posts(site="alpha.com", status="draft")[0]["id"]
    queue.approve(post_id, cfg=cfg)
    db.update("posts", post_id, {"scheduled_at": db.utcnow()})
    publisher.publish_post(post_id)

    with pytest.raises(ValueError):
        queue.edit(post_id, body="too late")


def test_auto_approval_schedules_without_a_human(fake_fleet, fake_adapter):
    make_site(
        fake_fleet,
        "alpha.com",
        articles=1,
        config_yaml="platforms: [fake]\napproval: auto\ncadence:\n  slots: ['06:00','12:00']\n",
    )
    accounts.sync_channels()
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)

    assert not queue.list_posts(site="alpha.com", status="draft")
    assert queue.list_posts(site="alpha.com", status="scheduled")


def test_tick_runs_the_whole_pipeline_for_every_managed_site(synced):
    result = worker.tick(publish=True)
    assert set(result["sites"]) == {"alpha.com", "beta.com"}
    for stats in result["sites"].values():
        assert "errors" not in stats, stats
        assert stats["ingest"]["new"] >= 1
        assert stats["generate"]["drafted"] >= 1


def test_tick_survives_one_broken_site(synced, monkeypatch):
    def explode(*args, **kwargs):
        raise RuntimeError("content directory on fire")

    monkeypatch.setattr(sources, "ingest", explode)
    result = worker.tick(site="alpha.com")
    assert "errors" in result["sites"]["alpha.com"]
    # The run is recorded as not-ok rather than crashing the process.
    run = db.rows_to_dicts(db.query("SELECT * FROM runs ORDER BY id DESC LIMIT 1"))[0]
    assert run["ok"] == 0


def test_drafting_stops_when_the_queue_is_already_full(synced):
    """A 15-minute tick with a big backlog must not keep spending model calls
    on copy the cadence can never send."""
    cfg = load_site_config("alpha.com")  # cap 2/day -> ceiling 4
    for _ in range(generator.queue_ceiling(cfg, "fake")):
        queue.create_post(site="alpha.com", platform="fake", body="waiting", status="draft")

    sources.ingest("alpha.com", cfg)
    assert generator.generate("alpha.com", cfg, limit=5)["drafted"] == 0
    assert generator.platforms_for("alpha.com", cfg) == []


def test_default_source_budget_is_small(synced):
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    result = generator.generate("alpha.com", cfg)  # no explicit limit
    assert result["sources"] == 2


def test_a_platform_can_borrow_another_platform_s_copy(fake_fleet, fake_adapter):
    """copy_from reuses an already-drafted post instead of paying for a second
    model call — the mirror-channel case."""
    make_site(
        fake_fleet, "alpha.com", articles=1,
        config_yaml=(
            "platforms: [fake, console]\n"
            "platform_overrides:\n"
            "  console:\n"
            "    copy_from: fake\n"
        ),
    )
    accounts.sync_channels()
    accounts.ensure_config_channels("alpha.com", ["fake", "console"])
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)

    posts = {p["platform"]: p for p in queue.list_posts(site="alpha.com")}
    assert posts["console"]["body"] == posts["fake"]["body"]
    assert posts["console"]["ai_model"] == "copy:fake"


def test_a_collection_can_pick_one_item_per_day(fake_fleet, fake_adapter):
    """Content with many sibling files per day (a horoscope per sign) must
    collapse to a single deterministic post, not one per sibling."""
    site = fake_fleet / "sites" / "alpha.com"
    for day in ("2026-08-24", "2026-08-25"):
        for sign in ("aries", "libra", "virgo"):
            path = site / "site" / "src" / "content" / "daily" / sign / f"{day}.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                f"---\nsign: {sign}\n---\n\nThe moon is at 5 percent and the market is flat. "
                f"That is the whole reading for {sign}.\n",
                encoding="utf-8",
            )
    make_site(
        fake_fleet, "alpha.com", articles=0,
        config_yaml=(
            "platforms: [fake]\n"
            "max_source_age_hours: 100000\n"
            "sources:\n"
            "  collections:\n"
            "    - name: horoscope\n"
            '      glob: "site/src/content/daily/*/*.md"\n'
            '      url_template: "https://{domain}/daily/{parent}/{slug}/"\n'
            '      id_template: "{parent}-{slug}"\n'
            '      title_template: "{Parent} — {slug}"\n'
            "      summary_from: body\n"
            "      date_from: slug\n"
            "      pick: one_per_day\n"
        ),
    )
    cfg = load_site_config("alpha.com")
    found = sources.discover("alpha.com", cfg)

    assert len(found) == 2, "two days of content, one pick each"
    assert {i["published_at"] for i in found} == {"2026-08-24", "2026-08-25"}
    assert all(i["summary"] and i["title"] for i in found)
    # Deterministic: the same day always resolves to the same sibling.
    assert [i["source_id"] for i in found] == [i["source_id"] for i in sources.discover("alpha.com", cfg)]


def test_collection_items_keep_their_own_source_type(fake_fleet, fake_adapter):
    make_site(
        fake_fleet, "alpha.com", articles=0,
        config_yaml=(
            "platforms: [fake]\n"
            "max_source_age_hours: 100000\n"
            "sources:\n"
            "  collections:\n"
            "    - name: signals\n"
            '      glob: "site/src/content/articles/*.md"\n'
            '      url_template: "https://{domain}/signals/{slug}/"\n'
        ),
    )
    articles = fake_fleet / "sites" / "alpha.com" / "site" / "src" / "content" / "articles"
    articles.mkdir(parents=True, exist_ok=True)
    (articles / "s1.md").write_text(
        "---\ntitle: A signals read\nexcerpt: Short excerpt.\ndate: '2026-08-25'\n---\n\nBody.\n",
        encoding="utf-8",
    )
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)

    row = db.one("SELECT source_type, url FROM sources WHERE site = 'alpha.com'")
    assert row["source_type"] == "signals"
    assert row["url"] == "https://alpha.com/signals/s1/"
