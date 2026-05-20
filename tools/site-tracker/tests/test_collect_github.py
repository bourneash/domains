"""Tests for collectors.github."""
from __future__ import annotations

import httpx
import pytest
import respx
from freezegun import freeze_time

from site_tracker import registry, store
from site_tracker.collectors import github as gh


@pytest.fixture(autouse=True)
def _gh_env(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "test-pat")


@pytest.fixture
def reg() -> registry.Registry:
    return registry.Registry(
        config={},
        sites={
            "alpha.test": {"active": True, "github": "org/alpha", "applies_to": ["github"]},
        },
    )


@respx.mock
def test_collects_last_push(db, reg):
    with freeze_time("2026-05-19T12:00:00Z"):
        respx.get("https://api.github.com/repos/org/alpha").mock(
            return_value=httpx.Response(200, json={
                "pushed_at": "2026-05-18T12:00:00Z",
            })
        )
        gh.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["github.last_push_age_hours"]["value"] == 24.0
    assert facts["github.last_push_age_hours"]["state"] == "green"


@respx.mock
def test_404_marks_unknown(db, reg):
    respx.get("https://api.github.com/repos/org/alpha").mock(
        return_value=httpx.Response(404)
    )
    gh.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["github.last_push_age_hours"]["state"] == "unknown"


@respx.mock
def test_pushed_at_absent_marks_unknown(db, reg):
    """If the /repos response is 200 but pushed_at is missing,
    last_push_age_hours should be unknown (not crash)."""
    respx.get("https://api.github.com/repos/org/alpha").mock(
        return_value=httpx.Response(200, json={})
    )
    gh.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["github.last_push_age_hours"]["state"] == "unknown"
    # commits_ahead is still emitted as unknown on the success path
    assert facts["github.commits_ahead"]["state"] == "unknown"
