"""LinkedIn provisioner — browser signup, email verification, TOTP 2FA setup."""

from __future__ import annotations

import os
import re

from social_setup.platforms.base import BasePlatform
from social_lib.credentials import write_creds
from social_lib.email_client import EmailClient
from social_lib.sms_gate import manual_gate


class LinkedInPlatform(BasePlatform):
    name = "linkedin"

    def provision(self, domain: str, brand, page) -> dict:
        email = f"social@{domain}"
        password = self._generate_password()

        result = self._do_signup(domain, brand, page, email, password)

        totp_secret = self.generate_and_store_totp(domain, "linkedin")
        write_creds(domain, "linkedin", {
            "LI_USERNAME": email,
            "LI_PASSWORD": password,
            "LI_PROFILE_URL": result.get("url", ""),
            "TOTP_SECRET": totp_secret,
        })
        return result

    def _do_signup(self, domain: str, brand, page, email: str, password: str) -> dict:
        """Drive CloakBrowser through LinkedIn signup. Returns {"username", "url"}."""
        # 1. Navigate to signup
        page.goto("https://www.linkedin.com/signup")
        page.wait_for_load_state("networkidle")

        # 2. Fill email + continue
        page.fill('input[id="email-address"]', email)
        page.click('button[data-id="sign-up-cta"]')
        page.wait_for_timeout(1500)

        # 3. Fill password
        page.fill('input[id="password"]', password)
        page.click('button[data-id="sign-up-submit"]')
        page.wait_for_timeout(2000)

        # 4. Fill first/last name (use brand name split or persona name)
        name_parts = brand.name.split(" ", 1) if brand else ["Social", "Editor"]
        page.fill('input[id="first-name"]', name_parts[0])
        page.fill('input[id="last-name"]', name_parts[1] if len(name_parts) > 1 else "Desk")
        page.click('button[type="submit"]')
        page.wait_for_timeout(2000)

        # 5. Email verification — auto-read from email-client
        mailbox = os.environ.get("HOTMAIL_ADDRESS", "jessetamburino@hotmail.com")
        api_key = os.environ.get("EMAIL_API_KEY")
        client = EmailClient(mailbox, api_key=api_key)
        msg = client.wait_for_message(to_addr=email, subject_contains="verification", timeout=120)
        body_text = msg.get("body_text", "")
        match = re.search(r"\b(\d{6})\b", body_text)
        if match:
            code = match.group(1)
        else:
            raise RuntimeError(
                f"Could not extract verification code from email body. Raw: {body_text[:200]}"
            )
        page.fill('input[autocomplete="one-time-code"]', code)
        page.click('button[type="submit"]')
        page.wait_for_timeout(2000)

        # 6. SMS verify gate (if triggered)
        if "phone" in page.url or page.query_selector('input[name="pin"]') or page.query_selector('input[name="phoneNumber"]'):
            code = manual_gate(f"linkedin-sms-{domain}")
            sms_field = page.query_selector('input[name="pin"]') or page.query_selector('input[name="phoneNumber"]')
            sms_field.fill(code)
            page.click('button[type="submit"]')
            page.wait_for_timeout(2000)

        # 7. Skip LinkedIn onboarding wizard steps
        for _ in range(5):
            skip = page.query_selector('button:has-text("Skip")')
            if skip:
                skip.click()
                page.wait_for_timeout(1000)

        profile_url = page.url
        return {"username": email, "url": profile_url}

    def _generate_password(self) -> str:
        from social_setup.passwords import generate
        return generate()
