"""Tests for writers.per_site_yaml."""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from site_tracker.writers import per_site_yaml


@pytest.fixture
def domains_root(tmp_path: Path) -> Path:
    root = tmp_path / "domains"
    (root / "sites" / "alpha.test" / "ops").mkdir(parents=True)
    return root


def _read(domains_root: Path, site: str) -> dict:
    p = domains_root / "sites" / site / "ops" / "facts.yaml"
    return yaml.safe_load(p.read_text())


def test_write_fact_creates_file_with_facts_block(domains_root):
    per_site_yaml.write_fact(
        "alpha.test", "cf.zone_active",
        value=True, source="cf_api", state="green", ttl_hours=6,
        domains_root=domains_root,
    )
    data = _read(domains_root, "alpha.test")
    assert data["facts"]["cf.zone_active"]["value"] is True
    assert data["facts"]["cf.zone_active"]["state"] == "green"
    assert data["facts"]["cf.zone_active"]["source"] == "cf_api"
    assert data["facts"]["cf.zone_active"]["ttl_hours"] == 6
    assert "verified_at" in data["facts"]["cf.zone_active"]
    assert data["last_updated"] is not None


def test_write_fact_preserves_other_facts(domains_root):
    per_site_yaml.write_fact(
        "alpha.test", "cf.zone_active",
        value=True, source="cf_api", state="green", ttl_hours=6,
        domains_root=domains_root,
    )
    per_site_yaml.write_fact(
        "alpha.test", "http.ga4_present",
        value=False, source="http_scrape", state="yellow", ttl_hours=24,
        domains_root=domains_root,
    )
    data = _read(domains_root, "alpha.test")
    assert set(data["facts"].keys()) == {"cf.zone_active", "http.ga4_present"}
    assert data["facts"]["cf.zone_active"]["value"] is True
    assert data["facts"]["http.ga4_present"]["value"] is False


def test_write_fact_overwrites_existing_key(domains_root):
    per_site_yaml.write_fact(
        "alpha.test", "http.ga4_present",
        value=False, source="http_scrape", state="yellow", ttl_hours=24,
        domains_root=domains_root,
    )
    per_site_yaml.write_fact(
        "alpha.test", "http.ga4_present",
        value=True, source="http_scrape", state="green", ttl_hours=24,
        domains_root=domains_root,
    )
    data = _read(domains_root, "alpha.test")
    assert data["facts"]["http.ga4_present"]["value"] is True
    assert data["facts"]["http.ga4_present"]["state"] == "green"


def test_write_fact_unknown_value_is_null(domains_root):
    per_site_yaml.write_fact(
        "alpha.test", "github.commits_ahead",
        value=None, source="github_api", state="unknown", ttl_hours=24,
        domains_root=domains_root,
    )
    data = _read(domains_root, "alpha.test")
    assert data["facts"]["github.commits_ahead"]["value"] is None
    assert data["facts"]["github.commits_ahead"]["state"] == "unknown"


def test_write_fact_missing_ops_dir_logs_and_skips(domains_root, caplog):
    # No ops/ dir for beta.test — should not raise, should not create the file.
    per_site_yaml.write_fact(
        "beta.test", "http.ga4_present",
        value=True, source="http_scrape", state="green", ttl_hours=24,
        domains_root=domains_root,
    )
    assert not (domains_root / "sites" / "beta.test" / "ops" / "facts.yaml").exists()


def test_write_fact_uses_env_var_when_no_override(tmp_path, monkeypatch):
    root = tmp_path / "envroot"
    (root / "sites" / "gamma.test" / "ops").mkdir(parents=True)
    monkeypatch.setenv("SITE_TRACKER_DOMAINS_ROOT", str(root))
    per_site_yaml.write_fact(
        "gamma.test", "cf.zone_active",
        value=True, source="cf_api", state="green", ttl_hours=6,
    )
    data = yaml.safe_load((root / "sites" / "gamma.test" / "ops" / "facts.yaml").read_text())
    assert data["facts"]["cf.zone_active"]["value"] is True
