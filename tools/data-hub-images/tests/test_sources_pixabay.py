import pytest

from datahub_images.sources import pixabay, SOURCE_FETCHERS
from datahub_images.sources import SourceUnavailable


def test_pixabay_missing_key_raises(monkeypatch):
    monkeypatch.delenv("PIXABAY_API_KEY", raising=False)
    with pytest.raises(SourceUnavailable):
        pixabay.search("Strait of Hormuz", 6, proxy="http://p:8888")


def test_pixabay_normalizes(monkeypatch):
    monkeypatch.setenv("PIXABAY_API_KEY", "test-key")
    fake = {"hits": [{
        "id": 99,
        "largeImageURL": "https://pixabay.com/large/99.jpg",
        "pageURL": "https://pixabay.com/photos/ship-99/",
        "imageWidth": 1920, "imageHeight": 1280,
        "user": "PixUser",
        "tags": "ship, ocean, military",
    }]}
    monkeypatch.setattr("datahub_images.sources.pixabay._get_json", lambda *a, **k: fake)
    out = pixabay.search("ship", 6, proxy="http://p:8888")
    assert out[0]["url"] == "https://pixabay.com/large/99.jpg"
    assert out[0]["width"] == 1920 and out[0]["height"] == 1280
    assert out[0]["license"] == "Pixabay License"
    assert out[0]["credit"]["source"] == "Pixabay"
    assert out[0]["credit"]["photographer"] == "PixUser"
    assert out[0]["source_image_key"] == "https://pixabay.com/photos/ship-99/"
    assert out[0]["tags"] == ["ship", "ocean", "military"]
    assert "pixabay" in SOURCE_FETCHERS


def test_pixabay_missing_dimensions_default_to_zero(monkeypatch):
    monkeypatch.setenv("PIXABAY_API_KEY", "test-key")
    fake = {"hits": [{"largeImageURL": "https://pixabay.com/large/1.jpg", "pageURL": "https://pixabay.com/photos/1/"}]}
    monkeypatch.setattr("datahub_images.sources.pixabay._get_json", lambda *a, **k: fake)
    out = pixabay.search("q", 6, proxy=None)
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["credit"]["photographer"] == "Pixabay contributor"
    assert out[0]["tags"] == []
