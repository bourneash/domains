import sys
from pathlib import Path
from unittest import mock
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import checker  # noqa: E402


class FakeResponse:
    def __init__(self, status):
        self.status = status


class FakePage:
    def __init__(self, url, body, rating=None, prime=None, raise_on_goto=False, status=200):
        self.url = url
        self._body = body
        self._rating = rating
        self._prime = prime
        self._raise = raise_on_goto
        self._status = status
        self.visited = []

    def goto(self, url, wait_until=None, timeout=None):
        self.visited.append(url)
        if self._raise:
            raise RuntimeError("net::ERR_CONNECTION_REFUSED")
        self.url = url
        return FakeResponse(self._status)

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
    assert ev["status"] == 200
    assert ev["body"] == "Buy Widget now"
    assert ev["rating"] == 4.6
    assert ev["prime"] is True
    assert ev["go_url"] == "https://totaljerks.com/go/widget/"
    mock_sleep.assert_called_once_with(3)


def test_5xx_status_captured_in_evidence():
    page = FakePage(url="https://amazon.com/dp/B00WIDGET1", body="Internal Server Error", status=500)
    with patch("checker.time.sleep"):
        ev = checker.check_product(page, "https://totaljerks.com", PRODUCT, {})
    assert ev["status"] == 500
    assert ev["redirect_ok"] is True


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

    with mock.patch("checker.launch_browser", return_value=(fake_ctx, fresh_page)) as mock_launch:
        ev = checker.recheck_product(PRODUCT, "https://totaljerks.com", {})

    assert ev["redirect_ok"] is True
    assert ev["body"] == "Buy Widget now"
    assert fake_ctx.closed is True
    mock_launch.assert_called_once_with(profile=checker.RECHECK_PROFILE)


def test_recheck_product_uses_dedicated_profile_not_default():
    """recheck_product must use a DIFFERENT profile than the main sweep's
    default, so cc_lib's launch-time pkill cleanup can never kill the main
    sweep's still-open browser (the bug: both used cc_lib.PROFILE)."""
    fresh_page = FakePage(url="https://amazon.com/dp/B00WIDGET1", body="Buy Widget now", rating=4.6, prime=True)
    fake_ctx = type("FakeCtx", (), {"closed": False, "close": lambda self: setattr(self, "closed", True)})()

    with mock.patch("checker.launch_browser", return_value=(fake_ctx, fresh_page)) as mock_launch:
        checker.recheck_product(PRODUCT, "https://totaljerks.com", {})

    called_profile = mock_launch.call_args.kwargs.get("profile")
    assert called_profile == checker.RECHECK_PROFILE
    assert called_profile != "/tmp/cloak-driver/profile"


def test_launch_browser_default_passes_no_profile_to_cc_lib():
    """The main sweep's call site (run.py -> checker.launch_browser()) must
    keep getting cc_lib's own default profile — no override."""
    fake_ctx, fake_page = object(), object()
    with mock.patch.dict(
        "sys.modules", {"cc_lib": mock.Mock(launch=mock.Mock(return_value=(fake_ctx, fake_page)))}
    ):
        result = checker.launch_browser()
        cc_lib_mock = sys.modules["cc_lib"]
        cc_lib_mock.launch.assert_called_once_with(headless=True)
    assert result == (fake_ctx, fake_page)


def test_launch_browser_passes_through_explicit_profile():
    fake_ctx, fake_page = object(), object()
    with mock.patch.dict(
        "sys.modules", {"cc_lib": mock.Mock(launch=mock.Mock(return_value=(fake_ctx, fake_page)))}
    ):
        result = checker.launch_browser(profile="/tmp/some/other-profile")
        cc_lib_mock = sys.modules["cc_lib"]
        cc_lib_mock.launch.assert_called_once_with(profile="/tmp/some/other-profile", headless=True)
    assert result == (fake_ctx, fake_page)


def test_launch_browser_always_headless_for_unattended_runs():
    """affiliate-audit never has a human in the loop and often runs inside a
    container with no display server — it must always launch headless,
    regardless of cc_lib.launch()'s own (visible-window) default."""
    fake_ctx, fake_page = object(), object()
    with mock.patch.dict(
        "sys.modules", {"cc_lib": mock.Mock(launch=mock.Mock(return_value=(fake_ctx, fake_page)))}
    ):
        checker.launch_browser()
        assert sys.modules["cc_lib"].launch.call_args.kwargs.get("headless") is True
