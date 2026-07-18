"""Grant the service account Viewer on GA4 properties.

A service account cannot grant itself, so this runs under Jesse's OAuth
credentials. One failure never aborts the fleet run.
"""
from __future__ import annotations

import json
from pathlib import Path

from googleapiclient.errors import HttpError

DEFAULT_KEY_PATH = Path("/home/jesse/projects/domains/.gcp/service-account.json")
VIEWER_ROLE = "predefinedRoles/viewer"


def service_account_email(key_path: Path | None = None) -> str:
    """Read the SA's client_email. Never touches the private key."""
    path = Path(key_path) if key_path else DEFAULT_KEY_PATH
    return json.loads(path.read_text())["client_email"]


def _existing_users(client, property_id: str) -> set[str]:
    api = client.properties().accessBindings()
    users: set[str] = set()
    request = api.list(parent=f"properties/{property_id}")
    while request is not None:
        response = request.execute()
        for binding in response.get("accessBindings", []):
            if binding.get("user"):
                users.add(binding["user"])
        request = api.list_next(request, response)
    return users


def grant_viewer(client, property_id: str, sa_email: str) -> str:
    """Return 'granted', 'already', or 'failed:<reason>'. Never raises."""
    try:
        if sa_email in _existing_users(client, property_id):
            return "already"
        client.properties().accessBindings().create(
            parent=f"properties/{property_id}",
            body={"user": sa_email, "roles": [VIEWER_ROLE]},
        ).execute()
        return "granted"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001 - one property must not abort the fleet
        return f"failed:{type(exc).__name__}"
