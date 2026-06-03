"""TikTok provisioner — semi-auto, phone verification required."""

from __future__ import annotations

import time

from rich.console import Console

from ..browser import human_gate, human_gate_input, launch_browser
from .base import PlatformProvisioner

console = Console()


class TikTokProvisioner(PlatformProvisioner):
    name = "tiktok"
    display_name = "TikTok"
    needs_browser = True

    def derive_username(self) -> str:
        return self.brand.domain.split(".")[0].replace("-", "").lower()

    def signup(self, page=None) -> dict:
        username = self.derive_username()
        console.print(f"  Creating TikTok account: [cyan]@{username}[/cyan]")

        if page is None:
            ctx, page = launch_browser(self.brand.domain, "tiktok")

        page.goto("https://www.tiktok.com/signup")
        time.sleep(3)

        # TikTok signup flow varies heavily and often requires phone
        completed = human_gate(
            "TikTok",
            "Complete the TikTok signup in the browser:\n"
            f"  - Use email: {self.email}\n"
            f"  - Password: {self.password}\n"
            f"  - Target username: @{username}\n"
            "  - Select 'Use email' signup method\n"
            "  - Complete phone/email verification\n"
            "  - Get to the logged-in feed"
        )
        if not completed:
            raise RuntimeError("TikTok signup skipped by user")

        actual_username = human_gate_input(
            "TikTok",
            f"What username did you get? (default: {username})"
        )
        if not actual_username:
            actual_username = username

        return {
            "TIKTOK_USERNAME": actual_username,
            "TIKTOK_PASSWORD": self.password,
            "TIKTOK_EMAIL": self.email,
        }

    def configure_profile(self, page) -> None:
        console.print("  Configuring TikTok profile...")

        try:
            page.goto("https://www.tiktok.com/setting/edit-profile")
            time.sleep(3)

            bio_input = page.locator('textarea[placeholder*="Bio"], textarea[name*="bio"]')
            if bio_input.count() > 0:
                bio_input.first.fill(self.brand.bio_short[:80])
                time.sleep(1)

            if self.brand.avatar_path and self.brand.avatar_path.exists():
                file_input = page.locator('input[type="file"]')
                if file_input.count() > 0:
                    file_input.first.set_input_files(str(self.brand.avatar_path))
                    time.sleep(3)
        except Exception:
            pass

        human_gate(
            "TikTok",
            f"Review and save the profile:\n"
            f"  - Bio: {self.brand.bio_short[:80]}\n"
            f"  - Website: {self.brand.url}\n"
            "  - Upload profile photo\n"
            "  - Switch to Business Account (Settings → Manage account → Switch to Business)"
        )
        console.print("  [green]Profile configured[/green]")

    def get_api_keys(self, page) -> dict | None:
        console.print("  Setting up TikTok Developer access...")

        completed = human_gate(
            "TikTok Developer",
            "Register for TikTok Developer access:\n"
            "  1. Go to developers.tiktok.com\n"
            "  2. Register as a developer\n"
            f"  3. Create an app named '{self.brand.name}'\n"
            "  4. Apply for Content Publishing API access\n"
            "  NOTE: TikTok API access requires review (days-weeks).\n"
            "  You can skip and add keys later when approved."
        )
        if not completed:
            return None

        client_key = human_gate_input("TikTok", "Paste Client Key (or skip):")
        if not client_key:
            return None

        client_secret = human_gate_input("TikTok", "Paste Client Secret:")

        return {
            "TIKTOK_CLIENT_KEY": client_key,
            "TIKTOK_CLIENT_SECRET": client_secret or "",
        }
