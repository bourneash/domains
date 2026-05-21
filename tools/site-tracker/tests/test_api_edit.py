"""Tests for GET + POST /site/{site}/edit/{key}."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from site_tracker.app.main import build_app


@pytest.fixture
def appdir(tmp_path: Path) -> Path:
    fx = Path(__file__).parent / "fixtures" / "sites.yml"
    repo = tmp_path / "domains"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    (repo / "tools" / "site-tracker").mkdir(parents=True)
    shutil.copy(fx, repo / "tools" / "site-tracker" / "sites.yml")
    (repo / "data").mkdir()
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    return repo


@pytest.fixture
def client(appdir: Path, monkeypatch):
    monkeypatch.chdir(appdir / "tools" / "site-tracker")
    app = build_app(
        sites_yml=appdir / "tools" / "site-tracker" / "sites.yml",
        db_path=appdir / "data" / "facts.db",
    )
    app.state.git_root = appdir
    return TestClient(app)


def test_get_edit_form_returns_input_fragment(client):
    r = client.get("/site/alpha.test/edit/manual.amazon_associates_id")
    assert r.status_code == 200
    assert "<input" in r.text or "<form" in r.text
    assert "amazon_associates_id" in r.text


def test_post_edit_writes_sites_yml_and_commits(client, appdir):
    r = client.post(
        "/site/alpha.test/edit/manual.adsense_status",
        data={"value": "approved"},
    )
    assert r.status_code == 200
    reloaded = yaml.safe_load((appdir / "tools" / "site-tracker" / "sites.yml").read_text())
    val = reloaded["sites"]["alpha.test"]["manual"]["adsense_status"]
    assert (val == "approved") or val.get("value") == "approved"
    log = subprocess.check_output(["git", "log", "-1", "--format=%s"], cwd=appdir, text=True).strip()
    assert "alpha.test" in log
    assert "adsense_status" in log


def test_post_edit_unknown_site_404(client):
    r = client.post("/site/doesnotexist.com/edit/manual.x", data={"value": "y"})
    assert r.status_code == 404
