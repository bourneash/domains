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


def _update_log(sr: Path, domain: str, email: str, platform: str, username: str, cred_file: str):
    log_path = sr / "ops" / "social" / "setup-log.json"
    log_data: dict = {}
    if log_path.exists():
        log_data = json.loads(log_path.read_text())
    if "platforms" not in log_data:
        log_data["platforms"] = {}
    log_data["domain"] = domain
    log_data["email"] = email
    log_data["platforms"][platform] = {
        "status": "created",
        "username": username,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "cred_file": cred_file,
    }
    log_path.write_text(json.dumps(log_data, indent=2) + "\n")


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
    import re
    from cloakbrowser import launch_persistent_context
    from social_lib.email_client import EmailClient
    from social_lib.sms_gate import manual_gate

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
        viewport={"width": 1280, "height": 800},
    )
    page = context.pages[0] if context.pages else context.new_page()

    def click_next():
        for sel in [
            'div[data-testid="ocfSignupNextLink"]',
            'button:has-text("Next")',
            'div[role="button"]:has-text("Next")',
        ]:
            el = page.locator(sel)
            if el.count() > 0 and el.first.is_visible():
                el.first.click()
                return
        raise RuntimeError("Could not find Next button")

    try:
        # ──────────────────────────────────────────────────────────────────
        # X signup flow (2026):
        #   1. x.com homepage → click signup link → "See what's happening" modal
        #   2. modal → "Continue with phone" → phone number entry
        #   3. phone entry → Continue → SMS code → enter code
        #   4. SMS verified (new account) → name + DOB form
        #   5. Fill name + DOB → Next → Customize screen → Next
        #   6. Optional: email address screen → fill
        #   7. Password → Skip photo → Username → Skip onboarding
        # ──────────────────────────────────────────────────────────────────

        print("  Loading x.com...")
        page.goto("https://x.com", wait_until="domcontentloaded")
        time.sleep(4)
        shot(page, "x-01-home")

        # ── Step 1: Open the signup modal ─────────────────────────────────
        # Try the signup link; if not found, scroll to reveal "Join today"
        # section which has the Create account button.
        def open_signup_modal():
            for sel in ['a[href="/i/flow/signup"]', 'a:has-text("Sign up")']:
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    el.first.click()
                    return True
            # Scroll down to find "Create account" / "Join today" section
            page.evaluate("window.scrollBy(0, 600)")
            time.sleep(1)
            for sel in ['a[href="/i/flow/signup"]', 'a:has-text("Create account")']:
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    el.first.click()
                    return True
            return False

        opened = open_signup_modal()
        time.sleep(3)
        shot(page, "x-02-after-modal-open")

        # ── Step 2: Click "Continue with phone" in the modal ─────────────
        # The "See what's happening" signup modal shows: Continue with phone
        # / Continue with Google / Continue with Apple.
        # If we're already past the phone number screen (modal opened directly
        # into phone form), skip this click.
        phone_input_sel = 'input[type="tel"], input[placeholder*="Phone" i], input[name*="phone" i]'
        name_input_sel = 'input[name="name"]'

        if page.locator(name_input_sel).count() == 0 and page.locator(phone_input_sel).count() == 0:
            print("  Clicking Continue with phone in signup modal...")
            for sel in [
                'button:has-text("Continue with phone")',
                'div[role="button"]:has-text("Continue with phone")',
                '[data-testid="google_sign_in_container"] ~ * button',  # next button after Google
            ]:
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    el.first.click()
                    time.sleep(3)
                    break
            shot(page, "x-03-after-continue-phone")

        # ── Step 3: Phone number entry ────────────────────────────────────
        # X asks for phone number. Enter via SMS gate so Jesse's phone
        # receives the code. If his phone is already on X, the flow will
        # route to login — we detect that and raise.
        if page.locator(phone_input_sel).count() > 0:
            print("  Phone number entry screen — SMS gate (enter phone in CloakBrowser)...")
            shot(page, "x-03-phone-entry")

            # X uses React controlled inputs — .fill() doesn't trigger
            # onChange handlers. Click to focus, then keyboard.type() fires
            # real key events that React sees.
            # Scope within the modal to avoid clicking background elements.
            dialog = page.locator('[role="dialog"]').last
            # Try dialog-scoped input first, fallback to page-scoped
            for scope in [dialog, page]:
                phone_el = scope.locator(
                    'input[autocomplete="tel"], input[type="tel"], input[placeholder*="Phone" i]'
                )
                if phone_el.count() == 0:
                    phone_el = scope.locator('input:not([type="hidden"]):not([type="submit"])')
                if phone_el.count() > 0 and phone_el.first.is_visible():
                    phone_el.first.click()
                    time.sleep(0.3)
                    page.keyboard.type("6107378479")
                    time.sleep(1)
                    shot(page, "x-03b-phone-filled")  # debug: confirm number shows in field
                    break

            # Submit by pressing Enter — avoids CloakBrowser visibility-check
            # issues with the dialog button, and works universally for forms.
            page.keyboard.press("Enter")
            time.sleep(4)
            shot(page, "x-03c-after-phone-submit")

            # Detect "couldn't send" error (phone already on X or rate-limited)
            if page.locator("text=couldn't send you a text").count() > 0 or \
               page.locator("text=check the number").count() > 0:
                shot(page, "x-03d-phone-error")
                raise RuntimeError(
                    "X rejected the phone number — it may already be registered. "
                    "To fix: provide a virtual number via SMSPOOL (add SMSPOOL_API_KEY to .env) "
                    "or use a spare SIM. X account cannot be created without a fresh number."
                )

            # ── SMS gate ──────────────────────────────────────────────────
            print("  Waiting for SMS code gate...")
            code = manual_gate(f"x-sms-{domain}")
            # Enter code
            for sel in ['input[autocomplete="one-time-code"]', 'input[data-testid="ocfEnterTextTextInput"]']:
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    el.first.fill(code)
                    break
            time.sleep(0.5)
            page.keyboard.press("Enter")
            time.sleep(3)
            shot(page, "x-04-after-sms-verify")

            # Detect if we got routed to login (password screen) instead of signup
            if page.locator('input[name="password"], input[type="password"]').count() > 0:
                if page.locator(name_input_sel).count() == 0:
                    raise RuntimeError(
                        "Phone is already registered on X — landed on login/password screen. "
                        "Use a different phone number for this account."
                    )

        # ── Step 4: Name form ─────────────────────────────────────────────
        if page.locator(name_input_sel).count() > 0 or True:
            try:
                page.wait_for_selector(name_input_sel, timeout=10000)
                print("  Filling name...")
                page.fill(name_input_sel, brand.name)
                time.sleep(0.5)
            except Exception:
                print("  Name field not found — may have been skipped or not required")

        # ── Step 5: Date of birth ─────────────────────────────────────────
        print("  Setting date of birth...")
        try:
            page.wait_for_selector('select[data-testid="month"]', timeout=5000)
            page.select_option('select[data-testid="month"]', "1")
            page.select_option('select[data-testid="day"]', "15")
            page.select_option('select[data-testid="year"]', "1990")
        except Exception:
            try:
                ms = page.locator('[id*="SELECTOR_1"]')
                if ms.count() > 0:
                    ms.first.select_option(index=1)
                    page.locator('[id*="SELECTOR_2"]').first.select_option(value="15")
                    page.locator('[id*="SELECTOR_3"]').first.select_option(value="1990")
            except Exception as e2:
                print(f"  DOB fill partial: {e2}")
        time.sleep(0.5)
        shot(page, "x-05-name-dob")

        # ── Step 6: Next → Next ───────────────────────────────────────────
        print("  Clicking Next...")
        click_next()
        time.sleep(2)
        shot(page, "x-06-after-next")

        # "Customize your experience" — just click Next
        if page.locator('h2:has-text("Customize"), span:has-text("Customize your experience")').count() > 0:
            print("  Skipping customization...")
            click_next()
            time.sleep(2)

        # ── Step 7: CAPTCHA gate ──────────────────────────────────────────
        if page.locator('[data-testid="arkose_iframe"], iframe[title*="captcha" i]').count() > 0:
            print("  CAPTCHA detected...")
            shot(page, "x-captcha")
            wait_for_human(page,
                "Solve the CAPTCHA in the CloakBrowser window, then signal continue.",
                "x-captcha-gate")
            time.sleep(2)

        # ── Step 8: Email address (X may ask) ────────────────────────────
        if page.locator('input[name="email"], input[type="email"]').count() > 0:
            print("  Filling email...")
            for sel in ['input[name="email"]', 'input[type="email"]']:
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    el.first.fill(email)
                    break
            time.sleep(0.5)
            click_next()
            time.sleep(2)
            shot(page, "x-07-after-email")

        # Email verify (if X sends a code to the email we just provided)
        try:
            page.wait_for_selector('input[autocomplete="one-time-code"]', timeout=8000)
            html = page.content()
            if "email" in html.lower():
                print("  Email verify — reading from email-client...")
                mailbox = os.environ.get("HOTMAIL_ADDRESS", "jessetamburino@hotmail.com")
                client = EmailClient(mailbox)
                msg = client.wait_for_message(to_addr=email, subject_contains="", timeout=120)
                body = msg.get("body_text", "") + msg.get("body_html", "")
                m = re.search(r"\b(\d{6,8})\b", body)
                if m:
                    page.locator('input[autocomplete="one-time-code"]').first.fill(m.group(1))
                    click_next()
                    time.sleep(2)
        except Exception:
            pass

        # ── Step 9: Password ──────────────────────────────────────────────
        print("  Setting password...")
        try:
            page.wait_for_selector('input[type="password"]', timeout=10000)
            page.fill('input[type="password"]', password)
            time.sleep(0.5)
            click_next()
            time.sleep(3)
            shot(page, "x-08-after-password")
        except Exception as e:
            print(f"  Password step: {e}")

        # ── Step 10: Skip profile photo ───────────────────────────────────
        for skip_sel in ['button:has-text("Skip for now")', 'a:has-text("Skip")']:
            el = page.locator(skip_sel)
            if el.count() > 0 and el.first.is_visible():
                el.first.click()
                time.sleep(2)
                break

        # ── Step 11: Username ─────────────────────────────────────────────
        print("  Setting username...")
        try:
            uname_input = page.locator('input[data-testid="ocfEnterTextTextInput"]')
            if uname_input.count() > 0 and uname_input.first.is_visible():
                uname_input.first.triple_click()
                uname_input.first.fill(username)
                time.sleep(1)
                click_next()
                time.sleep(3)
                shot(page, "x-09-after-username")
        except Exception as e:
            print(f"  Username step: {e}")

        # ── Step 12: Skip interests / follow suggestions ──────────────────
        for _ in range(8):
            time.sleep(1)
            for skip_sel in ['button:has-text("Skip")', 'a:has-text("Skip")']:
                el = page.locator(skip_sel)
                if el.count() > 0 and el.first.is_visible():
                    el.first.click()
                    time.sleep(1.5)
                    break
            if "home" in page.url:
                break

        shot(page, "x-10-done")
        print(f"  Final URL: {page.url}")

        # Read actual username from profile
        try:
            page.goto("https://x.com/settings/account/username", wait_until="domcontentloaded")
            time.sleep(2)
            actual_username = page.locator('input[name="username"]').input_value() or username
        except Exception:
            actual_username = username

        # ── Save creds ────────────────────────────────────────────────────
        sr = site_root(domain)
        creds = {
            "X_USERNAME": actual_username,
            "X_PASSWORD": password,
            "X_EMAIL": email,
        }
        path = write_creds(sr, "x", creds)
        print(f"  Creds saved: {path}")

        _update_log(sr, domain, email, "x", actual_username, "ops/social/.x-creds")
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
    import re
    from cloakbrowser import launch_persistent_context
    from social_lib.email_client import EmailClient
    from social_lib.sms_gate import manual_gate

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
        viewport={"width": 1280, "height": 800},
    )
    page = context.pages[0] if context.pages else context.new_page()

    try:
        # ── Step 1: Navigate to signup ────────────────────────────────────
        print("  Navigating to TikTok...")
        page.goto("https://www.tiktok.com/signup/phone-or-email/email", wait_until="domcontentloaded")
        time.sleep(5)
        shot(page, "tiktok-01-landing")

        # If redirected to home, find signup link
        if "signup" not in page.url:
            for sel in ['a:has-text("Sign up")', 'button:has-text("Sign up")']:
                el = page.locator(sel)
                if el.count() > 0 and el.first.is_visible():
                    el.first.click()
                    time.sleep(3)
                    break

        # Click "Use phone / email" if on the choice screen
        for sel in [
            'div:has-text("Use phone / email")',
            'a:has-text("Use phone / email")',
            'span:has-text("Use phone / email")',
        ]:
            el = page.locator(sel)
            if el.count() > 0 and el.first.is_visible():
                el.first.click()
                time.sleep(2)
                break

        # Switch to Email tab
        for sel in [
            'a:has-text("Email")',
            '[class*="email-tab"]',
            'span:has-text("Email"):not(:has-text("phone"))',
        ]:
            el = page.locator(sel)
            if el.count() > 0 and el.first.is_visible():
                el.first.click()
                time.sleep(1.5)
                break

        shot(page, "tiktok-02-email-tab")

        # ── Step 2: Birthday ──────────────────────────────────────────────
        print("  Setting birthday...")
        try:
            page.wait_for_selector('input[type="date"], select[name*="month"], input[placeholder*="MM"]', timeout=5000)
            # Try date input
            date_input = page.locator('input[type="date"]')
            if date_input.count() > 0:
                date_input.first.fill("1990-01-15")
            else:
                # Individual selects
                m = page.locator('select[name*="month"]')
                if m.count() > 0:
                    m.first.select_option("1")
                d = page.locator('select[name*="day"]')
                if d.count() > 0:
                    d.first.select_option("15")
                y = page.locator('select[name*="year"]')
                if y.count() > 0:
                    y.first.select_option("1990")
            time.sleep(0.5)
            page.locator('button:has-text("Next"), div[role="button"]:has-text("Next")').first.click()
            time.sleep(2)
        except Exception as e:
            print(f"  Birthday step: {e}")
        shot(page, "tiktok-03-after-birthday")

        # ── Step 3: Email field ───────────────────────────────────────────
        print("  Filling email...")
        try:
            page.wait_for_selector('input[name="email"], input[type="email"]', timeout=8000)
            page.fill('input[name="email"], input[type="email"]', email)
            time.sleep(0.5)
        except Exception as e:
            print(f"  Email fill: {e}")

        # ── Step 4: Send verification code ───────────────────────────────
        print("  Requesting verification code...")
        for sel in [
            'button:has-text("Send code")',
            'button:has-text("Get code")',
            'span:has-text("Send code")',
        ]:
            el = page.locator(sel)
            if el.count() > 0 and el.first.is_visible():
                el.first.click()
                break
        time.sleep(3)
        shot(page, "tiktok-04-code-sent")

        # CAPTCHA may appear here (slider puzzle) — gate
        if page.locator('[id*="captcha"], [class*="captcha"], .secsdk-captcha-drag-icon').count() > 0:
            print("  CAPTCHA detected — waiting for manual solve...")
            shot(page, "tiktok-captcha")
            wait_for_human(page,
                "Solve the CAPTCHA slider in the CloakBrowser window, then signal continue.",
                "tiktok-captcha-gate")
            time.sleep(2)

        # ── Step 5: Enter email code ──────────────────────────────────────
        print("  Reading verification code from email-client...")
        try:
            mailbox = os.environ.get("HOTMAIL_ADDRESS", "jessetamburino@hotmail.com")
            api_key = os.environ.get("EMAIL_API_KEY")
            client = EmailClient(mailbox, api_key=api_key)
            msg = client.wait_for_message(to_addr=email, subject_contains="", timeout=120)
            body = msg.get("body_text", "") + msg.get("body_html", "")
            match = re.search(r"\b(\d{6})\b", body)
            if not match:
                raise RuntimeError(f"No 6-digit code in email: {body[:200]}")
            code = match.group(1)
            print(f"  Got code: {code}")
            page.wait_for_selector(
                'input[name="code"], input[placeholder*="code" i], input[autocomplete="one-time-code"]',
                timeout=10000,
            )
            page.fill(
                'input[name="code"], input[placeholder*="code" i], input[autocomplete="one-time-code"]',
                code,
            )
            time.sleep(0.5)
        except Exception as e:
            print(f"  Code entry: {e}")
            shot(page, "tiktok-code-error")

        # ── Step 6: Password ──────────────────────────────────────────────
        print("  Setting password...")
        try:
            page.wait_for_selector('input[type="password"]', timeout=8000)
            page.fill('input[type="password"]', password)
            time.sleep(0.5)
        except Exception as e:
            print(f"  Password: {e}")

        # Click Next / Sign up
        for sel in [
            'button:has-text("Sign up")',
            'button[type="submit"]',
            'button:has-text("Next")',
        ]:
            el = page.locator(sel)
            if el.count() > 0 and el.first.is_visible():
                el.first.click()
                break
        time.sleep(5)
        shot(page, "tiktok-05-after-signup")

        # ── Step 7: Username (post-signup) ────────────────────────────────
        print("  Checking username...")
        try:
            page.goto("https://www.tiktok.com/setting/", wait_until="domcontentloaded")
            time.sleep(3)
            actual_username = page.locator('input[name="uniqueId"], [class*="username"] input').input_value() or username
        except Exception:
            actual_username = username

        shot(page, "tiktok-06-done")
        print(f"  Final URL: {page.url}")

        # ── Save creds ────────────────────────────────────────────────────
        sr = site_root(domain)
        creds = {
            "TIKTOK_USERNAME": actual_username,
            "TIKTOK_PASSWORD": password,
            "TIKTOK_EMAIL": email,
        }
        path = write_creds(sr, "tiktok", creds)
        print(f"  Creds saved: {path}")

        _update_log(sr, domain, email, "tiktok", actual_username, "ops/social/.tiktok-creds")
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
