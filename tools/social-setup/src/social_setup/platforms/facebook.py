"""Facebook Page provisioner — requires existing personal account, semi-auto."""

from __future__ import annotations

import time

from rich.console import Console

from ..browser import human_gate, human_gate_input, launch_browser
from .base import PlatformProvisioner

console = Console()

CATEGORY_MAP = {
    "news": "News & media website",
    "product_review": "Product/service",
    "entertainment": "Entertainment website",
    "general": "Website",
}


class FacebookProvisioner(PlatformProvisioner):
    name = "facebook"
    display_name = "Facebook Page"
    needs_browser = True

    def derive_username(self) -> str:
        return self.brand.domain.split(".")[0].replace("-", "").capitalize()

    def signup(self, page=None) -> dict:
        page_name = self.brand.name
        console.print(f"  Creating Facebook Page: [cyan]{page_name}[/cyan]")

        if page is None:
            ctx, page = launch_browser(self.brand.domain, "facebook")

        # Facebook Pages require a personal account — check if logged in
        page.goto("https://www.facebook.com/pages/creation/")
        time.sleep(3)

        # If we hit a login wall, we need the user's personal account
        if "login" in page.url.lower():
            completed = human_gate(
                "Facebook",
                "Facebook Pages require a personal account.\n"
                "  Log into your personal Facebook account in the browser.\n"
                "  (This is only used to create/admin the Page — it won't be public.)"
            )
            if not completed:
                raise RuntimeError("Facebook signup skipped — no personal account")
            page.goto("https://www.facebook.com/pages/creation/")
            time.sleep(3)

        try:
            name_input = page.locator('input[name="page_name"], input[aria-label*="Page name"]')
            if name_input.count() > 0:
                name_input.first.fill(page_name)
                time.sleep(1)

            category = CATEGORY_MAP.get(self.brand.category, "Website")
            cat_input = page.locator('input[aria-label*="Category"], input[placeholder*="category"]')
            if cat_input.count() > 0:
                cat_input.first.fill(category)
                time.sleep(2)
                # Select first suggestion
                suggestion = page.locator('ul[role="listbox"] li, div[role="option"]').first
                if suggestion.count() > 0:
                    suggestion.click()
                    time.sleep(1)

            bio_input = page.locator('textarea[aria-label*="Bio"], textarea[name*="bio"], textarea[placeholder*="bio"]')
            if bio_input.count() > 0:
                bio_input.first.fill(self.brand.bio_short)
                time.sleep(1)
        except Exception as e:
            console.print(f"  [yellow]Auto-fill partial: {e}[/yellow]")

        completed = human_gate(
            "Facebook Page",
            f"Complete the Page creation in the browser:\n"
            f"  - Page name: {page_name}\n"
            f"  - Category: {CATEGORY_MAP.get(self.brand.category, 'Website')}\n"
            f"  - Bio: {self.brand.bio_short[:80]}...\n"
            "  - Click 'Create Page'\n"
            "  - Add profile photo and cover image if prompted"
        )
        if not completed:
            raise RuntimeError("Facebook Page creation skipped by user")

        page_id = human_gate_input(
            "Facebook",
            "Paste the Page ID (from Page Settings → Page transparency, or from the URL):"
        )

        return {
            "FB_PAGE_NAME": page_name,
            "FB_PAGE_ID": page_id or "",
            "FB_EMAIL": self.email,
        }

    def configure_profile(self, page) -> None:
        console.print("  Configuring Facebook Page...")

        try:
            # Navigate to page settings to set website URL
            page.goto("https://www.facebook.com/settings/?tab=page_info")
            time.sleep(3)
        except Exception:
            pass

        human_gate(
            "Facebook Page",
            f"Configure the Page:\n"
            f"  - Website: {self.brand.url}\n"
            f"  - Contact email: contact@{self.brand.domain}\n"
            "  - Upload profile picture and cover photo\n"
            "  - Set page username if available"
        )
        console.print("  [green]Page configured[/green]")

    def get_api_keys(self, page) -> dict | None:
        console.print("  Setting up Facebook Graph API access...")

        completed = human_gate(
            "Facebook Developer",
            "Set up Graph API access:\n"
            "  1. Go to developers.facebook.com\n"
            "  2. Create an app (type: Business)\n"
            "  3. Add 'Pages' product\n"
            "  4. Generate a Page Access Token with manage_pages, publish_pages permissions\n"
            "  NOTE: This may require Business Verification which takes days.\n"
            "  You can skip this now and add the token later."
        )
        if not completed:
            return None

        access_token = human_gate_input("Facebook", "Paste Page Access Token (or skip for now):")
        if not access_token:
            return None

        return {
            "FB_ACCESS_TOKEN": access_token,
        }
