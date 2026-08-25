"""credentials.py is now a thin delegation layer over vault_store.

The previous version of this file tested the flat-file store that
`ops/social/.<platform>-creds` used to be — it imported `cred_path`, which
commit eeee6db deleted when the fleet moved to Vaultwarden. The suite has been
uncollectable ever since (ImportError at module import, so *all* of
social-lib's credential coverage was silently gone, not just the stale cases).

These tests assert the two things that are actually true of the module now:
delegation is faithful and lossless, and no vault I/O happens for the pure
path helper. The vault itself is faked — a unit test must never depend on a
running Vaultwarden or the `bw` CLI.
"""

import base64
import json

import pytest

from social_lib import credentials, vault_store


class FakeVault:
    """In-memory stand-in for vault_store, keyed the same way it is."""

    def __init__(self):
        self.items: dict[tuple[str, str], dict] = {}

    def write_creds(self, domain, platform, data):
        self.items[(domain, platform)] = dict(data)

    def read_creds(self, domain, platform):
        return dict(self.items.get((domain, platform), {}))

    def has_creds(self, domain, platform):
        return (domain, platform) in self.items

    def write_stub(self, domain, platform):
        if not self.has_creds(domain, platform):
            self.write_creds(domain, platform, {"STATUS": "deferred"})


@pytest.fixture
def vault(monkeypatch):
    fake = FakeVault()
    for name in ("write_creds", "read_creds", "has_creds", "write_stub"):
        monkeypatch.setattr(credentials.vault_store, name, getattr(fake, name))
    return fake


def test_site_root_honours_domains_root(monkeypatch, tmp_path):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    assert credentials.site_root("example.com") == tmp_path / "sites" / "example.com"


def test_site_root_defaults_without_env(monkeypatch):
    monkeypatch.delenv("DOMAINS_ROOT", raising=False)
    assert credentials.site_root("example.com").parts[-2:] == ("sites", "example.com")


def test_write_read_roundtrip_is_lossless(vault):
    data = {"BLUESKY_HANDLE": "test.bsky.social", "BLUESKY_PASSWORD": "s3cr3t"}
    credentials.write_creds("example.com", "bluesky", data)
    assert credentials.read_creds("example.com", "bluesky") == data


def test_read_creds_missing_item_is_empty(vault):
    assert credentials.read_creds("example.com", "tiktok") == {}


def test_creds_are_keyed_per_domain_and_platform(vault):
    credentials.write_creds("a.com", "bluesky", {"USER": "a"})
    credentials.write_creds("b.com", "bluesky", {"USER": "b"})
    credentials.write_creds("a.com", "reddit", {"USER": "c"})
    assert credentials.read_creds("a.com", "bluesky")["USER"] == "a"
    assert credentials.read_creds("b.com", "bluesky")["USER"] == "b"
    assert credentials.read_creds("a.com", "reddit")["USER"] == "c"


def test_has_creds_false_when_missing(vault):
    assert not credentials.has_creds("example.com", "tiktok")


def test_has_creds_true_when_written(vault):
    credentials.write_creds("example.com", "tiktok", {"USER": "x"})
    assert credentials.has_creds("example.com", "tiktok")


def test_write_stub_marks_deferred(vault):
    credentials.write_stub("example.com", "facebook")
    assert credentials.read_creds("example.com", "facebook") == {"STATUS": "deferred"}


def test_write_stub_never_clobbers_real_creds(vault):
    credentials.write_creds("example.com", "instagram", {"USER": "real"})
    credentials.write_stub("example.com", "instagram")
    assert credentials.read_creds("example.com", "instagram")["USER"] == "real"


# --- vault_store: the parts that need no running vault -----------------------

def test_encode_is_base64_json():
    encoded = vault_store._encode({"name": "example.com — bluesky"})
    assert json.loads(base64.b64decode(encoded)) == {"name": "example.com — bluesky"}


def test_write_creds_builds_the_item_the_vault_expects(monkeypatch):
    """Secrets must be typed as hidden fields, every key preserved, and the
    item filed into the shared org collection — that sharing is the whole
    reason the fleet uses an org vault rather than automation's personal one."""
    sent = {}

    monkeypatch.setattr(vault_store, "_ensure_unlocked", lambda: None)
    monkeypatch.setattr(vault_store, "_find_item", lambda d, p: None)
    monkeypatch.setattr(vault_store, "_bw",
                        lambda args, input_text=None: sent.update(args=args) or "")

    vault_store.write_creds("example.com", "bluesky", {
        "BLUESKY_HANDLE": "test.bsky.social",
        "BLUESKY_PASSWORD": "s3cr3t",
        "BLUESKY_APP_TOKEN": "tok",
        "NOTE": "plain",
    })

    assert sent["args"][:2] == ["create", "item"]
    body = json.loads(base64.b64decode(sent["args"][2]))
    assert body["name"] == "example.com — bluesky"
    assert body["organizationId"] == vault_store.ORG_ID
    assert body["collectionIds"] == [vault_store.COLLECTION_ID]
    assert body["login"]["username"] == "test.bsky.social"
    assert body["login"]["password"] == "s3cr3t"

    types = {f["name"]: f["type"] for f in body["fields"]}
    assert types == {
        "BLUESKY_HANDLE": 0, "BLUESKY_PASSWORD": 1, "BLUESKY_APP_TOKEN": 1, "NOTE": 0
    }


def test_write_creds_edits_an_existing_item_instead_of_duplicating(monkeypatch):
    sent = {}
    monkeypatch.setattr(vault_store, "_ensure_unlocked", lambda: None)
    monkeypatch.setattr(vault_store, "_find_item", lambda d, p: {"id": "item-123"})
    monkeypatch.setattr(vault_store, "_bw",
                        lambda args, input_text=None: sent.update(args=args) or "")

    vault_store.write_creds("example.com", "bluesky", {"USER": "x"})
    assert sent["args"][:3] == ["edit", "item", "item-123"]


def test_read_creds_reads_fields_not_the_login_block(monkeypatch):
    """login.username/password are cosmetic (they make the Bitwarden UI look
    sane); `fields` is the source of truth for a lossless round-trip."""
    monkeypatch.setattr(vault_store, "_find_item", lambda d, p: {
        "login": {"username": "ui-only", "password": "ui-only"},
        "fields": [{"name": "BLUESKY_HANDLE", "value": "real"},
                   {"name": "EMPTY"}],
    })
    assert vault_store.read_creds("example.com", "bluesky") == {
        "BLUESKY_HANDLE": "real", "EMPTY": ""
    }
