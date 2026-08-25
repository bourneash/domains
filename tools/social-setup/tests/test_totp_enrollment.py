import re

from social_setup.platforms.base import BasePlatform
from social_lib.credentials import read_creds, write_creds
from social_lib.totp import current_code

# Creds live in Vaultwarden now, not in ops/social/.<platform>-creds files —
# these tests used to seed those files and set DOMAINS_ROOT, which has been
# meaningless since the vault migration. The store is faked in conftest.py.


def test_generate_and_store_totp_writes_secret():
    write_creds("example.com", "bluesky", {"HANDLE": "test"})

    secret = BasePlatform().generate_and_store_totp("example.com", "bluesky")

    assert len(secret) == 32
    creds = read_creds("example.com", "bluesky")
    assert creds["TOTP_SECRET"] == secret
    assert creds["HANDLE"] == "test", "enrolment must not drop existing fields"


def test_generate_and_store_totp_returns_valid_code():
    write_creds("example.com", "reddit", {"USER": "test"})

    secret = BasePlatform().generate_and_store_totp("example.com", "reddit")

    assert re.match(r"^\d{6}$", current_code(secret))
