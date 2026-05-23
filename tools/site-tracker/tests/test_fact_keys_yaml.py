"""Tests for the YAML-backed fact catalog loader."""
from __future__ import annotations

from pathlib import Path

import pytest

from site_tracker import fact_keys


def test_catalog_loads_14_facts_from_standard_yaml():
    # The module-level FACTS is populated at import time from standard.yaml.
    assert len(fact_keys.FACTS) == 14
    for key in (
        "cf.zone_active", "cf.worker_bound", "cf.email_routing",
        "http.ga4_present", "http.adsense_present",
        "http.meta_pixel_present", "http.gtm_present",
        "http.sitemap_200", "http.robots_present",
        "http.tls_expiry_days",
        "fs.last_commit_age_hours", "fs.ops_board_last_run_age_hours",
        "github.commits_ahead", "github.last_push_age_hours",
    ):
        assert key in fact_keys.FACTS, f"missing: {key}"


def test_families_returns_canonical_order():
    assert fact_keys.families() == [
        "cf", "http", "sitemap", "tls", "git", "ops", "github", "manual",
    ]


def test_keys_for_family_groups_correctly():
    assert set(fact_keys.keys_for_family("cf")) == {
        "cf.zone_active", "cf.worker_bound", "cf.email_routing",
    }
    assert set(fact_keys.keys_for_family("sitemap")) == {
        "http.sitemap_200", "http.robots_present",
    }
    # manual has no static keys
    assert fact_keys.keys_for_family("manual") == []


def test_state_rules_resolve_correctly():
    # cf.zone_active uses bool_green_red
    assert fact_keys.FACTS["cf.zone_active"].state_from_value(True, {}) == "green"
    assert fact_keys.FACTS["cf.zone_active"].state_from_value(False, {}) == "red"

    # http.ga4_present uses bool_green_yellow
    assert fact_keys.FACTS["http.ga4_present"].state_from_value(False, {}) == "yellow"

    # tls
    assert fact_keys.FACTS["http.tls_expiry_days"].state_from_value(3, {}) == "red"
    assert fact_keys.FACTS["http.tls_expiry_days"].state_from_value(15, {}) == "yellow"
    assert fact_keys.FACTS["http.tls_expiry_days"].state_from_value(90, {}) == "green"

    # commit_age active site
    assert fact_keys.FACTS["fs.last_commit_age_hours"].state_from_value(100, {"active": True}) == "green"
    assert fact_keys.FACTS["fs.last_commit_age_hours"].state_from_value(2000, {"active": True}) == "red"
    # commit_age parked
    assert fact_keys.FACTS["fs.last_commit_age_hours"].state_from_value(99999, {"active": False}) == "green"

    # push_age does NOT short-circuit on inactive
    assert fact_keys.FACTS["github.last_push_age_hours"].state_from_value(99999, {"active": False}) == "red"


def test_env_override(tmp_path: Path, monkeypatch):
    """Setting SITE_TRACKER_REGISTRY redirects loading to a custom catalog."""
    catalog = tmp_path / "custom.yaml"
    catalog.write_text("""
facts:
  custom.fact:
    family: cf
    source: test
    ttl_hours: 1
    describe: a custom fact
    state_rule: bool_green_red
families: [cf]
""")
    monkeypatch.setenv("SITE_TRACKER_REGISTRY", str(catalog))
    # Force a fresh load via the internal helper
    specs, families_list = fact_keys._load_catalog()
    assert "custom.fact" in specs
    assert families_list == ["cf"]


def test_unknown_state_rule_raises(tmp_path: Path, monkeypatch):
    catalog = tmp_path / "broken.yaml"
    catalog.write_text("""
facts:
  bad.fact:
    family: cf
    source: test
    ttl_hours: 1
    describe: bad
    state_rule: does_not_exist
families: [cf]
""")
    monkeypatch.setenv("SITE_TRACKER_REGISTRY", str(catalog))
    with pytest.raises(ValueError, match="does_not_exist"):
        fact_keys._load_catalog()
