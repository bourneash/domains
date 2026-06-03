"""X (Twitter) provisioner — semi-auto with human gates for phone/CAPTCHA."""

from __future__ import annotations

import time

from rich.console import Console

from ..browser import human_gate, human_gate_input, launch_browser
from .base import PlatformProvisioner

console = Console()


class XProvisioner(PlatformProvisioner):
    name = "x"
    display_name = "X (Twitter)"
    needs_browser = True

    def derive_username(self) -> str:
        return self.brand.domain.split(".")[0].replace("-", "").capitalize()

    def signup(self, page=None) -> dict:
        username = self.derive_username()
        console.print(f"  Creating X account: [cyan]@{username}[/cyan]")

        if page is None:
            ctx, page = launch_browser(self.brand.domain, "x")

        page.goto("https://x.com/i/flow/signup")
        time.sleep(3)

        # X signup is a multi-step flow, selectors change frequently.
        # We fill what we can and gate the rest.
        try:
            name_input = page.locator('input[name="name"]')
            if name_input.count() > 0:
                name_input.first.fill(self.brand.name)
                time.sleep(1)

            email_input = page.locator('input[name="email"], input[autocomplete="email"]')
            if email_input.count() > 0:
                email_input.first.fill(self.email)
                time.sleep(1)

            # Look for date of birth fields (X requires this)
            month_select = page.locator('select[id*="SELECTOR_1"]')
            if month_select.count() > 0:
                month_select.first.select_option(value="1")
                day_select = page.locator('select[id*="SELECTOR_2"]')
                if day_select.count() > 0:
                    day_select.first.select_option(value="1")
                year_select = page.locator('select[id*="SELECTOR_3"]')
                if year_select.count() > 0:
                    year_select.first.select_option(value="1990")
                time.sleep(1)

            # Try to advance to next step
            next_buttons = page.locator('button:has-text("Next"), div[role="button"]:has-text("Next")')
            if next_buttons.count() > 0:
                next_buttons.first.click()
                time.sleep(2)
        except Exception as e:
            console.print(f"  [yellow]Auto-fill partial: {e}[/yellow]")

        # At this point we almost certainly hit a verification gate
        completed = human_gate(
            "X (Twitter)",
            "Complete the signup process in the browser:\n"
            f"  - Email: {self.email}\n"
            f"  - Password: {self.password}\n"
            f"  - Username: try @{username}\n"
            "  - Complete phone/email verification and any CAPTCHAs\n"
            "  - Get to the logged-in home screen"
        )
        if not completed:
            raise RuntimeError("X signup skipped by user")

        actual_username = human_gate_input(
            "X (Twitter)",
            f"What username did you end up with? (default: {username})"
        )
        if not actual_username:
            actual_username = username

        return {
            "X_USERNAME": actual_username,
            "X_PASSWORD": self.password,
            "X_EMAIL": self.email,
        }

    def configure_profile(self, page) -> None:
        console.print("  Configuring X profile...")

        try:
            page.goto("https://x.com/settings/profile")
            time.sleep(3)

            bio_input = page.locator('textarea[name="description"]')
            if bio_input.count() > 0:
                bio_input.first.fill(self.brand.bio_short)
                time.sleep(1)

            url_input = page.locator('input[name="url"]')
            if url_input.count() > 0:
                url_input.first.fill(self.brand.url)
                time.sleep(1)

            if self.brand.avatar_path and self.brand.avatar_path.exists():
                avatar_input = page.locator('input[type="file"]').first
                if avatar_input.count() > 0:
                    avatar_input.set_input_files(str(self.brand.avatar_path))
                    time.sleep(2)

            save_btn = page.locator('button:has-text("Save"), div[role="button"]:has-text("Save")')
            if save_btn.count() > 0:
                save_btn.first.click()
                time.sleep(2)
                console.print("  [green]Profile configured[/green]")
            else:
                human_gate("X (Twitter)", "Save the profile settings in the browser.")
        except Exception as e:
            console.print(f"  [yellow]Auto-config partial, manual step needed: {e}[/yellow]")
            human_gate("X (Twitter)", "Review and save the profile settings.")

    def get_api_keys(self, page) -> dict | None:
        console.print("  Navigating to X Developer Portal for API keys...")

        page.goto("https://developer.x.com/en/portal/dashboard")
        time.sleep(3)

        completed = human_gate(
            "X (Twitter) Developer Portal",
            "Complete the developer account setup:\n"
            "  1. Sign up for Free tier at developer.x.com\n"
            f"  2. Create a project named '{self.brand.name}'\n"
            "  3. Create an app within the project\n"
            "  4. Generate all keys:\n"
            "     - API Key & Secret\n"
            "     - Access Token & Secret\n"
            "     - Bearer Token\n"
            "  5. Set app permissions to Read and Write"
        )
        if not completed:
            return None

        api_key = human_gate_input("X (Twitter)", "Paste API Key (Consumer Key):")
        api_secret = human_gate_input("X (Twitter)", "Paste API Secret (Consumer Secret):")
        access_token = human_gate_input("X (Twitter)", "Paste Access Token:")
        access_secret = human_gate_input("X (Twitter)", "Paste Access Token Secret:")
        bearer = human_gate_input("X (Twitter)", "Paste Bearer Token:")

        if not api_key:
            return None

        return {
            "X_API_KEY": api_key,
            "X_API_SECRET": api_secret or "",
            "X_ACCESS_TOKEN": access_token or "",
            "X_ACCESS_SECRET": access_secret or "",
            "X_BEARER_TOKEN": bearer or "",
        }
