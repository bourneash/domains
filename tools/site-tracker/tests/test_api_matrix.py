"""Tests for the FastAPI app — healthz first."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from site_tracker import store
from site_tracker.app.main import build_app


@pytest.fixture
def appdir(tmp_path: Path) -> Path:
    """A working directory with sites.yml + data/facts.db."""
    fx = Path(__file__).parent / "fixtures" / "sites.yml"
    shutil.copy(fx, tmp_path / "sites.yml")
    (tmp_path / "data").mkdir()
    return tmp_path


@pytest.fixture
def client(appdir: Path, monkeypatch):
    monkeypatch.chdir(appdir)
    app = build_app(sites_yml=appdir / "sites.yml", db_path=appdir / "data" / "facts.db")
    return TestClient(app)


def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def _seed_facts(db_path: Path):
    store.init_db(db_path)
    conn = store.connect(db_path)
    try:
        store.upsert_fact(conn, site="alpha.test", key="cf.zone_active",
                          value=True, source="cf_api", state="green", ttl_hours=6)
        store.upsert_fact(conn, site="alpha.test", key="http.ga4_present",
                          value=True, source="http_scrape", state="green", ttl_hours=24)
        store.upsert_fact(conn, site="beta.test", key="http.ga4_present",
                          value=False, source="http_scrape", state="yellow", ttl_hours=24)
    finally:
        conn.close()


def test_matrix_renders_sites_and_columns(client, appdir):
    _seed_facts(appdir / "data" / "facts.db")
    r = client.get("/")
    assert r.status_code == 200
    html = r.text
    assert "alpha.test" in html
    assert "beta.test" in html
    # parked.test is in fixtures sites.yml and should also render
    assert "parked.test" in html
    # Column headers (families) — at least these
    assert ">cf<" in html
    assert ">http<" in html


def test_matrix_cell_state_class_present(client, appdir):
    _seed_facts(appdir / "data" / "facts.db")
    r = client.get("/")
    html = r.text
    assert "cell green" in html
    assert "cell yellow" in html


def test_matrix_n_a_for_families_site_doesnt_apply_to(client, appdir):
    _seed_facts(appdir / "data" / "facts.db")
    r = client.get("/")
    html = r.text
    # parked.test only applies_to [cf], so its sitemap/http cells should be n_a
    assert "cell n_a" in html
