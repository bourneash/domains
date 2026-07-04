import pytest

from datahub_images.sources import govflickr, SOURCE_FETCHERS
from datahub_images.sources import SourceUnavailable


def test_govflickr_missing_key_raises(monkeypatch):
    monkeypatch.delenv("FLICKR_API_KEY", raising=False)
    with pytest.raises(SourceUnavailable):
        govflickr.search("carrier strike group", 6, proxy="http://p:8888")


def test_govflickr_normalizes(monkeypatch):
    monkeypatch.setenv("FLICKR_API_KEY", "test-key")
    fake = {"photos": {"photo": [{
        "id": "5555",
        "owner": "22355218@N04",
        "ownername": "The White House",
        "url_l": "https://live.staticflickr.com/large.jpg",
        "width_l": "2048", "height_l": "1365",
        "tags": "military iran briefing",
    }]}}
    monkeypatch.setattr("datahub_images.sources.govflickr._get_json", lambda *a, **k: fake)
    out = govflickr.search("briefing", 1, proxy="http://p:8888")
    assert out[0]["url"] == "https://live.staticflickr.com/large.jpg"
    assert out[0]["width"] == 2048 and out[0]["height"] == 1365
    assert out[0]["license"] == "Public Domain (U.S. Government work)"
    assert out[0]["credit"]["source"] == "Flickr (The White House)"
    assert out[0]["credit"]["photographer"] == "The White House"
    assert out[0]["source_image_key"] == "https://www.flickr.com/photos/22355218@N04/5555"
    assert out[0]["tags"] == ["military", "iran", "briefing"]
    assert "govflickr" in SOURCE_FETCHERS
    assert len(out) == 1  # stopped once limit reached, didn't query remaining photostreams


def test_govflickr_missing_dimensions_default_to_zero(monkeypatch):
    monkeypatch.setenv("FLICKR_API_KEY", "test-key")
    fake = {"photos": {"photo": [{"id": "1", "owner": "22355218@N04", "url_l": "https://live.staticflickr.com/x.jpg"}]}}
    monkeypatch.setattr("datahub_images.sources.govflickr._get_json", lambda *a, **k: fake)
    out = govflickr.search("q", 1, proxy=None)
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["credit"]["photographer"] == "The White House"
    assert out[0]["tags"] == []
