"""Fix a Bluesky account whose stored Vaultwarden password no longer
authenticates the API (401 Invalid identifier or password) *without* going
through the forgot-password/email-code flow. The account's persistent
CloakBrowser profile is still logged in via its saved session cookie even
when the main password on file is stale — API auth and the browser session
are independent. So: reopen that profile, generate a brand new App Password
from Settings > App Passwords (Bluesky's own recommended mechanism for
API/bot auth, separate from the main account password), and write that back
to the vault. No email code, no captcha, no login prompt.

Usage: bsky_app_password_refresh.py <domain> <handle> [vault-key] [label]

vault-key defaults to <domain> (bare, non-persona account).
label defaults to "social-hub-<date-ish>" — cosmetic, shown in Bluesky's
App Passwords list.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/jesse/projects/domains/tools/social-setup/src")
sys.path.insert(0, "/home/jesse/projects/domains/tools/social-lib/src")

from social_setup.browser import launch_browser  # noqa: E402
from social_lib.credentials import read_creds, write_creds  # noqa: E402

DOMAIN = sys.argv[1]
HANDLE = sys.argv[2]
VAULT_KEY = sys.argv[3] if len(sys.argv) > 3 else DOMAIN
LABEL = sys.argv[4] if len(sys.argv) > 4 else "social-hub-refresh"
PROFILE_KEY = VAULT_KEY

SHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PREFIX = f"bsky-apppw-{DOMAIN.split('.')[0]}"


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}.png"))


def click_if_present(page, *selectors, timeout=3000):
    for sel in selectors:
        try:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click(timeout=timeout)
                time.sleep(1.2)
                return True
        except Exception:
            pass
    return False


context, page = launch_browser(PROFILE_KEY, "bluesky")
page.goto("https://bsky.app/settings/app-passwords", wait_until="domcontentloaded", timeout=30000)
time.sleep(4)
shot(page, "01-app-passwords-page")

logged_in = page.locator('[data-testid="composeBtn"]').count() > 0 or "app-passwords" in page.url
print(f"STATUS on app-passwords page, url={page.url}, logged_in_guess={logged_in}", flush=True)

if not click_if_present(page, 'button:has-text("Add App Password")', 'button:has-text("Add app password")'):
    print("STATUS could not find 'Add App Password' button", flush=True)
shot(page, "02-add-clicked")

try:
    name_input = page.locator('input[type="text"]').first
    if name_input.count() > 0:
        name_input.fill(LABEL)
except Exception as e:
    print(f"label-fill note: {e}", flush=True)
shot(page, "03-labeled")

# Modal is a 2-step wizard: name entry -> "Next" -> a confirm/create step.
click_if_present(page, 'button:has-text("Next")')
time.sleep(1.5)
shot(page, "03b-after-next")
click_if_present(page, 'button:has-text("Create App Password")', 'button:has-text("Create")', 'button:has-text("Confirm")')
time.sleep(2)
shot(page, "04-created")

app_password = ""
try:
    body = page.locator("body").inner_text(timeout=5000)
    import re
    m = re.search(r"[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}", body)
    if m:
        app_password = m.group(0)
except Exception as e:
    print(f"extract note: {e}", flush=True)

print(f"APP_PASSWORD_FOUND:{app_password}", flush=True)
context.close()

if app_password:
    # write_creds replaces the whole field set, so merge onto whatever's
    # already there (BLUESKY_DID, BLUESKY_EMAIL) instead of dropping it.
    existing = read_creds(VAULT_KEY, "bluesky") or {}
    existing["BLUESKY_HANDLE"] = HANDLE
    existing["BLUESKY_PASSWORD"] = app_password
    existing.pop("BLUESKY_USERNAME", None)  # stale main-password alias, if any
    write_creds(VAULT_KEY, "bluesky", existing)
    print(f"STATUS creds written to vault, handle={HANDLE}", flush=True)
else:
    print("STATUS could not extract app password from page — check screenshots, "
          "may need Jesse to read it off-screen (shown once only)", flush=True)

print("STATUS done", flush=True)
