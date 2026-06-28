# tools/social-poster/tests/test_e2e_americastrikes.py
"""End-to-end integration test: content_loader against real americastrikes.com articles."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from social_poster.content_loader import load_latest_articles

_DOMAINS_ROOT = Path(os.environ.get("DOMAINS_ROOT", "/home/jesse/projects/domains"))
_SITE_PATH = _DOMAINS_ROOT / "sites" / "americastrikes.com"


@pytest.mark.skipif(
    not _SITE_PATH.exists(),
    reason="americastrikes.com not present in DOMAINS_ROOT",
)
def test_load_articles_from_americastrikes():
    """load_latest_articles returns real articles from the americastrikes.com site directory."""
    articles = load_latest_articles("americastrikes.com")

    assert len(articles) >= 1, "Expected at least 1 article from americastrikes.com"

    first = articles[0]
    assert first.title, "First article must have a non-empty title"
    assert first.url, "First article must have a non-empty url"
    assert first.url.startswith("https://americastrikes.com/"), (
        f"URL should start with https://americastrikes.com/, got: {first.url}"
    )


@pytest.mark.skipif(
    not _SITE_PATH.exists(),
    reason="americastrikes.com not present in DOMAINS_ROOT",
)
def test_articles_sorted_newest_first():
    """Articles are returned newest-first by published date."""
    articles = load_latest_articles("americastrikes.com", limit=5)
    if len(articles) < 2:
        pytest.skip("Need at least 2 articles to verify sort order")

    dates = [a.published_at for a in articles if a.published_at]
    assert dates == sorted(dates, reverse=True), (
        f"Articles not sorted newest-first: {dates}"
    )


@pytest.mark.skipif(
    not _SITE_PATH.exists(),
    reason="americastrikes.com not present in DOMAINS_ROOT",
)
def test_articles_have_descriptions():
    """At least some articles have non-empty summaries."""
    articles = load_latest_articles("americastrikes.com")
    non_empty = [a for a in articles if a.summary]
    assert non_empty, "Expected at least one article with a non-empty description/summary"
