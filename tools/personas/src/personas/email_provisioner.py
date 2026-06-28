# tools/personas/src/personas/email_provisioner.py
from __future__ import annotations
import os
from social_lib.email_client import EmailClient
from personas.store import make_handle


def provision_email(name: str, domain: str) -> str:
    """
    Create CF Email Routing alias <firstname>.<lastname>@<domain> → hotmail.
    Returns the full email address.
    """
    handle = make_handle(name)              # "jane-doe"
    local_part = handle.replace("-", ".")   # "jane.doe"
    address = f"{local_part}@{domain}"

    mailbox = os.environ.get("HOTMAIL_ADDRESS", "jessetamburino@hotmail.com")
    api_key = os.environ.get("EMAIL_API_KEY")
    # Accept either name — CLOUDFLARE_API_TOKEN is what wrangler/our .env uses
    # Accept either name — CLOUDFLARE_API_TOKEN is what wrangler/our .env uses
    cf_token = os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CF_API_TOKEN", "")
    if not cf_token:
        raise ValueError("CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) is not set in environment")

    domain_key = domain.upper().replace(".", "_")
    cf_zone_id = os.environ.get(f"CF_ZONE_ID_{domain_key}", "")
    if not cf_zone_id:
        # Look up zone ID from CF API — avoids needing per-domain env vars
        import httpx as _httpx
        r = _httpx.get(
            f"https://api.cloudflare.com/client/v4/zones?name={domain}",
            headers={"Authorization": f"Bearer {cf_token}"},
        )
        r.raise_for_status()
        zones = r.json().get("result", [])
        if not zones:
            raise ValueError(f"No CF zone found for {domain}")
        cf_zone_id = zones[0]["id"]

    client = EmailClient(mailbox, api_key=api_key)
    client.ensure_alias(
        domain=domain,
        local_part=local_part,
        cf_token=cf_token,
        cf_zone_id=cf_zone_id,
    )
    return address
