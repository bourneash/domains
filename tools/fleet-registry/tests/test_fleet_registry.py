"""Tests for the fleet registry loader + merge derivations."""

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_registry as B  # noqa: E402
import fleet_registry as R  # noqa: E402


@pytest.fixture()
def registry(tmp_path, monkeypatch):
    path = tmp_path / "registry" / "fleet.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump({"sites": {
        "alpha.com": {"status": "live", "repo": "o/alpha", "capabilities": ["site", "cron", "analytics"],
                      "analytics": {"ga4_property_id": "1"}},
        "beta.com": {"status": "scaffold", "repo": "o/beta", "capabilities": ["site"]},
        "typo.com": {"status": "redirect", "capabilities": []},
        "gamma.com": {"status": "live", "capabilities": ["site"],
                      "capabilities_override": ["site", "cron"]},
    }}), encoding="utf-8")
    monkeypatch.setenv("FLEET_REGISTRY", str(path))
    R.load(fresh=True)
    return path


def test_sites_filters_by_status(registry):
    assert R.sites() == ["alpha.com", "beta.com", "gamma.com", "typo.com"]
    assert R.sites(status="live") == ["alpha.com", "gamma.com"]
    assert R.sites(status="redirect") == ["typo.com"]


def test_get_and_helpers(registry):
    assert R.get("alpha.com")["repo"] == "o/alpha"
    assert R.get("nope.com") is None
    assert R.repo("beta.com") == "o/beta"
    assert R.analytics("alpha.com") == {"ga4_property_id": "1"}
    assert R.analytics("beta.com") == {}


def test_capability_override_wins(registry):
    """A human-set capabilities_override replaces detection, not merges with it."""
    assert R.with_capability("cron") == ["alpha.com", "gamma.com"]
    assert R.with_capability("analytics") == ["alpha.com"]


def test_worker_name_read_from_jsonc(tmp_path):
    site = tmp_path / "site"
    site.mkdir()
    (site / "wrangler.jsonc").write_text(
        '// leading comment\n{\n  /* block */\n  "name": "alpha-com",\n'
        '  "compatibility_date": "2026-05-26"\n}\n',
        encoding="utf-8",
    )
    assert B.read_worker_name(site) == "alpha-com"


def test_worker_name_absent(tmp_path):
    site = tmp_path / "site"
    site.mkdir()
    assert B.read_worker_name(site) is None


@pytest.mark.parametrize("disk,expected", [
    ({"has_site": True, "has_ops": True, "has_cron": True, "has_smoke": False}, "live"),
    ({"has_site": True, "has_ops": True, "has_cron": False, "has_smoke": True}, "live"),
    ({"has_site": True, "has_ops": True, "has_cron": False, "has_smoke": False}, "scaffold"),
    ({"has_site": False, "has_ops": True, "has_cron": False, "has_smoke": False}, "parked"),
    ({"has_site": False, "has_ops": False, "has_cron": False, "has_smoke": False}, "redirect"),
])
def test_derive_status_prefers_disk_evidence(disk, expected):
    """DOMAINS_INDEX buckets are provably stale, so disk wins — including when
    the index still calls a shipping site 'parked'."""
    assert B.derive_status(disk, "parked") == expected


def test_slack_match_tolerates_adhoc_env_keys():
    squashed = {"rc9": "SLACK_CHANNEL_RC9", "saveusfarms": "SLACK_CHANNEL_SAVE_US_FARMS",
                "amputeenewscom": "SLACK_CHANNEL_AMPUTEENEWS_COM"}
    assert B.match_slack("rc-9.com", squashed) == "SLACK_CHANNEL_RC9"
    assert B.match_slack("saveusfarms.com", squashed) == "SLACK_CHANNEL_SAVE_US_FARMS"
    assert B.match_slack("amputeenews.com", squashed) == "SLACK_CHANNEL_AMPUTEENEWS_COM"
    assert B.match_slack("unknown.com", squashed) is None


def test_domains_index_parses_section_buckets(tmp_path, monkeypatch):
    index = tmp_path / "DOMAINS_INDEX.md"
    index.write_text(
        "# Domains Index\n\n## Active sites (built / operating)\n"
        "| Domain | In use | TLDR |\n|---|---|---|\n| alpha.com | ok | thing |\n"
        "\n## Parked / empty (registered, no site yet)\n| beta.com | | |\n"
        "\n## Bootstrap scripts\n| not-a-domain | | |\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(B, "ROOT", tmp_path)
    assert B.read_domains_index() == {"alpha.com": "active", "beta.com": "parked"}


def _merge(monkeypatch, tmp_path, old, new):
    out = tmp_path / "fleet.yaml"
    out.write_text(yaml.safe_dump({"sites": old}), encoding="utf-8")
    monkeypatch.setattr(B, "OUT", out)
    return B.merge_preserved(new)


def test_merge_upgrades_scaffold_to_live(monkeypatch, tmp_path):
    """A scaffold that grew cron/smoke really went live; preserving the stored
    'scaffold' is how greatamericanlakes.com stayed mislabelled after launch."""
    merged = _merge(monkeypatch, tmp_path,
                    {"a.com": {"status": "scaffold"}}, {"a.com": {"status": "live"}})
    assert merged["a.com"]["status"] == "live"


def test_merge_never_demotes_hand_set_live(monkeypatch, tmp_path):
    """'live' set by hand on a deployed site outranks the cron/smoke heuristic."""
    merged = _merge(monkeypatch, tmp_path,
                    {"a.com": {"status": "live"}}, {"a.com": {"status": "scaffold"}})
    assert merged["a.com"]["status"] == "live"


@pytest.mark.parametrize("stored", ["parked", "redirect", "staging"])
def test_merge_preserves_policy_statuses(monkeypatch, tmp_path, stored):
    merged = _merge(monkeypatch, tmp_path,
                    {"a.com": {"status": stored}}, {"a.com": {"status": "live"}})
    assert merged["a.com"]["status"] == stored
