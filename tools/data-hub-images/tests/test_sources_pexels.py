import pytest

from datahub_images.sources import pexels, SOURCE_FETCHERS
from datahub_images.sources import SourceUnavailable


def test_pexels_missing_key_raises(monkeypatch):
    monkeypatch.delenv("PEXELS_API_KEY", raising=False)
    with pytest.raises(SourceUnavailable):
        pexels.search("Strait of Hormuz", 6, proxy="http://p:8888")


def test_pexels_normalizes(monkeypatch):
    monkeypatch.setenv("PEXELS_API_KEY", "test-key")
    fake = {"photos": [{
        "id": 42,
        "url": "https://www.pexels.com/photo/42",
        "src": {"large2x": "https://images.pexels.com/large2x.jpg", "original": "https://images.pexels.com/orig.jpg"},
        "width": 1880, "height": 1253,
        "photographer": "John Smith",
        "photographer_url": "https://www.pexels.com/@johnsmith",
        "alt": "Cargo ship at sea",
    }]}
    monkeypatch.setattr("datahub_images.sources.pexels._get_json", lambda *a, **k: fake)
    out = pexels.search("cargo ship", 6, proxy="http://p:8888")
    assert out[0]["url"] == "https://images.pexels.com/large2x.jpg"
    assert out[0]["width"] == 1880 and out[0]["height"] == 1253
    assert out[0]["license"] == "Pexels License"
    assert out[0]["credit"]["source"] == "Pexels"
    assert out[0]["credit"]["photographer"] == "John Smith"
    assert out[0]["credit"]["url"] == "https://www.pexels.com/@johnsmith"
    assert out[0]["source_image_key"] == "https://www.pexels.com/photo/42"
    assert "pexels" in SOURCE_FETCHERS


def test_pexels_missing_dimensions_default_to_zero(monkeypatch):
    monkeypatch.setenv("PEXELS_API_KEY", "test-key")
    fake = {"photos": [{"src": {"original": "https://images.pexels.com/orig.jpg"}}]}
    monkeypatch.setattr("datahub_images.sources.pexels._get_json", lambda *a, **k: fake)
    out = pexels.search("q", 6, proxy=None)
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["credit"]["photographer"] == "Pexels photographer"
