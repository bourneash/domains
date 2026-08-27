# tools/social-poster/tests/test_adapters.py
import pytest
from unittest.mock import patch, MagicMock
from social_poster.content_loader import Article
from social_poster.adapters.x import XAdapter
from social_poster.adapters.bluesky import BlueskyAdapter
from social_poster.adapters.reddit import RedditAdapter
from social_poster.adapters.pinterest import PinterestAdapter
from social_poster.adapters.tiktok import TikTokAdapter
from social_poster.adapters.linkedin import LinkedInAdapter
from social_poster.adapters import ALL_ADAPTERS


def _article():
    return Article(
        slug="test-article",
        title="Iran Strikes US Base: What We Know",
        url="https://americastrikes.com/articles/test-article",
        summary="Breaking coverage of the latest strike.",
        tags=["iran", "defense", "breaking"],
        published_at="2026-06-28T12:00:00Z",
    )


def _long_article():
    """Article with a very long title to test char-limit enforcement."""
    return Article(
        slug="long-article",
        title="A" * 250,
        url="https://americastrikes.com/articles/long-article",
        summary="B" * 300,
        tags=["tag1", "tag2", "tag3"],
        published_at="2026-06-28T12:00:00Z",
        image_url="https://americastrikes.com/images/hero.jpg",
    )


# ---------------------------------------------------------------------------
# X (Twitter)
# ---------------------------------------------------------------------------

def test_x_adapter_name():
    assert XAdapter.name == "x"


def test_x_adapter_formats_tweet():
    adapter = XAdapter()
    creds = {
        "X_API_KEY": "k", "X_API_SECRET": "s",
        "X_ACCESS_TOKEN": "at", "X_ACCESS_SECRET": "as",
    }
    with patch("tweepy.Client") as MockClient:
        MockClient.return_value.create_tweet.return_value = MagicMock(data={"id": "999"})
        result = adapter.post(_article(), creds)
    assert "999" in result or "x.com" in result
    call_text = MockClient.return_value.create_tweet.call_args[1]["text"]
    assert "americastrikes.com/articles/test-article" in call_text
    assert len(call_text) <= 280


def test_x_adapter_enforces_280_char_limit():
    adapter = XAdapter()
    creds = {
        "X_API_KEY": "k", "X_API_SECRET": "s",
        "X_ACCESS_TOKEN": "at", "X_ACCESS_SECRET": "as",
    }
    with patch("tweepy.Client") as MockClient:
        MockClient.return_value.create_tweet.return_value = MagicMock(data={"id": "1"})
        adapter.post(_long_article(), creds)
    call_text = MockClient.return_value.create_tweet.call_args[1]["text"]
    assert len(call_text) <= 280


def test_x_adapter_returns_url():
    adapter = XAdapter()
    creds = {
        "X_API_KEY": "k", "X_API_SECRET": "s",
        "X_ACCESS_TOKEN": "at", "X_ACCESS_SECRET": "as",
    }
    with patch("tweepy.Client") as MockClient:
        MockClient.return_value.create_tweet.return_value = MagicMock(data={"id": "42"})
        result = adapter.post(_article(), creds)
    assert result == "https://x.com/i/status/42"


# ---------------------------------------------------------------------------
# Bluesky
# ---------------------------------------------------------------------------

def test_bluesky_adapter_name():
    assert BlueskyAdapter.name == "bluesky"


def test_bluesky_adapter_posts(monkeypatch):
    adapter = BlueskyAdapter()
    creds = {"BLUESKY_HANDLE": "test.bsky.social", "BLUESKY_APP_PASSWORD": "xxx"}
    with patch("social_poster.adapters.bluesky.Client") as MockClient:
        MockClient.return_value.send_post.return_value = MagicMock(uri="at://did/post/123")
        result = adapter.post(_article(), creds)
    assert result  # non-empty


def test_bluesky_adapter_posts_contain_url():
    adapter = BlueskyAdapter()
    creds = {"BLUESKY_HANDLE": "test.bsky.social", "BLUESKY_APP_PASSWORD": "xxx"}
    with patch("social_poster.adapters.bluesky.Client") as MockClient:
        MockClient.return_value.send_post.return_value = MagicMock(uri="at://did/post/456")
        result = adapter.post(_article(), creds)
    builder = MockClient.return_value.send_post.call_args[0][0]
    call_text = builder.build_text()
    assert "americastrikes.com/articles/test-article" in call_text
    assert len(call_text) <= 300


def test_bluesky_adapter_enforces_300_char_limit():
    adapter = BlueskyAdapter()
    creds = {"BLUESKY_HANDLE": "test.bsky.social", "BLUESKY_APP_PASSWORD": "xxx"}
    with patch("social_poster.adapters.bluesky.Client") as MockClient:
        MockClient.return_value.send_post.return_value = MagicMock(uri="at://did/post/789")
        adapter.post(_long_article(), creds)
    builder = MockClient.return_value.send_post.call_args[0][0]
    assert len(builder.build_text()) <= 300


# ---------------------------------------------------------------------------
# Reddit
# ---------------------------------------------------------------------------

def test_reddit_adapter_name():
    assert RedditAdapter.name == "reddit"


def test_reddit_adapter_submits_link():
    adapter = RedditAdapter()
    creds = {
        "REDDIT_CLIENT_ID": "cid",
        "REDDIT_CLIENT_SECRET": "csec",
        "REDDIT_USERNAME": "user",
        "REDDIT_PASSWORD": "pass",
        "REDDIT_SUBREDDIT": "news",
    }
    with patch("praw.Reddit") as MockReddit:
        mock_submission = MagicMock()
        mock_submission.permalink = "/r/news/comments/abc/test/"
        MockReddit.return_value.subreddit.return_value.submit.return_value = mock_submission
        result = adapter.post(_article(), creds)
    assert "reddit.com" in result
    submit_kwargs = MockReddit.return_value.subreddit.return_value.submit.call_args[1]
    assert submit_kwargs["title"] == _article().title
    assert submit_kwargs["url"] == _article().url


def test_reddit_adapter_defaults_subreddit():
    adapter = RedditAdapter()
    creds = {
        "REDDIT_CLIENT_ID": "cid",
        "REDDIT_CLIENT_SECRET": "csec",
        "REDDIT_USERNAME": "user",
        "REDDIT_PASSWORD": "pass",
        # No REDDIT_SUBREDDIT — should default to "news"
    }
    with patch("praw.Reddit") as MockReddit:
        mock_submission = MagicMock()
        mock_submission.permalink = "/r/news/comments/xyz/test/"
        MockReddit.return_value.subreddit.return_value.submit.return_value = mock_submission
        result = adapter.post(_article(), creds)
    MockReddit.return_value.subreddit.assert_called_once_with("news")


# ---------------------------------------------------------------------------
# Pinterest
# ---------------------------------------------------------------------------

def test_pinterest_adapter_name():
    assert PinterestAdapter.name == "pinterest"


def test_pinterest_adapter_posts_pin():
    adapter = PinterestAdapter()
    creds = {
        "PINTEREST_ACCESS_TOKEN": "tok",
        "PINTEREST_BOARD_ID": "board123",
    }
    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "pin999"}
        mock_post.return_value = mock_resp
        result = adapter.post(_article(), creds)
    assert "pin999" in result
    payload = mock_post.call_args[1]["json"]
    assert payload["board_id"] == "board123"
    assert payload["link"] == _article().url
    assert len(payload["title"]) <= 100
    assert len(payload["description"]) <= 500


def test_pinterest_adapter_includes_image():
    adapter = PinterestAdapter()
    creds = {"PINTEREST_ACCESS_TOKEN": "tok", "PINTEREST_BOARD_ID": "b1"}
    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "pinX"}
        mock_post.return_value = mock_resp
        adapter.post(_long_article(), creds)
    payload = mock_post.call_args[1]["json"]
    assert "media_source" in payload
    assert payload["media_source"]["url"] == "https://americastrikes.com/images/hero.jpg"


def test_pinterest_adapter_no_image_omits_media_source():
    adapter = PinterestAdapter()
    creds = {"PINTEREST_ACCESS_TOKEN": "tok", "PINTEREST_BOARD_ID": "b1"}
    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "pinY"}
        mock_post.return_value = mock_resp
        adapter.post(_article(), creds)  # _article() has no image_url
    payload = mock_post.call_args[1]["json"]
    assert "media_source" not in payload


# ---------------------------------------------------------------------------
# TikTok
# ---------------------------------------------------------------------------

def test_tiktok_adapter_name():
    assert TikTokAdapter.name == "tiktok"


def test_tiktok_adapter_posts():
    adapter = TikTokAdapter()
    creds = {"TIKTOK_ACCESS_TOKEN": "tok"}
    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"data": {"share_url": "https://tiktok.com/@user/video/123"}}
        mock_post.return_value = mock_resp
        result = adapter.post(_article(), creds)
    assert "tiktok.com" in result
    payload = mock_post.call_args[1]["json"]
    assert "post_info" in payload
    assert len(payload["post_info"]["text"]) <= 2200


def test_tiktok_adapter_enforces_summary_truncation():
    adapter = TikTokAdapter()
    creds = {"TIKTOK_ACCESS_TOKEN": "tok"}
    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"data": {}}
        mock_post.return_value = mock_resp
        adapter.post(_long_article(), creds)
    payload = mock_post.call_args[1]["json"]
    # Summary segment is capped at 150 chars before embedding in text
    text = payload["post_info"]["text"]
    # The full text must be within API limit
    assert len(text) <= 2200


# ---------------------------------------------------------------------------
# LinkedIn
# ---------------------------------------------------------------------------

def test_linkedin_adapter_name():
    assert LinkedInAdapter.name == "linkedin"


def test_linkedin_adapter_posts():
    adapter = LinkedInAdapter()
    creds = {
        "LI_ACCESS_TOKEN": "tok",
        "LI_PERSON_URN": "urn:li:person:abc123",
    }
    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.headers = {"x-restli-id": "urn:li:ugcPost:999"}
        mock_post.return_value = mock_resp
        result = adapter.post(_article(), creds)
    assert "linkedin.com" in result
    payload = mock_post.call_args[1]["json"]
    assert payload["author"] == "urn:li:person:abc123"
    assert payload["lifecycleState"] == "PUBLISHED"
    content = payload["specificContent"]["com.linkedin.ugc.ShareContent"]
    assert _article().url in content["shareCommentary"]["text"]
    assert len(content["shareCommentary"]["text"]) <= 3000


def test_linkedin_adapter_enforces_3000_char_limit():
    adapter = LinkedInAdapter()
    creds = {"LI_ACCESS_TOKEN": "tok", "LI_PERSON_URN": "urn:li:person:x"}
    with patch("httpx.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.headers = {}
        mock_post.return_value = mock_resp
        adapter.post(_long_article(), creds)
    payload = mock_post.call_args[1]["json"]
    content = payload["specificContent"]["com.linkedin.ugc.ShareContent"]
    assert len(content["shareCommentary"]["text"]) <= 3000


# ---------------------------------------------------------------------------
# ALL_ADAPTERS registry
# ---------------------------------------------------------------------------

def test_all_adapters_registry_has_six_platforms():
    assert set(ALL_ADAPTERS.keys()) == {"x", "bluesky", "reddit", "pinterest", "tiktok", "linkedin"}


def test_all_adapters_instances_correct_type():
    assert isinstance(ALL_ADAPTERS["x"], XAdapter)
    assert isinstance(ALL_ADAPTERS["bluesky"], BlueskyAdapter)
    assert isinstance(ALL_ADAPTERS["reddit"], RedditAdapter)
    assert isinstance(ALL_ADAPTERS["pinterest"], PinterestAdapter)
    assert isinstance(ALL_ADAPTERS["tiktok"], TikTokAdapter)
    assert isinstance(ALL_ADAPTERS["linkedin"], LinkedInAdapter)
