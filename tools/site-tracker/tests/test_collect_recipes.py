"""Tests for collectors.recipes."""
from __future__ import annotations

import httpx
import pytest
import respx

from site_tracker import registry, store
from site_tracker.collectors import recipes


@pytest.fixture
def reg() -> registry.Registry:
    return registry.Registry(
        config={},
        sites={
            "alpha.test": {
                "active": True,
                "applies_to": ["contact", "legal", "branding"],
            },
        },
    )


HEAD_WITH_MAILTO = """
<!doctype html>
<html><head>
<title>x</title>
<a href="mailto:hello@alpha.test">contact us</a>
</head></html>
"""

HEAD_NO_MAILTO = "<!doctype html><html><head><title>x</title></head></html>"


@respx.mock
def test_regex_on_head_match_emits_true(db, reg):
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_WITH_MAILTO))
    respx.get("https://alpha.test/privacy").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/terms").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/.well-known/security.txt").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/favicon.ico").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/about").mock(return_value=httpx.Response(404))
    recipes.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.has_contact_email"]["value"] is True
    assert facts["http.has_contact_email"]["state"] == "green"


@respx.mock
def test_regex_on_head_no_match_emits_false(db, reg):
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_NO_MAILTO))
    respx.get("https://alpha.test/privacy").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/terms").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/.well-known/security.txt").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/favicon.ico").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/about").mock(return_value=httpx.Response(404))
    recipes.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.has_contact_email"]["value"] is False
    assert facts["http.has_contact_email"]["state"] == "yellow"


@respx.mock
def test_path_status_match_emits_true(db, reg):
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_NO_MAILTO))
    respx.get("https://alpha.test/privacy").mock(return_value=httpx.Response(200, text="<h1>privacy</h1>"))
    respx.get("https://alpha.test/terms").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/.well-known/security.txt").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/favicon.ico").mock(return_value=httpx.Response(200))
    respx.get("https://alpha.test/about").mock(return_value=httpx.Response(200))
    recipes.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.has_privacy_page"]["value"] is True
    assert facts["http.has_privacy_page"]["state"] == "green"
    assert facts["http.has_favicon"]["value"] is True


@respx.mock
def test_homepage_500_marks_regex_facts_unknown(db, reg):
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(503, text=""))
    respx.get("https://alpha.test/privacy").mock(return_value=httpx.Response(200))
    respx.get("https://alpha.test/terms").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/.well-known/security.txt").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/favicon.ico").mock(return_value=httpx.Response(200))
    respx.get("https://alpha.test/about").mock(return_value=httpx.Response(200))
    recipes.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    # regex_on_head depends on homepage; should be unknown
    assert facts["http.has_contact_email"]["state"] == "unknown"
    # path_status facts don't depend on homepage; still work
    assert facts["http.has_privacy_page"]["value"] is True


def test_recipe_collector_skips_inactive_sites(db):
    reg = registry.Registry(
        config={},
        sites={"parked.test": {"active": False, "applies_to": ["contact"]}},
    )
    recipes.run(reg, db)
    assert store.get_site_facts(db, "parked.test") == {}


def test_recipe_collector_skips_families_not_in_applies_to(db):
    reg = registry.Registry(
        config={},
        sites={"alpha.test": {"active": True, "applies_to": ["cf"]}},
    )
    # No HTTP mocks needed — collector should not even attempt fetches.
    recipes.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert "http.has_contact_email" not in facts
    assert "http.has_privacy_page" not in facts


@respx.mock
def test_regex_on_body_searches_full_response(db, monkeypatch):
    """regex_on_body should match content outside <head> (e.g., footer text)."""
    reg = registry.Registry(
        config={},
        sites={"alpha.test": {"active": True, "applies_to": ["legal"]}},
    )
    body = """<!doctype html><html><head></head><body>
    <main>hi</main>
    <footer>As an Amazon Associate I earn from qualifying purchases.</footer>
    </body></html>"""
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=body))
    # Other path_status facts in 'legal' need mocks too
    respx.get("https://alpha.test/privacy").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/terms").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/.well-known/security.txt").mock(return_value=httpx.Response(404))
    recipes.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.has_affiliate_disclosure"]["value"] is True
    assert facts["http.has_affiliate_disclosure"]["state"] == "green"
