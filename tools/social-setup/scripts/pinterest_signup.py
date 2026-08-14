"""Full-auto Pinterest business signup for any domain.
Drives every step itself — only pauses if it detects an actual captcha
widget on the page. Everything else (fill, submit, skip onboarding,
extract username) happens with no human input.
Usage: pinterest_signup.py <domain> <business-name> [persona-slug]

Without persona-slug: the domain-level brand account (email social@<domain>,
vault key "<domain>"). With persona-slug: a per-persona account — email
<persona-slug>@<domain>, vault key "<domain>::<persona-slug>", separate
browser profile."""
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/jesse/projects/domains/tools/social-setup/src")
sys.path.insert(0, "/home/jesse/projects/domains/tools/social-lib/src")

from social_setup.browser import launch_browser  # noqa: E402
from social_setup.passwords import generate as gen_password  # noqa: E402
from social_setup.email import ensure_social_alias  # noqa: E402
from social_lib.credentials import write_creds  # noqa: E402

import sys
DOMAIN = sys.argv[1]
BIZ_NAME = sys.argv[2]
PERSONA = sys.argv[3] if len(sys.argv) > 3 else None
EMAIL_LOCAL = PERSONA or "social"
EMAIL = f"{EMAIL_LOCAL}@{DOMAIN}"
VAULT_KEY = f"{DOMAIN}::{PERSONA}" if PERSONA else DOMAIN
PROFILE_KEY = VAULT_KEY
ensure_social_alias(DOMAIN, EMAIL_LOCAL)
PASSWORD = gen_password()
WEBSITE = f"https://{DOMAIN}"
SHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
SHOT_DIR.mkdir(parents=True, exist_ok=True)
SCREENSHOT_PREFIX = f"pin-{DOMAIN.split('.')[0]}" + (f"-{PERSONA}" if PERSONA else "")


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / name))


def captcha_present(page) -> bool:
    for sel in [
        'iframe[src*="recaptcha"]',
        'iframe[title*="captcha" i]',
        'div[class*="captcha" i]',
        '#px-captcha',
        'iframe[src*="hcaptcha"]',
    ]:
        try:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                return True
        except Exception:
            pass
    for phrase in ["Protecting your account", "Start Puzzle", "Verifying browser"]:
        try:
            loc = page.get_by_text(phrase)  # substring match, unlike locator('text="..."')
            if loc.count() > 0 and loc.first.is_visible():
                return True
        except Exception:
            pass
    return False


def click_if_present(page, *selectors, timeout=3000):
    for sel in selectors:
        try:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click(timeout=timeout)
                time.sleep(1)
                return True
        except Exception:
            pass
    return False


print(f"Generated password: {PASSWORD}", flush=True)

context, page = launch_browser(PROFILE_KEY, "pinterest")
page.goto("https://www.pinterest.com/business/create/", wait_until="domcontentloaded", timeout=30000)
time.sleep(3)

try:
    page.locator('input[name="email"], input[id="email"]').first.fill(EMAIL)
    page.locator('input[name="password"], input[id="password"]').first.fill(PASSWORD)
    dob = page.locator('input[type="date"]')
    dob_deadline = time.time() + 15
    while dob.count() == 0 and time.time() < dob_deadline:
        time.sleep(0.5)
        dob = page.locator('input[type="date"]')
    if dob.count():
        # Plain el.value= is silently dropped by React-controlled inputs (worked once,
        # failed the next run — not reliable). Use the native property setter so
        # React's change-tracking actually sees it, matching how a real keystroke would.
        dob.first.evaluate(
            "el => { "
            "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; "
            "setter.call(el, '1992-01-01'); "
            "el.dispatchEvent(new Event('input', {bubbles: true})); "
            "el.dispatchEvent(new Event('change', {bubbles: true})); }"
        )
        time.sleep(0.5)
        actual_val = dob.first.evaluate("el => el.value")
        print(f"STATUS dob set to: {actual_val}", flush=True)
    biz = page.locator('input[name="businessName"], input[id*="businessName"]')
    if biz.count():
        biz.first.fill(BIZ_NAME)
    site = page.locator('input[name="website"], input[id*="website"]')
    if site.count():
        site.first.fill(WEBSITE)
except Exception as e:
    print(f"autofill note: {e}", flush=True)

shot(page, f"{SCREENSHOT_PREFIX}-01-filled.png")

if captcha_present(page):
    print("STATUS captcha present before submit — need Jesse", flush=True)
else:
    # The button stays disabled during an async validation pass (password
    # breach check etc.) right after the last field is filled — clicking
    # too early is a silent no-op. Wait for it to actually be enabled.
    submit_btn = page.locator('button[type="submit"], button:has-text("Create account")')
    enable_deadline = time.time() + 10
    while time.time() < enable_deadline:
        if submit_btn.count() > 0 and submit_btn.first.is_enabled():
            break
        time.sleep(0.5)
    click_if_present(page, 'button[type="submit"]', 'button:has-text("Create account")')
    time.sleep(3)
    shot(page, f"{SCREENSHOT_PREFIX}-02-postsubmit.png")
    print(f"STATUS post-submit url={page.url}", flush=True)

# Drive the onboarding wizard: repeatedly try to skip / dismiss anything that
# isn't a captcha, for up to 2 minutes, checking for captcha each loop.
deadline = time.time() + 2 * 60
while time.time() < deadline:
    if captcha_present(page):
        print("STATUS captcha detected mid-flow — need Jesse", flush=True)
        break
    progressed = click_if_present(
        page,
        'button:has-text("Skip")',
        'button:has-text("Not now")',
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'button:has-text("Done")',
        'button:has-text("Get started")',
    )
    if "pinterest.com" in page.url and any(
        seg in page.url for seg in ("/business-hub", "/pin-creation-tool", "/settings")
    ):
        print("STATUS looks like we're in the dashboard", flush=True)
        break
    if not progressed:
        time.sleep(3)

shot(page, f"{SCREENSHOT_PREFIX}-03-wizard.png")
print(f"STATUS wizard-loop end url={page.url}", flush=True)

if captcha_present(page):
    print("STATUS PAUSED FOR CAPTCHA — Jesse, solve it in the window, I'll keep polling", flush=True)
    resume_deadline = time.time() + 10 * 60
    while time.time() < resume_deadline:
        time.sleep(10)
        if not captcha_present(page):
            print("STATUS captcha cleared, resuming", flush=True)
            break
    # keep skipping onboarding after captcha clears
    deadline2 = time.time() + 2 * 60
    while time.time() < deadline2:
        click_if_present(
            page,
            'button:has-text("Skip")',
            'button:has-text("Not now")',
            'button:has-text("Continue")',
            'button:has-text("Next")',
            'button:has-text("Done")',
        )
        time.sleep(3)

shot(page, f"{SCREENSHOT_PREFIX}-04-final.png")

# Try to read back the actual username from account/profile settings
try:
    # networkidle never fires here (Pinterest keeps a live connection open),
    # and the React body renders noticeably after domcontentloaded — a short
    # sleep here was the majority false-negative cause in the last sweep.
    page.goto("https://www.pinterest.com/settings/", wait_until="domcontentloaded", timeout=30000)
    time.sleep(6)
    shot(page, f"{SCREENSHOT_PREFIX}-05-settings.png")
    username_field = page.locator('input[name="username"], input[id*="username"]')
    actual_username = ""
    if username_field.count():
        actual_username = username_field.first.input_value(timeout=5000)
    print(f"USERNAME_FOUND:{actual_username}", flush=True)
except Exception as e:
    print(f"username read note: {e}", flush=True)
    actual_username = ""

print(f"STATUS final url={page.url}", flush=True)
time.sleep(5)
context.close()

if actual_username:
    write_creds(VAULT_KEY, "pinterest", {
        "PINTEREST_USERNAME": actual_username,
        "PINTEREST_PASSWORD": PASSWORD,
        "PINTEREST_EMAIL": EMAIL,
    })
    print("STATUS creds written to vault", flush=True)
else:
    print("STATUS SIGNUP DID NOT SUCCEED — no username found, no creds written", flush=True)

print(f"STATUS done — username: {actual_username}", flush=True)
