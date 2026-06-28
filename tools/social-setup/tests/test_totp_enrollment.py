import os
import pytest
from social_setup.platforms.base import BasePlatform
from social_lib.credentials import read_creds


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    return tmp_path


def test_generate_and_store_totp_writes_secret(fake_root):
    # Ensure the social/ dir and a cred stub exist first
    cred_dir = fake_root / "sites" / "example.com" / "ops" / "social"
    cred_dir.mkdir(parents=True)
    (cred_dir / ".bluesky-creds").write_text("HANDLE=test\n")
    (cred_dir / ".bluesky-creds").chmod(0o600)

    platform = BasePlatform()
    secret = platform.generate_and_store_totp("example.com", "bluesky")

    assert len(secret) == 32
    creds = read_creds("example.com", "bluesky")
    assert creds["TOTP_SECRET"] == secret


def test_generate_and_store_totp_returns_valid_code(fake_root):
    import re
    from social_lib.totp import current_code

    cred_dir = fake_root / "sites" / "example.com" / "ops" / "social"
    cred_dir.mkdir(parents=True)
    (cred_dir / ".reddit-creds").write_text("USER=test\n")
    (cred_dir / ".reddit-creds").chmod(0o600)

    platform = BasePlatform()
    secret = platform.generate_and_store_totp("example.com", "reddit")
    code = current_code(secret)
    assert re.match(r"^\d{6}$", code)
