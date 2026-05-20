"""Tests for the FastAPI app — healthz first."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

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
