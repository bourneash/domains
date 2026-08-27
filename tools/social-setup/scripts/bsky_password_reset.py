"""Recover a Bluesky account whose stored Vaultwarden password no longer
authenticates (401 Invalid identifier or password) by driving the app's
"Forgot Password?" flow. No existing script covered this — bsky_signup.py
and bsky_finish_onboarding.py both assume the stored password is still
correct.

The reset flow itself needs a 6-digit code emailed to the account's address
(social@<domain>, forwarded to Jesse's real inbox) — that inbox isn't wired
into the fleet email-client service yet (see skills-domain-social-setup
§4), so this pauses with the CloakBrowser window visible and asks Jesse to
type the code + a new password directly into Bluesky's own reset form,
rather than trying to read the email itself.

Usage: bsky_password_reset.py <domain> <handle> [vault-key]

vault-key defaults to <domain> (bare, non-persona account) — pass an
explicit persona-qualified key ("<domain>::<persona-slug>") for a persona
account instead.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/jesse/projects/domains/tools/social-setup/src")
sys.path.insert(0, "/home/jesse/projects/domains/tools/social-lib/src")

from social_setup.browser import launch_browser  # noqa: E402
from social_lib.credentials import write_creds  # noqa: E402

DOMAIN = sys.argv[1]
HANDLE = sys.argv[2]
VAULT_KEY = sys.argv[3] if len(sys.argv) > 3 else DOMAIN
PROFILE_KEY = VAULT_KEY
EMAIL = f"social@{DOMAIN}"

SHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PREFIX = f"bsky-reset-{DOMAIN.split('.')[0]}"


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}.png"))


def click_if_present(page, *selectors, timeout=3000):
    for sel in selectors:
        try:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click(timeout=timeout)
                time.sleep(1.5)
                return True
        except Exception:
            pass
    return False


context, page = launch_browser(PROFILE_KEY, "bluesky")
page.goto("https://bsky.app", wait_until="domcontentloaded", timeout=30000)
time.sleep(4)

click_if_present(page, 'button:has-text("Sign in")', 'a:has-text("Sign in")')
time.sleep(1.5)
shot(page, "01-signin-modal")

if not click_if_present(page, 'button:has-text("Forgot password")', 'a:has-text("Forgot password")'):
    print("STATUS could not find 'Forgot password' link", flush=True)
shot(page, "02-forgot-clicked")

# Bluesky's reset form asks for the account's email (not handle) on this step.
try:
    email_input = page.locator('input[type="email"], input[placeholder*="mail" i]')
    if email_input.count() > 0:
        email_input.first.fill(EMAIL)
        print(f"STATUS filled email {EMAIL}", flush=True)
    click_if_present(page, 'button:has-text("Next")', 'button:has-text("Send")')
except Exception as e:
    print(f"email-step note: {e}", flush=True)
shot(page, "03-email-submitted")

print(f"STATUS waiting on reset code — check {EMAIL} (forwards to Jesse's inbox), "
      "type the code + a new password directly into the CloakBrowser window, "
      "and submit. This script just polls for completion, it does not touch the form again.",
      flush=True)

# Poll for the reset having gone through: Bluesky lands you either back at a
# sign-in prompt (reset done, needs fresh login) or straight into the app
# (auto-logged-in post-reset) depending on flow version.
deadline = time.time() + 15 * 60
reset_done = False
while time.time() < deadline:
    try:
        if page.locator('[data-testid="composeBtn"]').count() > 0:
            reset_done = True
            break
        # A password field re-appearing after the code step usually means the
        # reset succeeded and it's asking to confirm the new password once more
        # or has returned to a plain sign-in form — either way stop polling
        # once the code-entry UI itself is gone.
        code_field = page.locator('input[placeholder*="code" i], input[autocomplete="one-time-code"]')
        if code_field.count() == 0 or not code_field.first.is_visible():
            body = page.locator("body").inner_text(timeout=3000)
            if "reset" in body.lower() and ("success" in body.lower() or "updated" in body.lower()):
                reset_done = True
                break
    except Exception:
        pass
    time.sleep(10)

shot(page, "04-final")
print(f"STATUS poll ended, reset_done={reset_done}, url={page.url}", flush=True)
context.close()

print("STATUS done — this script does NOT know the new password (Jesse typed it "
      "directly into the browser). Re-run bsky_verify_login.py once you have it, "
      "or pass it here for a one-shot verify+write.", flush=True)
