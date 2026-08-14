from __future__ import annotations
import httpx

EMAIL_API = "http://localhost:9200"


class EmailClient:
    def __init__(self, mailbox: str, api_key: str | None = None):
        self.mailbox = mailbox
        # Server auth is `Authorization: Bearer <key>` (see email-client's
        # api/auth.py) — x-api-key was the old scheme, updated to match.
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def wait_for_message(
        self,
        to_addr: str,
        subject_contains: str = "",
        timeout: int = 120,
    ) -> dict:
        resp = httpx.post(
            f"{EMAIL_API}/mailbox/{self.mailbox}/wait",
            json={
                "match": {"to": to_addr, "subject": subject_contains},
                "timeout_seconds": timeout,
            },
            headers=self._headers,
            timeout=timeout + 15,
        )
        resp.raise_for_status()
        return resp.json()["message"]

    def ensure_alias(
        self,
        domain: str,
        local_part: str,
        cf_token: str,
        cf_zone_id: str,
    ) -> bool:
        """Create CF Email Routing rule local_part@domain → hotmail. Returns True if created."""
        address = f"{local_part}@{domain}"
        headers = {"Authorization": f"Bearer {cf_token}", "Content-Type": "application/json"}
        list_resp = httpx.get(
            f"https://api.cloudflare.com/client/v4/zones/{cf_zone_id}/email/routing/rules",
            headers=headers,
        )
        list_resp.raise_for_status()
        for rule in list_resp.json().get("result", []):
            for matcher in rule.get("matchers", []):
                if matcher.get("value") == address:
                    return False  # already exists
        create_resp = httpx.post(
            f"https://api.cloudflare.com/client/v4/zones/{cf_zone_id}/email/routing/rules",
            headers=headers,
            json={
                "enabled": True,
                "matchers": [{"field": "to", "type": "literal", "value": address}],
                "actions": [{"type": "forward", "value": ["jessetamburino@hotmail.com"]}],
            },
        )
        create_resp.raise_for_status()
        return True
