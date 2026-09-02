"""A failed API call is not a product verdict.

On 2026-07-30 a transient PA-API 403 made every one of 412 ASINs report as
`delisted`. The same 403 was observed succeeding and failing within the same
hour on 2026-09-01, on identical credentials and partner tag — so it is not an
account state, and must never be recorded as one.
"""
from amz_stats.collectors import build_summary


def test_api_errors_are_unchecked_not_delisted():
    catalog = {"asins": {}, "errors": ["B001", "B002"]}
    out = build_summary({"example.com": ["B001", "B002"]}, catalog)
    t = out["totals"]
    assert t["unchecked_count"] == 2, "a failed call must be counted as unchecked"
    assert t["delisted_count"] == 0, (
        "a transient API failure must NEVER report as a delisting — that is what "
        "turned an Amazon hiccup into '412 products delisted'"
    )


def test_genuinely_absent_asin_is_missing_not_unchecked():
    # API answered, item simply absent from the response: that IS a signal.
    catalog = {"asins": {}, "errors": []}
    out = build_summary({"example.com": ["B003"]}, catalog)
    assert out["totals"]["missing_count"] == 1
    assert out["totals"]["unchecked_count"] == 0


def test_live_asin_unaffected():
    catalog = {"asins": {"B004": {"availability": "IN_STOCK"}}, "errors": []}
    out = build_summary({"example.com": ["B004"]}, catalog)
    t = out["totals"]
    assert t["unchecked_count"] == 0 and t["delisted_count"] == 0 and t["missing_count"] == 0


def test_403_is_retried_like_429():
    import inspect
    from amz_stats import collectors
    src = inspect.getsource(collectors.collect_catalog)
    assert "exc.status in (429, 403)" in src, (
        "403 must be retried: PA-API returns it transiently, and without a retry "
        "one hiccup wipes a whole run"
    )
