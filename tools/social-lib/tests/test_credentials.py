import os
import stat
from pathlib import Path
import pytest
from social_lib.credentials import (
    site_root, cred_path, write_creds, read_creds, has_creds, write_stub
)


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    return tmp_path


def test_site_root(fake_root):
    assert site_root("example.com") == fake_root / "sites" / "example.com"


def test_cred_path(fake_root):
    p = cred_path("example.com", "bluesky")
    assert p == fake_root / "sites" / "example.com" / "ops" / "social" / ".bluesky-creds"


def test_write_read_roundtrip(fake_root):
    write_creds("example.com", "bluesky", {"HANDLE": "test.bsky.social", "PASSWORD": "s3cr3t"})
    result = read_creds("example.com", "bluesky")
    assert result["HANDLE"] == "test.bsky.social"
    assert result["PASSWORD"] == "s3cr3t"


def test_write_creds_chmod_600(fake_root):
    write_creds("example.com", "reddit", {"USER": "testuser"})
    path = cred_path("example.com", "reddit")
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600


def test_read_creds_skips_comments(fake_root):
    write_creds("example.com", "x", {"KEY": "value"})
    path = cred_path("example.com", "x")
    path.write_text("# comment\nKEY=value\n# another comment\nOTHER=thing\n")
    result = read_creds("example.com", "x")
    assert "KEY" in result
    assert "OTHER" in result
    assert len(result) == 2


def test_has_creds_false_when_missing(fake_root):
    assert not has_creds("example.com", "tiktok")


def test_has_creds_true_when_written(fake_root):
    write_creds("example.com", "tiktok", {"USER": "x"})
    assert has_creds("example.com", "tiktok")


def test_write_stub_creates_file(fake_root):
    write_stub("example.com", "facebook")
    path = cred_path("example.com", "facebook")
    assert path.exists()
    assert "deferred" in path.read_text()


def test_write_stub_does_not_overwrite(fake_root):
    write_creds("example.com", "instagram", {"USER": "real"})
    write_stub("example.com", "instagram")
    result = read_creds("example.com", "instagram")
    assert result["USER"] == "real"
