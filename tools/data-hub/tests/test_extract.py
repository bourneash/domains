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
