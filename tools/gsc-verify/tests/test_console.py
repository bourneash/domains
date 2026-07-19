from googleapiclient.errors import HttpError

from gsc_verify import console


def _http_error(status):
    return HttpError(type("R", (), {"status": status, "reason": "x"})(), b"x")


class FakeSites:
    def __init__(self, error=None, fail_times=0, fail_status=429):
        self.error = error
        self.fail_times = fail_times
        self.fail_status = fail_status
        self.calls = 0
        self.added = []

    def add(self, siteUrl=None):
        self.calls += 1
        if self.error:
            raise self.error
        if self.calls <= self.fail_times:
            raise _http_error(self.fail_status)
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


def test_add_site_retries_429_then_succeeds():
    """A transient rate limit must not be reported as a failure — it must
    be retried with backoff and succeed once the burst clears. This is the
    real bug hit registering 17 domains back-to-back on the live fleet."""
    sites = FakeSites(fail_times=2, fail_status=429)
    delays = []
    result = console.add_site(_client(sites), "example.com", sleep=delays.append)
    assert result == "added"
    assert sites.added == ["sc-domain:example.com"]
    assert sites.calls == 3
    assert delays == [2, 4]  # exponential backoff, only for the two 429s


def test_add_site_exhausts_retries_on_persistent_429():
    sites = FakeSites(fail_times=99, fail_status=429)
    delays = []
    result = console.add_site(_client(sites), "example.com", sleep=delays.append)
    assert result == "failed:http-429"
    assert len(delays) == 3  # 3 retries after the initial attempt, then give up


def test_add_site_does_not_retry_non_429_errors():
    """A real failure (403 Forbidden) must return immediately — retrying it
    would just waste ~14s per domain on a fleet run for an error that will
    never resolve itself."""
    sites = FakeSites(fail_times=99, fail_status=403)
    delays = []
    result = console.add_site(_client(sites), "example.com", sleep=delays.append)
    assert result == "failed:http-403"
    assert sites.calls == 1
    assert delays == []


def test_submit_sitemap_retries_429_then_succeeds():
    class FlakySitemaps(FakeSitemaps):
        def __init__(self):
            super().__init__()
            self.calls = 0

        def submit(self, siteUrl=None, feedpath=None):
            self.calls += 1
            if self.calls <= 1:
                raise _http_error(429)
            return super().submit(siteUrl=siteUrl, feedpath=feedpath)

    sitemaps = FlakySitemaps()
    delays = []
    result = console.submit_sitemap(_client(sitemaps=sitemaps), "example.com", sleep=delays.append)
    assert result == "submitted"
    assert delays == [2]
