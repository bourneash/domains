"""Tests for site_tracker.registry."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from site_tracker import registry


@pytest.fixture
def sites_yml(tmp_path: Path) -> Path:
    src = Path(__file__).parent / "fixtures" / "sites.yml"
    dst = tmp_path / "sites.yml"
    shutil.copy(src, dst)
    return dst


def test_load_returns_sites_dict(sites_yml: Path):
    reg = registry.load(sites_yml)
    assert set(reg.sites.keys()) == {"alpha.test", "beta.test", "parked.test"}
    assert reg.sites["alpha.test"]["active"] is True


def test_load_normalizes_bare_manual_values_to_dict(sites_yml: Path):
    """Bare-string manual values (e.g. from hand-edited sites.yml) get lifted
    to the {value, set_at} dict shape so downstream readers don't have to branch."""
    reg = registry.load(sites_yml)
    # The fixture has alpha.test's amazon_associates_id as a bare string.
    val = reg.sites["alpha.test"]["manual"]["amazon_associates_id"]
    assert isinstance(val, dict)
    assert val["value"] == "alpha-20"
    assert val["set_at"] is None


def test_load_returns_config(sites_yml: Path):
    reg = registry.load(sites_yml)
    assert reg.config["auto_commit"] is True
    assert reg.config["auto_push"] is False


def test_set_manual_fact_writes_value_and_set_at(sites_yml: Path):
    reg = registry.load(sites_yml)
    registry.set_manual_fact(reg, sites_yml, "beta.test", "adsense_status", "approved")
    reloaded = registry.load(sites_yml)
    val = reloaded.sites["beta.test"]["manual"]["adsense_status"]
    assert val["value"] == "approved"
    assert "set_at" in val


def test_set_manual_fact_overwrites_existing(sites_yml: Path):
    reg = registry.load(sites_yml)
    registry.set_manual_fact(reg, sites_yml, "alpha.test", "amazon_associates_id", "alpha-30")
    reloaded = registry.load(sites_yml)
    val = reloaded.sites["alpha.test"]["manual"]["amazon_associates_id"]
    assert val["value"] == "alpha-30"
    assert "set_at" in val


def test_set_manual_fact_raises_unknown_site(sites_yml: Path):
    reg = registry.load(sites_yml)
    with pytest.raises(KeyError):
        registry.set_manual_fact(reg, sites_yml, "doesnotexist.com", "x", "y")


def test_active_sites_filter(sites_yml: Path):
    reg = registry.load(sites_yml)
    active = registry.active_sites(reg)
    assert set(active.keys()) == {"alpha.test", "beta.test"}


def test_applies_to_includes(sites_yml: Path):
    reg = registry.load(sites_yml)
    assert registry.site_applies_to(reg, "alpha.test", "cf") is True
    assert registry.site_applies_to(reg, "alpha.test", "ops") is False
    assert registry.site_applies_to(reg, "beta.test", "ops") is True
