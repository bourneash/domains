import pytest

from datahub_images.sources import dvids, SOURCE_FETCHERS
from datahub_images.sources import SourceUnavailable


def test_dvids_missing_key_raises(monkeypatch):
    monkeypatch.delenv("DVIDS_API_KEY", raising=False)
    with pytest.raises(SourceUnavailable):
        dvids.search("carrier strike group", 6, proxy="http://p:8888")


def test_dvids_normalizes(monkeypatch):
    monkeypatch.setenv("DVIDS_API_KEY", "test-key")
    search_resp = {"results": [{"id": "photo:1234", "type": "image", "url": "https://dvidshub.net/image/1234", "width": 1600, "height": 1067}]}
    asset_resp = {"results": {
        "image": "https://cloudfront.example/1234.jpg",
        "image_width": "1920", "image_height": "1280",
        "release_status": "released",
        "credit": {"rank": "PO2", "name": "John Doe"},
        "unit_name": "USS Nimitz",
        "url": "https://dvidshub.net/image/1234",
    }}
    responses = iter([search_resp, asset_resp])
    monkeypatch.setattr("datahub_images.sources.dvids._get_json", lambda *a, **k: next(responses))
    out = dvids.search("carrier strike group", 6, proxy="http://p:8888")
    assert out[0]["url"] == "https://cloudfront.example/1234.jpg"
    assert out[0]["width"] == 1920 and out[0]["height"] == 1280
    assert out[0]["license"] == "Public Domain (US Government work)"
    assert out[0]["credit"]["source"] == "DVIDS"
    assert out[0]["credit"]["photographer"] == "PO2 John Doe / USS Nimitz / DVIDS"
    assert out[0]["source_image_key"] == "https://dvidshub.net/image/1234"
    assert "dvids" in SOURCE_FETCHERS


def test_dvids_skips_unreleased_and_missing_dimensions_default_to_zero(monkeypatch):
    monkeypatch.setenv("DVIDS_API_KEY", "test-key")
    search_resp = {"results": [
        {"id": "a", "type": "image", "url": "https://dvidshub.net/image/a"},
        {"id": "b", "type": "image", "url": "https://dvidshub.net/image/b"},
    ]}
    asset_a = {"results": {"image": "https://cloudfront.example/a.jpg", "release_status": "pending review"}}
    asset_b = {"results": {"image": "https://cloudfront.example/b.jpg"}}
    responses = iter([search_resp, asset_a, asset_b])
    monkeypatch.setattr("datahub_images.sources.dvids._get_json", lambda *a, **k: next(responses))
    out = dvids.search("q", 6, proxy=None)
    assert len(out) == 1
    assert out[0]["url"] == "https://cloudfront.example/b.jpg"
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["credit"]["photographer"] == "DVIDS"
