import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, "/home/jesse/projects/domains/tools/social-setup/src")
sys.path.insert(0, "/home/jesse/projects/domains/tools/social-lib/src")

from social_setup.browser import launch_browser  # noqa: E402
from social_lib.credentials import write_creds  # noqa: E402

DOMAIN = sys.argv[1]
LOG_FILE = sys.argv[2]
PERSONA = sys.argv[3] if len(sys.argv) > 3 else None
PASSWORD = None
for line in open(LOG_FILE):
    if line.startswith("Generated password: "):
        PASSWORD = line.split("Generated password: ", 1)[1].strip()
        break
if not PASSWORD:
    raise SystemExit(f"could not find password in {LOG_FILE}")
EMAIL_LOCAL = PERSONA or "social"
EMAIL = f"{EMAIL_LOCAL}@{DOMAIN}"
VAULT_KEY = f"{DOMAIN}::{PERSONA}" if PERSONA else DOMAIN
PROFILE_KEY = VAULT_KEY
SHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
PREFIX = f"bsky-{DOMAIN.split('.')[0]}" + (f"-{PERSONA}" if PERSONA else "")


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}"))


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
time.sleep(3)
shot(page, "10-resume.png")
print(f"STATUS resumed url={page.url}", flush=True)

deadline = time.time() + 2 * 60
while time.time() < deadline:
    if page.locator('[data-testid="composeBtn"]').count() > 0:
        print("STATUS reached home feed", flush=True)
        break

    # onboarding interest-picker: click one tag, then the enabled continue button
    try:
        news_tag = page.locator('button:has-text("News"), :text("News")')
        if news_tag.count() > 0 and news_tag.first.is_visible():
            news_tag.first.click(timeout=3000)
            time.sleep(1)
    except Exception as e:
        print(f"tag click note: {e}", flush=True)

    progressed = click_if_present(
        page,
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'button:has-text("Choose an interest")',
        'button:has-text("Skip")',
        'button:has-text("Finish")',
        "button:has-text(\"Let's go\")",
        'button:has-text("Done")',
    )
    if not progressed:
        time.sleep(2)

shot(page, "11-onboarded.png")
print(f"STATUS final url={page.url}", flush=True)

handle = ""
try:
    page.goto("https://bsky.app/settings", wait_until="domcontentloaded", timeout=20000)
    time.sleep(3)
    shot(page, "12-settings.png")
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
    print("STATUS still no handle — needs manual check", flush=True)

print("STATUS done", flush=True)
