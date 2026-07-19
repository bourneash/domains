import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import classify  # noqa: E402

CHECKS = {
    "prime_required": True,
    "min_rating": 4.0,
}


def _evidence(**overrides):
    base = {"redirect_ok": True, "body": "normal product page", "prime": True, "rating": 4.6}
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
