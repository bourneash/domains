"""Bluesky provisioner — browser signup (CAPTCHA required), API profile config."""

from __future__ import annotations

import time

import httpx
from rich.console import Console

from ..browser import human_gate, human_gate_input, launch_browser
from .base import PlatformProvisioner

console = Console()

BSKY_API = "https://bsky.social/xrpc"


class BlueskyProvisioner(PlatformProvisioner):
    name = "bluesky"
    display_name = "Bluesky"
    needs_browser = True

    def derive_username(self) -> str:
        return self.brand.domain.split(".")[0].lower().replace("-", "")

    def signup(self, page=None) -> dict:
        handle = f"{self.derive_username()}.bsky.social"
        console.print(f"  Creating Bluesky account: [cyan]{handle}[/cyan]")

        if page is None:
            ctx, page = launch_browser(self.brand.domain, "bluesky")

        page.goto("https://bsky.app")
        time.sleep(2)

        # Navigate to signup
        try:
            create_btn = page.locator('button:has-text("Create a new account"), a:has-text("Create account"), button:has-text("Create account")')
            if create_btn.count() > 0:
                create_btn.first.click()
                time.sleep(2)
        except Exception:
            page.goto("https://bsky.app")
            time.sleep(2)

        # Try to fill in the form
        try:
            email_input = page.locator('input[type="email"], input[placeholder*="Email"], input[autocomplete="email"]')
            if email_input.count() > 0:
                email_input.first.fill(self.email)
                time.sleep(1)

            pass_input = page.locator('input[type="password"], input[placeholder*="assword"]')
            if pass_input.count() > 0:
                pass_input.first.fill(self.password)
                time.sleep(1)

            # Date of birth if present
            dob_input = page.locator('input[placeholder*="birth"], input[type="date"]')
            if dob_input.count() > 0:
                dob_input.first.fill("1990-01-01")
                time.sleep(1)
        except Exception as e:
            console.print(f"  [yellow]Auto-fill partial: {e}[/yellow]")

        # Human gate for CAPTCHA and completing signup
        completed = human_gate(
            "Bluesky",
            "Complete the Bluesky signup in the browser:\n"
            f"  - Email: {self.email}\n"
            f"  - Password: {self.password}\n"
            f"  - Handle: try '{self.derive_username()}'\n"
            "  - Complete the CAPTCHA verification\n"
            "  - Verify email if prompted\n"
            "  - Get to the logged-in feed"
        )
        if not completed:
            raise RuntimeError("Bluesky signup skipped by user")

        actual_handle = human_gate_input(
            "Bluesky",
            f"What handle did you get? (default: {handle})"
        )
        if not actual_handle:
            actual_handle = handle
        elif not actual_handle.endswith(".bsky.social"):
            actual_handle = f"{actual_handle}.bsky.social"

        # Get DID by resolving the handle
        did = ""
        try:
            resp = httpx.get(
                f"{BSKY_API}/com.atproto.identity.resolveHandle",
                params={"handle": actual_handle},
                timeout=15,
            )
            if resp.status_code == 200:
                did = resp.json().get("did", "")
        except Exception:
            pass

        # Create an app password for API access
        app_password = ""
        try:
            session = httpx.post(
                f"{BSKY_API}/com.atproto.server.createSession",
                json={"identifier": actual_handle, "password": self.password},
                timeout=15,
            )
            if session.status_code == 200:
                token = session.json()["accessJwt"]
                if not did:
                    did = session.json().get("did", "")
                app_pw_resp = httpx.post(
                    f"{BSKY_API}/com.atproto.server.createAppPassword",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"name": f"{self.brand.domain}-bot"},
                    timeout=15,
                )
                if app_pw_resp.status_code == 200:
                    app_password = app_pw_resp.json().get("password", "")
                    console.print("  [green]App password created for API access[/green]")
        except Exception as e:
            console.print(f"  [yellow]Could not create app password: {e}[/yellow]")

        return {
            "BLUESKY_HANDLE": actual_handle,
            "BLUESKY_DID": did,
            "BLUESKY_PASSWORD": self.password,
            "BLUESKY_APP_PASSWORD": app_password,
            "BLUESKY_EMAIL": self.email,
        }

    def configure_profile(self, page=None) -> None:
        console.print("  Configuring Bluesky profile via API...")
        from social_lib.credentials import read_creds
        creds = read_creds(self.brand.domain, "bluesky") or {}

        handle = creds.get("BLUESKY_HANDLE", "")
        password = creds.get("BLUESKY_PASSWORD", self.password)

        if not handle:
            console.print("  [yellow]No handle in creds, skipping profile config[/yellow]")
            return

        try:
            session = httpx.post(
                f"{BSKY_API}/com.atproto.server.createSession",
                json={"identifier": handle, "password": password},
                timeout=15,
            )
            if session.status_code != 200:
                console.print("  [yellow]Could not authenticate to configure profile[/yellow]")
                return

            token = session.json()["accessJwt"]
            did = session.json().get("did", creds.get("BLUESKY_DID", ""))

            current = httpx.get(
                f"{BSKY_API}/com.atproto.repo.getRecord",
                params={"repo": did, "collection": "app.bsky.actor.profile", "rkey": "self"},
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
            )

            profile_record = {
                "$type": "app.bsky.actor.profile",
                "displayName": self.brand.name,
                "description": self.brand.bio_short,
            }

            if current.status_code == 200:
                existing = current.json().get("value", {})
                cid = current.json().get("cid", "")
                profile_record = {**existing, **profile_record}
                httpx.post(
                    f"{BSKY_API}/com.atproto.repo.putRecord",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "repo": did,
                        "collection": "app.bsky.actor.profile",
                        "rkey": "self",
                        "swapRecord": cid,
                        "record": profile_record,
                    },
                    timeout=15,
                )
            else:
                httpx.post(
                    f"{BSKY_API}/com.atproto.repo.createRecord",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "repo": did,
                        "collection": "app.bsky.actor.profile",
                        "rkey": "self",
                        "record": profile_record,
                    },
                    timeout=15,
                )

            console.print(f"  [green]Profile configured: {self.brand.name}[/green]")
        except Exception as e:
            console.print(f"  [yellow]Profile config failed: {e}[/yellow]")

    def get_api_keys(self, page=None) -> dict | None:
        return None
