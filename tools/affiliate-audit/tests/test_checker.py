import sys
from pathlib import Path
from unittest import mock
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import checker  # noqa: E402


class FakePage:
    def __init__(self, url, body, rating=None, prime=None, raise_on_goto=False):
        self.url = url
        self._body = body
        self._rating = rating
        self._prime = prime
        self._raise = raise_on_goto
        self.visited = []

    def goto(self, url, wait_until=None, timeout=None):
        self.visited.append(url)
        if self._raise:
            raise RuntimeError("net::ERR_CONNECTION_REFUSED")
        self.url = url

    def inner_text(self, selector):
        assert selector == "body"
        return self._body

    def evaluate(self, js):
        if "primeBadge" in js or "prime" in js.lower():
            return self._prime
        return self._rating


PRODUCT = {"id": "widget", "asin": "B00WIDGET1"}


def test_normal_product_ok_evidence():
    page = FakePage(url="https://amazon.com/dp/B00WIDGET1", body="Buy Widget now", rating=4.6, prime=True)
    with patch("checker.time.sleep") as mock_sleep:
        ev = checker.check_product(page, "https://totaljerks.com", PRODUCT, {})
    assert ev["redirect_ok"] is True
    assert ev["body"] == "Buy Widget now"
    assert ev["rating"] == 4.6
    assert ev["prime"] is True
    assert ev["go_url"] == "https://totaljerks.com/go/widget/"
    mock_sleep.assert_called_once_with(3)


def test_goto_failure_is_broken_redirect():
    page = FakePage(url="", body="", raise_on_goto=True)
    with patch("checker.time.sleep") as mock_sleep:
        ev = checker.check_product(page, "https://totaljerks.com", PRODUCT, {})
    assert ev["redirect_ok"] is False
    assert ev["body"] == ""
    mock_sleep.assert_not_called()


def test_recheck_product_uses_fresh_context():
    fresh_page = FakePage(url="https://amazon.com/dp/B00WIDGET1", body="Buy Widget now", rating=4.6, prime=True)
    fake_ctx = type("FakeCtx", (), {"closed": False, "close": lambda self: setattr(self, "closed", True)})()

    with mock.patch("checker.launch_browser", return_value=(fake_ctx, fresh_page)):
        ev = checker.recheck_product(PRODUCT, "https://totaljerks.com", {})

    assert ev["redirect_ok"] is True
    assert ev["body"] == "Buy Widget now"
    assert fake_ctx.closed is True
