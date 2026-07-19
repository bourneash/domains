from fastapi.testclient import TestClient
from datahub.api import create_app
from datahub.config import Settings, AnalyticsSite
from datahub import store


def _app(db, sites=None):
    settings = Settings(db_path=":memory:", home_ips=set(), proxy_us="http://h:8181",
                        proxy_eu="http://h:8182", control_us="http://h:9281",
                        control_eu="http://h:9282", registry_dir="/x")
    app = create_app(settings, conn=db, sources=[], subscriptions={},
                     analytics_sites=sites or {})
    return TestClient(app)


def _ga4_row(date, sessions=10):
    return {"date": date, "grain": "site", "dim_key": "", "sessions": sessions, "users": 8,
            "new_users": 2, "views": 30, "engaged_sessions": 6, "engagement_rate": 0.6,
            "avg_session_duration": 40.0, "conversions": 1}


def test_metrics_ga4_endpoint_returns_site_rows(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_row("2026-07-18")])
    client = _app(db)
    r = client.get("/metrics/ga4?site=xxxtea.com")
    assert r.status_code == 200
    assert r.json()["records"][0]["sessions"] == 10


def test_metrics_ga4_endpoint_requires_site(db):
    client = _app(db)
    r = client.get("/metrics/ga4")
    assert r.status_code == 422


def test_metrics_gsc_endpoint_returns_rows(db):
    store.upsert_gsc_metrics(db, "xxxtea.com", [{"date": "2026-07-18", "grain": "site", "dim_key": "",
                                                 "clicks": 5, "impressions": 100, "ctr": 0.05, "position": 6.0}])
    client = _app(db)
    r = client.get("/metrics/gsc?site=xxxtea.com")
    assert r.json()["records"][0]["clicks"] == 5


def test_metrics_summary_flags_site_with_no_data_as_absent_not_zero(db):
    client = _app(db)
    r = client.get("/metrics/summary?site=nosuchsite.com")
    body = r.json()
    assert body["has_data"] is False
    assert "sessions" not in body or body.get("sessions") is None


def test_metrics_summary_totals_sessions_over_window(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_row("2026-07-17", 10), _ga4_row("2026-07-18", 20)])
    client = _app(db)
    r = client.get("/metrics/summary?site=xxxtea.com&window=28")
    body = r.json()
    assert body["has_data"] is True
    assert body["sessions"] == 30


def test_metrics_summary_omits_gsc_keys_when_gsc_absent(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [_ga4_row("2026-07-18", 10)])
    client = _app(db)
    r = client.get("/metrics/summary?site=xxxtea.com&window=28")
    body = r.json()
    assert body["has_data"] is True
    assert body["sessions"] == 10
    assert "clicks" not in body
    assert "impressions" not in body


def test_metrics_summary_omits_ga4_keys_when_ga4_absent(db):
    store.upsert_gsc_metrics(db, "xxxtea.com", [{"date": "2026-07-18", "grain": "site", "dim_key": "",
                                                 "clicks": 5, "impressions": 100, "ctr": 0.05, "position": 6.0}])
    client = _app(db)
    r = client.get("/metrics/summary?site=xxxtea.com&window=28")
    body = r.json()
    assert body["has_data"] is True
    assert body["clicks"] == 5
    assert "sessions" not in body
    assert "users" not in body
    assert "new_users" not in body
    assert "views" not in body
    assert "conversions" not in body


def test_metrics_top_returns_pages_sorted_by_metric(db):
    store.upsert_ga4_metrics(db, "xxxtea.com", [
        {**_ga4_row("2026-07-18"), "grain": "page", "dim_key": "/a", "sessions": 5},
        {**_ga4_row("2026-07-18"), "grain": "page", "dim_key": "/b", "sessions": 50},
    ])
    client = _app(db)
    r = client.get("/metrics/top?site=xxxtea.com&source=ga4&metric=sessions&limit=1")
    top = r.json()["top"]
    assert len(top) == 1
    assert top[0]["dim_key"] == "/b"


def test_metrics_health_marks_consent_gated_sites(db):
    sites = {"saveusfarms.com": AnalyticsSite(ga4_property_id="1", gsc_property="sc-domain:saveusfarms.com",
                                              consent_gated=True)}
    client = _app(db, sites=sites)
    r = client.get("/metrics/health")
    body = r.json()
    assert body["sites"]["saveusfarms.com"]["consent_gated"] is True
