"""Tests for collectors.http_scrape."""
from __future__ import annotations

import respx
import httpx
import pytest

from site_tracker import registry, store
from site_tracker.collectors import http_scrape


@pytest.fixture
def reg() -> registry.Registry:
    return registry.Registry(
        config={},
        sites={
            "alpha.test": {
                "active": True,
                "applies_to": ["http", "sitemap", "tls"],
            },
        },
    )


HEAD_WITH_PIXELS = """
<!doctype html>
<html><head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890"></script>
<script>!function(f,b,e,v,n,t,s){fbq('init', '987654321');}();</script>
<script>(function(w,d,s,l,i){...})(window,document,'script','dataLayer','GTM-AAA111');</script>
</head><body></body></html>
"""

HEAD_BARE = "<!doctype html><html><head></head><body></body></html>"


@respx.mock
def test_detects_pixels_in_head(db, reg, monkeypatch):
    monkeypatch.setattr(http_scrape, "_tls_expiry_days", lambda host: 90)
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_WITH_PIXELS))
    respx.get("https://alpha.test/sitemap.xml").mock(return_value=httpx.Response(200, text="<urlset/>"))
    respx.get("https://alpha.test/robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *"))
    http_scrape.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.ga4_present"]["value"] is True
    assert facts["http.adsense_present"]["value"] is True
    assert facts["http.meta_pixel_present"]["value"] is True
    assert facts["http.gtm_present"]["value"] is True


@respx.mock
def test_missing_pixels_marked_false(db, reg, monkeypatch):
    monkeypatch.setattr(http_scrape, "_tls_expiry_days", lambda host: 90)
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_BARE))
    respx.get("https://alpha.test/sitemap.xml").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/robots.txt").mock(return_value=httpx.Response(404))
    http_scrape.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.ga4_present"]["value"] is False
    assert facts["http.sitemap_200"]["value"] is False
    assert facts["http.robots_present"]["value"] is False


@respx.mock
def test_homepage_timeout_marks_unknown(db, reg, monkeypatch):
    monkeypatch.setattr(http_scrape, "_tls_expiry_days", lambda host: 90)
    respx.get("https://alpha.test/").mock(side_effect=httpx.ConnectTimeout("boom"))
    respx.get("https://alpha.test/sitemap.xml").mock(return_value=httpx.Response(404))
    respx.get("https://alpha.test/robots.txt").mock(return_value=httpx.Response(404))
    http_scrape.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.ga4_present"]["state"] == "unknown"


@respx.mock
def test_tls_expiry_stored_when_probe_succeeds(db, reg, monkeypatch):
    monkeypatch.setattr(http_scrape, "_tls_expiry_days", lambda host: 45)
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_BARE))
    respx.get("https://alpha.test/sitemap.xml").mock(return_value=httpx.Response(200, text="<urlset/>"))
    respx.get("https://alpha.test/robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *"))
    http_scrape.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.tls_expiry_days"]["value"] == 45
    assert facts["http.tls_expiry_days"]["state"] == "green"


@respx.mock
def test_tls_expiry_unknown_when_probe_fails(db, reg, monkeypatch):
    monkeypatch.setattr(http_scrape, "_tls_expiry_days", lambda host: None)
    respx.get("https://alpha.test/").mock(return_value=httpx.Response(200, text=HEAD_BARE))
    respx.get("https://alpha.test/sitemap.xml").mock(return_value=httpx.Response(200, text="<urlset/>"))
    respx.get("https://alpha.test/robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *"))
    http_scrape.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["http.tls_expiry_days"]["state"] == "unknown"
