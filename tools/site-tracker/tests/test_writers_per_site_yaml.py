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


HAND_AUTHORED = """\
# alpha.test — site facts
# Static, human-authored facts about this domain project. Machine-readable
# health facts (cf.*, http.*, canary.*) are appended by ops roles once the
# automation is activated; keep this hand-authored block at the top.

site:
  domain: alpha.test
  stood_up: '2026-06-30'
  worker_name: alpha-test          # Cloudflare Worker name
  repo: bourneash/alpha.test       # private; SSH alias git@github-bourneash:

niche:
  focus: testing
"""


def _raw(domains_root: Path, site: str) -> str:
    return (domains_root / "sites" / site / "ops" / "facts.yaml").read_text()


def test_write_fact_preserves_hand_authored_comments(domains_root):
    """A machine fact append must not destroy the hand-authored comment block."""
    p = domains_root / "sites" / "alpha.test" / "ops" / "facts.yaml"
    p.write_text(HAND_AUTHORED)

    per_site_yaml.write_fact(
        "alpha.test", "cf.zone_active",
        value=True, source="cf_api", state="green", ttl_hours=6,
        domains_root=domains_root,
    )

    raw = _raw(domains_root, "alpha.test")
    assert "# alpha.test — site facts" in raw
    assert "keep this hand-authored block at the top" in raw
    assert "# Cloudflare Worker name" in raw, "inline comments must survive too"
    assert "# private; SSH alias" in raw

    data = _read(domains_root, "alpha.test")
    assert data["site"]["domain"] == "alpha.test"
    assert data["niche"]["focus"] == "testing"
    assert data["facts"]["cf.zone_active"]["value"] is True


def test_write_fact_comments_survive_repeated_writes(domains_root):
    """Idempotence: comments must not erode across successive role ticks."""
    p = domains_root / "sites" / "alpha.test" / "ops" / "facts.yaml"
    p.write_text(HAND_AUTHORED)
    for i in range(3):
        per_site_yaml.write_fact(
            "alpha.test", f"http.probe_{i}",
            value=i, source="http_scrape", state="green", ttl_hours=24,
            domains_root=domains_root,
        )
    raw = _raw(domains_root, "alpha.test")
    assert raw.count("# Cloudflare Worker name") == 1
    assert "keep this hand-authored block at the top" in raw
    data = _read(domains_root, "alpha.test")
    assert set(data["facts"]) == {"http.probe_0", "http.probe_1", "http.probe_2"}


def test_write_fact_malformed_yaml_does_not_clobber_file(domains_root):
    """A malformed file must not be silently overwritten — back it up first."""
    p = domains_root / "sites" / "alpha.test" / "ops" / "facts.yaml"
    p.write_text("site: [unclosed\n  bad: : :\n")
    per_site_yaml.write_fact(
        "alpha.test", "cf.zone_active",
        value=True, source="cf_api", state="green", ttl_hours=6,
        domains_root=domains_root,
    )
    backup = p.with_suffix(".yaml.corrupt")
    assert backup.exists(), "original content must be preserved on a parse failure"
    assert "unclosed" in backup.read_text()


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
