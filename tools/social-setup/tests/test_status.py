"""Tests for social_setup.status — write_social_status / read_social_status."""

import json
import pytest
from social_setup.status import write_social_status, read_social_status


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    return tmp_path


def test_write_read_roundtrip(fake_root):
    results = {
        "bluesky": {"state": "provisioned"},
        "facebook": {"state": "deferred"},
    }
    write_social_status("example.com", results)
    status = read_social_status("example.com")
    assert status["bluesky"]["state"] == "provisioned"
    assert status["facebook"]["state"] == "deferred"


def test_write_adds_timestamp(fake_root):
    write_social_status("example.com", {"reddit": {"state": "provisioned"}})
    status = read_social_status("example.com")
    assert "provisioned_at" in status["reddit"]


def test_deferred_has_no_timestamp(fake_root):
    write_social_status("example.com", {"twitter": {"state": "deferred"}})
    status = read_social_status("example.com")
    assert "provisioned_at" not in status["twitter"]


def test_read_returns_empty_when_missing(fake_root):
    assert read_social_status("no-such-domain.com") == {}


def test_status_file_written_as_valid_json(fake_root):
    write_social_status("example.com", {"bluesky": {"state": "provisioned"}})
    path = fake_root / "sites" / "example.com" / "ops" / "social" / "social-status.json"
    assert path.exists()
    data = json.loads(path.read_text())
    assert "bluesky" in data


def test_existing_provisioned_at_preserved(fake_root):
    """If provisioned_at is already set, do not overwrite it."""
    fixed_ts = "2026-01-01T00:00:00+00:00"
    write_social_status(
        "example.com",
        {"bluesky": {"state": "provisioned", "provisioned_at": fixed_ts}},
    )
    status = read_social_status("example.com")
    assert status["bluesky"]["provisioned_at"] == fixed_ts
