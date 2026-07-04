import pytest

from datahub_images.sources import unsplash, SOURCE_FETCHERS
from datahub_images.sources import SourceUnavailable


def test_unsplash_missing_key_raises(monkeypatch):
    monkeypatch.delenv("UNSPLASH_ACCESS_KEY", raising=False)
    with pytest.raises(SourceUnavailable):
        unsplash.search("Strait of Hormuz", 6, proxy="http://p:8888")


def test_unsplash_normalizes(monkeypatch):
    monkeypatch.setenv("UNSPLASH_ACCESS_KEY", "test-key")
    fake = {"results": [{
        "id": "abc123",
        "urls": {"full": "https://images.unsplash.com/full.jpg", "regular": "https://images.unsplash.com/reg.jpg"},
        "width": 1600, "height": 900,
        "user": {"name": "Jane Doe"},
        "links": {"html": "https://unsplash.com/photos/abc123", "download_location": "https://api.unsplash.com/photos/abc123/download"},
        "tags": [{"title": "military"}, {"title": "ship"}],
    }]}
    monkeypatch.setattr("datahub_images.sources.unsplash._get_json", lambda *a, **k: fake)
    out = unsplash.search("Strait of Hormuz", 6, proxy="http://p:8888")
    assert out[0]["url"] == "https://images.unsplash.com/full.jpg"
    assert out[0]["width"] == 1600 and out[0]["height"] == 900
    assert out[0]["license"] == "Unsplash License"
    assert out[0]["credit"]["source"] == "Unsplash"
    assert out[0]["credit"]["photographer"] == "Jane Doe"
    assert out[0]["credit"]["url"] == "https://unsplash.com/photos/abc123"
    assert out[0]["source_image_key"] == "https://unsplash.com/photos/abc123"
    assert out[0]["tags"] == ["military", "ship"]
    assert out[0]["download_location"] == "https://api.unsplash.com/photos/abc123/download"
    assert "unsplash" in SOURCE_FETCHERS


def test_unsplash_missing_dimensions_default_to_zero(monkeypatch):
    monkeypatch.setenv("UNSPLASH_ACCESS_KEY", "test-key")
    fake = {"results": [{"id": "x", "urls": {"regular": "https://images.unsplash.com/r.jpg"}}]}
    monkeypatch.setattr("datahub_images.sources.unsplash._get_json", lambda *a, **k: fake)
    out = unsplash.search("q", 6, proxy=None)
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["credit"]["photographer"] == "Unsplash photographer"
