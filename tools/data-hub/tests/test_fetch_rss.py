from pathlib import Path
import datahub.fetch_rss as fr
from datahub.config import Source

FIXTURE = (Path(__file__).parent / "fixtures" / "sample_feed.xml").read_bytes()


def test_fetch_rss_normalizes_and_skips_untitled(monkeypatch):
    monkeypatch.setattr(fr, "fetch_feed_bytes", lambda url, **kw: FIXTURE)
    src = Source(id="sample", type="rss", url="https://example.com/feed",
                 tags=["world", "defense"])
    items = fr.fetch_rss(src, proxy="http://h:8181")
    assert len(items) == 2  # untitled item dropped
    first = items[0]
    assert first["title"] == "Carrier transits the strait"
    assert first["url"] == "https://example.com/a"
    assert first["summary"] == "Tensions rise in the gulf."  # html stripped + ws collapsed
    assert first["source_id"] == "sample"
    assert first["tags"] == ["world", "defense"]
    assert first["published_iso"].startswith("2026-06-28T10:00:00")


def test_required_pattern_filters_entries(monkeypatch):
    monkeypatch.setattr(fr, "fetch_feed_bytes", lambda url, **kw: FIXTURE)
    src = Source(id="sample", type="rss", url="https://example.com/feed",
                 tags=["world"], fetch={"required_pattern": "market"})
    items = fr.fetch_rss(src, proxy=None)
    assert [i["title"] for i in items] == ["Markets wobble"]


def test_strip_html_collapses_whitespace():
    assert fr.strip_html("<p>a   b\n c</p>") == "a b c"
