"""Test fixtures: a self-contained fake fleet.

Every test runs against a temporary DOMAINS_ROOT holding two fake sites, a fake
social registry, a temp DB, and a fake platform adapter registered through
`platforms.OVERRIDES`. Nothing touches the vault, the network, or the real
repo — but the code paths exercised are the production ones.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

os.environ.setdefault("SOCIAL_HUB_AI_BACKEND", "fake")
os.environ.setdefault("SOCIAL_HUB_NO_SLACK", "1")


@pytest.fixture(autouse=True)
def fake_fleet(tmp_path, monkeypatch):
    root = tmp_path / "domains"
    (root / "tools" / "social-setup" / "registry").mkdir(parents=True)
    monkeypatch.setenv("DOMAINS_ROOT", str(root))
    monkeypatch.setenv("SOCIAL_HUB_DB", str(tmp_path / "hub.db"))
    monkeypatch.setenv("SOCIAL_HUB_CONSOLE_OUTBOX", str(tmp_path / "outbox.jsonl"))
    monkeypatch.setenv("SOCIAL_HUB_AI_BACKEND", "fake")
    monkeypatch.setenv("SOCIAL_HUB_NO_SLACK", "1")
    monkeypatch.setenv("SOCIAL_HUB_NO_VAULT", "1")
    monkeypatch.delenv("SOCIAL_HUB_TOKEN", raising=False)

    registry = {
        "version": 1,
        "personas": [{"id": "per_1", "site": "alpha.com", "name": "nova"}],
        "accounts": [
            {"site": "alpha.com", "platform": "fake", "scope": "brand", "status": "active",
             "handle": "alpha", "credsInVault": True},
            {"site": "alpha.com", "platform": "fake", "scope": "persona", "personaId": "per_1",
             "status": "active", "handle": "nova", "credsInVault": True},
            {"site": "alpha.com", "platform": "pinterest", "scope": "brand", "status": "suspended",
             "handle": "alphapins", "credsInVault": False},
            {"site": "beta.com", "platform": "fake", "scope": "brand", "status": "active",
             "handle": "beta", "credsInVault": True},
        ],
        "siteMeta": {},
    }
    registry_file = root / "tools" / "social-setup" / "registry" / "social.json"
    registry_file.write_text(json.dumps(registry), encoding="utf-8")
    monkeypatch.setenv("SOCIAL_HUB_REGISTRY", str(registry_file))

    for site, count in (("alpha.com", 3), ("beta.com", 1)):
        make_site(root, site, articles=count)

    # Reload modules that captured paths at import time.
    import importlib

    from social_hub import accounts, config, db

    importlib.reload(config)
    importlib.reload(accounts)
    db.reset_connections()
    yield root
    db.reset_connections()


def make_site(root: Path, domain: str, *, articles: int = 1, config_yaml: str | None = None) -> Path:
    site = root / "sites" / domain
    content = site / "site" / "src" / "content" / "articles"
    content.mkdir(parents=True, exist_ok=True)
    (site / "ops" / "social").mkdir(parents=True, exist_ok=True)

    for index in range(articles):
        published = (datetime.now(timezone.utc) - timedelta(hours=index)).isoformat()
        (content / f"story-{index}.md").write_text(
            "---\n"
            f"title: Story number {index} about something consequential\n"
            f"description: A summary of story {index} that is long enough to be useful copy.\n"
            f"published: '{published}'\n"
            "keywords:\n  - defense\n  - policy\n"
            "image: /articles/story.jpg\n"
            "---\n\nBody text.\n",
            encoding="utf-8",
        )

    (site / "ops" / "social" / "hub.yaml").write_text(
        config_yaml
        if config_yaml is not None
        else (
            "enabled: true\n"
            "platforms: [fake]\n"
            "approval: manual\n"
            "voice: Terse and factual.\n"
            "cadence:\n"
            "  per_platform_per_day: 2\n"
            "  min_gap_minutes: 60\n"
            "  quiet_hours: [3, 5]\n"
            '  slots: ["06:00", "12:00", "18:00"]\n'
            "reply:\n"
            "  enabled: true\n"
            "  approval: manual\n"
            "  max_per_day: 5\n"
            "  ignore_keywords: [spam]\n"
        ),
        encoding="utf-8",
    )
    return site


@pytest.fixture
def fake_adapter(monkeypatch):
    """A recording in-memory adapter registered as platform `fake`."""
    from social_hub.platforms import OVERRIDES, Adapter, AdapterError, Capabilities, Mention, PostRef

    class FakeAdapter(Adapter):
        name = "fake"
        caps = Capabilities(
            publish=True, reply=True, mentions=True, media=True, metrics=True, max_chars=200
        )
        required_creds = ()
        sent: list = []
        inbox: list = []
        fail_with: Exception | None = None

        def _verify(self):
            return {"handle": "fake-handle"}

        def publish(self, out):
            if FakeAdapter.fail_with:
                raise FakeAdapter.fail_with
            FakeAdapter.sent.append(("post", out))
            return PostRef(remote_id=f"r{len(FakeAdapter.sent)}", url=f"https://fake/{len(FakeAdapter.sent)}")

        def reply(self, out):
            if FakeAdapter.fail_with:
                raise FakeAdapter.fail_with
            FakeAdapter.sent.append(("reply", out))
            return PostRef(remote_id=f"r{len(FakeAdapter.sent)}", url=f"https://fake/{len(FakeAdapter.sent)}")

        def fetch_mentions(self, limit=25, since=None):
            return list(FakeAdapter.inbox)

    FakeAdapter.sent = []
    FakeAdapter.inbox = []
    FakeAdapter.fail_with = None
    OVERRIDES["fake"] = FakeAdapter
    yield FakeAdapter
    OVERRIDES.pop("fake", None)


@pytest.fixture
def synced(fake_adapter):
    from social_hub import accounts

    accounts.sync_channels()
    accounts.clear_creds_cache()
    return fake_adapter


def mention(**kwargs):
    from social_hub.platforms import Mention

    defaults = dict(
        remote_id="m1",
        text="Is this figure right?",
        author="Someone",
        author_handle="someone",
        url="https://fake/m1",
        parent_remote_id="m1",
        created_at=datetime.now(timezone.utc).isoformat(),
        kind="reply",
    )
    return Mention(**{**defaults, **kwargs})
