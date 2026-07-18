from googleapiclient.errors import HttpError

from gsc_verify import console


class FakeSites:
    def __init__(self, error=None):
        self.error = error
        self.added = []

    def add(self, siteUrl=None):
        if self.error:
            raise self.error
        self.added.append(siteUrl)
        return type("R", (), {"execute": lambda _s: {}})()


class FakeSitemaps:
    def __init__(self):
        self.submitted = []

    def submit(self, siteUrl=None, feedpath=None):
        self.submitted.append((siteUrl, feedpath))
        return type("R", (), {"execute": lambda _s: {}})()


def _client(sites=None, sitemaps=None):
    s, m = sites or FakeSites(), sitemaps or FakeSitemaps()
    return type("C", (), {"sites": lambda _c: s, "sitemaps": lambda _c: m})()


def test_sc_property_uses_domain_prefix():
    assert console.sc_property("example.com") == "sc-domain:example.com"


def test_add_site_uses_domain_property():
    sites = FakeSites()
    assert console.add_site(_client(sites), "example.com") == "added"
    assert sites.added == ["sc-domain:example.com"]


def test_add_site_failure_is_reported_not_raised():
    err = HttpError(type("R", (), {"status": 403, "reason": "Forbidden"})(), b"denied")
    assert console.add_site(_client(FakeSites(error=err)), "example.com").startswith("failed:")


def test_submit_sitemap_defaults_to_site_root():
    sitemaps = FakeSitemaps()
    assert console.submit_sitemap(_client(sitemaps=sitemaps), "example.com") == "submitted"
    assert sitemaps.submitted == [
        ("sc-domain:example.com", "https://example.com/sitemap.xml")
    ]
