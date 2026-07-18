from ga4_provision import discover


class FakeList:
    def __init__(self, pages):
        self._pages = pages
        self._i = 0

    def execute(self):
        return self._pages[self._i]


class FakeProperties:
    def __init__(self, pages):
        self._pages = pages
        self._i = 0

    def list(self, **kw):
        page = self._pages[self._i]
        self._i += 1
        return type("R", (), {"execute": lambda _s: page})()

    def list_next(self, request, response):
        return None if self._i >= len(self._pages) else object()


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
