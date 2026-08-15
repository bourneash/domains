"""Resume an Instagram signup that's stuck at the email/phone confirmation-code
screen after a prior run's browser context was closed. Reopens the same
persistent profile (same domain/persona key), navigates to instagram.com,
and waits for a human to type the code into the visible window and continue
— mirrors the human-gate polling pattern in instagram_signup.py itself but
doesn't redo any form-filling (the account already exists server-side at
this point; redoing signup would just hit "email taken").

WARNING (2026-08-15): see the note at the top of instagram_signup.py — every
account created via this pipeline was later cancelled by Instagram for spam.
Don't run this to revive an account expecting it to stick without addressing
that first.

Usage: instagram_resume_code.py <domain> <username> [persona-slug]
"""
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools/social-setup/src"))
sys.path.insert(0, str(REPO_ROOT / "tools/social-lib/src"))

from social_setup.browser import launch_browser  # noqa: E402
from social_lib.credentials import write_creds  # noqa: E402

DOMAIN = sys.argv[1]
USERNAME = sys.argv[2]
PERSONA = sys.argv[3] if len(sys.argv) > 3 else None
EMAIL_LOCAL = PERSONA or "social"
EMAIL = f"{EMAIL_LOCAL}@{DOMAIN}"
VAULT_KEY = f"{DOMAIN}::{PERSONA}" if PERSONA else DOMAIN
PROFILE_KEY = VAULT_KEY
PASSWORD = sys.argv[4] if len(sys.argv) > 4 else None

SHOT_DIR = REPO_ROOT / ".cloak-screenshots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PREFIX = f"ig-resume-{DOMAIN.split('.')[0]}" + (f"-{PERSONA}" if PERSONA else "")


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}.png"))


def email_code_gate_present(page) -> bool:
    try:
        loc = page.get_by_text("Enter the confirmation code")
        if loc.count() > 0 and loc.first.is_visible():
            body = page.locator("body").inner_text()
            return "@" in body.split("Enter the confirmation code", 1)[-1][:150]
    except Exception:
        pass
    return False


context, page = launch_browser(PROFILE_KEY, "instagram")
page.goto("https://www.instagram.com/", wait_until="domcontentloaded", timeout=30000)
time.sleep(4)
shot(page, "01-reopen")
print(f"STATUS reopened profile, url={page.url}", flush=True)

deadline = time.time() + 15 * 60
while time.time() < deadline:
    if email_code_gate_present(page):
        print(f"STATUS waiting on email code — check {EMAIL}, type it into the "
              "browser window, click Continue", flush=True)
        time.sleep(10)
        continue
    logged_in = False
    try:
        logged_in = page.locator('svg[aria-label="Home"], a[href="/accounts/edit/"]').count() > 0
    except Exception:
        pass
    if logged_in:
        print("STATUS logged in", flush=True)
        break
    time.sleep(5)

shot(page, "02-final")
print(f"STATUS final url={page.url}", flush=True)

logged_in = False
try:
    logged_in = page.locator('svg[aria-label="Home"], a[href="/accounts/edit/"]').count() > 0
except Exception as e:
    print(f"verify note: {e}", flush=True)

print(f"LOGGED_IN:{logged_in}", flush=True)
context.close()

if logged_in and PASSWORD:
    write_creds(VAULT_KEY, "instagram", {
        "INSTAGRAM_USERNAME": USERNAME,
        "INSTAGRAM_PASSWORD": PASSWORD,
        "INSTAGRAM_EMAIL": EMAIL,
    })
    print(f"STATUS creds written to vault, username={USERNAME}", flush=True)
elif logged_in:
    print("STATUS logged in but no password passed — creds NOT written, "
          "re-run with the password from the original signup log as arg 4", flush=True)
else:
    print("STATUS SIGNUP DID NOT RESUME — still not logged in", flush=True)

print("STATUS done", flush=True)
