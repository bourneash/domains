"""Tests for the click CLI."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from click.testing import CliRunner

from site_tracker.cli import main


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    fixt = Path(__file__).parent / "fixtures" / "sites.yml"
    (tmp_path / "tools" / "site-tracker").mkdir(parents=True)
    shutil.copy(fixt, tmp_path / "tools" / "site-tracker" / "sites.yml")
    (tmp_path / "data").mkdir()
    return tmp_path


def test_init_db_creates_facts_db(workdir: Path, monkeypatch):
    monkeypatch.chdir(workdir / "tools" / "site-tracker")
    runner = CliRunner()
    res = runner.invoke(main, ["init-db", "--data-dir", str(workdir / "data")])
    assert res.exit_code == 0, res.output
    assert (workdir / "data" / "facts.db").exists()


def test_collect_unknown_collector_errors(workdir: Path, monkeypatch):
    monkeypatch.chdir(workdir / "tools" / "site-tracker")
    runner = CliRunner()
    res = runner.invoke(main, ["collect", "doesnotexist",
                               "--data-dir", str(workdir / "data")])
    assert res.exit_code == 2
    # The "unknown collector" message is written to stderr.
    combined = (res.output + (res.stderr or "")).lower()
    assert "unknown collector" in combined


def test_collect_all_runs_each_collector(workdir: Path, monkeypatch):
    monkeypatch.chdir(workdir / "tools" / "site-tracker")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "")  # cf collector will skip
    # Stub http_scrape's slow network paths so the test stays fast.
    from site_tracker.collectors import http_scrape
    monkeypatch.setattr(http_scrape, "_tls_expiry_days", lambda h: None)
    monkeypatch.setattr(http_scrape, "_fetch", lambda *_: None)
    runner = CliRunner()
    res = runner.invoke(main, ["collect-all", "--data-dir", str(workdir / "data")])
    assert "filesystem" in res.output
    assert "cloudflare" in res.output
