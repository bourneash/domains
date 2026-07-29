import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import classify  # noqa: E402

CHECKS = {
    "prime_required": True,
    "min_rating": 4.0,
}


_NORMAL_BODY = "normal product page. " * 12  # >200 chars, like a real Amazon dp page body


def _evidence(**overrides):
    base = {"redirect_ok": True, "status": 200, "body": _NORMAL_BODY, "prime": True, "rating": 4.6}
    base.update(overrides)
    return base


def test_broken_redirect_takes_priority():
    ev = _evidence(redirect_ok=False)
    assert classify.classify(ev, CHECKS) == "broken_redirect"


def test_captcha_is_inconclusive_even_if_other_markers_present():
    ev = _evidence(body="please solve this captcha, Robot Check")
    assert classify.classify(ev, CHECKS) == "inconclusive"


def test_dead_soft_404():
    ev = _evidence(body="Sorry! We couldn't find that page")
    assert classify.classify(ev, CHECKS) == "dead"


def test_oos():
    ev = _evidence(body="currently unavailable")
    assert classify.classify(ev, CHECKS) == "oos"


def test_continue_shopping_interstitial_is_inconclusive():
    """Amazon's real soft bot-check page for a flagged/datacenter IP — confirmed
    live via a VPN-proxied CloakBrowser session 2026-07-29. Must not fall through
    to no_prime just because this short page has no primeBadge element."""
    ev = _evidence(body="Click the button below to continue shopping\nContinue shopping", prime=False)
    assert classify.classify(ev, CHECKS) == "inconclusive"


def test_short_unrecognized_body_is_inconclusive_not_ok():
    ev = _evidence(body="short", prime=True, rating=4.8)
    assert classify.classify(ev, CHECKS) == "inconclusive"


def test_5xx_status_with_no_markers_is_inconclusive():
    ev = _evidence(status=500, body="Internal Server Error")
    assert classify.classify(ev, CHECKS) == "inconclusive"


def test_missing_status_does_not_force_inconclusive():
    """status=None means the checker couldn't capture it (e.g. an older
    evidence shape) — fall through to normal body-based classification
    rather than treating unknown as an error."""
    ev = _evidence(status=None)
    assert classify.classify(ev, CHECKS) == "ok"


def test_soft_404_wins_over_non_200_status():
    ev = _evidence(status=404, body="Sorry! We couldn't find that page")
    assert classify.classify(ev, CHECKS) == "dead"


def test_no_prime():
    ev = _evidence(prime=False)
    assert classify.classify(ev, CHECKS) == "no_prime"


def test_low_rating():
    ev = _evidence(rating=3.2)
    assert classify.classify(ev, CHECKS) == "low_rating"


def test_ok():
    ev = _evidence()
    assert classify.classify(ev, CHECKS) == "ok"


def test_prime_not_required_when_config_disables_it():
    ev = _evidence(prime=False)
    assert classify.classify(ev, {"prime_required": False, "min_rating": 4.0}) == "ok"


def test_unknown_rating_is_not_low_rating():
    ev = _evidence(rating=None)
    assert classify.classify(ev, CHECKS) == "ok"
