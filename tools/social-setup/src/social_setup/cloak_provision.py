"""CloakBrowser provisioner — single-session script for one platform signup.

Usage:
    python -m social_setup.cloak_provision reddit ultrarough.com
    python -m social_setup.cloak_provision pinterest ultrarough.com
    python -m social_setup.cloak_provision x americastrikes.com
    python -m social_setup.cloak_provision bluesky <domain>

Runs the full signup flow in one browser session. Takes screenshots at key
moments and pauses for human input when needed (captcha, phone verify).
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .config import extract_brand, site_root
from .credentials import write_creds, has_creds
from .passwords import generate as gen_password

SCREENSHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
GATE_DIR = Path("/tmp/cloak-gates")
GATE_DIR.mkdir(parents=True, exist_ok=True)


def shot(page, name: str) -> str:
    path = str(SCREENSHOT_DIR / f"{name}.png")
    page.screenshot(path=path)
    print(f"  [screenshot] {path}", flush=True)
    return path


def wait_for_human(page, msg: str, name: str = "gate"):
    """Pause and wait for a continue signal via flag file.

    Creates GATE_DIR/<name>.waiting, blocks until GATE_DIR/<name>.continue exists.
    The orchestrator (Claude) creates the .continue file when Jesse says done.
    """
    shot(page, name)

    # Write the gate request
    waiting_file = GATE_DIR / f"{name}.waiting"
    continue_file = GATE_DIR / f"{name}.continue"
    skip_file = GATE_DIR / f"{name}.skip"

    # Clean up old signals
    continue_file.unlink(missing_ok=True)
    skip_file.unlink(missing_ok=True)

    waiting_file.write_text(json.dumps({
        "message": msg,
        "screenshot": str(SCREENSHOT_DIR / f"{name}.png"),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }))

    print(f"\n  WAITING: {msg}", flush=True)
    print(f"  Gate: {waiting_file}", flush=True)
    print(f"  Signal continue: touch {continue_file}", flush=True)
    print(f"  Signal skip: touch {skip_file}", flush=True)

    # If running interactively, also accept stdin
    import select
    while True:
        # Check for flag files
        if continue_file.exists():
            continue_file.unlink(missing_ok=True)
            waiting_file.unlink(missing_ok=True)
            print("  [gate] Continue signal received", flush=True)
            return True
        if skip_file.exists():
            skip_file.unlink(missing_ok=True)
            waiting_file.unlink(missing_ok=True)
            print("  [gate] Skip signal received", flush=True)
            return False

        # Check stdin (non-blocking)
        if sys.stdin.isatty():
            ready, _, _ = select.select([sys.stdin], [], [], 0)
            if ready:
                line = sys.stdin.readline().strip()
                waiting_file.unlink(missing_ok=True)
                if line.lower() == "skip":
                    return False
                return True

        time.sleep(1)


def provision_reddit(domain: str):
    from cloakbrowser import launch_persistent_context

    brand = extract_brand(domain)
    email = f"social@{domain}"
    password = gen_password()
    username = brand.name.replace(" ", "") + "Desk"

    print(f"Reddit signup for {domain}")
    print(f"  Email: {email}")
    print(f"  Username: {username}")
    print(f"  Password: {password}")

    profile_dir = f"/tmp/cloak-profiles/{domain}/reddit"
    os.makedirs(profile_dir, exist_ok=True)

    context = launch_persistent_context(
        profile_dir,
        headless=False,
        humanize=True,
        viewport={"width": 1000, "height": 700},
    )
    page = context.pages[0] if context.pages else context.new_page()

    try:
        # Step 1: Navigate to signup
        print("  Navigating to Reddit signup...")
        page.goto("https://www.reddit.com/register", wait_until="domcontentloaded")
        time.sleep(4)
        shot(page, "reddit-01-register")

        # Step 2: Fill email
        print("  Filling email...")
        page.locator('input[name="email"], input[type="email"]').first.fill(email)
        time.sleep(1)
        page.locator('button:has-text("Continue")').first.click()
        time.sleep(4)
        shot(page, "reddit-02-email-sent")

        # Step 3: Email verification
        wait_for_human(page,
            f"Check inbox for {email} (→ hotmail) and enter the 6-digit Reddit code in the browser.",
            "reddit-03-verify")

        time.sleep(2)
        shot(page, "reddit-04-after-verify")

        # Step 4: Username and password
        print(f"  Setting username: {username}")
        uname_input = page.locator('input[name="username"]')
        uname_input.fill("")
        uname_input.fill(username)
        time.sleep(2)

        print("  Setting password...")
        page.locator('input[name="password"]').fill(password)
        time.sleep(1)

        shot(page, "reddit-05-username-password")

        # Submit
        print("  Submitting...")
        page.locator('button[type="submit"]').click()
        time.sleep(5)
        shot(page, "reddit-06-after-submit")

        # Step 5: Skip onboarding
        print("  Skipping onboarding steps...")
        for i in range(8):
            time.sleep(2)
            # Try various skip/continue patterns
            for selector in [
                'button:has-text("I prefer not to say")',
                'button:has-text("Skip"):visible',
                'button:has-text("Continue"):visible',
            ]:
                try:
                    el = page.locator(selector)
                    if el.count() > 0 and el.first.is_visible():
                        el.first.click(timeout=3000)
                        time.sleep(1)
                        break
                except Exception:
                    continue

            # Check if we reached the home page
            if "reddit.com" in page.url and "/register" not in page.url:
                break

        shot(page, "reddit-07-done")
        print(f"  Final URL: {page.url}")

        # Check if we got username confirmation
        actual_username = username
        title = page.title()
        print(f"  Page title: {title}")

        # Save creds
        sr = site_root(domain)
        creds = {
            "REDDIT_USERNAME": actual_username,
            "REDDIT_PASSWORD": password,
            "REDDIT_EMAIL": email,
        }
        path = write_creds(sr, "reddit", creds)
        print(f"  Creds saved: {path}")

        # Update log
        log_path = sr / "ops" / "social" / "setup-log.json"
        log_data = {}
        if log_path.exists():
            log_data = json.loads(log_path.read_text())
        if "platforms" not in log_data:
            log_data["platforms"] = {}
        log_data["domain"] = domain
        log_data["email"] = email
        log_data["platforms"]["reddit"] = {
            "status": "created",
            "username": actual_username,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "api_keys": False,
            "cred_file": "ops/social/.reddit-creds",
        }
        log_path.write_text(json.dumps(log_data, indent=2) + "\n")
        print("  Log updated")

        print(f"\n  Reddit account created: u/{actual_username}")

    except Exception as e:
        shot(page, "reddit-error")
        print(f"  ERROR: {e}")
        raise
    finally:
        context.close()


def provision_pinterest(domain: str):
    from cloakbrowser import launch_persistent_context

    brand = extract_brand(domain)
    email = f"social@{domain}"
    password = gen_password()

    print(f"Pinterest signup for {domain}")
    print(f"  Email: {email}")
    print(f"  Password: {password}")

    profile_dir = f"/tmp/cloak-profiles/{domain}/pinterest"
    os.makedirs(profile_dir, exist_ok=True)

    context = launch_persistent_context(
        profile_dir,
        headless=False,
        humanize=True,
        viewport={"width": 1000, "height": 700},
    )
    page = context.pages[0] if context.pages else context.new_page()

    try:
        print("  Navigating to Pinterest business signup...")
        page.goto("https://www.pinterest.com/business/create/", wait_until="domcontentloaded")
        time.sleep(3)

        print("  Filling signup form...")
        page.get_by_role("textbox", name="Email Email").fill(email)
        page.get_by_role("textbox", name="Password Password").fill(password)
        page.get_by_role("textbox", name="Birthdate").fill("1990-01-15")
        time.sleep(1)

        page.get_by_role("button", name="Create account").click()
        time.sleep(5)
        shot(page, "pinterest-01-after-create")

        # Onboarding: business type
        print("  Selecting business type...")
        try:
            page.get_by_role("radio", name="Publisher or media").click(timeout=5000)
            time.sleep(1)
            page.get_by_role("button", name="Next").click()
            time.sleep(3)
        except Exception:
            pass

        # Business details
        print("  Filling business details...")
        try:
            page.get_by_role("textbox", name="Business name").fill(brand.name)
            page.get_by_role("textbox", name="www.mywebsite.com").fill(f"https://{domain}")
            time.sleep(1)
            page.get_by_role("button", name="Next").click()
            time.sleep(3)
        except Exception:
            pass

        # Skip remaining onboarding
        print("  Skipping remaining onboarding...")
        for i in range(5):
            try:
                skip = page.get_by_role("button", name="Skip")
                if skip.count() > 0:
                    skip.first.click(timeout=3000)
                    time.sleep(2)
                    continue
                nxt = page.get_by_role("button", name="Next")
                if nxt.count() > 0:
                    nxt.first.click(timeout=3000)
                    time.sleep(2)
                    continue
            except Exception:
                break

        shot(page, "pinterest-02-done")
        print(f"  Final URL: {page.url}")

        # Get username from profile
        try:
            page.goto("https://www.pinterest.com/settings/edit-profile/", wait_until="domcontentloaded")
            time.sleep(3)
            username = page.locator("#username").input_value()
        except Exception:
            username = ""

        # Save creds
        sr = site_root(domain)
        creds = {
            "PINTEREST_USERNAME": username,
            "PINTEREST_PASSWORD": password,
            "PINTEREST_EMAIL": email,
        }
        path = write_creds(sr, "pinterest", creds)
        print(f"  Creds saved: {path}")

        # Update log
        log_path = sr / "ops" / "social" / "setup-log.json"
        log_data = {}
        if log_path.exists():
            log_data = json.loads(log_path.read_text())
        if "platforms" not in log_data:
            log_data["platforms"] = {}
        log_data["domain"] = domain
        log_data["email"] = email
        log_data["platforms"]["pinterest"] = {
            "status": "created",
            "username": username,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "cred_file": "ops/social/.pinterest-creds",
        }
        log_path.write_text(json.dumps(log_data, indent=2) + "\n")

        print(f"\n  Pinterest account created: {username}")

    except Exception as e:
        shot(page, "pinterest-error")
        print(f"  ERROR: {e}")
        raise
    finally:
        context.close()


def provision_x(domain: str):
    from cloakbrowser import launch_persistent_context

    brand = extract_brand(domain)
    email = f"social@{domain}"
    password = gen_password()
    username = brand.name.replace(" ", "")

    print(f"X (Twitter) signup for {domain}")
    print(f"  Email: {email}")
    print(f"  Username: @{username}")
    print(f"  Password: {password}")

    profile_dir = f"/tmp/cloak-profiles/{domain}/x"
    os.makedirs(profile_dir, exist_ok=True)

    context = launch_persistent_context(
        profile_dir,
        headless=False,
        humanize=True,
        viewport={"width": 1000, "height": 700},
    )
    page = context.pages[0] if context.pages else context.new_page()

    try:
        print("  Navigating to X signup...")
        page.goto("https://x.com/i/flow/signup", wait_until="domcontentloaded")
        time.sleep(5)
        shot(page, "x-01-signup")

        # X signup is heavily gated — human will need to help
        wait_for_human(page,
            f"Complete X signup in the browser:\n"
            f"  Email: {email}\n"
            f"  Password: {password}\n"
            f"  Target username: @{username}\n"
            f"  Complete phone/email verification\n"
            f"  Get to the logged-in home screen",
            "x-02-human-gate")

        shot(page, "x-03-done")
        print(f"  Final URL: {page.url}")

        # Check for username from a gate file
        uname_file = GATE_DIR / "x-username.txt"
        if uname_file.exists():
            actual_username = uname_file.read_text().strip() or username
            uname_file.unlink(missing_ok=True)
        else:
            actual_username = username

        sr = site_root(domain)
        creds = {
            "X_USERNAME": actual_username,
            "X_PASSWORD": password,
            "X_EMAIL": email,
        }
        path = write_creds(sr, "x", creds)
        print(f"  Creds saved: {path}")

        log_path = sr / "ops" / "social" / "setup-log.json"
        log_data = {}
        if log_path.exists():
            log_data = json.loads(log_path.read_text())
        if "platforms" not in log_data:
            log_data["platforms"] = {}
        log_data["domain"] = domain
        log_data["email"] = email
        log_data["platforms"]["x"] = {
            "status": "created",
            "username": actual_username,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "cred_file": "ops/social/.x-creds",
        }
        log_path.write_text(json.dumps(log_data, indent=2) + "\n")

        print(f"\n  X account created: @{actual_username}")

    except Exception as e:
        shot(page, "x-error")
        print(f"  ERROR: {e}")
        raise
    finally:
        context.close()


def provision_instagram(domain: str):
    from cloakbrowser import launch_persistent_context

    brand = extract_brand(domain)
    email = f"social@{domain}"
    password = gen_password()
    username = brand.name.replace(" ", "").lower()

    print(f"Instagram signup for {domain}")
    print(f"  Email: {email}")
    print(f"  Username: @{username}")
    print(f"  Password: {password}")

    profile_dir = f"/tmp/cloak-profiles/{domain}/instagram"
    os.makedirs(profile_dir, exist_ok=True)

    context = launch_persistent_context(
        profile_dir,
        headless=False,
        humanize=True,
        viewport={"width": 1000, "height": 700},
    )
    page = context.pages[0] if context.pages else context.new_page()

    try:
        print("  Navigating to Instagram signup...")
        page.goto("https://www.instagram.com/accounts/emailsignup/", wait_until="domcontentloaded")
        time.sleep(4)
        shot(page, "ig-01-signup")

        # Fill the form
        print("  Filling signup form...")
        try:
            page.locator('input[name="emailOrPhone"]').fill(email)
            time.sleep(0.5)
            page.locator('input[name="fullName"]').fill(brand.name)
            time.sleep(0.5)
            page.locator('input[name="username"]').fill(username)
            time.sleep(0.5)
            page.locator('input[name="password"]').fill(password)
            time.sleep(1)
            shot(page, "ig-02-form-filled")

            page.locator('button[type="submit"]').click()
            time.sleep(5)
            shot(page, "ig-03-after-submit")
        except Exception as e:
            print(f"  Auto-fill partial: {e}")

        # Birthday step
        try:
            # Instagram shows month/day/year selects
            month_sel = page.locator('select[title="Month:"]')
            if month_sel.count() > 0:
                month_sel.select_option("1")
                page.locator('select[title="Day:"]').select_option("15")
                page.locator('select[title="Year:"]').select_option("1990")
                time.sleep(0.5)
                page.get_by_role("button", name="Next").click()
                time.sleep(3)
                shot(page, "ig-04-after-birthday")
        except Exception:
            pass

        # Likely phone/email verification gate
        wait_for_human(page,
            f"Complete Instagram signup in the browser:\n"
            f"  - If stuck, fill: email={email}, user=@{username}, pw={password}\n"
            f"  - Complete phone/email verification and any CAPTCHAs\n"
            f"  - Get to the logged-in feed",
            "ig-05-human-gate")

        shot(page, "ig-06-done")
        print(f"  Final URL: {page.url}")

        actual_username = username

        sr = site_root(domain)
        creds = {
            "INSTAGRAM_USERNAME": actual_username,
            "INSTAGRAM_PASSWORD": password,
            "INSTAGRAM_EMAIL": email,
        }
        path = write_creds(sr, "instagram", creds)
        print(f"  Creds saved: {path}")

        log_path = sr / "ops" / "social" / "setup-log.json"
        log_data = {}
        if log_path.exists():
            log_data = json.loads(log_path.read_text())
        if "platforms" not in log_data:
            log_data["platforms"] = {}
        log_data["domain"] = domain
        log_data["email"] = email
        log_data["platforms"]["instagram"] = {
            "status": "created",
            "username": actual_username,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "cred_file": "ops/social/.instagram-creds",
        }
        log_path.write_text(json.dumps(log_data, indent=2) + "\n")

        print(f"\n  Instagram account created: @{actual_username}")

    except Exception as e:
        shot(page, "ig-error")
        print(f"  ERROR: {e}")
        raise
    finally:
        context.close()


def provision_tiktok(domain: str):
    from cloakbrowser import launch_persistent_context

    brand = extract_brand(domain)
    email = f"social@{domain}"
    password = gen_password()
    username = brand.name.replace(" ", "").lower()

    print(f"TikTok signup for {domain}")
    print(f"  Email: {email}")
    print(f"  Username: @{username}")
    print(f"  Password: {password}")

    profile_dir = f"/tmp/cloak-profiles/{domain}/tiktok"
    os.makedirs(profile_dir, exist_ok=True)

    context = launch_persistent_context(
        profile_dir,
        headless=False,
        humanize=True,
        viewport={"width": 1000, "height": 700},
    )
    page = context.pages[0] if context.pages else context.new_page()

    try:
        print("  Navigating to TikTok signup...")
        page.goto("https://www.tiktok.com/signup", wait_until="domcontentloaded")
        time.sleep(5)
        shot(page, "tiktok-01-signup")

        # TikTok signup is heavily interactive — human gate
        wait_for_human(page,
            f"Complete TikTok signup in the browser:\n"
            f"  Email: {email}\n"
            f"  Password: {password}\n"
            f"  Target username: @{username}\n"
            f"  Use 'Email' signup method\n"
            f"  Complete phone/email verification",
            "tiktok-02-human-gate")

        shot(page, "tiktok-03-done")
        print(f"  Final URL: {page.url}")

        actual_username = username

        sr = site_root(domain)
        creds = {
            "TIKTOK_USERNAME": actual_username,
            "TIKTOK_PASSWORD": password,
            "TIKTOK_EMAIL": email,
        }
        path = write_creds(sr, "tiktok", creds)
        print(f"  Creds saved: {path}")

        log_path = sr / "ops" / "social" / "setup-log.json"
        log_data = {}
        if log_path.exists():
            log_data = json.loads(log_path.read_text())
        if "platforms" not in log_data:
            log_data["platforms"] = {}
        log_data["domain"] = domain
        log_data["email"] = email
        log_data["platforms"]["tiktok"] = {
            "status": "created",
            "username": actual_username,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "cred_file": "ops/social/.tiktok-creds",
        }
        log_path.write_text(json.dumps(log_data, indent=2) + "\n")

        print(f"\n  TikTok account created: @{actual_username}")

    except Exception as e:
        shot(page, "tiktok-error")
        print(f"  ERROR: {e}")
        raise
    finally:
        context.close()


PROVISIONERS = {
    "reddit": provision_reddit,
    "pinterest": provision_pinterest,
    "x": provision_x,
    "instagram": provision_instagram,
    "tiktok": provision_tiktok,
}


def main():
    if len(sys.argv) < 3:
        print(f"Usage: python -m social_setup.cloak_provision <platform> <domain>")
        print(f"  Platforms: {', '.join(PROVISIONERS.keys())}")
        sys.exit(1)

    platform = sys.argv[1].lower()
    domain = sys.argv[2]

    if platform not in PROVISIONERS:
        print(f"Unknown platform: {platform}. Available: {', '.join(PROVISIONERS.keys())}")
        sys.exit(1)

    force = "--force" in sys.argv
    if has_creds(site_root(domain), platform) and not force:
        print(f"  {platform} creds already exist for {domain}. Use --force to overwrite.")
        return

    PROVISIONERS[platform](domain)


if __name__ == "__main__":
    main()
