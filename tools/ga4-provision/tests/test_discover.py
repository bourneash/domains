import pytest

from ga4_provision import discover


class FakeRequest:
    """Models a google-api-python-client request object: .execute() -> page."""

    def __init__(self, page):
        self._page = page

    def execute(self):
        return self._page


class FakeProperties:
    def __init__(self, pages):
        self._pages = pages
        self._i = 0

    def list(self, **kw):
        page = self._pages[self._i]
        self._i += 1
        return FakeRequest(page)

    def list_next(self, request, response):
        if self._i >= len(self._pages):
            return None
        page = self._pages[self._i]
        self._i += 1
        return FakeRequest(page)


def test_discover_returns_properties():
    pages = [{
        "properties": [
            {"name": "properties/123", "displayName": "saveusfarms.com",
             "parent": "accounts/396394354"},
            {"name": "properties/456", "displayName": "xxxtea.com",
             "parent": "accounts/396394354"},
        ]
    }]
    client = type("C", (), {"properties": lambda _s: FakeProperties(pages)})()
    result = discover.discover_properties(client)
    assert [p.property_id for p in result] == ["123", "456"]
    assert result[0].display_name == "saveusfarms.com"
    assert result[0].account_id == "396394354"


def test_empty_account_returns_empty_list():
    client = type("C", (), {"properties": lambda _s: FakeProperties([{}])})()
    assert discover.discover_properties(client) == []


def test_discover_paginates_across_multiple_pages():
    pages = [
        {
            "properties": [
                {"name": "properties/123", "displayName": "saveusfarms.com",
                 "parent": "accounts/396394354"},
            ]
        },
        {
            "properties": [
                {"name": "properties/456", "displayName": "xxxtea.com",
                 "parent": "accounts/396394354"},
            ]
        },
    ]
    client = type("C", (), {"properties": lambda _s: FakeProperties(pages)})()
    result = discover.discover_properties(client)
    assert [p.property_id for p in result] == ["123", "456"]
    assert result[0].display_name == "saveusfarms.com"
    assert result[1].display_name == "xxxtea.com"


def test_missing_parent_raises():
    pages = [{
        "properties": [
            {"name": "properties/123", "displayName": "saveusfarms.com"},
        ]
    }]
    client = type("C", (), {"properties": lambda _s: FakeProperties(pages)})()
    with pytest.raises(KeyError):
        discover.discover_properties(client)


def test_malformed_resource_name_raises():
    pages = [{
        "properties": [
            {"name": "properties/", "displayName": "saveusfarms.com",
             "parent": "accounts/396394354"},
        ]
    }]
    client = type("C", (), {"properties": lambda _s: FakeProperties(pages)})()
    with pytest.raises(ValueError):
        discover.discover_properties(client)
