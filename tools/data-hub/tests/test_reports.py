import json
from datetime import datetime, timedelta, timezone

import httpx
from datahub import api, store
from datahub.config import Settings
from datahub.report_adapters import SeedFileAdapter
from starlette.requests import Request


def _source():
    return {
        "source_id": "captain-reviewed",
        "name": "Captain Reviewed Reports",
        "homepage_url": "https://reports.example/",
        "source_type": "manual-seed",
        "provenance": "Human-reviewed report supplied by the source owner",
        "default_port": "Cape May",
        "default_state": "NJ",
        "default_region": "Mid-Atlantic",
        "default_lat": 38.935,
        "default_lon": -74.906,
    }


def _report(external_id="trip-1", report_date=None):
    report_date = report_date or datetime.now(timezone.utc).date().isoformat()
    return {
        "source_id": "captain-reviewed", "external_id": external_id,
        "url": f"https://reports.example/{external_id}", "title": "Tuna east of the inlet",
        "summary": "A reviewed trip report.", "report_date": report_date,
        "published_at": report_date + "T18:00:00+00:00", "port": "Cape May", "state": "NJ",
        "region": "Mid-Atlantic", "lat": 38.8, "lon": -74.2, "area": "Offshore",
        "report_type": "charter", "methods": ["trolling"], "conditions": {"waves_ft": 2},
        "confidence": 0.9, "evidence_excerpt": "three yellowfin released",
        "raw": {"reviewed": True}, "content_hash": external_id,
        "species": [{"species_slug": "yellowfin-tuna", "species_verbatim": "yellowfin",
                     "catch_count": 3, "disposition": "released"}],
    }


def _client(db):
    settings = Settings(db_path=":memory:", home_ips={"24.55.143.75"},
                        proxy_us="http://h:1", proxy_eu="http://h:2",
                        control_us="http://h:3", control_eu="http://h:4", registry_dir="/x")
    vpn = httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, content=b"185.2.2.2")))
    return api.create_app(settings, conn=db, sources=[], subscriptions={}, vpn_client=vpn)


def test_report_upsert_queries_species_location_and_provenance(db):
    store.upsert_fishing_report_source(db, _source())
    assert store.upsert_fishing_reports(db, [_report()]) == 1
    # Re-ingestion updates the report and replaces species facts rather than duplicating it.
    changed = _report()
    changed["summary"] = "Updated"
    changed["species"][0]["catch_count"] = 4
    store.upsert_fishing_reports(db, [changed])
    rows = store.query_fishing_reports(db, species="yellowfin-tuna", state="nj",
                                       min_lon=-75, max_lon=-73, min_lat=38, max_lat=40)
    assert len(rows) == 1
    assert rows[0]["summary"] == "Updated"
    assert rows[0]["species"][0]["catch_count"] == 4
    assert rows[0]["provenance"].startswith("Human-reviewed")
    assert store.fishing_report_sources(db)[0]["report_count"] == 1


def test_reports_api_filters_logs_and_validates_bbox(db):
    store.upsert_fishing_report_source(db, _source())
    store.upsert_fishing_reports(db, [_report()])
    app = _client(db)
    endpoints = {route.path: route.endpoint for route in app.routes if hasattr(route, "endpoint")}
    request = Request({"type": "http", "method": "GET", "path": "/reports",
                       "headers": [], "client": ("127.0.0.1", 1234)})
    response = endpoints["/reports"](
        request=request, species="yellowfin-tuna", state=None, port=None, region=None,
        source=None, since=None, bbox="-75,38,-73,40", limit=100)
    assert len(response["reports"]) == 1
    summary = endpoints["/reports/summary"](request=request, since=None)
    assert summary["report_count"] == 1
    assert summary["species"][0]["species_slug"] == "yellowfin-tuna"
    assert endpoints["/reports/sources"]()["sources"][0]["latest_report_date"]
    pulls = store.query_pulls(db)
    assert {p["endpoint"] for p in pulls} == {"reports", "reports/summary"}


def test_reports_have_independent_365_day_retention(db):
    store.upsert_fishing_report_source(db, _source())
    old = _report("old", (datetime.now(timezone.utc) - timedelta(days=400)).date().isoformat())
    old["fetched_at"] = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
    recent = _report("recent", (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat())
    recent["fetched_at"] = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    store.upsert_fishing_reports(db, [old, recent])
    deleted = store.prune(db, retention_days=7, report_retention_days=365)
    assert deleted["fishing_reports"] == 1
    assert [r["external_id"] for r in store.query_fishing_reports(db)] == ["recent"]


def test_seed_file_adapter_validates_and_normalizes(tmp_path):
    seed = {
        "source": _source(),
        "reports": [{
            "url": "https://reports.example/a", "title": "Stripers on the shoal",
            "report_date": "2026-09-17", "evidence_excerpt": "two striped bass released",
            "species": [{"species": "Striped Bass", "catch_count": 2, "disposition": "released"}],
        }],
    }
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(seed))
    source, reports = SeedFileAdapter(path).load()
    assert source["source_id"] == "captain-reviewed"
    assert reports[0]["port"] == "Cape May"
    assert reports[0]["species"][0]["species_slug"] == "striped-bass"
    assert reports[0]["external_id"] and reports[0]["content_hash"]
