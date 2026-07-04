from datahub_images.sources import wikimedia, SOURCE_FETCHERS


def test_wikimedia_normalizes(monkeypatch):
    fake = {"query": {"pages": {"1": {"title": "File:Strait.jpg", "imageinfo": [
        {"url": "https://upload/strait.jpg", "width": 1600, "height": 900,
         "extmetadata": {"LicenseShortName": {"value": "CC BY 2.0"}, "Artist": {"value": "Jane"}},
         "descriptionurl": "https://commons/wiki/File:Strait.jpg"}]}}}}
    monkeypatch.setattr("datahub_images.sources.wikimedia._get_json", lambda *a, **k: fake)
    out = wikimedia.search("Strait of Hormuz", 6, proxy="http://p:8888")
    assert out[0]["url"] == "https://upload/strait.jpg"
    assert out[0]["width"] == 1600 and out[0]["license"] == "CC BY 2.0"
    assert out[0]["credit"]["source"] == "Wikimedia Commons"
    assert "wikimedia" in SOURCE_FETCHERS


def test_wikimedia_normalizes_missing_dimensions_default_to_zero(monkeypatch):
    fake = {"query": {"pages": {"1": {"title": "File:NoDims.jpg", "imageinfo": [
        {"url": "https://upload/nodims.jpg",
         "extmetadata": {},
         "descriptionurl": "https://commons/wiki/File:NoDims.jpg"}]}}}}
    monkeypatch.setattr("datahub_images.sources.wikimedia._get_json", lambda *a, **k: fake)
    out = wikimedia.search("nothing", 6, proxy="http://p:8888")
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["license"] == "unknown"
    assert out[0]["credit"]["photographer"] == "Unknown"
    assert out[0]["source_image_key"] == "https://commons/wiki/File:NoDims.jpg"


def test_wikimedia_skips_pages_without_imageinfo(monkeypatch):
    fake = {"query": {"pages": {"1": {"title": "File:Missing.jpg"}}}}
    monkeypatch.setattr("datahub_images.sources.wikimedia._get_json", lambda *a, **k: fake)
    out = wikimedia.search("q", 6, proxy="http://p:8888")
    assert out == []
