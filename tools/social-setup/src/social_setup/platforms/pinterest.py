"""Pinterest Business provisioner — near-full automation, email signup."""

from __future__ import annotations

import time

from rich.console import Console

from ..browser import human_gate, human_gate_input, launch_browser
from .base import PlatformProvisioner

console = Console()

BOARD_TOPICS = {
    "news": "News & Current Events",
    "product_review": "Products & Reviews",
    "entertainment": "Entertainment",
    "general": "Other",
}


class PinterestProvisioner(PlatformProvisioner):
    name = "pinterest"
    display_name = "Pinterest"
    needs_browser = True

    def derive_username(self) -> str:
        return self.brand.domain.split(".")[0].replace("-", "").lower()

    def signup(self, page=None) -> dict:
        username = self.derive_username()
        console.print(f"  Creating Pinterest Business account: [cyan]{username}[/cyan]")

        if page is None:
            ctx, page = launch_browser(self.brand.domain, "pinterest")

        # Go directly to business signup
        page.goto("https://www.pinterest.com/business/create/")
        time.sleep(3)

        try:
            email_input = page.locator('input[name="email"], input[id="email"]')
            if email_input.count() > 0:
                email_input.first.fill(self.email)
                time.sleep(1)

            pass_input = page.locator('input[name="password"], input[id="password"]')
            if pass_input.count() > 0:
                pass_input.first.fill(self.password)
                time.sleep(1)

            # Business name
            biz_input = page.locator('input[name="businessName"], input[id*="businessName"]')
            if biz_input.count() > 0:
                biz_input.first.fill(self.brand.name)
                time.sleep(1)

            # Website
            url_input = page.locator('input[name="website"], input[id*="website"]')
            if url_input.count() > 0:
                url_input.first.fill(self.brand.url)
                time.sleep(1)

            create_btn = page.locator('button[type="submit"], button:has-text("Create account")')
            if create_btn.count() > 0:
                create_btn.first.click()
                time.sleep(3)
        except Exception as e:
            console.print(f"  [yellow]Auto-fill partial: {e}[/yellow]")

        completed = human_gate(
            "Pinterest",
            "Complete the Business account signup in the browser:\n"
            f"  - Email: {self.email}\n"
            f"  - Password: {self.password}\n"
            f"  - Business name: {self.brand.name}\n"
            f"  - Website: {self.brand.url}\n"
            "  - Complete any email verification\n"
            "  - Skip onboarding steps or fill relevant ones\n"
            "  - Get to the business dashboard"
        )
        if not completed:
            raise RuntimeError("Pinterest signup skipped by user")

        actual_username = human_gate_input(
            "Pinterest",
            f"What username/URL did you get? (default: {username})"
        )
        if not actual_username:
            actual_username = username

        return {
            "PINTEREST_USERNAME": actual_username,
            "PINTEREST_PASSWORD": self.password,
            "PINTEREST_EMAIL": self.email,
        }

    def configure_profile(self, page) -> None:
        console.print("  Configuring Pinterest profile...")

        try:
            page.goto("https://www.pinterest.com/settings/edit-profile/")
            time.sleep(3)

            about_input = page.locator('textarea[name="about"], textarea[id*="about"]')
            if about_input.count() > 0:
                about_input.first.fill(self.brand.bio_short)
                time.sleep(1)

            if self.brand.avatar_path and self.brand.avatar_path.exists():
                file_input = page.locator('input[type="file"]')
                if file_input.count() > 0:
                    file_input.first.set_input_files(str(self.brand.avatar_path))
                    time.sleep(3)

            save_btn = page.locator('button:has-text("Save"), button[type="submit"]')
            if save_btn.count() > 0:
                save_btn.first.click()
                time.sleep(2)
        except Exception:
            pass

        human_gate(
            "Pinterest",
            f"Review the profile settings:\n"
            f"  - Display name: {self.brand.name}\n"
            f"  - About: {self.brand.bio_short[:80]}\n"
            f"  - Website: {self.brand.url}\n"
            "  - Upload profile photo\n"
            "  - Claim website (Settings → Claim → enter domain → add HTML tag or DNS)"
        )

        # Create a default board
        self._create_default_board(page)
        console.print("  [green]Profile configured[/green]")

    def _create_default_board(self, page) -> None:
        topic = BOARD_TOPICS.get(self.brand.category, "Other")
        console.print(f"  Creating default board: {self.brand.name}")

        try:
            page.goto("https://www.pinterest.com/pin-creation-tool/")
            time.sleep(2)
            page.goto("https://www.pinterest.com/board-creation-tool/")
            time.sleep(3)

            name_input = page.locator('input[id*="boardName"], input[name*="name"]')
            if name_input.count() > 0:
                name_input.first.fill(self.brand.name)
                time.sleep(1)

            create_btn = page.locator('button:has-text("Create")')
            if create_btn.count() > 0:
                create_btn.first.click()
                time.sleep(2)
        except Exception:
            console.print("  [yellow]Could not auto-create board, create manually[/yellow]")

    def get_api_keys(self, page) -> dict | None:
        console.print("  Setting up Pinterest API access...")

        completed = human_gate(
            "Pinterest Developer",
            "Set up Pinterest API:\n"
            "  1. Go to developers.pinterest.com\n"
            "  2. Create an app\n"
            f"  3. App name: '{self.brand.name}'\n"
            f"  4. App website: {self.brand.url}\n"
            "  5. Request access to Pins, Boards scopes\n"
            "  6. Generate access token"
        )
        if not completed:
            return None

        app_id = human_gate_input("Pinterest", "Paste App ID:")
        if not app_id:
            return None
        app_secret = human_gate_input("Pinterest", "Paste App Secret:")
        access_token = human_gate_input("Pinterest", "Paste Access Token (or skip if pending approval):")

        result = {
            "PINTEREST_APP_ID": app_id,
            "PINTEREST_APP_SECRET": app_secret or "",
        }
        if access_token:
            result["PINTEREST_ACCESS_TOKEN"] = access_token
        return result
