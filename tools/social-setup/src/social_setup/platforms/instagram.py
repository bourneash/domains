"""Instagram provisioner — semi-auto, phone verification required."""

from __future__ import annotations

import time

from rich.console import Console

from ..browser import human_gate, human_gate_input, launch_browser
from .base import PlatformProvisioner

console = Console()


class InstagramProvisioner(PlatformProvisioner):
    name = "instagram"
    display_name = "Instagram"
    needs_browser = True

    def derive_username(self) -> str:
        base = self.brand.domain.split(".")[0].replace("-", "")
        return base.lower()

    def signup(self, page=None) -> dict:
        username = self.derive_username()
        console.print(f"  Creating Instagram account: [cyan]@{username}[/cyan]")

        if page is None:
            ctx, page = launch_browser(self.brand.domain, "instagram")

        page.goto("https://www.instagram.com/accounts/emailsignup/")
        time.sleep(3)

        try:
            email_input = page.locator('input[name="emailOrPhone"]')
            if email_input.count() > 0:
                email_input.first.fill(self.email)
                time.sleep(1)

            fullname_input = page.locator('input[name="fullName"]')
            if fullname_input.count() > 0:
                fullname_input.first.fill(self.brand.name)
                time.sleep(1)

            user_input = page.locator('input[name="username"]')
            if user_input.count() > 0:
                user_input.first.fill(username)
                time.sleep(1)

            pass_input = page.locator('input[name="password"]')
            if pass_input.count() > 0:
                pass_input.first.fill(self.password)
                time.sleep(1)

            signup_btn = page.locator('button[type="submit"]')
            if signup_btn.count() > 0:
                signup_btn.first.click()
                time.sleep(3)
        except Exception as e:
            console.print(f"  [yellow]Auto-fill partial: {e}[/yellow]")

        completed = human_gate(
            "Instagram",
            "Complete the signup in the browser:\n"
            f"  - Email: {self.email}\n"
            f"  - Full name: {self.brand.name}\n"
            f"  - Username: @{username}\n"
            f"  - Password: {self.password}\n"
            "  - Complete phone verification and any CAPTCHAs\n"
            "  - You'll likely need to verify via SMS\n"
            "  - Get to the logged-in feed"
        )
        if not completed:
            raise RuntimeError("Instagram signup skipped by user")

        actual_username = human_gate_input(
            "Instagram",
            f"What username did you get? (default: {username})"
        )
        if not actual_username:
            actual_username = username

        return {
            "INSTAGRAM_USERNAME": actual_username,
            "INSTAGRAM_PASSWORD": self.password,
            "INSTAGRAM_EMAIL": self.email,
        }

    def configure_profile(self, page) -> None:
        console.print("  Configuring Instagram profile...")

        try:
            page.goto("https://www.instagram.com/accounts/edit/")
            time.sleep(3)

            bio_input = page.locator('textarea[id*="bio"], textarea[name*="biography"]')
            if bio_input.count() > 0:
                bio_input.first.fill(self.brand.bio_short)
                time.sleep(1)

            url_input = page.locator('input[name="external_url"], input[id*="url"]')
            if url_input.count() > 0:
                url_input.first.fill(self.brand.url)
                time.sleep(1)

            if self.brand.avatar_path and self.brand.avatar_path.exists():
                # Instagram requires clicking the avatar area to trigger file upload
                avatar_btn = page.locator('button:has-text("Change profile photo"), input[type="file"]')
                if avatar_btn.count() > 0:
                    file_input = page.locator('input[type="file"]')
                    if file_input.count() > 0:
                        file_input.first.set_input_files(str(self.brand.avatar_path))
                        time.sleep(3)

            submit_btn = page.locator('button[type="submit"]:has-text("Submit"), button:has-text("Submit")')
            if submit_btn.count() > 0:
                submit_btn.first.click()
                time.sleep(2)
                console.print("  [green]Profile configured[/green]")
            else:
                human_gate("Instagram", "Save the profile settings in the browser.")
        except Exception:
            human_gate("Instagram", "Review and save the profile settings in the browser.")

    def _switch_to_business(self, page) -> None:
        """Attempt to switch to a business/professional account."""
        console.print("  Switching to Professional account...")
        human_gate(
            "Instagram",
            "Switch to a Professional (Business) account:\n"
            "  Settings → Account → Switch to Professional Account\n"
            "  Choose 'Business' and select a relevant category"
        )
