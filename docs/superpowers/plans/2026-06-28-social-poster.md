# Social Poster — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tools/social-poster/` — a posting engine that reads site articles, formats them per platform, and posts via each platform's API. Includes a cron role and skill for fleet-wide installation.

**Architecture:** Content loader reads site article files → per-platform adapters format → API clients post → post-log.jsonl deduplicates. CLI + thin cron shell wrapper. Follows existing cron-role patterns.

**Tech Stack:** Python 3.11+, tweepy (X), atproto (Bluesky), praw (Reddit), httpx (Pinterest/TikTok/LinkedIn), click, social-lib

**Prerequisites:**
- `tools/social-lib/` installed
- `tools/social-setup/` installed (cred files populated for target domain)

## Global Constraints

- Post log at `sites/<domain>/ops/social/post-log.jsonl` — one JSON line per post
- Never post the same article+platform combo twice (check log before posting)
- Platform adapters are independent — one failing doesn't block others
- Cron schedule: `0 9,17 * * *` (9am + 5pm daily)
- Cron role follows existing `tools/cron-roles/` pattern
- Package name: `social-poster`, import name: `social_poster`

---

## File Map

```
tools/social-poster/
  pyproject.toml
  src/social_poster/
    __init__.py
    content_loader.py       ← reads site articles from src/content/ or content.json
    post_log.py             ← jsonl read/write + dedup check
    adapters/
      __init__.py
      base.py               ← AbstractAdapter with format() + post() interface
      x.py                  ← X/Twitter via tweepy
      bluesky.py            ← Bluesky via atproto
      reddit.py             ← Reddit via praw
      pinterest.py          ← Pinterest via httpx
      tiktok.py             ← TikTok text post via httpx
      linkedin.py           ← LinkedIn post via httpx
    poster.py               ← orchestrates load → adapt → post → log
    cli.py
  cron/
    run.sh                  ← cron entry point (sources .env, calls poster CLI)
  tests/
    test_content_loader.py
    test_post_log.py
    test_adapters.py
    test_poster.py
```

---

### Task 1: Package scaffold + content_loader

**Files:**
- Create: `tools/social-poster/pyproject.toml`
- Create: `tools/social-poster/src/social_poster/__init__.py`
- Create: `tools/social-poster/src/social_poster/content_loader.py`
- Create: `tools/social-poster/tests/test_content_loader.py`

**Interfaces:**
- Produces:
  - `Article` dataclass: `slug, title, url, summary, tags: list[str], image_url: str | None, published_at: str`
  - `load_latest_articles(domain: str, limit: int = 10) -> list[Article]` — reads from site's content directory, returns newest first
  - Content is sourced from `sites/<domain>/src/content/**/*.md` frontmatter, OR `sites/<domain>/content.json` if Markdown not found

- [ ] **Step 1: Create pyproject.toml**

```toml
# tools/social-poster/pyproject.toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.backends.legacy:build"

[project]
name = "social-poster"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "tweepy>=4.14",
    "atproto>=0.0.50",
    "praw>=7.7",
    "httpx>=0.27",
    "click>=8.1",
    "pyyaml>=6.0",
    "social-lib @ file:///home/jesse/projects/domains/tools/social-lib",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[project.scripts]
social-poster = "social_poster.cli:cli"

[tool.setuptools.packages.find]
where = ["src"]
```

- [ ] **Step 2: Write failing tests**

```python
# tools/social-poster/tests/test_content_loader.py
import os
import pytest
from pathlib import Path
from social_poster.content_loader import Article, load_latest_articles


@pytest.fixture
def fake_site(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    site = tmp_path / "sites" / "example.com"
    site.mkdir(parents=True)
    return site


def _write_md(site: Path, slug: str, title: str, date: str, summary: str = "Test summary."):
    content_dir = site / "src" / "content" / "articles"
    content_dir.mkdir(parents=True, exist_ok=True)
    (content_dir / f"{slug}.md").write_text(
        f"---\ntitle: {title}\npubDate: {date}\ndescription: {summary}\ntags: [news, test]\n---\n\nBody text here."
    )


def test_load_latest_articles_returns_articles(fake_site):
    _write_md(fake_site, "article-1", "First Article", "2026-06-01")
    _write_md(fake_site, "article-2", "Second Article", "2026-06-02")
    articles = load_latest_articles("example.com")
    assert len(articles) == 2


def test_load_latest_articles_newest_first(fake_site):
    _write_md(fake_site, "old", "Old Article", "2026-01-01")
    _write_md(fake_site, "new", "New Article", "2026-06-01")
    articles = load_latest_articles("example.com")
    assert articles[0].title == "New Article"


def test_load_latest_articles_respects_limit(fake_site):
    for i in range(5):
        _write_md(fake_site, f"art-{i}", f"Article {i}", f"2026-0{i+1}-01")
    articles = load_latest_articles("example.com", limit=3)
    assert len(articles) == 3


def test_article_has_url(fake_site):
    _write_md(fake_site, "my-article", "My Article", "2026-06-01")
    articles = load_latest_articles("example.com")
    assert articles[0].url == "https://example.com/articles/my-article"


def test_load_returns_empty_when_no_content(fake_site):
    articles = load_latest_articles("example.com")
    assert articles == []
```

- [ ] **Step 3: Run — expect failure**

```bash
cd tools/social-poster && pip install -e ".[dev]" -q && pytest tests/test_content_loader.py -v
```

- [ ] **Step 4: Implement content_loader.py**

```python
# tools/social-poster/src/social_poster/content_loader.py
from __future__ import annotations
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
import yaml
from social_lib.credentials import site_root


@dataclass
class Article:
    slug: str
    title: str
    url: str
    summary: str
    tags: list[str] = field(default_factory=list)
    image_url: Optional[str] = None
    published_at: str = ""


def _parse_frontmatter(text: str) -> dict:
    match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return {}
    try:
        return yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        return {}


def load_latest_articles(domain: str, limit: int = 10) -> list[Article]:
    root = site_root(domain)
    articles = []

    # Try Astro content directory first
    for pattern in ("src/content/**/*.md", "src/content/**/*.mdx", "content/**/*.md"):
        md_files = list(root.glob(pattern))
        if md_files:
            break

    for path in md_files:
        fm = _parse_frontmatter(path.read_text())
        if not fm.get("title"):
            continue
        slug = path.stem
        pub_date = str(fm.get("pubDate", fm.get("date", fm.get("publishedDate", ""))))
        articles.append(Article(
            slug=slug,
            title=fm["title"],
            url=f"https://{domain}/articles/{slug}",
            summary=fm.get("description", fm.get("excerpt", ""))[:280],
            tags=[str(t) for t in fm.get("tags", [])],
            image_url=fm.get("image", fm.get("heroImage")),
            published_at=pub_date,
        ))

    articles.sort(key=lambda a: a.published_at, reverse=True)
    return articles[:limit]
```

- [ ] **Step 5: Run — expect pass**

```bash
pytest tests/test_content_loader.py -v
```
Expected: 5 passed

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml src/ tests/test_content_loader.py
git commit -m "feat(social-poster): scaffold + content_loader"
```

---

### Task 2: post_log

**Files:**
- Create: `tools/social-poster/src/social_poster/post_log.py`
- Create: `tools/social-poster/tests/test_post_log.py`

**Interfaces:**
- Produces:
  - `already_posted(domain: str, slug: str, platform: str) -> bool`
  - `record_post(domain: str, slug: str, platform: str, post_url: str) -> None` — appends to jsonl
  - `recent_posts(domain: str, limit: int = 50) -> list[dict]`

- [ ] **Step 1: Write failing tests**

```python
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
```

- [ ] **Step 2: Implement post_log.py**

```python
# tools/social-poster/src/social_poster/post_log.py
from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
from social_lib.credentials import site_root


def _log_path(domain: str) -> Path:
    return site_root(domain) / "ops" / "social" / "post-log.jsonl"


def already_posted(domain: str, slug: str, platform: str) -> bool:
    path = _log_path(domain)
    if not path.exists():
        return False
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if entry.get("slug") == slug and entry.get("platform") == platform:
            return True
    return False


def record_post(domain: str, slug: str, platform: str, post_url: str) -> None:
    path = _log_path(domain)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "slug": slug,
        "platform": platform,
        "post_url": post_url,
        "posted_at": datetime.now(timezone.utc).isoformat(),
    }
    with path.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def recent_posts(domain: str, limit: int = 50) -> list[dict]:
    path = _log_path(domain)
    if not path.exists():
        return []
    lines = [l for l in path.read_text().splitlines() if l.strip()]
    return [json.loads(l) for l in lines[-limit:]]
```

- [ ] **Step 3: Run — expect pass**

```bash
pytest tests/test_post_log.py -v
```
Expected: 5 passed

- [ ] **Step 4: Commit**

```bash
git add src/social_poster/post_log.py tests/test_post_log.py
git commit -m "feat(social-poster): post_log dedup + record"
```

---

### Task 3: platform adapters

**Files:**
- Create: `tools/social-poster/src/social_poster/adapters/base.py`
- Create: `tools/social-poster/src/social_poster/adapters/__init__.py`
- Create: `tools/social-poster/src/social_poster/adapters/x.py`
- Create: `tools/social-poster/src/social_poster/adapters/bluesky.py`
- Create: `tools/social-poster/src/social_poster/adapters/reddit.py`
- Create: `tools/social-poster/src/social_poster/adapters/pinterest.py`
- Create: `tools/social-poster/src/social_poster/adapters/tiktok.py`
- Create: `tools/social-poster/src/social_poster/adapters/linkedin.py`
- Create: `tools/social-poster/tests/test_adapters.py`

**Interfaces:**
- Produces: each adapter has `name: str` class attribute and `post(article: Article, creds: dict) -> str` method returning the post URL/ID

- [ ] **Step 1: Write failing tests**

```python
# tools/social-poster/tests/test_adapters.py
import pytest
from unittest.mock import patch, MagicMock
from social_poster.content_loader import Article
from social_poster.adapters.x import XAdapter
from social_poster.adapters.bluesky import BlueskyAdapter
from social_poster.adapters.reddit import RedditAdapter


def _article():
    return Article(
        slug="test-article",
        title="Iran Strikes US Base: What We Know",
        url="https://americastrikes.com/articles/test-article",
        summary="Breaking coverage of the latest strike.",
        tags=["iran", "defense", "breaking"],
        published_at="2026-06-28T12:00:00Z",
    )


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


def test_bluesky_adapter_name():
    assert BlueskyAdapter.name == "bluesky"


def test_bluesky_adapter_posts(monkeypatch):
    adapter = BlueskyAdapter()
    creds = {"BLUESKY_HANDLE": "test.bsky.social", "BLUESKY_APP_PASSWORD": "xxx"}
    with patch("atproto.Client") as MockClient:
        MockClient.return_value.send_post.return_value = MagicMock(uri="at://did/post/123")
        result = adapter.post(_article(), creds)
    assert result  # non-empty


def test_reddit_adapter_name():
    assert RedditAdapter.name == "reddit"
```

- [ ] **Step 2: Run — expect failure**

```bash
pytest tests/test_adapters.py -v
```

- [ ] **Step 3: Implement base.py**

```python
# tools/social-poster/src/social_poster/adapters/base.py
from __future__ import annotations
from abc import ABC, abstractmethod
from social_poster.content_loader import Article


class AbstractAdapter(ABC):
    name: str

    @abstractmethod
    def post(self, article: Article, creds: dict) -> str:
        """Post article to platform. Returns post URL or ID string."""
```

- [ ] **Step 4: Implement x.py**

```python
# tools/social-poster/src/social_poster/adapters/x.py
from __future__ import annotations
import tweepy
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class XAdapter(AbstractAdapter):
    name = "x"

    def post(self, article: Article, creds: dict) -> str:
        client = tweepy.Client(
            consumer_key=creds["X_API_KEY"],
            consumer_secret=creds["X_API_SECRET"],
            access_token=creds["X_ACCESS_TOKEN"],
            access_token_secret=creds["X_ACCESS_SECRET"],
        )
        hashtags = " ".join(f"#{t}" for t in article.tags[:2])
        text = f"{article.title}\n{article.url}"
        if hashtags:
            candidate = f"{text} {hashtags}"
            text = candidate if len(candidate) <= 280 else text
        response = client.create_tweet(text=text[:280])
        tweet_id = response.data["id"]
        return f"https://x.com/i/status/{tweet_id}"
```

- [ ] **Step 5: Implement bluesky.py**

```python
# tools/social-poster/src/social_poster/adapters/bluesky.py
from __future__ import annotations
from atproto import Client
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class BlueskyAdapter(AbstractAdapter):
    name = "bluesky"

    def post(self, article: Article, creds: dict) -> str:
        client = Client()
        client.login(creds["BLUESKY_HANDLE"], creds["BLUESKY_APP_PASSWORD"])
        text = f"{article.title}\n{article.url}"
        response = client.send_post(text=text[:300])
        return response.uri
```

- [ ] **Step 6: Implement reddit.py**

```python
# tools/social-poster/src/social_poster/adapters/reddit.py
from __future__ import annotations
import praw
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class RedditAdapter(AbstractAdapter):
    name = "reddit"

    def post(self, article: Article, creds: dict) -> str:
        reddit = praw.Reddit(
            client_id=creds["REDDIT_CLIENT_ID"],
            client_secret=creds["REDDIT_CLIENT_SECRET"],
            username=creds["REDDIT_USERNAME"],
            password=creds["REDDIT_PASSWORD"],
            user_agent=f"social-poster/0.1 by {creds['REDDIT_USERNAME']}",
        )
        subreddit_name = creds.get("REDDIT_SUBREDDIT", "news")
        sub = reddit.subreddit(subreddit_name)
        submission = sub.submit(title=article.title, url=article.url)
        return f"https://reddit.com{submission.permalink}"
```

- [ ] **Step 7: Implement pinterest.py**

```python
# tools/social-poster/src/social_poster/adapters/pinterest.py
from __future__ import annotations
import httpx
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class PinterestAdapter(AbstractAdapter):
    name = "pinterest"

    def post(self, article: Article, creds: dict) -> str:
        token = creds.get("PINTEREST_ACCESS_TOKEN", "")
        board_id = creds.get("PINTEREST_BOARD_ID", "")
        payload = {
            "board_id": board_id,
            "title": article.title[:100],
            "description": article.summary[:500],
            "link": article.url,
        }
        if article.image_url:
            payload["media_source"] = {"source_type": "image_url", "url": article.image_url}
        resp = httpx.post(
            "https://api.pinterest.com/v5/pins",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        pin_id = resp.json()["id"]
        return f"https://www.pinterest.com/pin/{pin_id}/"
```

- [ ] **Step 8: Implement tiktok.py**

```python
# tools/social-poster/src/social_poster/adapters/tiktok.py
from __future__ import annotations
import httpx
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class TikTokAdapter(AbstractAdapter):
    name = "tiktok"

    def post(self, article: Article, creds: dict) -> str:
        # TikTok Content Posting API v2 — text post
        token = creds.get("TIKTOK_ACCESS_TOKEN", "")
        text = f"{article.title}\n\n{article.summary[:150]}\n\n{article.url}"
        resp = httpx.post(
            "https://open.tiktokapis.com/v2/post/publish/text/",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"post_info": {"text": text[:2200], "privacy_level": "PUBLIC_TO_EVERYONE"}},
        )
        resp.raise_for_status()
        return resp.json().get("data", {}).get("share_url", "https://tiktok.com")
```

- [ ] **Step 9: Implement linkedin.py**

```python
# tools/social-poster/src/social_poster/adapters/linkedin.py
from __future__ import annotations
import httpx
from social_poster.adapters.base import AbstractAdapter
from social_poster.content_loader import Article


class LinkedInAdapter(AbstractAdapter):
    name = "linkedin"

    def post(self, article: Article, creds: dict) -> str:
        token = creds.get("LI_ACCESS_TOKEN", "")
        author_urn = creds.get("LI_PERSON_URN", "")  # urn:li:person:xxxxx
        text = f"{article.title}\n\n{article.summary}\n\nRead more: {article.url}"
        payload = {
            "author": author_urn,
            "lifecycleState": "PUBLISHED",
            "specificContent": {
                "com.linkedin.ugc.ShareContent": {
                    "shareCommentary": {"text": text[:3000]},
                    "shareMediaCategory": "ARTICLE",
                    "media": [{"status": "READY", "originalUrl": article.url}],
                }
            },
            "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"},
        }
        resp = httpx.post(
            "https://api.linkedin.com/v2/ugcPosts",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        post_id = resp.headers.get("x-restli-id", "")
        return f"https://www.linkedin.com/feed/update/{post_id}/"
```

- [ ] **Step 10: Create adapters/__init__.py**

```python
# tools/social-poster/src/social_poster/adapters/__init__.py
from .x import XAdapter
from .bluesky import BlueskyAdapter
from .reddit import RedditAdapter
from .pinterest import PinterestAdapter
from .tiktok import TikTokAdapter
from .linkedin import LinkedInAdapter

ALL_ADAPTERS = {
    a.name: a()
    for a in [XAdapter, BlueskyAdapter, RedditAdapter, PinterestAdapter, TikTokAdapter, LinkedInAdapter]
}
```

- [ ] **Step 11: Run tests**

```bash
pytest tests/test_adapters.py -v
```
Expected: 5 passed

- [ ] **Step 12: Commit**

```bash
git add src/social_poster/adapters/ tests/test_adapters.py
git commit -m "feat(social-poster): all platform adapters (X, Bluesky, Reddit, Pinterest, TikTok, LinkedIn)"
```

---

### Task 4: poster orchestrator + CLI

**Files:**
- Create: `tools/social-poster/src/social_poster/poster.py`
- Create: `tools/social-poster/src/social_poster/cli.py`
- Create: `tools/social-poster/tests/test_poster.py`

**Interfaces:**
- Consumes: `content_loader.load_latest_articles`, `post_log.already_posted`, `post_log.record_post`, `adapters.ALL_ADAPTERS`, `social_lib.credentials.read_creds`
- Produces:
  - `post_domain(domain: str, platforms: list[str] | None = None) -> list[dict]` — returns list of `{platform, slug, result: "posted"|"skipped"|"error", url?, error?}`

- [ ] **Step 1: Write failing test**

```python
# tools/social-poster/tests/test_poster.py
from unittest.mock import patch, MagicMock
import pytest
from social_poster.poster import post_domain
from social_poster.content_loader import Article


MOCK_ARTICLE = Article(
    slug="test-slug", title="Test Title",
    url="https://example.com/articles/test-slug",
    summary="A summary.", tags=["test"], published_at="2026-06-28T00:00:00Z"
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


def test_post_domain_skips_already_posted(monkeypatch, tmp_path):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    ops = tmp_path / "sites" / "example.com" / "ops" / "social"
    ops.mkdir(parents=True)
    import json
    (ops / "post-log.jsonl").write_text(
        json.dumps({"slug": "test-slug", "platform": "bluesky", "post_url": "old", "posted_at": "x"}) + "\n"
    )

    with patch("social_poster.poster.load_latest_articles", return_value=[MOCK_ARTICLE]), \
         patch("social_poster.poster.read_creds", return_value={}):
        results = post_domain("example.com", platforms=["bluesky"])

    assert results[0]["result"] == "skipped"
```

- [ ] **Step 2: Implement poster.py**

```python
# tools/social-poster/src/social_poster/poster.py
from __future__ import annotations
from social_poster.content_loader import load_latest_articles
from social_poster.post_log import already_posted, record_post
from social_poster.adapters import ALL_ADAPTERS
from social_lib.credentials import read_creds


def post_domain(domain: str, platforms: list[str] | None = None) -> list[dict]:
    active = platforms or list(ALL_ADAPTERS.keys())
    articles = load_latest_articles(domain, limit=5)
    results = []

    for article in articles:
        for platform_name in active:
            if platform_name not in ALL_ADAPTERS:
                continue
            if already_posted(domain, article.slug, platform_name):
                results.append({"platform": platform_name, "slug": article.slug, "result": "skipped"})
                continue
            creds = read_creds(domain, platform_name)
            if not creds:
                results.append({"platform": platform_name, "slug": article.slug, "result": "skipped", "reason": "no creds"})
                continue
            try:
                adapter = ALL_ADAPTERS[platform_name]
                url = adapter.post(article, creds)
                record_post(domain, article.slug, platform_name, url)
                results.append({"platform": platform_name, "slug": article.slug, "result": "posted", "url": url})
                break  # only post one article per platform per run
            except Exception as e:
                results.append({"platform": platform_name, "slug": article.slug, "result": "error", "error": str(e)})

    return results
```

- [ ] **Step 3: Implement cli.py**

```python
# tools/social-poster/src/social_poster/cli.py
from __future__ import annotations
import click
from rich.console import Console
from rich.table import Table
from social_poster.poster import post_domain
from social_poster.post_log import recent_posts

console = Console()


@click.group()
def cli():
    """Social media poster — post site articles to all platforms."""


@cli.command()
@click.argument("domain")
@click.option("--platforms", default=None, help="Comma-separated list, e.g. x,bluesky,reddit")
@click.option("--dry-run", is_flag=True, help="Show what would be posted without posting")
def post(domain: str, platforms: str | None, dry_run: bool):
    """Post latest article(s) from DOMAIN to social platforms."""
    platform_list = [p.strip() for p in platforms.split(",")] if platforms else None

    if dry_run:
        from social_poster.content_loader import load_latest_articles
        articles = load_latest_articles(domain, limit=3)
        console.print(f"[bold]Dry run for {domain}[/bold]")
        for a in articles:
            console.print(f"  {a.slug}: {a.title}")
        return

    results = post_domain(domain, platforms=platform_list)
    table = Table(title=f"Post results — {domain}")
    table.add_column("Platform")
    table.add_column("Article")
    table.add_column("Result")
    table.add_column("URL")
    for r in results:
        status = {"posted": "[green]posted[/green]", "skipped": "[dim]skipped[/dim]", "error": "[red]error[/red]"}.get(r["result"], r["result"])
        table.add_row(r["platform"], r["slug"], status, r.get("url", r.get("error", "")))
    console.print(table)


@cli.command()
@click.argument("domain")
@click.option("--limit", default=20)
def log(domain: str, limit: int):
    """Show recent post log for DOMAIN."""
    posts = recent_posts(domain, limit=limit)
    if not posts:
        console.print("No posts logged yet.")
        return
    table = Table(title=f"Post log — {domain}")
    table.add_column("Platform")
    table.add_column("Slug")
    table.add_column("Posted At")
    for p in posts:
        table.add_row(p["platform"], p["slug"], p["posted_at"][:19])
    console.print(table)
```

- [ ] **Step 4: Run all tests**

```bash
pytest -v
```
Expected: all tests pass

- [ ] **Step 5: Install and smoke test**

```bash
pip install -e . -q
social-poster --help
social-poster post --help
```

- [ ] **Step 6: Commit**

```bash
git add src/social_poster/poster.py src/social_poster/cli.py tests/test_poster.py
git commit -m "feat(social-poster): orchestrator + CLI"
```

---

### Task 5: cron role + skill

**Files:**
- Create: `tools/social-poster/cron/run.sh`
- Create: `.claude/skills/domains-cron-role-social-poster/SKILL.md`
- Create: `.claude/skills/domains-social-setup/SKILL.md`
- Create: `.claude/skills/domains-social-status/SKILL.md`

- [ ] **Step 1: Create cron/run.sh**

```bash
#!/usr/bin/env bash
# tools/social-poster/cron/run.sh
# Called by supercronic inside each site's ops container.
# Expects DOMAIN env var and .env.shared sourced by container entrypoint.
set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN env var required}"
LOG_DIR="${LOG_DIR:-/app/logs}"
mkdir -p "$LOG_DIR"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] social-poster starting for $DOMAIN" >> "$LOG_DIR/social-poster.log"

social-poster post "$DOMAIN" >> "$LOG_DIR/social-poster.log" 2>&1 || {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: social-poster failed" >> "$LOG_DIR/social-poster.log"
    exit 1
}
```

```bash
chmod +x tools/social-poster/cron/run.sh
```

- [ ] **Step 2: Create domains-cron-role-social-poster skill**

```markdown
<!-- .claude/skills/domains-cron-role-social-poster/SKILL.md -->
---
name: domains-cron-role-social-poster
description: Install the social-poster cron role on a site's ops container. Posts latest articles to all active social platforms 2x/day. Use after social accounts are provisioned for the site.
---

# Social Poster Cron Role Installer

## Prerequisites
- Site must have social accounts provisioned (`social-setup status <domain>` shows platforms as provisioned)
- Ops container must be running

## Add to site's crontab

In `sites/<domain>/ops/supercronic/crontab`, add:
```
0 9,17 * * * /app/cron/social-poster/run.sh
```

## Copy runner into ops container

```bash
mkdir -p sites/<domain>/ops/cron/social-poster/
cp tools/social-poster/cron/run.sh sites/<domain>/ops/cron/social-poster/run.sh
chmod +x sites/<domain>/ops/cron/social-poster/run.sh
```

Add to `sites/<domain>/ops/Dockerfile` or volume mount so the script is available inside the container.

## Install social-poster package in container

In `sites/<domain>/ops/requirements.txt` (or equivalent), add:
```
social-poster @ file:///app/tools/social-poster
social-lib @ file:///app/tools/social-lib
```

## Restart container

```bash
cd sites/<domain>/ops
docker compose restart
```

## Verify

```bash
docker compose exec ops social-poster post <domain> --dry-run
```
Expected: shows articles that would be posted.
```

- [ ] **Step 3: Create domains-social-setup skill**

```markdown
<!-- .claude/skills/domains-social-setup/SKILL.md -->
---
name: domains-social-setup
description: Provision social media accounts for a domain site. Creates accounts on X, TikTok, LinkedIn, Reddit, Pinterest, Bluesky via CloakBrowser + VPN. Use when onboarding a new site or adding social presence to an existing one.
---

# Social Media Account Provisioner

## Prerequisites

```bash
# Ensure VPN proxy is running
cd /home/jesse/projects/domains/tools/vpn-proxy
docker compose ps  # should show vpn-us and vpn-eu as healthy
# If not: docker compose --env-file ../../.env up -d

# Install tools
cd /home/jesse/projects/domains
pip install -e tools/social-lib/ -e tools/social-setup/ -q
source .env
```

## Provision a site

```bash
social-setup provision <domain>
# e.g.: social-setup provision americastrikes.com
```

This provisions in order: Bluesky → Reddit → Pinterest → X → TikTok → LinkedIn

## SMS gate (X and TikTok)

When X or TikTok asks for phone verification, CloakBrowser pauses and prints:
```
[SMS GATE] Code sent to 6107378479
Write it to /tmp/cloak-gates/<gate-name>.continue to continue.
```
Check Jesse's phone. Then in another terminal:
```bash
echo "123456" > /tmp/cloak-gates/<gate-name>.continue
```

## Check status

```bash
social-setup status <domain>
social-setup status --all
```

## Include Meta (when ready)

```bash
social-setup provision <domain> --include-meta
# Requires SMSPOOL_API_KEY in .env
```
```

- [ ] **Step 4: Create domains-social-status skill**

```markdown
<!-- .claude/skills/domains-social-status/SKILL.md -->
---
name: domains-social-status
description: Show fleet-wide social media status — which sites have accounts provisioned, which platforms are active, and recent post activity. Use for auditing or before onboarding a new site.
---

# Social Media Fleet Status

## Account provisioning status

```bash
social-setup status --all
```
Shows per-site, per-platform: provisioned / pending / deferred

## Recent posts

```bash
social-poster log <domain> --limit 20
```

## All sites at a glance

```bash
for site in $(ls /home/jesse/projects/domains/sites/); do
    echo "--- $site ---"
    social-setup status "$site" 2>/dev/null || echo "  (not configured)"
done
```

## Persona status

```bash
persona status --all
```
```

- [ ] **Step 5: Commit everything**

```bash
git add tools/social-poster/cron/ .claude/skills/domains-cron-role-social-poster/ .claude/skills/domains-social-setup/ .claude/skills/domains-social-status/
git commit -m "feat(social-poster): cron role + all 4 skills (social-setup, persona-create, poster, status)"
```

---

### Task 6: End-to-end test on americastrikes.com

This task validates the full stack on the designated test site.

- [ ] **Step 1: Verify VPN proxy is running**

```bash
cd /home/jesse/projects/domains/tools/vpn-proxy
./check-health.sh
```
Expected: `healthy` + non-home IP for `vpn-us`

- [ ] **Step 2: Provision social accounts**

```bash
cd /home/jesse/projects/domains
source .env
social-setup provision americastrikes.com
```
Follow SMS gate prompts for X and TikTok. Each platform takes 3-5 minutes.

- [ ] **Step 3: Verify creds written**

```bash
ls -la sites/americastrikes.com/ops/social/
social-setup status americastrikes.com
```
Expected: `.bluesky-creds`, `.reddit-creds`, `.x-creds`, `.tiktok-creds`, `.linkedin-creds`, `.pinterest-creds` all present and non-empty.

- [ ] **Step 4: Create 2 reporter personas**

```bash
persona create --site americastrikes.com --count 2 --role "reporter"
persona list --site americastrikes.com
```
Expected: 2 personas with names, emails, avatars.

- [ ] **Step 5: Test poster dry-run**

```bash
social-poster post americastrikes.com --dry-run
```
Expected: shows article titles that would be posted.

- [ ] **Step 6: Live post to Bluesky (lowest-risk platform first)**

```bash
social-poster post americastrikes.com --platforms bluesky
```
Expected: `posted` result with a `bsky.app` URL. Verify by opening the URL.

- [ ] **Step 7: Commit parent submodule pointer**

```bash
cd /home/jesse/projects/domains
git add sites/americastrikes.com
git commit -m "chore: americastrikes social accounts provisioned + personas created"
git push
```
