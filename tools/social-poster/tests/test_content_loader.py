# tools/social-poster/tests/test_content_loader.py
import json
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


# --- Additional coverage ---

def test_article_dataclass_fields(fake_site):
    _write_md(fake_site, "slug-a", "Slug A", "2026-06-10", "A nice summary")
    articles = load_latest_articles("example.com")
    a = articles[0]
    assert a.slug == "slug-a"
    assert a.title == "Slug A"
    assert a.summary == "A nice summary"
    assert a.tags == ["news", "test"]
    assert a.published_at == "2026-06-10"
    assert a.image_url is None


def test_article_with_image(fake_site, monkeypatch):
    content_dir = fake_site / "src" / "content" / "articles"
    content_dir.mkdir(parents=True, exist_ok=True)
    (content_dir / "img-article.md").write_text(
        "---\ntitle: Image Article\npubDate: 2026-06-15\ndescription: Has image.\nimage: /cover.jpg\ntags: []\n---\nBody."
    )
    articles = load_latest_articles("example.com")
    assert articles[0].image_url == "/cover.jpg"


def test_fallback_to_content_json(fake_site, monkeypatch):
    data = [
        {"slug": "json-art", "title": "JSON Article", "published": "2026-06-20",
         "description": "From JSON.", "tags": ["alpha"]},
    ]
    (fake_site / "content.json").write_text(json.dumps(data))
    articles = load_latest_articles("example.com")
    assert len(articles) == 1
    assert articles[0].title == "JSON Article"
    assert articles[0].url == "https://example.com/articles/json-art"


def test_site_layout_with_site_subdir(tmp_path, monkeypatch):
    """Simulates the americastrikes.com layout: sites/<domain>/site/src/content/articles/"""
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    site = tmp_path / "sites" / "example.com"
    content_dir = site / "site" / "src" / "content" / "articles"
    content_dir.mkdir(parents=True)
    (content_dir / "nested-article.md").write_text(
        "---\ntitle: Nested Article\npublished: '2026-06-05T12:00:00Z'\ndescription: Deep layout.\nkeywords: [geo, defense]\n---\nBody."
    )
    articles = load_latest_articles("example.com")
    assert len(articles) == 1
    assert articles[0].title == "Nested Article"
    assert articles[0].tags == ["geo", "defense"]


def test_skips_md_without_title(fake_site):
    content_dir = fake_site / "src" / "content" / "articles"
    content_dir.mkdir(parents=True, exist_ok=True)
    (content_dir / "no-title.md").write_text("---\ndescription: No title here.\n---\nBody.")
    articles = load_latest_articles("example.com")
    assert articles == []


def test_summary_truncated_to_280(fake_site):
    long_desc = "x" * 400
    content_dir = fake_site / "src" / "content" / "articles"
    content_dir.mkdir(parents=True, exist_ok=True)
    (content_dir / "long.md").write_text(
        f"---\ntitle: Long\npubDate: 2026-06-01\ndescription: {long_desc}\ntags: []\n---\nBody."
    )
    articles = load_latest_articles("example.com")
    assert len(articles[0].summary) == 280


# --- Per-site nonstandard content sources ---


def test_json_collection_loader(tmp_path, monkeypatch):
    """Mirrors weirdgirlstore.com's one-JSON-file-per-product curios layout."""
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    site = tmp_path / "sites" / "weirdgirlstore.com"
    curios = site / "site" / "src" / "content" / "curios"
    curios.mkdir(parents=True)
    (curios / "old-thing.json").write_text(json.dumps({
        "slug": "old-thing", "name": "Old Thing", "tagline": "An old tagline.",
        "published": "2026-01-01",
    }))
    (curios / "new-thing.json").write_text(json.dumps({
        "slug": "new-thing", "name": "New Thing", "tagline": "A new tagline.",
        "published": "2026-06-01",
        "images": [{"src": "/images/curios/new-thing.webp"}],
    }))

    from social_poster.content_loader import load_latest_articles as _lla
    articles = _lla("weirdgirlstore.com", limit=5)
    assert [a.slug for a in articles] == ["new-thing", "old-thing"]
    assert articles[0].url == "https://weirdgirlstore.com/finds/new-thing/"
    assert articles[0].summary == "A new tagline."
    assert articles[0].image_url == "/images/curios/new-thing.webp"


def test_ts_record_array_loader(tmp_path, monkeypatch):
    """Mirrors ultrarough.com's affiliate.ts SKUS registry."""
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    site = tmp_path / "sites" / "ultrarough.com"
    lib_dir = site / "site" / "src" / "lib"
    lib_dir.mkdir(parents=True)
    (lib_dir / "affiliate.ts").write_text(
        "export const SKUS: Sku[] = [\n"
        "  {\n"
        "    id: 'first-sku',\n"
        "    name: 'First SKU',\n"
        "    blurb:\n"
        "      'The first one.',\n"
        "    image: 'first-image',\n"
        "  },\n"
        "  {\n"
        "    id: 'campaign-sku',\n"
        "    name: \"Campaign Only SKU\",\n"
        "    blurb: 'Hidden from grids.',\n"
        "    image: 'campaign-image',\n"
        "    campaignOnly: true,\n"
        "  },\n"
        "  {\n"
        "    id: 'second-sku',\n"
        "    name: 'Second SKU',\n"
        "    blurb: \"Meguiar's second one.\",\n"
        "    image: 'second-image',\n"
        "  },\n"
        "];\n"
    )

    from social_poster.content_loader import load_latest_articles as _lla
    articles = _lla("ultrarough.com", limit=5)
    # campaignOnly SKU excluded; newest (last in array) first.
    assert [a.slug for a in articles] == ["second-sku", "first-sku"]
    assert articles[0].url == "https://ultrarough.com/reviews/second-sku/"
    assert articles[0].summary == "Meguiar's second one."
    assert articles[0].image_url == "https://ultrarough.com/gallery/second-image-1200.webp"
