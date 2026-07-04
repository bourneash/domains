from datahub_images.sources import loc, SOURCE_FETCHERS


def test_loc_normalizes(monkeypatch):
    fake = {"results": [{
        "id": "https://www.loc.gov/item/2020123456/",
        "title": "Aircraft carrier at sea",
        "image_url": ["https://tile.loc.gov/small.jpg", "https://tile.loc.gov/large.jpg"],
        "width": 3000, "height": 2000,
        "subject": ["Aircraft carriers", "United States Navy"],
    }]}
    monkeypatch.setattr("datahub_images.sources.loc._get_json", lambda *a, **k: fake)
    out = loc.search("aircraft carrier", 6, proxy="http://p:8888")
    assert out[0]["url"] == "https://tile.loc.gov/large.jpg"
    assert out[0]["width"] == 3000 and out[0]["height"] == 2000
    assert out[0]["license"] == "Library of Congress"
    assert out[0]["credit"]["source"] == "Library of Congress"
    assert out[0]["source_image_key"] == "https://www.loc.gov/item/2020123456/"
    assert out[0]["tags"] == ["Aircraft carriers", "United States Navy"]
    assert "loc" in SOURCE_FETCHERS


def test_loc_missing_dimensions_default_to_zero_and_skips_missing_image(monkeypatch):
    fake = {"results": [
        {"id": "https://www.loc.gov/item/1/"},
        {"id": "https://www.loc.gov/item/2/", "image_url": "https://tile.loc.gov/single.jpg"},
    ]}
    monkeypatch.setattr("datahub_images.sources.loc._get_json", lambda *a, **k: fake)
    out = loc.search("q", 6, proxy=None)
    assert len(out) == 1
    assert out[0]["width"] == 0 and out[0]["height"] == 0
    assert out[0]["tags"] == []
