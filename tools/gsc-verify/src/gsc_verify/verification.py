"""Site Verification API — the service account verifies domains itself.

The Search Console API exposes no permissions endpoint, so access cannot be
granted to the service account. Instead it proves control of the domain via a
DNS TXT record and becomes a verified owner in its own right.
"""
from __future__ import annotations

from googleapiclient.errors import HttpError

DNS_METHOD = "DNS_TXT"
SITE_TYPE = "INET_DOMAIN"


def dns_record_name(domain: str) -> str:
    """Google's DNS_TXT method places the record at the bare domain."""
    return domain


def get_token(client, domain: str) -> str:
    """Request the verification token to publish as a TXT record."""
    response = client.webResource().getToken(
        body={
            "site": {"type": SITE_TYPE, "identifier": domain},
            "verificationMethod": DNS_METHOD,
        }
    ).execute()
    return response["token"]


def is_verified(client, domain: str) -> bool:
    """True when this identity already owns the domain."""
    try:
        response = client.webResource().list().execute()
    except HttpError:
        return False
    for item in response.get("items", []):
        site = item.get("site", {})
        if site.get("type") == SITE_TYPE and site.get("identifier") == domain:
            return True
    return False


def verify(client, domain: str) -> str:
    """Return 'verified' or 'failed:<reason>'. Never raises."""
    try:
        client.webResource().insert(
            verificationMethod=DNS_METHOD,
            body={"site": {"type": SITE_TYPE, "identifier": domain}},
        ).execute()
        return "verified"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001 - one domain must not abort the fleet
        return f"failed:{type(exc).__name__}"
