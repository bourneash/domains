"""Full-auto Bluesky signup for any domain — fills everything, drives the
post-signup onboarding wizard, only pauses for a real captcha.
Usage: bsky_signup.py <domain> <handle> [persona-slug]

Without persona-slug: the domain-level brand account (email social@<domain>,
vault key "<domain>", browser profile keyed on domain alone) — original
behavior, unchanged.

With persona-slug (e.g. "sam-reyes"): a per-persona account — email
<persona-slug>@<domain>, vault key "<domain>::<persona-slug>", separate
browser profile so persona sessions never collide with the brand account's
or each other's."""
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, "/home/jesse/projects/domains/tools/social-setup/src")
sys.path.insert(0, "/home/jesse/projects/domains/tools/social-lib/src")

from social_setup.browser import launch_browser  # noqa: E402
from social_setup.passwords import generate as gen_password  # noqa: E402
from social_setup.email import ensure_social_alias  # noqa: E402
from social_lib.credentials import write_creds  # noqa: E402

DOMAIN = sys.argv[1]
HANDLE_BASE = sys.argv[2]
PERSONA = sys.argv[3] if len(sys.argv) > 3 else None
EMAIL_LOCAL = PERSONA or "social"
EMAIL = f"{EMAIL_LOCAL}@{DOMAIN}"
VAULT_KEY = f"{DOMAIN}::{PERSONA}" if PERSONA else DOMAIN
PROFILE_KEY = VAULT_KEY
ensure_social_alias(DOMAIN, EMAIL_LOCAL)
PASSWORD = gen_password()
SHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PREFIX = f"bsky-{DOMAIN.split('.')[0]}" + (f"-{PERSONA}" if PERSONA else "")


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}"))


def captcha_present(page) -> bool:
    for sel in ['iframe[src*="recaptcha"]', 'iframe[title*="captcha" i]', '#px-captcha', 'iframe[src*="hcaptcha"]',
                '.h-captcha', 'text="I am human"', 'div:has-text("Complete the challenge")']:
        try:
            loc = page.locator(sel)
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

context, page = launch_browser(PROFILE_KEY, "bluesky")
page.goto("https://bsky.app", wait_until="domcontentloaded", timeout=30000)
time.sleep(5)

# Bluesky's signup is itself a short stepped wizard (landing modal -> maybe a
# provider-select screen -> email/password/dob screen). Don't assume one
# click gets there — keep clicking "Create account"/"Next" until the actual
# form fields show up, verifying by checking for them each pass.
click_deadline = time.time() + 30
email_input = pass_input = dob_input = None
while time.time() < click_deadline:
    email_input = page.locator('input[type="email"], input[placeholder*="Email" i], input[autocomplete="email"]')
    if email_input.count() > 0 and email_input.first.is_visible():
        break
    click_if_present(page, 'button:has-text("Create account")', 'a:has-text("Create account")',
                      'button:has-text("Next")')
    time.sleep(1.5)

shot(page, "01-modal.png")

try:
    if email_input is not None and email_input.count() > 0:
        email_input.first.fill(EMAIL)
    pass_input = page.locator('input[type="password"], input[placeholder*="assword"]')
    if pass_input.count() > 0:
        pass_input.first.fill(PASSWORD)
    dob_input = page.locator('input[placeholder*="birth"], input[type="date"]')
    if dob_input.count() > 0:
        dob_input.first.evaluate(
            "el => { el.value = '1992-01-01'; "
            "el.dispatchEvent(new Event('input', {bubbles: true})); "
            "el.dispatchEvent(new Event('change', {bubbles: true})); }"
        )
except Exception as e:
    print(f"autofill note: {e}", flush=True)

shot(page, "02-filled.png")
print(f"STATUS email_found={email_input.count() if email_input is not None else 0}", flush=True)

if captcha_present(page):
    print("STATUS captcha present — need Jesse", flush=True)
    resume_deadline = time.time() + 10 * 60
    while time.time() < resume_deadline:
        time.sleep(10)
        # captcha widgets often stay in the DOM (just hidden/inert) after being
        # solved, so captcha_present() alone under-detects clearance. Also treat
        # a now-enabled Next/Continue button as proof it cleared.
        next_btn = page.locator('button:has-text("Next"), button:has-text("Continue")')
        btn_enabled = next_btn.count() > 0 and next_btn.first.is_enabled()
        if not captcha_present(page) or btn_enabled:
            print("STATUS captcha cleared, resuming", flush=True)
            break

# Try to advance the signup wizard (Next buttons, username step, etc.)
deadline = time.time() + 3 * 60
handle_filled = False
while time.time() < deadline:
    if captcha_present(page):
        print("STATUS captcha appeared mid-flow — need Jesse", flush=True)
        resume_deadline = time.time() + 10 * 60
        while time.time() < resume_deadline:
            time.sleep(10)
            next_btn = page.locator('button:has-text("Next"), button:has-text("Continue")')
            btn_enabled = next_btn.count() > 0 and next_btn.first.is_enabled()
            if not captcha_present(page) or btn_enabled:
                print("STATUS captcha cleared, resuming", flush=True)
                break

    if not handle_filled:
        handle_input = page.locator(
            'input[placeholder*="username" i], input[placeholder*="handle" i], '
            'input[placeholder*="bsky.social" i]'
        )
        if handle_input.count() > 0 and handle_input.first.is_visible():
            handle_input.first.fill(HANDLE_BASE)
            handle_filled = True
            time.sleep(1.5)

    # Handle already taken — Bluesky shows "<x>.bsky.social is not available".
    # Clicking the suggested-alternative rows proved unreliable (timing/DOM
    # instability), so just retype the input with a random numeric suffix and
    # let Bluesky re-validate — same effect, far more robust than clicking.
    if handle_filled:
        try:
            unavailable = page.get_by_text("is not available")  # substring match — text="..." requires exact
            if unavailable.count() > 0 and unavailable.first.is_visible():
                import random
                suffixed = f"{HANDLE_BASE}{random.randint(10, 99)}"
                handle_input = page.locator(
                    'input[placeholder*="username" i], input[placeholder*="handle" i], '
                    'input[placeholder*="bsky.social" i]'
                )
                if handle_input.count() > 0:
                    handle_input.first.fill(suffixed)
                    print(f"STATUS handle taken, retrying as {suffixed}", flush=True)
                    time.sleep(2)
        except Exception as e:
            print(f"handle-suggestion note: {e}", flush=True)

    progressed = click_if_present(
        page,
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Create account")',
        'button:has-text("Skip")',
        'button:has-text("Finish")',
        "button:has-text(\"Let's go\")",
        'button:has-text("Done")',
    )
    if page.locator('[data-testid="composeBtn"]').count() > 0:
        print("STATUS reached home feed", flush=True)
        break
    if not progressed:
        time.sleep(3)

shot(page, "03-final.png")
print(f"STATUS final url={page.url}", flush=True)

# Verify + extract actual handle from settings
handle = ""
try:
    page.goto("https://bsky.app/settings", wait_until="domcontentloaded", timeout=20000)
    time.sleep(3)
    shot(page, "04-settings.png")
    body = page.locator("body").inner_text(timeout=5000)
    for line in body.splitlines():
        if ".bsky.social" in line:
            handle = line.strip().lstrip("@")
            break
except Exception as e:
    print(f"handle lookup note: {e}", flush=True)

print(f"HANDLE_FOUND:{handle}", flush=True)
context.close()

if handle:
    try:
        resp = httpx.get(
            "https://bsky.social/xrpc/com.atproto.identity.resolveHandle",
            params={"handle": handle}, timeout=15
        )
        did = resp.json().get("did", "")
    except Exception as e:
        print(f"DID lookup note: {e}", flush=True)
        did = ""

    write_creds(VAULT_KEY, "bluesky", {
        "BLUESKY_HANDLE": handle,
        "BLUESKY_DID": did,
        "BLUESKY_PASSWORD": PASSWORD,
        "BLUESKY_EMAIL": EMAIL,
    })
    print(f"STATUS creds written to vault, handle={handle}, did={did}", flush=True)
else:
    print("STATUS SIGNUP DID NOT SUCCEED — no creds written, needs retry", flush=True)

print("STATUS done", flush=True)
