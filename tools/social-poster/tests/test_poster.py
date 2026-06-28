# tools/social-poster/tests/test_poster.py
from unittest.mock import patch, MagicMock
import json
import pytest
from social_poster.poster import post_domain
from social_poster.content_loader import Article


MOCK_ARTICLE = Article(
    slug="test-slug",
    title="Test Title",
    url="https://example.com/articles/test-slug",
    summary="A summary.",
    tags=["test"],
    published_at="2026-06-28T00:00:00Z",
)


def test_post_domain_returns_results(monkeypatch, tmp_path):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    (tmp_path / "sites" / "example.com" / "ops" / "social").mkdir(parents=True)

    with patch("social_poster.poster.load_latest_articles", return_value=[MOCK_ARTICLE]), \
         patch("social_poster.poster.read_creds", return_value={"BLUESKY_HANDLE": "x.bsky.social", "BLUESKY_APP_PASSWORD": "p"}), \
         patch("social_poster.poster.ALL_ADAPTERS") as mock_adapters:
        mock_adapter = MagicMock()
        mock_adapter.post.return_value = "https://bsky.app/post/1"
        mock_adapters.__contains__ = lambda self, k: k == "bluesky"
        mock_adapters.__getitem__ = lambda self, k: mock_adapter
        mock_adapters.items = lambda: [("bluesky", mock_adapter)]

        results = post_domain("example.com", platforms=["bluesky"])

    assert len(results) == 1
    assert results[0]["result"] == "posted"
    assert results[0]["platform"] == "bluesky"
    assert results[0]["url"] == "https://bsky.app/post/1"


def test_post_domain_skips_already_posted(monkeypatch, tmp_path):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    ops = tmp_path / "sites" / "example.com" / "ops" / "social"
    ops.mkdir(parents=True)
    # post_log uses "article_slug" as the key — must match what already_posted() reads
    (ops / "post-log.jsonl").write_text(
        json.dumps({
            "article_slug": "test-slug",
            "platform": "bluesky",
            "post_url": "https://bsky.app/post/old",
            "posted_at": "2026-06-28T00:00:00Z",
        }) + "\n"
    )

    with patch("social_poster.poster.load_latest_articles", return_value=[MOCK_ARTICLE]), \
         patch("social_poster.poster.read_creds", return_value={}):
        results = post_domain("example.com", platforms=["bluesky"])

    assert len(results) == 1
    assert results[0]["result"] == "skipped"


def test_post_domain_skips_when_no_creds(monkeypatch, tmp_path):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    (tmp_path / "sites" / "example.com" / "ops" / "social").mkdir(parents=True)

    with patch("social_poster.poster.load_latest_articles", return_value=[MOCK_ARTICLE]), \
         patch("social_poster.poster.read_creds", return_value={}), \
         patch("social_poster.poster.ALL_ADAPTERS") as mock_adapters:
        mock_adapters.__contains__ = lambda self, k: k == "bluesky"

        results = post_domain("example.com", platforms=["bluesky"])

    assert len(results) == 1
    assert results[0]["result"] == "skipped"
    assert results[0].get("reason") == "no creds"


def test_post_domain_records_error_on_adapter_exception(monkeypatch, tmp_path):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    (tmp_path / "sites" / "example.com" / "ops" / "social").mkdir(parents=True)

    with patch("social_poster.poster.load_latest_articles", return_value=[MOCK_ARTICLE]), \
         patch("social_poster.poster.read_creds", return_value={"TOKEN": "abc"}), \
         patch("social_poster.poster.ALL_ADAPTERS") as mock_adapters:
        mock_adapter = MagicMock()
        mock_adapter.post.side_effect = RuntimeError("network failure")
        mock_adapters.__contains__ = lambda self, k: k == "bluesky"
        mock_adapters.__getitem__ = lambda self, k: mock_adapter

        results = post_domain("example.com", platforms=["bluesky"])

    assert len(results) == 1
    assert results[0]["result"] == "error"
    assert "network failure" in results[0]["error"]


def test_post_domain_no_articles(monkeypatch, tmp_path):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    (tmp_path / "sites" / "example.com" / "ops" / "social").mkdir(parents=True)

    with patch("social_poster.poster.load_latest_articles", return_value=[]), \
         patch("social_poster.poster.read_creds", return_value={"TOKEN": "abc"}), \
         patch("social_poster.poster.ALL_ADAPTERS") as mock_adapters:
        mock_adapters.__contains__ = lambda self, k: k == "bluesky"
        mock_adapters.__getitem__ = lambda self, k: MagicMock()
        results = post_domain("example.com", platforms=["bluesky"])

    assert results == []
