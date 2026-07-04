from datahub_images.sources import openverse, SOURCE_FETCHERS


def test_openverse_normalizes(monkeypatch):
    fake = {"results": [{
        "id": "abc-123",
        "url": "https://openverse.example/img.jpg",
        "width": 2000, "height": 1333,
        "license": "cc0",
        "creator": "Jane Doe",
        "foreign_landing_url": "https://flickr.com/photos/jane/abc123",
        "tags": [{"name": "military"}, {"name": "aircraft"}],
    }]}
    monkeypatch.setattr("datahub_images.sources.openverse._get_json", lambda *a, **k: fake)
    out = openverse.search("aircraft", 6, proxy="http://p:8888")
    assert out[0]["url"] == "https://openverse.example/img.jpg"
    assert out[0]["width"] == 2000 and out[0]["height"] == 1333
    assert out[0]["license"] == "cc0"
    assert out[0]["credit"]["source"] == "Openverse"
    assert out[0]["credit"]["photographer"] == "Jane Doe"
    assert out[0]["source_image_key"] == "https://flickr.com/photos/jane/abc123"
    assert out[0]["tags"] == ["military", "aircraft"]
    assert "openverse" in SOURCE_FETCHERS


def test_openverse_missing_dimensions_and_landing_url_default(monkeypatch):
    fake = {"results": [{"id": "xyz", "url": "https://openverse.example/x.jpg"}]}
    monkeypatch.setattr("datahub_images.sources.openverse._get_json", lambda *a, **k: fake)
    out = openverse.search("q", 6, proxy=None)
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["license"] == "unknown"
    assert out[0]["credit"]["photographer"] == "Unknown"
    assert out[0]["source_image_key"] == "xyz"
    assert out[0]["tags"] == []
