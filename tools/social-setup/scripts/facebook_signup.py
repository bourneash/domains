"""Full-auto Facebook signup for a persona — fills the single-page /reg/
form, only pauses for a genuine captcha or an SMS/email code it can't
source itself.

Usage: facebook_signup.py <domain> <persona-slug> [first last]

PERSONA IS REQUIRED, unlike every other platform's signup script here —
confirmed live 2026-08-29 (0daynews.com) that Facebook rejects an
obviously brand-derived name outright: "It looks like you're trying to
create an account for a business, organization, or character. Please
create a Facebook Page instead." Facebook accounts model real people, not
brands — same footing as the LinkedIn caution already in this skill's
notes. A First/Last name is auto-generated deterministically from the
persona slug via social_lib.persona_names (same persona -> same name every
time) unless you pass explicit `first last` args to override.

Email <persona-slug>@<domain>, vault key "<domain>::<persona-slug>",
separate browser profile per persona.

Reconned live 2026-08-29 (0daynews.com) before writing this — see the DOM
notes below. Unlike Instagram's birthday widget (parked — virtualized Year
listbox, see instagram_signup.py's docstring), Facebook's Month/Day/Year
comboboxes render every option as a real, non-virtualized DOM node with a
sane bounding box even off-screen, so a normal Playwright `.click()` (which
auto-scrolls into view as part of its actionability check) just works — no
custom scroll-container hack needed.

Routed through the fleet's VPN proxy pinned to the FIXED US exit (see
[[reference_vpn_rotating_proxy]]) — same lesson learned the hard way on
x_signup.py: the random-global exit can land in an EU-ish region and serve
a different (GDPR) flow than this script is built against.
"""
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
from social_lib.sms_gate import smspool_order, smspool_wait_for_code, smspool_cancel, smspool_check  # noqa: E402
from social_lib.persona_names import generate_full_name  # noqa: E402

DOMAIN = sys.argv[1]
PERSONA = sys.argv[2]
if len(sys.argv) > 4:
    FIRST_NAME, LAST_NAME = sys.argv[3], sys.argv[4]
else:
    FIRST_NAME, LAST_NAME = generate_full_name(f"{DOMAIN}:{PERSONA}")
    print(f"STATUS generated name for persona {PERSONA!r}: {FIRST_NAME} {LAST_NAME}", flush=True)
EMAIL_LOCAL = PERSONA
EMAIL = f"{EMAIL_LOCAL}@{DOMAIN}"
VAULT_KEY = f"{DOMAIN}::{PERSONA}"
PROFILE_KEY = VAULT_KEY
ensure_social_alias(DOMAIN, EMAIL_LOCAL)
PASSWORD = gen_password()
SHOT_DIR = REPO_ROOT / ".cloak-screenshots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PREFIX = f"fb-{DOMAIN.split('.')[0]}" + (f"-{PERSONA}" if PERSONA else "")


def shot(page, name):
    try:
        page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}.png"))
    except Exception:
        pass


def captcha_present(page) -> bool:
    for sel in [
        'iframe[src*="recaptcha"]', 'iframe[title*="captcha" i]', 'iframe[src*="hcaptcha"]',
        '.h-captcha', 'img[src*="captcha"]', '[data-testid="captcha"]',
    ]:
        try:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                return True
        except Exception:
            pass
    return False


def click_text(page, *texts, timeout=3000):
    """Same hit-test discipline as x_signup.py — confirmed there
    (2026-08-29) that neither role=dialog scoping nor a bare "first visible
    match" is safe against duplicate/stale elements sharing text. Filters
    to visible + enabled + hit-test-passing before clicking."""
    for text in texts:
        for exact in (True, False):
            try:
                loc = page.get_by_text(text, exact=exact)
                n = loc.count()
                candidates = []
                for i in range(n):
                    cand = loc.nth(i)
                    if not cand.is_visible():
                        continue
                    try:
                        if not cand.is_enabled():
                            continue
                    except Exception:
                        pass
                    candidates.append(cand)
                hit = []
                for c in candidates:
                    try:
                        box = c.bounding_box()
                        if not box or box["width"] <= 0 or box["height"] <= 0:
                            continue
                        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                        ok = c.evaluate(
                            """(el, pt) => {
                                const top = document.elementFromPoint(pt.x, pt.y);
                                if (!top) return false;
                                return top === el || el.contains(top) || top.contains(el);
                            }""",
                            {"x": cx, "y": cy},
                        )
                        if ok:
                            hit.append(c)
                    except Exception:
                        pass
                chosen = hit[0] if hit else (candidates[-1] if candidates else None)
                if chosen is not None:
                    chosen.click(timeout=timeout)
                    time.sleep(1.2)
                    return True
            except Exception:
                pass
    return False


def select_dropdown_option(page, trigger_aria_label, value):
    """Facebook's Month/Day/Year/Gender controls are role=combobox divs, not
    native <select> — confirmed live 2026-08-29 (page.locator('select')
    returns 0). Clicking a specific option node is unreliable: Facebook
    pre-renders all three Month/Day/Year listboxes' option nodes in the DOM
    even when closed (197 role=option nodes present with only one combobox
    open), and even filtering to a visible, hit-tested node still silently
    landed on a no-op for Year on two separate live runs with no error and
    no effect. Type-ahead + Enter is far more reliable — confirmed live:
    click to focus/open, type the value, press Enter, verify the trigger's
    displayed text updated."""
    trigger = page.locator(f'[aria-label="{trigger_aria_label}"]')
    if trigger.count() == 0:
        print(f"STATUS dropdown trigger not found: {trigger_aria_label}", flush=True)
        return False

    for attempt in range(3):
        trigger.first.click()
        time.sleep(1.0)
        trigger.first.type(value, delay=100)
        time.sleep(0.5)
        page.keyboard.press("Enter")
        time.sleep(0.6)
        try:
            shown = trigger.first.inner_text()
            if value in shown:
                return True
            print(f"STATUS dropdown verify mismatch: {trigger_aria_label} shows {shown!r}, wanted {value!r} (attempt {attempt + 1})", flush=True)
        except Exception as e:
            print(f"STATUS dropdown verify exception: {trigger_aria_label}: {e}", flush=True)
    return False


print(f"Generated password: {PASSWORD}", flush=True)

# --- rent the number BEFORE opening the browser (same reasoning as
# x_signup.py — don't race SMSPool's expiry against browser flakiness) ---
order = smspool_order("facebook")
order_id = order.get("order_id") or order.get("orderid")
phone_local = order.get("phonenumber") or str(order.get("number"))
print(f"STATUS rented {phone_local} (order {order_id}) from SMSPool", flush=True)

context, page = launch_browser(PROFILE_KEY, "facebook", proxy="http://127.0.0.1:8181")
success = False
claimed_username = ""
try:
    page.goto("https://www.facebook.com/reg/", wait_until="domcontentloaded", timeout=30000)
    time.sleep(4)
    click_text(page, "Refuse non-essential cookies", "Decline optional cookies", "Only allow essential cookies")
    shot(page, "01-landing")

    text_inputs = page.locator('input[type="text"]')
    if text_inputs.count() >= 2:
        text_inputs.nth(0).fill(FIRST_NAME)
        text_inputs.nth(1).fill(LAST_NAME)

    select_dropdown_option(page, "Select Month", "January")
    select_dropdown_option(page, "Select Day", "1")
    select_dropdown_option(page, "Select Year", "1992")

    # Gender: pick whatever the first non-placeholder option is — this is a
    # brand/persona account, not a real person, and no positioning brief
    # dictates one. Don't hardcode "Male"/"Female"/"Custom" since the exact
    # label set isn't guaranteed stable.
    gender_trigger = page.locator('[aria-label="Select your gender" i], [role="combobox"]:has-text("Select your gender")')
    if gender_trigger.count() == 0:
        gender_trigger = page.get_by_text("Select your gender", exact=True)
    if gender_trigger.count():
        gender_trigger.first.click()
        time.sleep(0.6)
        gopts = page.locator('[role="option"], [role="menuitem"]')
        picked = False
        for i in range(gopts.count()):
            o = gopts.nth(i)
            try:
                if o.is_visible() and o.inner_text().strip():
                    o.click(timeout=3000)
                    picked = True
                    break
            except Exception:
                pass
        if not picked:
            print("STATUS gender dropdown: no clickable option found", flush=True)

    shot(page, "02-name-birthday-gender-filled")

    # Re-locate the mobile/email + password fields fresh — the earlier
    # `text_inputs` locator may be stale after the dropdown interactions
    # reflowed the page.
    mobile_input = page.locator('input[type="text"]').nth(2)
    mobile_input.fill(phone_local)
    page.locator('input[type="password"]').first.fill(PASSWORD)
    shot(page, "03-contact-password-filled")

    # NOT "Sign Up" — confirmed live 2026-08-29 that the page footer has a
    # harmless "Sign Up" link (to this same /reg/ page) that click_text's
    # exact-match, hit-tested search picks over the real button since it's
    # tried first and passes every filter (visible, enabled, hit-tests).
    # That silently reloads /reg/ instead of submitting the form — exactly
    # matched the "blank form after submit, no error" symptom this cost
    # real debugging time chasing as if it were a Facebook-side rejection.
    # The actual button's label is "Submit", nothing else.
    click_text(page, "Submit")
    time.sleep(3)
    shot(page, "04-post-submit")
    print(f"STATUS post-submit url={page.url}", flush=True)

    # Human/automation gates: captcha, then SMS code. Facebook may also ask
    # to "confirm" the birthday/name on a follow-up screen — handled
    # generically by the Next/Continue click loop below.
    deadline = time.time() + 3 * 60
    code_entered = False
    while time.time() < deadline:
        if captcha_present(page):
            print("STATUS captcha present — need Jesse", flush=True)
            resume_deadline = time.time() + 10 * 60
            while time.time() < resume_deadline:
                time.sleep(10)
                if not captcha_present(page):
                    print("STATUS captcha cleared, resuming", flush=True)
                    break

        if not code_entered:
            # The real field has NO name/autocomplete/aria-label at all —
            # confirmed live 2026-08-29 (only auto-generated x-prefixed
            # classes and an auto-generated id, e.g. "_R_3ae95kacppb6amH1_"
            # — nothing stable). maxlength="5" (the code length) is the
            # only reliable signal, matched on the dedicated confirmemail.php
            # page where it's the only text input, so no collision risk
            # with the name/phone/password fields from the earlier /reg/
            # form (a different page entirely by this point).
            code_input = page.locator(
                'input[maxlength="5"], input[maxlength="6"], '
                'input[name="code"], input[autocomplete="one-time-code"], '
                'input[aria-label*="code" i]'
            )
            if code_input.count() > 0 and code_input.first.is_visible():
                print("STATUS SMS code field found — waiting on SMSPool "
                      "(Jesse can also type it into the browser window "
                      "himself; either source is picked up)", flush=True)
                # Race SMSPool's own delivery against a human typing the
                # code directly into the visible browser window — confirmed
                # live 2026-08-29 that Facebook's SMS can arrive and be
                # visible to a person watching the window well before (or
                # instead of) SMSPool's own sms/check endpoint relays it.
                code = None
                code_deadline = time.time() + 600
                while time.time() < code_deadline:
                    try:
                        resp = smspool_check(order_id)
                        polled = (resp.get("sms") or resp.get("code") or "").strip()
                    except Exception:
                        polled = ""
                    if polled:
                        code = polled
                        print(f"STATUS code arrived via SMSPool: {code}", flush=True)
                        break
                    try:
                        typed = code_input.first.input_value(timeout=2000).strip()
                    except Exception:
                        typed = ""
                    if typed and len(typed) >= 4:
                        code = typed
                        print(f"STATUS code appears already typed in browser: {code}", flush=True)
                        break
                    time.sleep(5)
                if not code:
                    print("STATUS no code arrived within 10 min via SMSPool or "
                          "the browser field — leaving the window open, not "
                          "closing it, in case Jesse wants to finish manually", flush=True)
                    break
                if not code_input.first.input_value(timeout=2000).strip():
                    code_input.first.fill(code)
                print("STATUS verification code entered", flush=True)
                shot(page, "05-code-filled")
                click_text(page, "Continue", "Next", "Confirm")
                time.sleep(3)
                code_entered = True
                continue

        progressed = click_text(page, "Continue", "Next", "OK", "Not Now", "Skip")
        if page.locator('[aria-label="Home" i], [aria-label="Facebook" i][role="link"]').count() > 0:
            print("STATUS reached home/feed", flush=True)
            success = True
            break
        if not progressed:
            time.sleep(3)

    shot(page, "06-final")
    print(f"STATUS final url={page.url}", flush=True)
except Exception as e:
    print(f"STATUS exception during flow: {e}", flush=True)

# Verify via the logged-in nav rather than trusting the loop's own
# "reached home/feed" flag alone — same discipline as every other
# platform's script here.
logged_in = success
try:
    if not logged_in:
        logged_in = page.locator('[aria-label="Home" i], [aria-label="Your profile" i]').count() > 0
except Exception as e:
    print(f"verify note: {e}", flush=True)

# Never auto-close the browser on a failure — per Jesse 2026-08-29, after
# an earlier run's browser window got pulled out from under him mid-manual-
# assist by an unconditional context.close(). If not logged in yet, give it
# one more few-minute window checking whether a human finishes it by hand
# in the still-open window, and only close (or leave open indefinitely) —
# never force it shut on a script-side timeout.
if not logged_in:
    print("STATUS not logged in yet — window stays OPEN, watching for up to "
          "5 more minutes in case it's finished by hand", flush=True)
    watch_deadline = time.time() + 5 * 60
    while time.time() < watch_deadline and not logged_in:
        time.sleep(10)
        try:
            logged_in = page.locator('[aria-label="Home" i], [aria-label="Your profile" i]').count() > 0
        except Exception:
            pass

print(f"LOGGED_IN:{logged_in}", flush=True)

if logged_in:
    write_creds(VAULT_KEY, "facebook", {
        "FACEBOOK_EMAIL_OR_PHONE": phone_local,
        "FACEBOOK_PASSWORD": PASSWORD,
        "FACEBOOK_NAME": f"{FIRST_NAME} {LAST_NAME}",
        "FACEBOOK_PHONE": phone_local,
    })
    print("STATUS creds written to vault", flush=True)
    context.close()
else:
    print("STATUS SIGNUP DID NOT SUCCEED — not logged in, no creds written. "
          "Browser window left OPEN — close it yourself when done, or "
          "re-run this script (it reuses the same profile).", flush=True)

print("STATUS done", flush=True)
