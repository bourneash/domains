"""Regression test for the registry <-> _redirects drift class.

products.json/affiliate.ts and _redirects are two hand-maintained copies of
the same ASIN. broadwayshowgirls' theatre-off-book-tshirt drifted for weeks
after a manual dead-ASIN fix touched only the registry — heal.py's automated
swap keeps both in sync, but nothing caught a manual edit to just one side
until the live cloak check happened to reach that id. `cloak.check_static`
is the local, always-run equivalent that closes that gap fleet-wide.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cloak

REDIRECTS = (
    "/go/wicked-tee        https://www.amazon.com/dp/B0DHYKC62V?tag=site-20  302\n"
    "/go/wicked-tee/       https://www.amazon.com/dp/B0DHYKC62V?tag=site-20  302\n"
    "/go/search-only        https://www.amazon.com/s?k=opera+glasses&tag=site-20  302\n"
)


def test_matching_asin_is_ok():
    res = cloak.check_static(REDIRECTS, "/go/", "wicked-tee", "B0DHYKC62V", "site-20")
    assert res is not None and res.ok


def test_stale_asin_is_flagged():
    # The exact shape of the bug: registry moved on to a replacement ASIN,
    # _redirects still carries the retired one.
    res = cloak.check_static(REDIRECTS, "/go/", "wicked-tee", "B0CRVH593L", "site-20")
    assert res is not None
    assert not res.ok
    assert "drifted" in res.reason


def test_missing_tag_is_flagged():
    res = cloak.check_static(REDIRECTS, "/go/", "wicked-tee", "B0DHYKC62V", "other-tag-20")
    assert res is not None and not res.ok
    assert "affiliate tag" in res.reason


def test_search_url_registry_is_exempt_from_asin_check():
    # No ASIN to compare against a search-URL entry.
    res = cloak.check_static(REDIRECTS, "/go/", "search-only", None, "site-20")
    assert res is None


def test_no_line_for_id_returns_none():
    # discover.py's stale/missing-route checks own this case, not drift
    # detection — nothing to compare against here.
    res = cloak.check_static(REDIRECTS, "/go/", "no-such-id", "B0DHYKC62V", "site-20")
    assert res is None


def test_no_redirects_file_returns_none():
    res = cloak.check_static("", "/go/", "wicked-tee", "B0DHYKC62V", "site-20")
    assert res is None
