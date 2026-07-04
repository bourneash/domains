from datahub_images.sources import nara, SOURCE_FETCHERS


def test_nara_normalizes(monkeypatch):
    fake = {"body": {"hits": {"hits": [{"_source": {"record": {
        "naId": "12345",
        "title": "USS Enterprise underway",
        "digitalObjects": [{"objectUrl": "https://catalog.archives.gov/img/12345.jpg",
                              "objectWidth": 1600, "objectHeight": 1200}],
    }}}]}}}
    monkeypatch.setattr("datahub_images.sources.nara._get_json", lambda *a, **k: fake)
    out = nara.search("USS Enterprise", 6, proxy="http://p:8888")
    assert out[0]["url"] == "https://catalog.archives.gov/img/12345.jpg"
    assert out[0]["width"] == 1600 and out[0]["height"] == 1200
    assert out[0]["license"] == "Public Domain"
    assert out[0]["credit"]["source"] == "U.S. National Archives"
    assert out[0]["source_image_key"] == "https://catalog.archives.gov/id/12345"
    assert "nara" in SOURCE_FETCHERS


def test_nara_missing_dimensions_default_to_zero_and_skips_records_without_digital_objects(monkeypatch):
    fake = {"body": {"hits": {"hits": [
        {"_source": {"record": {"naId": "1"}}},
        {"_source": {"record": {"naId": "2", "digitalObjects": [{"objectUrl": "https://catalog.archives.gov/img/2.jpg"}]}}},
    ]}}}
    monkeypatch.setattr("datahub_images.sources.nara._get_json", lambda *a, **k: fake)
    out = nara.search("q", 6, proxy=None)
    assert len(out) == 1
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["source_image_key"] == "https://catalog.archives.gov/id/2"
