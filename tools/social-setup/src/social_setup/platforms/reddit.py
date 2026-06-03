"""Reddit provisioner — near-full automation, email verify only."""

from __future__ import annotations

import time

from rich.console import Console

from ..browser import human_gate, human_gate_input, launch_browser
from .base import PlatformProvisioner

console = Console()


class RedditProvisioner(PlatformProvisioner):
    name = "reddit"
    display_name = "Reddit"
    needs_browser = True

    def derive_username(self) -> str:
        base = self.brand.domain.split(".")[0].replace("-", "")
        return f"{base.capitalize()}Desk"

    def signup(self, page=None) -> dict:
        username = self.derive_username()
        console.print(f"  Creating Reddit account: [cyan]u/{username}[/cyan]")

        if page is None:
            ctx, page = launch_browser(self.brand.domain, "reddit")

        page.goto("https://www.reddit.com/register")
        time.sleep(3)

        try:
            email_input = page.locator('input[name="email"], input[id="regEmail"]')
            if email_input.count() > 0:
                email_input.first.fill(self.email)
                time.sleep(1)

                continue_btn = page.locator('button:has-text("Continue"), button[type="submit"]')
                if continue_btn.count() > 0:
                    continue_btn.first.click()
                    time.sleep(3)

            user_input = page.locator('input[name="username"], input[id="regUsername"]')
            if user_input.count() > 0:
                user_input.first.fill(username)
                time.sleep(1)

            pass_input = page.locator('input[name="password"], input[id="regPassword"]')
            if pass_input.count() > 0:
                pass_input.first.fill(self.password)
                time.sleep(1)

            signup_btn = page.locator('button:has-text("Sign Up"), button:has-text("Sign up")')
            if signup_btn.count() > 0:
                signup_btn.first.click()
                time.sleep(3)
        except Exception as e:
            console.print(f"  [yellow]Auto-fill partial: {e}[/yellow]")

        completed = human_gate(
            "Reddit",
            "Complete the signup in the browser:\n"
            f"  - Email: {self.email}\n"
            f"  - Username: u/{username}\n"
            f"  - Password: {self.password}\n"
            "  - Complete any CAPTCHA or email verification\n"
            "  - Get to the logged-in Reddit home"
        )
        if not completed:
            raise RuntimeError("Reddit signup skipped by user")

        actual_username = human_gate_input(
            "Reddit",
            f"What username did you get? (default: {username})"
        )
        if not actual_username:
            actual_username = username

        return {
            "REDDIT_USERNAME": actual_username,
            "REDDIT_PASSWORD": self.password,
            "REDDIT_EMAIL": self.email,
        }

    def configure_profile(self, page) -> None:
        console.print("  Configuring Reddit profile...")

        try:
            page.goto("https://www.reddit.com/settings/profile")
            time.sleep(3)

            about_input = page.locator('textarea[id*="about"], textarea[name*="about"]')
            if about_input.count() > 0:
                about_input.first.fill(self.brand.bio_short)
                time.sleep(1)

            save_btn = page.locator('button:has-text("Save")')
            if save_btn.count() > 0:
                save_btn.first.click()
                time.sleep(2)
                console.print("  [green]Profile configured[/green]")
        except Exception:
            human_gate("Reddit", "Set bio and save profile settings.")

    def get_api_keys(self, page) -> dict | None:
        console.print("  Creating Reddit API app...")

        page.goto("https://www.reddit.com/prefs/apps")
        time.sleep(3)

        completed = human_gate(
            "Reddit Developer",
            "Create a Reddit script-type app:\n"
            "  1. Scroll to bottom, click 'create another app...'\n"
            f"  2. Name: '{self.brand.name}'\n"
            "  3. Type: 'script'\n"
            f"  4. Redirect URI: http://localhost:8080\n"
            f"  5. About URL: {self.brand.url}\n"
            "  6. Click 'create app'"
        )
        if not completed:
            return None

        client_id = human_gate_input("Reddit", "Paste the app ID (under 'personal use script'):")
        client_secret = human_gate_input("Reddit", "Paste the app secret:")

        if not client_id:
            return None

        creds = self._read_existing_creds()
        username = creds.get("REDDIT_USERNAME", self.derive_username())

        return {
            "REDDIT_CLIENT_ID": client_id,
            "REDDIT_CLIENT_SECRET": client_secret or "",
            "REDDIT_USER_AGENT": f"{self.brand.domain}:{client_id}:v1.0 (by /u/{username})",
        }

    def _read_existing_creds(self) -> dict:
        from ..credentials import read_creds
        return read_creds(self.brand.site_root, self.name) or {}
