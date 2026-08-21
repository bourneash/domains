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


_INTEREST_TOPICS = [
    "News", "Sports", "Art", "Music", "Comics", "Tech", "Culture", "Nature",
    "Animals", "Science", "Food", "Books", "Photography", "Gaming",
]


def wait_for_dom_settle(page, checks=2, interval=0.8, max_wait=6.0):
    deadline = time.time() + max_wait
    last_count = None
    stable_hits = 0
    while time.time() < deadline:
        try:
            count = page.evaluate("document.querySelectorAll('*').length")
        except Exception:
            return
        if last_count is not None and count == last_count:
            stable_hits += 1
            if stable_hits >= checks:
                return
        else:
            stable_hits = 0
        last_count = count
        time.sleep(interval)


def pick_one_interest_tag(page):
    for topic in _INTEREST_TOPICS:
        try:
            tag = page.get_by_text(topic, exact=True)
            if tag.count() > 0 and tag.first.is_visible():
                wait_for_dom_settle(page)
                tag.first.click(timeout=3000)
                wait_for_dom_settle(page)
                time.sleep(1)
                return True
        except Exception:
            continue
    return False


context, page = launch_browser(PROFILE_KEY, "bluesky")
page.goto("https://bsky.app", wait_until="domcontentloaded", timeout=30000)
time.sleep(3)
shot(page, "10-resume.png")
print(f"STATUS resumed url={page.url}", flush=True)

deadline = time.time() + 5 * 60
tag_already_picked = False
while time.time() < deadline:
    if page.locator('[data-testid="composeBtn"]').count() > 0:
        print("STATUS reached home feed", flush=True)
        break

    # Interests-picker step: pick exactly one tag (skip if we already have one
    # selected this run — re-picking races the re-render and is how the prior
    # attempt stalled), settling the DOM before/after so the next click isn't
    # racing a re-render.
    tag_clicked = False
    if not tag_already_picked:
        tag_clicked = pick_one_interest_tag(page)
        tag_already_picked = tag_already_picked or tag_clicked

    progressed = False
    if not tag_clicked:
        wait_for_dom_settle(page, max_wait=3.0)
        next_or_continue = page.locator('button:has-text("Continue"), button:has-text("Next")')
        if next_or_continue.count() > 0 and next_or_continue.first.is_visible():
            enable_deadline = time.time() + 5
            while time.time() < enable_deadline and not next_or_continue.first.is_enabled():
                time.sleep(0.5)
            if next_or_continue.first.is_enabled():
                progressed = click_if_present(page, 'button:has-text("Continue")', 'button:has-text("Next")')
        if not progressed:
            progressed = click_if_present(
                page,
                'button:has-text("Choose an interest")',
                'button:has-text("Skip")',
                'button:has-text("Finish")',
                "button:has-text(\"Let's go\")",
                'button:has-text("Done")',
            )
    if not progressed and not tag_clicked:
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
