"""Tests for /collectors."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

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


def test_collectors_page_lists_all_known(client):
    r = client.get("/collectors")
    assert r.status_code == 200
    for name in ("filesystem", "http_scrape", "cloudflare", "github"):
        assert name in r.text


def test_post_run_unknown_404(client):
    r = client.post("/collectors/doesnotexist/run")
    assert r.status_code == 404
