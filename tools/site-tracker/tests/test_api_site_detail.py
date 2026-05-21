"""Tests for GET /site/{site}."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from site_tracker import store
from site_tracker.app.main import build_app


@pytest.fixture
def appdir(tmp_path: Path) -> Path:
    fx = Path(__file__).parent / "fixtures" / "sites.yml"
    shutil.copy(fx, tmp_path / "sites.yml")
    (tmp_path / "data").mkdir()
    return tmp_path


@pytest.fixture
def client(appdir: Path, monkeypatch):
    monkeypatch.chdir(appdir)
    app = build_app(sites_yml=appdir / "sites.yml", db_path=appdir / "data" / "facts.db")
    return TestClient(app)


def _seed(db_path: Path):
    store.init_db(db_path)
    conn = store.connect(db_path)
    try:
        store.upsert_fact(conn, site="alpha.test", key="cf.zone_active",
                          value=True, source="cf_api", state="green", ttl_hours=6)
        store.upsert_fact(conn, site="alpha.test", key="http.ga4_present",
                          value=True, source="http_scrape", state="green", ttl_hours=24)
    finally:
        conn.close()


def test_drilldown_lists_every_applicable_fact(client, appdir):
    _seed(appdir / "data" / "facts.db")
    r = client.get("/site/alpha.test")
    assert r.status_code == 200
    html = r.text
    assert "cf.zone_active" in html
    assert "http.ga4_present" in html
    # alpha.test applies_to manual but has manual.amazon_associates_id seeded in fixtures
    assert "amazon_associates_id" in html


def test_drilldown_unknown_site_404(client):
    r = client.get("/site/doesnotexist.com")
    assert r.status_code == 404


def test_drilldown_renders_when_manual_block_is_empty(client):
    """beta.test has applies_to: [..., manual] but manual: {} — the page must
    render the empty Manual section with the '+ add' affordance, no errors."""
    r = client.get("/site/beta.test")
    assert r.status_code == 200
    html = r.text
    assert "Manual facts" in html
    assert "click to add a manual fact" in html
