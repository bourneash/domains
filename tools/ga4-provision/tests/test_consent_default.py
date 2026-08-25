"""Consent gating defaults to ON, because every fleet site gates GA4.

Regression: CONSENT_GATED was an allowlist naming 5 sites while 29 were
actually gated, so two dozen sites' consented-only traffic was reported with
no undercount caveat. Verified 2026-08-25 by loading each live site with no
consent given — 0 of 29 fired a googletagmanager request.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from ga4_provision.registry import CONSENT_UNGATED, build_registry
from ga4_provision.discover import Property


def _reg(sites):
    props = [Property(property_id=str(100 + i), display_name=s, account_id="396394354") for i, s in enumerate(sites)]
    return build_registry(props, {s: f"G-{i}" for i, s in enumerate(sites)})["sites"]


def test_unknown_site_defaults_to_gated():
    """A newly added site must inherit gated=True, not False."""
    r = _reg(["brand-new-site.com"])
    assert r["brand-new-site.com"]["consent_gated"] is True


def test_exception_list_can_mark_a_site_ungated():
    r = _reg(["ungated-example.com"])
    assert r["ungated-example.com"]["consent_gated"] is True, (
        "precondition: the domain is not in the exception set"
    )
    CONSENT_UNGATED.add("ungated-example.com")
    try:
        assert _reg(["ungated-example.com"])["ungated-example.com"]["consent_gated"] is False
    finally:
        CONSENT_UNGATED.discard("ungated-example.com")


def test_explicit_override_still_wins():
    """Callers passing an explicit GATED set keep the old semantics."""
    props = [Property(property_id="1", display_name="a.com", account_id="396394354"),
             Property(property_id="2", display_name="b.com", account_id="396394354")]
    r = build_registry(props, {}, consent_gated={"a.com"})["sites"]
    assert r["a.com"]["consent_gated"] is True
    assert r["b.com"]["consent_gated"] is False
