"""Full-auto Reddit account signup for a given domain — fills everything,
only pauses if a real captcha widget shows up. Usage: reddit_signup.py <domain> <username>"""
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/jesse/projects/domains/tools/social-setup/src")
sys.path.insert(0, "/home/jesse/projects/domains/tools/social-lib/src")

from social_setup.browser import launch_browser  # noqa: E402
from social_setup.passwords import generate as gen_password  # noqa: E402
from social_lib.credentials import write_creds  # noqa: E402

DOMAIN = sys.argv[1]
USERNAME = sys.argv[2]
EMAIL = f"social@{DOMAIN}"
PASSWORD = gen_password()
SHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PREFIX = f"reddit-{DOMAIN.split('.')[0]}"


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}"))


def captcha_present(page) -> bool:
    for sel in ['iframe[src*="recaptcha"]', 'iframe[title*="captcha" i]', '#px-captcha', 'iframe[src*="hcaptcha"]',
                'div:has-text("Prove your humanity")']:
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


def click_continue(page):
    """Reddit's Continue button isn't always a real <button> — try role-based
    matching too, and press Enter as a last resort (submits the focused form)."""
    for attempt in [
        lambda: page.get_by_role("button", name="Continue").click(timeout=3000),
        lambda: page.locator('button:has-text("Continue"), [role="button"]:has-text("Continue")').first.click(timeout=3000),
        lambda: page.keyboard.press("Enter"),
    ]:
        try:
            attempt()
            time.sleep(1.5)
            return True
        except Exception:
            continue
    return False


print(f"Generated password: {PASSWORD}", flush=True)

context, page = launch_browser(DOMAIN, "reddit")
page.goto("https://www.reddit.com/register/", wait_until="domcontentloaded", timeout=30000)
time.sleep(3)

# Reddit serves either an old single-page form (input[name=email]/[id=regEmail])
# or a newer stepped modal (plain input[type=email], then username, then
# password, one Continue click apart, no name/id attrs). Handle both by
# probing for whichever field is actually visible on each pass, not assuming
# a fixed flow — this is what broke silently last time.
email_selectors = 'input[name="email"], input[id="regEmail"], input[type="email"]'
user_selectors = 'input[name="username"], input[id="regUsername"], input[placeholder="Username" i]'
pass_selectors = 'input[name="password"], input[id="regPassword"], input[type="password"]'

step_deadline = time.time() + 90
filled_email = filled_user = filled_pass = False
while time.time() < step_deadline:
    if captcha_present(page):
        print("STATUS captcha during signup steps — need Jesse", flush=True)
        break
    try:
        if not filled_email:
            f = page.locator(email_selectors)
            if f.count() > 0 and f.first.is_visible():
                f.first.fill(EMAIL)
                filled_email = True
                time.sleep(0.5)
                click_continue(page)
                continue

        if not filled_user:
            f = page.locator(user_selectors)
            if f.count() > 0 and f.first.is_visible():
                f.first.fill(USERNAME)
                filled_user = True
                time.sleep(0.5)
                click_continue(page)
                continue

        if not filled_pass:
            f = page.locator(pass_selectors)
            if f.count() > 0 and f.first.is_visible():
                f.first.fill(PASSWORD)
                filled_pass = True
                time.sleep(0.5)
                shot(page, "01-filled.png")
                click_if_present(page, 'button:has-text("Sign Up")', 'button:has-text("Sign up")',
                                  'button:has-text("Continue")')
                time.sleep(2)
                continue

        if filled_email and filled_user and filled_pass:
            break
    except Exception as e:
        print(f"step note: {e}", flush=True)
    time.sleep(1.5)

print(f"STATUS steps: email={filled_email} user={filled_user} pass={filled_pass}", flush=True)
shot(page, "02-postsubmit.png")
print(f"STATUS post-submit url={page.url}", flush=True)

if captcha_present(page):
    print("STATUS PAUSED FOR CAPTCHA — Jesse, solve it in the window", flush=True)
    resume_deadline = time.time() + 10 * 60
    while time.time() < resume_deadline:
        time.sleep(10)
        if not captcha_present(page):
            print("STATUS captcha cleared, resuming", flush=True)
            break

    # This is often a general site bot-check, not the register form's own
    # captcha — clearing it redirects to reddit.com home, losing whatever
    # step we were on. If we're not on /register/ anymore (and nothing got
    # filled), go back and redo the whole step loop from scratch.
    if "register" not in page.url and not (filled_email and filled_user and filled_pass):
        print(f"STATUS post-challenge redirected to {page.url}, re-navigating to register", flush=True)
        page.goto("https://www.reddit.com/register/", wait_until="domcontentloaded", timeout=30000)
        time.sleep(3)
        step_deadline = time.time() + 90
        filled_email = filled_user = filled_pass = False
        while time.time() < step_deadline:
            if captcha_present(page):
                print("STATUS captcha again on retry — need Jesse again", flush=True)
                resume2 = time.time() + 10 * 60
                while time.time() < resume2:
                    time.sleep(10)
                    if not captcha_present(page):
                        break
            try:
                if not filled_email:
                    f = page.locator(email_selectors)
                    if f.count() > 0 and f.first.is_visible():
                        f.first.fill(EMAIL)
                        filled_email = True
                        time.sleep(0.5)
                        click_continue(page)
                        continue
                if not filled_user:
                    f = page.locator(user_selectors)
                    if f.count() > 0 and f.first.is_visible():
                        f.first.fill(USERNAME)
                        filled_user = True
                        time.sleep(0.5)
                        click_continue(page)
                        continue
                if not filled_pass:
                    f = page.locator(pass_selectors)
                    if f.count() > 0 and f.first.is_visible():
                        f.first.fill(PASSWORD)
                        filled_pass = True
                        time.sleep(0.5)
                        shot(page, "01b-refilled.png")
                        click_if_present(page, 'button:has-text("Sign Up")', 'button:has-text("Sign up")')
                        click_continue(page)
                        time.sleep(2)
                        continue
                if filled_email and filled_user and filled_pass:
                    break
            except Exception as e:
                print(f"re-step note: {e}", flush=True)
            time.sleep(1.5)
        print(f"STATUS re-fill steps: email={filled_email} user={filled_user} pass={filled_pass}", flush=True)

# Drive any post-signup onboarding (avatar picker, interest picker, etc.)
deadline = time.time() + 2 * 60
while time.time() < deadline:
    if captcha_present(page):
        print("STATUS captcha appeared mid-flow — need Jesse", flush=True)
        resume_deadline = time.time() + 10 * 60
        while time.time() < resume_deadline:
            time.sleep(10)
            if not captcha_present(page):
                break
    progressed = click_if_present(
        page,
        'button:has-text("Skip")',
        'button:has-text("Not now")',
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'button:has-text("Done")',
        'button:has-text("Maybe later")',
    )
    if "reddit.com" in page.url and page.url.rstrip("/").endswith(("reddit.com", "reddit.com/home")):
        print("STATUS looks like home feed", flush=True)
        break
    if not progressed:
        time.sleep(3)

shot(page, "03-final.png")
print(f"STATUS final url={page.url}", flush=True)

# Verify we're actually logged in before trusting anything — a captcha that
# silently re-triggers (as happened once already) leaves us back on the
# register page with nothing created, and we must not write bogus creds.
try:
    page.goto("https://www.reddit.com/", wait_until="domcontentloaded", timeout=20000)
    time.sleep(3)
    body = page.locator("body").inner_text(timeout=5000)
    logged_in = "log out" in body.lower() or "logout" in body.lower() or USERNAME.lower() in body.lower()
except Exception as e:
    print(f"verify note: {e}", flush=True)
    logged_in = False

shot(page, "04-verify.png")
print(f"STATUS verify logged_in={logged_in} url={page.url}", flush=True)

if logged_in:
    write_creds(DOMAIN, "reddit", {
        "REDDIT_USERNAME": USERNAME,
        "REDDIT_PASSWORD": PASSWORD,
        "REDDIT_EMAIL": EMAIL,
    })
    print("STATUS creds written to vault", flush=True)
else:
    print("STATUS SIGNUP DID NOT SUCCEED — no creds written, needs retry", flush=True)

time.sleep(3)
context.close()
print("STATUS done", flush=True)
