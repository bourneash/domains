from __future__ import annotations

from social_hub import accounts, db, oversight, quality, queue
from social_hub.config import load_site_config


def _post(*, body="A useful, complete social post with a point.", model="claude"):
    return queue.create_post(
        site="alpha.com", platform="fake", body=body,
        link="https://alpha.com/story/", origin="ai", ai_model=model,
        source_type="article", source_id="story-0",
    )


def test_fallback_is_quarantined_and_does_not_release_source(fake_fleet):
    now = db.utcnow()
    db.insert("sources", {
        "site": "alpha.com", "source_type": "article", "source_id": "story-0",
        "title": "A real title", "url": "https://alpha.com/story/", "state": "drafted",
        "first_seen_at": now,
    })
    post_id = _post(model="fallback")
    finding = quality.inspect_post(post_id, load_site_config("alpha.com"))[0]
    queue.quarantine(post_id, by="quality-gate", **finding)

    post = queue.get(post_id)
    assert post["status"] == "needs_rewrite"
    assert post["feedback_category"] == "fallback_generation"
    assert db.one("SELECT state FROM sources WHERE source_id = 'story-0'")["state"] == "needs_rewrite"
    assert db.one("SELECT category FROM feedback WHERE post_id = ?", (post_id,))["category"] == "fallback_generation"


def test_editing_a_quarantine_returns_it_to_review(fake_fleet):
    post_id = _post(model="fallback")
    queue.quarantine(post_id, by="quality-gate", category="fallback_generation", reason="Rewrite fallback copy")
    edited = queue.edit(post_id, body="A human rewrite with a real hook and a clean ending.")
    assert edited["status"] == "draft"
    assert edited["quality_status"] == "pending"
    assert edited["error"] is None


def test_learning_proposal_requires_two_real_site_feedback_records(fake_fleet):
    ids = []
    for reason in ("Voice too formal", "Voice too formal again"):
        post_id = _post(body=f"{reason} but long enough to pass basic checks.")
        queue.quarantine(post_id, by="social-controller", category="wrong_voice", reason=reason)
        ids.append(db.one("SELECT id FROM feedback WHERE post_id = ?", (post_id,))["id"])
    row = oversight.propose(
        site="alpha.com", scope="site", target_path="sites/alpha.com/ops/social/hub.yaml",
        instruction="Make the voice less formal.", evidence=ids, actor="test",
    )
    assert row["state"] == "proposed" and row["evidence"] == ids
    applied = oversight.apply_proposal(row["id"], actor="test")
    assert applied["state"] == "applied"


def test_fleet_learning_requires_operator_approval(fake_fleet):
    ids = []
    for n in range(2):
        post_id = _post(body=f"Repeated shared failure number {n} with enough context.")
        queue.quarantine(post_id, by="social-controller", category="wrong_voice", reason="Same shared failure")
        ids.append(db.one("SELECT id FROM feedback WHERE post_id = ?", (post_id,))["id"])
    row = oversight.propose(
        site="alpha.com", scope="fleet", target_path="tools/cron-roles/archetypes/promoter/role.md.tmpl",
        instruction="Avoid the recurring shared failure.", evidence=ids, actor="test",
    )
    try:
        oversight.apply_proposal(row["id"], actor="social-controller")
    except ValueError as exc:
        assert "operator approval" in str(exc)
    else:
        raise AssertionError("unapproved fleet proposal was applied")
    oversight.review_proposal(row["id"], state="approved", actor="operator")
    assert oversight.apply_proposal(row["id"], actor="social-controller")["state"] == "applied"


def test_missing_voice_forces_manual_approval(fake_fleet):
    path = fake_fleet / "sites" / "alpha.com" / "ops" / "social" / "hub.yaml"
    path.write_text("enabled: true\nplatforms: [fake]\napproval: auto\n", encoding="utf-8")
    cfg = load_site_config("alpha.com")
    assert cfg.approval == "manual"
    assert cfg.get("brand.state") == "unclassified"


def test_existing_console_channel_is_intrinsically_ready(fake_fleet):
    channel_id = db.insert(
        "channels",
        {
            "site": "alpha.com", "platform": "console", "persona": "",
            "status": "local", "enabled": 1, "has_creds": 0,
            "readiness": "unverified", "created_at": db.utcnow(), "updated_at": db.utcnow(),
        },
    )
    accounts.ensure_config_channels("alpha.com", ["console"])
    assert db.one("SELECT readiness FROM channels WHERE id = ?", (channel_id,))["readiness"] == "ready"
