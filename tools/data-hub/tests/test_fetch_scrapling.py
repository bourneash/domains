import sys
import types

import pytest

from datahub.config import Source
from datahub import fetch_scrapling


class _Node:
    def __init__(self, values, attrs=None):
        self.values = values
        self.attrib = attrs or {}

    def css(self, selector):
        return self.values.get(selector, [])

    def get(self):
        return self.values.get("text", "")


class _Page:
    def __init__(self, nodes):
        self.nodes = nodes

    def css(self, selector):
        return self.nodes if selector == "article" else []


def _source(**fetch):
    return Source(id="public-community", type="scrapling", url="https://example.test/feed",
                  tags=["community-fishing"], policy="direct", fetch=fetch)


def test_fetch_html_normalizes_public_cards(monkeypatch):
    node = _Node({"h2": [_Node({"text": "Stripers reported"})],
                  "a[href]": [_Node({"text": "source"}, {"href": "/post/1"})],
                  "p": [_Node({"text": "Short attributed summary"})],
                  "time": [_Node({"text": "2026-09-25", "datetime": "2026-09-25"})]})
    fake_fetcher = types.SimpleNamespace(get=lambda *args, **kwargs: _Page([node]))
    monkeypatch.setitem(sys.modules, "scrapling", types.ModuleType("scrapling"))
    fetchers = types.ModuleType("scrapling.fetchers")
    fetchers.Fetcher = fake_fetcher
    monkeypatch.setitem(sys.modules, "scrapling.fetchers", fetchers)
    monkeypatch.setattr(fetch_scrapling, "_allowed_by_robots", lambda *args: True)

    rows = fetch_scrapling.fetch_html(_source(title_selector="h2", published_selector="time"))
    assert rows[0]["title"] == "Stripers reported"
    assert rows[0]["url"] == "https://example.test/post/1"
    assert rows[0]["tags"] == ["community-fishing"]
    assert rows[0]["raw"]["collector"] == "scrapling"


def test_fetch_html_rejects_proxy(monkeypatch):
    with pytest.raises(fetch_scrapling.ScraplingPolicyError, match="do not use collector proxies"):
        fetch_scrapling.fetch_html(_source(), proxy="http://proxy.invalid")


def test_fetch_html_requires_robots_policy():
    with pytest.raises(fetch_scrapling.ScraplingPolicyError, match="robots_txt_obey"):
        fetch_scrapling.fetch_html(_source(robots_txt_obey=False))


def test_fetch_html_does_not_follow_external_links(monkeypatch):
    node = _Node({"h2": [_Node({"text": "External"})],
                  "a[href]": [_Node({"text": "external"}, {"href": "https://other.test/post"})]})
    fake_fetcher = types.SimpleNamespace(get=lambda *args, **kwargs: _Page([node]))
    monkeypatch.setitem(sys.modules, "scrapling", types.ModuleType("scrapling"))
    fetchers = types.ModuleType("scrapling.fetchers")
    fetchers.Fetcher = fake_fetcher
    monkeypatch.setitem(sys.modules, "scrapling.fetchers", fetchers)
    monkeypatch.setattr(fetch_scrapling, "_allowed_by_robots", lambda *args: True)
    assert fetch_scrapling.fetch_html(_source(title_selector="h2")) == []
