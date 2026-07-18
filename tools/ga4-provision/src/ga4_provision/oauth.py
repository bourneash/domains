"""Interactive OAuth as Jesse. Runs once; the service account does the rest.

Ports tools/auth-google/setup.mjs (Node) to Python. The cached token is a
convenience for re-runs when onboarding new sites — nothing recurring depends
on it, so its expiry is never a production concern.
"""
from __future__ import annotations

from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

OAUTH_CLIENT_PATH = Path("/home/jesse/projects/domains/.gcp/oauth-client.json")
TOKEN_CACHE_PATH = Path("/home/jesse/projects/domains/.gcp/ga4-provision-token.json")

# accessBindings.create needs manage.users; readonly is for property discovery.
USER_SCOPES = [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/analytics.manage.users",
]


def user_credentials(
    client_path: Path | None = None, token_path: Path | None = None
) -> Credentials:
    """Return user credentials, prompting in a browser only when necessary."""
    client_path = Path(client_path) if client_path else OAUTH_CLIENT_PATH
    token_path = Path(token_path) if token_path else TOKEN_CACHE_PATH

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(token_path, USER_SCOPES)

    if creds and creds.valid:
        return creds

    if creds and getattr(creds, "expired", False) and getattr(creds, "refresh_token", None):
        creds.refresh(Request())
    else:
        if not client_path.exists():
            raise FileNotFoundError(
                f"OAuth client not found at {client_path}. "
                "Expected the gitignored .gcp/oauth-client.json (installed type)."
            )
        flow = InstalledAppFlow.from_client_secrets_file(str(client_path), USER_SCOPES)
        creds = flow.run_local_server(port=0)

    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json())
    token_path.chmod(0o600)
    return creds
