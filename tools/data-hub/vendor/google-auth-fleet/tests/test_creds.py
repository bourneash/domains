import json
import pytest

from google_auth_fleet import creds
from google_auth_fleet.errors import CredentialsMissing, CredentialsMalformed


def test_missing_key_raises_credentials_missing(tmp_path):
    with pytest.raises(CredentialsMissing) as exc:
        creds.load_service_account(tmp_path / "nope.json")
    assert "nope.json" in str(exc.value)


def test_malformed_key_raises_credentials_malformed(tmp_path):
    bad = tmp_path / "sa.json"
    bad.write_text(json.dumps({"type": "service_account"}))
    with pytest.raises(CredentialsMalformed) as exc:
        creds.load_service_account(bad)
    assert "private_key" in str(exc.value)


def test_wrong_type_raises_credentials_malformed(tmp_path):
    bad = tmp_path / "sa.json"
    bad.write_text(json.dumps({"type": "authorized_user", "private_key": "x"}))
    with pytest.raises(CredentialsMalformed):
        creds.load_service_account(bad)
