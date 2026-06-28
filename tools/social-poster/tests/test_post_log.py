# tools/social-poster/tests/test_post_log.py
import pytest
from social_poster.post_log import already_posted, record_post, recent_posts


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    return tmp_path


def test_already_posted_false_when_no_log(fake_root):
    assert not already_posted("example.com", "my-article", "x")


def test_record_then_already_posted(fake_root):
    record_post("example.com", "my-article", "x", "https://x.com/status/123")
    assert already_posted("example.com", "my-article", "x")


def test_different_platform_not_already_posted(fake_root):
    record_post("example.com", "my-article", "x", "https://x.com/status/123")
    assert not already_posted("example.com", "my-article", "bluesky")


def test_recent_posts_returns_entries(fake_root):
    record_post("example.com", "art-1", "bluesky", "https://bsky.app/1")
    record_post("example.com", "art-2", "reddit", "https://reddit.com/2")
    posts = recent_posts("example.com")
    assert len(posts) == 2


def test_recent_posts_respects_limit(fake_root):
    for i in range(10):
        record_post("example.com", f"art-{i}", "x", f"https://x.com/{i}")
    posts = recent_posts("example.com", limit=3)
    assert len(posts) == 3
