"""HTTP surface + registry/channel behaviour."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from social_hub import accounts, db, generator, queue, sources
from social_hub.api import app
from social_hub.config import load_site_config


@pytest.fixture
def client(synced):
    return TestClient(app)


# --------------------------------------------------------------------------
# accounts
# --------------------------------------------------------------------------
def test_sync_mirrors_the_registry_and_disables_suspended_accounts(fake_adapter):
    result = accounts.sync_channels()
    assert result["created"] == 4

    pinterest = accounts.get_channel("alpha.com", "pinterest")
    assert pinterest["enabled"] == 0, "suspended in the registry means disabled here"

    brand = accounts.get_channel("alpha.com", "fake")
    assert brand["enabled"] == 1 and brand["handle"] == "alpha"
    assert accounts.get_channel("alpha.com", "fake", "nova")["persona"] == "nova"


def test_sync_preserves_a_manual_disable(fake_adapter):
    accounts.sync_channels()
    channel = accounts.get_channel("alpha.com", "fake")
    db.update("channels", channel["id"], {"enabled": 0})

    accounts.sync_channels()
    assert accounts.get_channel("alpha.com", "fake")["enabled"] == 0


def test_pick_channel_prefers_brand_then_persona(fake_adapter):
    accounts.sync_channels()
    assert accounts.pick_channel("alpha.com", "fake")["persona"] == ""
    assert accounts.pick_channel("alpha.com", "fake", persona="nova")["persona"] == "nova"

    brand = accounts.get_channel("alpha.com", "fake")
    db.update("channels", brand["id"], {"enabled": 0})
    assert accounts.pick_channel("alpha.com", "fake")["persona"] == "nova"


def test_no_drafts_are_generated_for_a_platform_with_no_live_channel(fake_adapter, fake_fleet):
    from tests.conftest import make_site

    make_site(fake_fleet, "alpha.com", articles=1, config_yaml="platforms: [fake, pinterest]\n")
    accounts.sync_channels()
    cfg = load_site_config("alpha.com")
    sources.ingest("alpha.com", cfg)
    generator.generate("alpha.com", cfg, limit=1)

    platforms = {p["platform"] for p in queue.list_posts(site="alpha.com")}
    assert platforms == {"fake"}, "pinterest is suspended — no copy should be written for it"


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
def test_health_and_sites(client):
    assert client.get("/api/health").json()["ok"] is True
    sites = client.get("/api/sites").json()["sites"]
    assert {s["site"] for s in sites} == {"alpha.com", "beta.com"}


def test_full_review_cycle_over_http(client):
    tick = client.post("/api/tick", json={"site": "alpha.com", "publish": False}).json()
    assert tick["sites"]["alpha.com"]["generate"]["drafted"] >= 1

    drafts = client.get("/api/posts?status=draft&site=alpha.com").json()["posts"]
    post_id = drafts[0]["id"]

    edited = client.patch(f"/api/posts/{post_id}", json={"body": "Edited by a human."}).json()
    assert edited["body"] == "Edited by a human."

    approved = client.post(f"/api/posts/{post_id}/approve", json={"by": "jesse"}).json()
    assert approved["status"] == "scheduled"

    sent = client.post(f"/api/posts/{post_id}/publish").json()
    assert sent["ok"] is True
    assert client.get(f"/api/posts/{post_id}").json()["status"] == "posted"


def test_reject_over_http(client):
    client.post("/api/tick", json={"site": "alpha.com", "publish": False})
    post_id = client.get("/api/posts?status=draft&site=alpha.com").json()["posts"][0]["id"]
    rejected = client.post(f"/api/posts/{post_id}/reject", json={"reason": "off voice"}).json()
    assert rejected["status"] == "rejected" and rejected["error"] == "off voice"


def test_compose_endpoint_creates_a_manual_post(client):
    client.post("/api/sources/ingest", json={"site": "alpha.com"})
    created = client.post(
        "/api/posts",
        json={"site": "alpha.com", "platform": "fake", "body": "Hand written.", "schedule": True},
    ).json()
    assert created["origin"] == "human" and created["status"] == "scheduled"


def test_compose_without_body_uses_a_source(client):
    client.post("/api/sources/ingest", json={"site": "alpha.com"})
    created = client.post("/api/posts", json={"site": "alpha.com", "platform": "fake"}).json()
    assert created["body"] and created["source_id"]


def test_channel_toggle_and_verify(client):
    channel = client.get("/api/channels?site=alpha.com").json()["channels"][0]
    off = client.patch(f"/api/channels/{channel['id']}", json={"enabled": False}).json()
    assert off["enabled"] == 0
    assert client.post(f"/api/channels/{channel['id']}/verify").json()["ok"] is True


def test_inbox_endpoints(client, synced, monkeypatch):
    from social_hub import ai
    from tests.conftest import mention

    monkeypatch.setattr(ai, "draft_reply", lambda *a, **k: ai.Draft(body="Answered.", model="test"))
    synced.inbox = [mention(remote_id="api1")]
    client.post("/api/inbox/poll", json={"site": "alpha.com"})

    mentions = client.get("/api/inbox?site=alpha.com").json()["mentions"]
    assert len(mentions) == 1

    drafted = client.post(f"/api/inbox/{mentions[0]['id']}/draft").json()
    assert drafted["ok"] and drafted["post"]["kind"] == "reply"

    ignored = client.post(f"/api/inbox/{mentions[0]['id']}/status", json={"status": "ignored"}).json()
    assert ignored["status"] == "ignored"


def test_calendar_lists_scheduled_work(client):
    client.post("/api/tick", json={"site": "alpha.com", "publish": False})
    post_id = client.get("/api/posts?status=draft&site=alpha.com").json()["posts"][0]["id"]
    client.post(f"/api/posts/{post_id}/approve", json={})
    assert client.get("/api/calendar?days=14").json()["posts"]


def test_missing_post_is_404(client):
    assert client.get("/api/posts/9999").status_code == 404


def test_token_guard_blocks_unauthenticated_calls(synced, monkeypatch):
    monkeypatch.setenv("SOCIAL_HUB_TOKEN", "s3cret")
    guarded = TestClient(app)
    assert guarded.get("/api/health").status_code == 401
    assert guarded.get("/api/health", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_token_is_rejected_in_the_query_string(synced, monkeypatch):
    """A credential in a URL leaks via access logs, proxy logs and Referer.

    The header is the only accepted channel; a correct token in ?token= must
    still be a 401, or the leaky path is quietly back.
    """
    monkeypatch.setenv("SOCIAL_HUB_TOKEN", "s3cret")
    guarded = TestClient(app)
    assert guarded.get("/api/health?token=s3cret").status_code == 401


def test_wrong_token_is_rejected(synced, monkeypatch):
    monkeypatch.setenv("SOCIAL_HUB_TOKEN", "s3cret")
    guarded = TestClient(app)
    assert guarded.get("/api/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    # A prefix of the real token must not pass either.
    assert guarded.get("/api/health", headers={"Authorization": "Bearer s3c"}).status_code == 401


def test_responses_carry_no_referrer_policy(synced, monkeypatch):
    monkeypatch.setenv("SOCIAL_HUB_TOKEN", "s3cret")
    guarded = TestClient(app)
    r = guarded.get("/api/health", headers={"Authorization": "Bearer s3cret"})
    assert r.headers.get("Referrer-Policy") == "no-referrer"
