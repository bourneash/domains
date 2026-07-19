"""Load the fleet service-account key. Never logs or returns the private key."""
from __future__ import annotations

import json
from pathlib import Path

from google.oauth2 import service_account

from .errors import CredentialsMalformed, CredentialsMissing

DEFAULT_KEY_PATH = Path("/home/jesse/projects/domains/.gcp/service-account.json")

REQUIRED_FIELDS = ("type", "private_key", "client_email", "project_id", "token_uri")


def load_service_account(path: Path | None = None, *, scopes: list[str] | None = None):
    """Return service-account Credentials, optionally scoped.

    Raises CredentialsMissing / CredentialsMalformed with an actionable message.
    """
    key_path = Path(path) if path else DEFAULT_KEY_PATH
    if not key_path.exists():
        raise CredentialsMissing(
            f"Service-account key not found at {key_path}. "
            "Expected the gitignored .gcp/service-account.json."
        )

    try:
        data = json.loads(key_path.read_text())
    except json.JSONDecodeError as exc:
        raise CredentialsMalformed(f"{key_path} is not valid JSON: {exc}") from exc

    if data.get("type") != "service_account":
        raise CredentialsMalformed(
            f"{key_path} has type={data.get('type')!r}, expected 'service_account'."
        )

    missing = [f for f in REQUIRED_FIELDS if not data.get(f)]
    if missing:
        raise CredentialsMalformed(
            f"{key_path} is missing required field(s): {', '.join(missing)}"
        )

    return service_account.Credentials.from_service_account_info(data, scopes=scopes)
