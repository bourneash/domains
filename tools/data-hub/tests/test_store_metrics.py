from datahub import store


def _ga4_record(date="2026-07-10", grain="site", dim_key=""):
    return {
        "date": date, "grain": grain, "dim_key": dim_key,
        "sessions": 100, "users": 80, "new_users": 20, "views": 300,
        "engaged_sessions": 60, "engagement_rate": 0.6,
        "avg_session_duration": 45.2, "conversions": 3,
    }


def _gsc_record(date="2026-07-10", grain="site", dim_key=""):
    return {
        "date": date, "grain": grain, "dim_key": dim_key,
        "clicks": 12, "impressions": 400, "ctr": 0.03, "position": 8.4,
    }


def test_upsert_ga4_metrics_inserts_and_returns_count(db):
    n = store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_record()])
    assert n == 1
    rows = store.query_ga4_metrics(db, "xxxtea.com")
    assert rows[0]["sessions"] == 100
    assert rows[0]["site"] == "xxxtea.com"


def test_upsert_ga4_metrics_revises_not_duplicates(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_record()])
    revised = _ga4_record()
    revised["sessions"] = 150
    store.upsert_ga4_metrics(db, "xxxtea.com", [revised])
    rows = store.query_ga4_metrics(db, "xxxtea.com")
    assert len(rows) == 1
    assert rows[0]["sessions"] == 150


def test_upsert_gsc_metrics_inserts_and_revises(db):
    store.upsert_gsc_metrics(db, "xxxtea.com", [_gsc_record()])
    revised = _gsc_record()
    revised["clicks"] = 99
    store.upsert_gsc_metrics(db, "xxxtea.com", [revised])
    rows = store.query_gsc_metrics(db, "xxxtea.com")
    assert len(rows) == 1
    assert rows[0]["clicks"] == 99


def test_query_ga4_metrics_filters_by_grain_and_dim_key(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [
        _ga4_record(grain="site", dim_key=""),
        _ga4_record(grain="page", dim_key="/tea/oolong"),
    ])
    site_rows = store.query_ga4_metrics(db, "xxxtea.com", grain="site")
    assert len(site_rows) == 1 and site_rows[0]["dim_key"] == ""
    page_rows = store.query_ga4_metrics(db, "xxxtea.com", grain="page", dim_key="/tea/oolong")
    assert len(page_rows) == 1 and page_rows[0]["dim_key"] == "/tea/oolong"


def test_query_ga4_metrics_since_until_bounds(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [
        _ga4_record(date="2026-07-01"), _ga4_record(date="2026-07-10"), _ga4_record(date="2026-07-20"),
    ])
    rows = store.query_ga4_metrics(db, "xxxtea.com", since="2026-07-05", until="2026-07-15")
    assert [r["date"] for r in rows] == ["2026-07-10"]


def test_query_metrics_isolated_per_site(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_record()])
    store.upsert_ga4_metrics(db, "sinderella.org", [_ga4_record()])
    assert len(store.query_ga4_metrics(db, "xxxtea.com")) == 1
    assert len(store.query_ga4_metrics(db, "sinderella.org")) == 1


def test_metrics_tables_exempt_from_retention_prune(db):
    old_record = _ga4_record(date="2020-01-01")
    store.upsert_ga4_metrics(db, "xxxtea.com", [old_record])
    store.upsert_gsc_metrics(db, "xxxtea.com", [_gsc_record(date="2020-01-01")])
    deleted = store.prune(db, retention_days=7)
    assert "ga4_metrics" not in deleted
    assert "gsc_metrics" not in deleted
    assert len(store.query_ga4_metrics(db, "xxxtea.com")) == 1
    assert len(store.query_gsc_metrics(db, "xxxtea.com")) == 1
