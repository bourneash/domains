"""Full-auto Instagram signup for any domain or persona — fills everything,
only pauses for a real captcha or Instagram's phone-verification gate
(Instagram frequently demands a real phone number; there's no automation
around that — a human has to enter a real number in the browser window and
we poll for it to clear, same pattern as a captcha).
Usage: instagram_signup.py <domain> <full-name> [persona-slug]

Without persona-slug: the domain-level brand account (email social@<domain>,
vault key "<domain>"). With persona-slug: a per-persona account — email
<persona-slug>@<domain>, vault key "<domain>::<persona-slug>", separate
browser profile."""
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools/social-setup/src"))
sys.path.insert(0, str(REPO_ROOT / "tools/social-lib/src"))

from social_setup.browser import launch_browser  # noqa: E402
from social_setup.passwords import generate as gen_password  # noqa: E402
from social_setup.email import ensure_social_alias  # noqa: E402
from social_lib.credentials import write_creds  # noqa: E402

DOMAIN = sys.argv[1]
FULL_NAME = sys.argv[2]
PERSONA = sys.argv[3] if len(sys.argv) > 3 else None
EMAIL_LOCAL = PERSONA or "social"
EMAIL = f"{EMAIL_LOCAL}@{DOMAIN}"
VAULT_KEY = f"{DOMAIN}::{PERSONA}" if PERSONA else DOMAIN
PROFILE_KEY = VAULT_KEY
ensure_social_alias(DOMAIN, EMAIL_LOCAL)
PASSWORD = gen_password()
# Instagram usernames: letters/numbers/periods/underscores only, no hyphens.
USERNAME_BASE = (PERSONA or DOMAIN.split(".")[0]).replace("-", "_")
SHOT_DIR = REPO_ROOT / ".cloak-screenshots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PREFIX = f"ig-{DOMAIN.split('.')[0]}" + (f"-{PERSONA}" if PERSONA else "")


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}.png"))


def captcha_present(page) -> bool:
    for sel in ['iframe[src*="recaptcha"]', 'iframe[title*="captcha" i]', '#px-captcha',
                'iframe[src*="hcaptcha"]', '.h-captcha']:
        try:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                return True
        except Exception:
            pass
    return False


def phone_gate_present(page) -> bool:
    for phrase in ["Enter your mobile number", "Confirm your mobile number",
                   "Enter the confirmation code", "phone number"]:
        try:
            loc = page.get_by_text(phrase)
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
                time.sleep(1.5)
                return True
        except Exception:
            pass
    return False


print(f"Generated password: {PASSWORD}", flush=True)

context, page = launch_browser(PROFILE_KEY, "instagram")
page.goto("https://www.instagram.com/accounts/emailsignup/", wait_until="domcontentloaded", timeout=30000)
time.sleep(4)
shot(page, "01-form")

try:
    # Instagram's signup form has no stable name/placeholder/aria-label
    # attributes on most fields (React, auto-generated ids) — match by
    # input type and DOM order instead: text(1)=email, password, text(2)=
    # full name, search=username (the one field that does carry a real
    # aria-label). Birthday is a custom dropdown widget, not a native
    # <select> — handled separately below, best-effort.
    text_inputs = page.locator('input[type="text"]')
    text_inputs.nth(0).fill(EMAIL)
    page.locator('input[type="password"]').first.fill(PASSWORD)
    if text_inputs.count() > 1:
        text_inputs.nth(1).fill(FULL_NAME)
    page.locator('input[type="search"][aria-label="Username" i]').first.fill(USERNAME_BASE)
except Exception as e:
    print(f"autofill note: {e}", flush=True)

# Birthday: custom click-to-open dropdown widgets, not native <select>.
# get_by_text().click() fails here (pointer-events blocked by an overlay
# div) — use a real mouse click at the element's screen coordinates instead,
# which bypasses Playwright's actionability check the same way a human
# click would.
def coord_click(locator):
    box = locator.bounding_box()
    if box:
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        return True
    return False


try:
    for label, value in (("Month", "January"), ("Day", "1"), ("Year", "1992")):
        trigger = page.get_by_text(label, exact=True)
        if trigger.count() > 0 and trigger.first.is_visible():
            coord_click(trigger.first)
            time.sleep(0.7)
            opt = page.get_by_text(value, exact=True)
            if opt.count() == 0:
                # Year's option list is long — the target may be below the
                # fold of its own scroll container. Scroll the option into
                # view by scrolling the nearest scrollable ancestor down
                # repeatedly and re-checking, rather than the page itself.
                for _ in range(15):
                    page.mouse.wheel(0, 200)
                    time.sleep(0.15)
                    opt = page.get_by_text(value, exact=True)
                    if opt.count() > 0 and opt.first.is_visible():
                        break
            if opt.count() > 0 and opt.first.is_visible():
                coord_click(opt.first)
            else:
                print(f"birthday-widget note: option '{value}' not visible after opening {label}", flush=True)
            time.sleep(0.5)
except Exception as e:
    print(f"birthday-widget note: {e}", flush=True)

shot(page, "02-filled")

# Username-taken handling: retry with a numeric suffix.
try:
    taken = page.get_by_text("username isn't available")
    if taken.count() > 0 and taken.first.is_visible():
        import random
        suffixed = f"{USERNAME_BASE}{random.randint(100, 999)}"
        page.locator('input[name="username"]').first.fill(suffixed)
        USERNAME_BASE = suffixed
        print(f"STATUS username taken, retrying as {suffixed}", flush=True)
        time.sleep(1)
except Exception:
    pass

click_if_present(page, 'button[type="submit"]', 'button:has-text("Sign up")')
time.sleep(3)
shot(page, "03-postsubmit")
print(f"STATUS post-submit url={page.url}", flush=True)

# Birthday step, if shown.
try:
    if page.get_by_text("your birthday").count() > 0:
        for name, val in (("month", "1"), ("day", "1"), ("year", "1992")):
            sel = page.locator(f'select[title*="{name}" i]')
            if sel.count() > 0:
                sel.first.select_option(val)
        click_if_present(page, 'button:has-text("Next")')
        time.sleep(2)
except Exception as e:
    print(f"birthday note: {e}", flush=True)

# Human gates: captcha or phone verification. Poll up to 10 min.
deadline = time.time() + 3 * 60
while time.time() < deadline:
    if captcha_present(page):
        print("STATUS captcha appeared — needs a human to solve it", flush=True)
        resume_deadline = time.time() + 10 * 60
        while time.time() < resume_deadline:
            time.sleep(10)
            if not captcha_present(page):
                print("STATUS captcha cleared, resuming", flush=True)
                break
    if phone_gate_present(page):
        print("STATUS phone verification required — needs a human to enter a real number "
              "in the browser window and complete the SMS code", flush=True)
        resume_deadline = time.time() + 10 * 60
        while time.time() < resume_deadline:
            time.sleep(10)
            if not phone_gate_present(page):
                print("STATUS phone gate cleared, resuming", flush=True)
                break
    progressed = click_if_present(
        page,
        'button:has-text("Next")',
        'button:has-text("OK")',
        'button:has-text("Not Now")',
        'button:has-text("Skip")',
    )
    if "instagram.com" in page.url and any(seg in page.url for seg in ("/accounts/onetap", "/", "/direct/inbox")) \
            and "emailsignup" not in page.url:
        break
    if not progressed:
        time.sleep(3)

shot(page, "04-final")
print(f"STATUS final url={page.url}", flush=True)

# Verify: check for the logged-in nav (search icon / profile link) rather than
# trusting the URL alone.
logged_in = False
try:
    logged_in = page.locator('svg[aria-label="Home"], a[href="/accounts/edit/"]').count() > 0
except Exception as e:
    print(f"verify note: {e}", flush=True)

print(f"LOGGED_IN:{logged_in}", flush=True)
context.close()

if logged_in:
    write_creds(VAULT_KEY, "instagram", {
        "INSTAGRAM_USERNAME": USERNAME_BASE,
        "INSTAGRAM_PASSWORD": PASSWORD,
        "INSTAGRAM_EMAIL": EMAIL,
    })
    print(f"STATUS creds written to vault, username={USERNAME_BASE}", flush=True)
else:
    print("STATUS SIGNUP DID NOT SUCCEED — not logged in, no creds written", flush=True)

print("STATUS done", flush=True)
