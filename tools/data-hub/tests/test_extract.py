import httpx

from datahub import extract


class _FakeResponse:
    def __init__(self, text, content_type="text/html", status=200):
        self.text = text
        self.headers = {"content-type": content_type}
        self._status = status

    def raise_for_status(self):
        if self._status >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=None)


class _FakeClient:
    def __init__(self, response=None, exc=None):
        self._response = response
        self._exc = exc
        self.closed = False

    def get(self, url, headers=None):
        if self._exc:
            raise self._exc
        return self._response

    def close(self):
        self.closed = True


ARTICLE_HTML = """
<html><body>
<article>
<h1>Carrier transits the strait</h1>
<p>Tensions rise in the gulf as a carrier group transits the strait of Hormuz
under escort, officials said Tuesday, in a move likely to draw scrutiny from
regional powers watching the corridor closely. Analysts said the deployment
follows weeks of escalating rhetoric between the two governments, and local
officials have urged calm while monitoring shipping lanes through the strait.</p>
</article>
</body></html>
"""

CONSENT_WALL_HTML = """
<html><body><article><p>Accept all cookies</p></article></body></html>
"""

PAYWALL_HTML = """
<html><body><article><p>Subscribe to continue reading this story and get
unlimited access to our journalism, exclusive newsletters, and more benefits
for members only.</p></article></body></html>
"""


def test_fetch_article_text_extracts_body():
    client = _FakeClient(response=_FakeResponse(ARTICLE_HTML))
    text = extract.fetch_article_text("https://example.com/a", client=client)
    assert "Tensions rise in the gulf" in text


def test_fetch_article_text_returns_empty_on_network_error():
    client = _FakeClient(exc=httpx.ConnectError("nope"))
    assert extract.fetch_article_text("https://example.com/a", client=client) == ""


def test_fetch_article_text_returns_empty_on_http_error():
    client = _FakeClient(response=_FakeResponse("<html></html>", status=404))
    assert extract.fetch_article_text("https://example.com/a", client=client) == ""


def test_fetch_article_text_skips_non_html_content_type():
    client = _FakeClient(response=_FakeResponse("%PDF-1.4 ...", content_type="application/pdf"))
    assert extract.fetch_article_text("https://example.com/a", client=client) == ""


def test_fetch_article_text_caps_length():
    huge = "<html><body><article><p>" + ("word " * 5000) + "</p></article></body></html>"
    client = _FakeClient(response=_FakeResponse(huge))
    text = extract.fetch_article_text("https://example.com/a", client=client)
    assert len(text) <= extract.MAX_CHARS


def test_fetch_article_text_rejects_short_consent_wall():
    client = _FakeClient(response=_FakeResponse(CONSENT_WALL_HTML))
    assert extract.fetch_article_text("https://example.com/a", client=client) == ""


def test_fetch_article_text_rejects_paywall_even_if_long_enough():
    client = _FakeClient(response=_FakeResponse(PAYWALL_HTML))
    assert extract.fetch_article_text("https://example.com/a", client=client) == ""


def test_looks_like_a_wall_matches_known_phrases():
    assert extract._looks_like_a_wall("Accept all cookies")
    assert extract._looks_like_a_wall("Please enable JavaScript to view this site")
    assert extract._looks_like_a_wall("Subscribe to continue reading this article")
    assert not extract._looks_like_a_wall("A real article that mentions cookies in passing.")


GNEWS_URL = "https://news.google.com/rss/articles/CBMifakebase64string?oc=5"


def test_is_google_news_url():
    assert extract._is_google_news_url(GNEWS_URL)
    assert extract._is_google_news_url("https://news.google.com/articles/CBMifake")
    assert not extract._is_google_news_url("https://example.com/a")


def test_resolve_google_news_url_returns_empty_for_non_google_news_url(monkeypatch):
    called = {"n": 0}
    monkeypatch.setattr(extract, "gnewsdecoder", lambda *a, **kw: called.__setitem__("n", called["n"] + 1))
    assert extract.resolve_google_news_url("https://example.com/a") == ""
    assert called["n"] == 0  # never even tries to decode a non-Google-News URL


def test_resolve_google_news_url_returns_empty_when_package_unavailable(monkeypatch):
    monkeypatch.setattr(extract, "gnewsdecoder", None)
    assert extract.resolve_google_news_url(GNEWS_URL) == ""


def test_resolve_google_news_url_success(monkeypatch):
    monkeypatch.setattr(extract, "gnewsdecoder",
                        lambda url, proxy=None: {"status": True, "decoded_url": "https://real-site.com/article"})
    assert extract.resolve_google_news_url(GNEWS_URL) == "https://real-site.com/article"


def test_resolve_google_news_url_handles_decode_failure(monkeypatch):
    monkeypatch.setattr(extract, "gnewsdecoder",
                        lambda url, proxy=None: {"status": False, "message": "Google changed the page format"})
    assert extract.resolve_google_news_url(GNEWS_URL) == ""


def test_resolve_google_news_url_handles_exception(monkeypatch):
    def boom(url, proxy=None):
        raise RuntimeError("network exploded")
    monkeypatch.setattr(extract, "gnewsdecoder", boom)
    assert extract.resolve_google_news_url(GNEWS_URL) == ""


def test_fetch_article_text_resolves_google_news_then_fetches_real_article(monkeypatch):
    monkeypatch.setattr(extract, "gnewsdecoder",
                        lambda url, proxy=None: {"status": True, "decoded_url": "https://real-site.com/article"})
    seen_urls = []

    class _RecordingClient(_FakeClient):
        def get(self, url, headers=None):
            seen_urls.append(url)
            return super().get(url, headers=headers)

    client = _RecordingClient(response=_FakeResponse(ARTICLE_HTML))
    text = extract.fetch_article_text(GNEWS_URL, client=client)
    assert "Tensions rise in the gulf" in text
    assert seen_urls == ["https://real-site.com/article"]  # fetched the REAL url, not the gnews redirect


def test_fetch_article_text_skips_fetch_when_google_news_resolution_fails(monkeypatch):
    monkeypatch.setattr(extract, "gnewsdecoder", lambda url, proxy=None: {"status": False})

    def boom(url, headers=None):
        raise AssertionError("must not fetch the gnews shell page if resolution failed")
    client = _FakeClient()
    client.get = boom
    assert extract.fetch_article_text(GNEWS_URL, client=client) == ""
