"""Full-auto X (Twitter) signup for any domain — real SMSPool number rented
per account (X requires phone verification, and rejects VoIP/Twilio-class
numbers — see reference_sms_verification_smspool memory for why).
Usage: x_signup.py <domain> <display-name> <desired-handle> [persona-slug]

Without persona-slug: the domain-level brand account (email social@<domain>,
vault key "<domain>"). With persona-slug: a per-persona account — email
<persona-slug>@<domain>, vault key "<domain>::<persona-slug>", separate
browser profile.

REAL FLOW (confirmed live 2026-08-29, shoptopless.com — the assumed flow in
the first draft of this script was wrong on several points, corrected here):
  1. /i/flow/signup lands on the login/signup chooser. "Continue with phone"
     starts account creation (no separate "Create account" link/button).
  2. Phone-only screen (NO name field, NO birthdate selects here — the first
     draft filled these too early against elements that don't exist yet).
  3. SMS code screen.
  4. Standalone "When's your birthday?" screen (month/day/year <select>s) —
     comes AFTER code verification, not before like Pinterest/Bluesky's DOB
     pattern. Defaults to *today's* date if left untouched.
  5. Combined Name + Username + Password screen (all three fields at once).
  6. Onboarding: "Follow the top posters" topic-pack picker, other
     skip/next screens, interests. Ends on the home timeline OR simply
     never quite gets there within the poll window — the account is
     already fully created well before this finishes, so don't gate
     success on reaching /home.
  7. /settings/screen_name to claim the desired handle over the
     auto-generated one.

KEY BUG (confirmed live): X renders the *disabled* "Continue" button from
the chooser screen underneath the modal AND the modal's own enabled
"Continue" button both match `get_by_text("Continue", exact=True)` — the
background one is invisible-by-overlap but Playwright's is_visible() only
checks CSS/bbox, not actual occlusion, so `.first` can silently resolve to
the dead one. Fix: scope every click to the topmost dialog
(`get_by_role("dialog")`) when one exists, and require the element be
enabled, not just visible.
"""
import random
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/jesse/projects/domains/tools/social-setup/src")
sys.path.insert(0, "/home/jesse/projects/domains/tools/social-lib/src")

from social_setup.browser import launch_browser  # noqa: E402
from social_setup.passwords import generate as gen_password  # noqa: E402
from social_setup.email import ensure_social_alias  # noqa: E402
from social_lib.credentials import write_creds  # noqa: E402
from social_lib.sms_gate import smspool_order, smspool_wait_for_code, smspool_cancel  # noqa: E402

DOMAIN = sys.argv[1]
DISPLAY_NAME = sys.argv[2]
HANDLE_BASE = sys.argv[3]
PERSONA = sys.argv[4] if len(sys.argv) > 4 else None
EMAIL_LOCAL = PERSONA or "social"
EMAIL = f"{EMAIL_LOCAL}@{DOMAIN}"
VAULT_KEY = f"{DOMAIN}::{PERSONA}" if PERSONA else DOMAIN
PROFILE_KEY = VAULT_KEY
ensure_social_alias(DOMAIN, EMAIL_LOCAL)
PASSWORD = gen_password()
SHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PREFIX = f"x-{DOMAIN.split('.')[0]}" + (f"-{PERSONA}" if PERSONA else "")


def shot(page, name):
    page.screenshot(path=str(SHOT_DIR / f"{PREFIX}-{name}"))


def dialog_scope(page):
    """The topmost modal, if X has rendered one — click targets should
    live inside this, never the dimmed chooser screen behind it."""
    try:
        dlg = page.get_by_role("dialog")
        if dlg.count() > 0:
            return dlg.last
    except Exception:
        pass
    return page


def captcha_present(page) -> bool:
    # X's challenge is Arkose Labs (FunCaptcha), not recaptcha/hcaptcha —
    # different iframe fingerprint. Check both families; a fleet-wide
    # captcha_present() convention already exists, keep matching it.
    for sel in [
        'iframe[src*="arkoselabs"]', 'iframe[data-e2e="arkose-iframe"]', '#arkose-iframe',
        'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[title*="captcha" i]',
    ]:
        try:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                return True
        except Exception:
            pass
    return False


def click_if_present(page, *selectors, timeout=3000):
    scope = dialog_scope(page)
    for sel in selectors:
        try:
            loc = scope.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click(timeout=timeout)
                time.sleep(1.2)
                return True
        except Exception:
            pass
    return False


def _hit_tests(cand) -> bool:
    """True if `cand`'s own center point actually resolves (via
    elementFromPoint) to `cand` itself or one of its ancestors/descendants
    — i.e. a real click at that point would land on this element, not on
    some other element stacked on top of/behind it at the same screen
    position. X repeatedly renders more than one element with identical
    text at different DOM depths (a live, front-most one plus a stale one
    left over from an earlier screen) with no reliable rule for which is
    first vs last in the DOM — dialog-scoping and DOM-order heuristics
    were both tried live (2026-08-29, 0daynews.com) and both silently
    matched the wrong one on different screens. A hit-test is the only
    check that mirrors what a real click actually does."""
    try:
        box = cand.bounding_box()
        if not box or box["width"] <= 0 or box["height"] <= 0:
            return False
        cx = box["x"] + box["width"] / 2
        cy = box["y"] + box["height"] / 2
        return bool(cand.evaluate(
            """(el, pt) => {
                const top = document.elementFromPoint(pt.x, pt.y);
                if (!top) return false;
                return top === el || el.contains(top) || top.contains(el);
            }""",
            {"x": cx, "y": cy},
        ))
    except Exception:
        return False


def click_text(page, *texts, timeout=3000):
    """X's button labels aren't reliably matched by CSS :has-text() — the
    visible text is often split across nested spans, so a single-element
    :has-text() locator silently matches 0 elements. get_by_text does
    substring matching against rendered text regardless of DOM split — use
    this for every X-rendered button/label, reserve CSS selectors for real
    form inputs (input[name=...] etc).

    Filters candidates to visible + enabled + hit-test-passing (see
    `_hit_tests`) before clicking — this replaced both an earlier
    role=dialog scope AND a "click the last DOM match" heuristic, neither
    of which held up across screens (confirmed live 2026-08-29,
    0daynews.com: the real button was inside the last dialog on one
    screen and outside every dialog on the next). Always prints a STATUS
    line with what it found so a stuck run's log shows why, instead of a
    silent 0-effect click. Tries an EXACT match first, falling back to
    substring — substring-only is ambiguous ("Continue" also
    substring-matches "Continue with phone"/"Continue with Google").
    """
    for text in texts:
        for exact in (True, False):
            try:
                loc = page.get_by_text(text, exact=exact)
                n = loc.count()
                visible_enabled = []
                for i in range(n):
                    cand = loc.nth(i)
                    if not cand.is_visible():
                        continue
                    try:
                        if not cand.is_enabled():
                            continue
                    except Exception:
                        pass  # not all elements support is_enabled(); allow through
                    visible_enabled.append(cand)
                hit = [c for c in visible_enabled if _hit_tests(c)]
                chosen = hit[0] if hit else (visible_enabled[-1] if visible_enabled else None)
                if chosen is not None:
                    print(
                        f"STATUS click_text({text!r}, exact={exact}): "
                        f"{n} matched, {len(visible_enabled)} visible+enabled, "
                        f"{len(hit)} hit-tested — clicking",
                        flush=True,
                    )
                    chosen.click(timeout=timeout)
                    time.sleep(1.2)
                    return True
            except Exception as e:
                print(f"STATUS click_text({text!r}) attempt failed: {e}", flush=True)
    return False


def wait_for_captcha_clear(page, gate_label):
    if not captcha_present(page):
        return
    print(f"STATUS captcha present ({gate_label}) — need Jesse", flush=True)
    resume_deadline = time.time() + 10 * 60
    while time.time() < resume_deadline:
        time.sleep(10)
        scope = dialog_scope(page)
        next_btn = scope.get_by_text("Next", exact=False)
        btn_enabled = False
        if next_btn.count() > 0:
            try:
                btn_enabled = next_btn.first.is_enabled()
            except Exception:
                pass
        if not captcha_present(page) or btn_enabled:
            print("STATUS captcha cleared, resuming", flush=True)
            return
    print(f"STATUS captcha never cleared ({gate_label}) — giving up this pass", flush=True)


def fill_birthday_screen(page, deadline_s=20):
    """Standalone 'When's your birthday?' screen — comes after code verify,
    not before like the rest of the fleet's platforms. Defaults to today's
    date if left alone, so always set it explicitly."""
    scope = dialog_scope(page)
    deadline = time.time() + deadline_s
    selects = scope.locator("select")
    while selects.count() < 3 and time.time() < deadline:
        time.sleep(1)
        selects = scope.locator("select")
    if selects.count() < 3:
        return False
    try:
        selects.nth(0).select_option(label="January")
        selects.nth(1).select_option("1")
        selects.nth(2).select_option("1992")
    except Exception as e:
        print(f"dob select note: {e}", flush=True)
        return False
    time.sleep(0.5)
    return True


def fill_name_username_password_screen(page, deadline_s=20) -> str:
    """Combined single screen with all three fields. Returns the username
    actually accepted (X shows an inline 'unavailable' hint per-keystroke;
    retries with a random numeric suffix on that hint, same convention as
    Bluesky's handle-taken retry)."""
    scope = dialog_scope(page)
    deadline = time.time() + deadline_s
    name_input = scope.locator('input[name="name"], input[autocomplete="name"]')
    while name_input.count() == 0 and time.time() < deadline:
        time.sleep(1)
        name_input = scope.locator('input[name="name"], input[autocomplete="name"]')
    if name_input.count() == 0:
        return ""

    name_input.first.fill(DISPLAY_NAME)

    username_input = scope.locator(
        'input[name="username"], input[autocomplete="username"]'
    )
    candidate = HANDLE_BASE
    if username_input.count():
        for attempt in range(4):
            username_input.first.fill(candidate)
            time.sleep(1.5)
            taken = scope.get_by_text("unavailable", exact=False)
            if taken.count() > 0 and taken.first.is_visible():
                candidate = f"{HANDLE_BASE}{random.randint(10, 99)}"
                continue
            break

    pw_input = scope.locator('input[name="password"], input[type="password"]')
    if pw_input.count():
        pw_input.first.fill(PASSWORD)

    return candidate


print(f"Generated password: {PASSWORD}", flush=True)

# --- rent the number BEFORE opening the browser, so we're not racing
# SMSPool's ~20min expiry window against browser/DOM flakiness ---
order = smspool_order("twitter")
order_id = order.get("order_id") or order.get("orderid")
phone_local = order.get("phonenumber") or str(order.get("number"))
print(f"STATUS rented {phone_local} (order {order_id}) from SMSPool", flush=True)

# Routed through the fleet's VPN proxy (tools/vpn-proxy) — 2026-08-29,
# after 9 straight identical "Something went wrong" rejections from X's
# phone-verify step on the FIXED US EXIT (8181), reproduced across a VPN
# pop switch AND a fresh CloakBrowser profile. See
# [[reference_vpn_rotating_proxy]]. Switched to the random-global exit
# (8183) 2026-08-30 per Jesse — different ASN than 8181 (GSL Networks vs
# Cogent), may dodge whatever datacenter-fingerprint block X is applying.
# NOTE: the random exit rotates PIA regions every 15min and landed in an
# EU-ish region once before, serving a GDPR cookie-consent flow this
# script isn't built for — verify the exit is US before a long run
# (`curl -x http://127.0.0.1:8183 https://ipinfo.io/json`), and if a run
# starts failing on an unexpected consent banner, that's likely why.
context, page = launch_browser(PROFILE_KEY, "x", proxy="http://127.0.0.1:8183")
success = False
claimed_username = ""
try:
    page.goto("https://x.com/i/flow/signup", wait_until="domcontentloaded", timeout=30000)
    time.sleep(4)
    # A GDPR-style cookie banner shows up on some (EU-ish) exits and sits
    # underneath the signup dialog — dismiss it defensively before doing
    # anything else. Privacy-preserving default per house policy: decline
    # non-essential rather than accept-all.
    click_text(page, "Refuse non-essential cookies", "Decline optional cookies", "Reject non-essential")
    shot(page, "01-landing.png")

    # /i/flow/signup lands on a combined login/signup chooser ("See what's
    # happening — Select an option below: Continue with phone / Google /
    # Apple / email-or-username"). "Continue with phone" itself starts the
    # create-account path — there's no separate "Create account" link.
    phone_deadline = time.time() + 20
    phone_input = page.locator('input[type="tel"]')
    while phone_input.count() == 0 and time.time() < phone_deadline:
        click_text(page, "Continue with phone")
        time.sleep(1)
        phone_input = page.locator('input[type="tel"]')
    shot(page, "01b-after-continue-with-phone.png")

    def phone_value_ok() -> bool:
        """The masked phone input has been seen losing a digit mid-flow
        (2026-08-29, 0daynews.com — "2297144885" became "229744885" after
        a click/hover nearby, tripping X's own "Please enter a valid
        value" check and permanently disabling Continue). Compare digits
        only since the field is visually space-formatted."""
        try:
            val = phone_input.first.input_value(timeout=3000)
        except Exception:
            return False
        return "".join(ch for ch in val if ch.isdigit()) == phone_local

    # This screen is phone-only — no name field, no DOB selects (confirmed
    # live; those come on later, separate screens).
    if phone_input.count():
        phone_input.first.fill(phone_local)
        if not phone_value_ok():
            print("STATUS phone field misfilled, re-filling", flush=True)
            phone_input.first.fill("")
            phone_input.first.fill(phone_local)
    else:
        email_input = page.locator('input[name="email"], input[type="email"]')
        if email_input.count():
            email_input.first.fill(EMAIL)

    shot(page, "02-step1-filled.png")
    wait_for_captcha_clear(page, "step1")
    # The phone input staying on-screen after a click does NOT mean the
    # click didn't land — confirmed live (2026-08-29, 0daynews.com) that a
    # real submit can go through and X re-renders the SAME phone form with
    # a "Something went wrong, please try again!" banner. A tight retry
    # loop keyed only on "input still present" can't tell that apart from
    # a genuinely no-op click, and re-firing Continue every ~1.5s just
    # resubmits the still-pending/just-failed request repeatedly — that
    # resubmission storm is what produced the error in the first place.
    # Cap attempts, pace them out, and log the error banner explicitly so
    # a real X-side rejection is visible in the log rather than looking
    # like a stuck click. Also re-verify (and repair) the field value each
    # pass, per the digit-loss bug above.
    #
    # Also confirmed live (same session) that a hit-tested, "successful"
    # click on this specific button can STILL be a total no-op — 4
    # consecutive clicks reported success (right hit-test target, right
    # element) with the page never advancing at all, no error banner
    # either. CloakBrowser's humanized click on this control isn't
    # reliably registering as a trusted interaction. Press Enter in the
    # phone field first (a real key event, not a synthesized click) and
    # only fall back to click_text if that doesn't move things along.
    error_banner = page.get_by_text("Something went wrong", exact=False)
    for attempt in range(3):
        if phone_input.count() == 0:
            break
        if not phone_value_ok():
            print("STATUS phone field misfilled before retry, re-filling", flush=True)
            phone_input.first.fill("")
            phone_input.first.fill(phone_local)
            time.sleep(1)
        if attempt == 0:
            try:
                phone_input.first.press("Enter", timeout=3000)
                print("STATUS pressed Enter in phone field", flush=True)
            except Exception as e:
                print(f"STATUS Enter press failed: {e}", flush=True)
        else:
            click_text(page, "Continue", "Next")
        time.sleep(3)
        phone_input = page.locator('input[type="tel"]')
        if phone_input.count() > 0 and error_banner.count() > 0 and error_banner.first.is_visible():
            print(f"STATUS phone-continue error banner seen (attempt {attempt + 1}/3), pausing before retry", flush=True)
            time.sleep(5)
    # X sometimes shows a "confirm your info" review screen before sending
    # the code — one more Next/Continue if so.
    click_text(page, "Sign up", "Continue", "Next")
    time.sleep(3)
    shot(page, "03-post-step1.png")

    # Step 2: SMS verification code. Only trust this if the page actually
    # shows verification copy first — a bare input[type="text"] fallback
    # matched the login screen's "Email or username" field once and burned
    # a 10min SMS-poll wait on a dead field.
    scope = dialog_scope(page)
    code_input = scope.locator('input[name="verfication_code"], input[name="verification_code"]')
    deadline = time.time() + 20
    while code_input.count() == 0 and time.time() < deadline:
        time.sleep(1)
        scope = dialog_scope(page)
        code_input = scope.locator('input[name="verfication_code"], input[name="verification_code"]')
    if code_input.count() == 0:
        try:
            if scope.get_by_text("code", exact=False).count() > 0:
                code_input = scope.locator('input[type="text"]').first
        except Exception:
            pass

    if code_input.count():
        code = smspool_wait_for_code(order_id, timeout=600)
        if not code:
            cancel = smspool_cancel(order_id)
            print(f"STATUS no SMS code arrived — cancelled order: {cancel}", flush=True)
            raise SystemExit(1)
        code_input.first.fill(code)
        print("STATUS verification code entered", flush=True)
        shot(page, "04-code-filled.png")
        click_text(page, "Next")
        time.sleep(3)
    else:
        print("STATUS no verification-code field found — flow may differ, check screenshot", flush=True)

    shot(page, "05-post-verify.png")

    # Step 3: standalone birthday screen.
    if fill_birthday_screen(page):
        shot(page, "06-birthday-filled.png")
        wait_for_captcha_clear(page, "birthday")
        click_text(page, "Continue", "Next")
        time.sleep(2)
    else:
        print("STATUS birthday screen not found/filled — check screenshot", flush=True)
    shot(page, "07-post-birthday.png")

    # Step 4: combined name + username + password screen.
    claimed_username = fill_name_username_password_screen(page)
    if claimed_username:
        print(f"STATUS name/username/password filled, username={claimed_username}", flush=True)
        shot(page, "08-name-user-pass-filled.png")
        wait_for_captcha_clear(page, "name-user-pass")
        click_text(page, "Sign up", "Next", "Continue")
        time.sleep(3)
    else:
        print("STATUS name/username/password screen not found — check screenshot", flush=True)
    shot(page, "09-post-signup-submit.png")

    # Drive whatever's left of onboarding (topic packs/interests/skip) for
    # up to 2min. The account is fully created well before this settles —
    # don't gate `success` on reaching the home timeline specifically.
    deadline = time.time() + 2 * 60
    while time.time() < deadline:
        wait_for_captcha_clear(page, "onboarding")
        if page.locator('a[data-testid="AppTabBar_Home_Link"]').count() > 0:
            print("STATUS reached home timeline", flush=True)
            success = True
            break
        progressed = click_text(page, "Skip for now", "Not now", "Maybe later", "Next", "Continue")
        if not progressed:
            time.sleep(3)

    shot(page, "10-final.png")
    print(f"STATUS final url={page.url}", flush=True)
except Exception as e:
    print(f"STATUS exception during flow: {e}", flush=True)

# The account is considered created once we made it through the
# name/username/password submit, regardless of whether the onboarding
# wizard's "reached home timeline" check fired — that check is a nice-to-
# have confirmation, not the actual create-account signal.
if claimed_username:
    success = True

# X may still have swapped in a random suffix if our chosen username lost a
# same-millisecond race, or the field never got read back correctly here —
# always re-verify against the settings page rather than trusting the form
# value, same "verify before vault-write" discipline as every other
# platform's script.
actual_handle = ""
try:
    settings_deadline = time.time() + 20
    while time.time() < settings_deadline:
        page.goto("https://x.com/settings/screen_name", wait_until="domcontentloaded", timeout=20000)
        time.sleep(3)
        handle_field = page.locator('input[name="screen_name"]')
        if handle_field.count():
            try:
                val = handle_field.first.input_value(timeout=5000)
            except Exception:
                val = ""
            if val:
                actual_handle = val
                break
        time.sleep(2)
    shot(page, "11-username-settings.png")

    if claimed_username and actual_handle and actual_handle.lower() != claimed_username.lower():
        # Try to claim the intended handle explicitly now that we're on
        # the settings page directly (belt-and-suspenders — the signup
        # screen's own username field should have already claimed it).
        handle_field = page.locator('input[name="screen_name"]')
        if handle_field.count():
            candidate = claimed_username
            for attempt in range(3):
                handle_field.first.fill(candidate)
                time.sleep(1.5)
                taken = page.get_by_text("already taken")
                unavailable = page.get_by_text("unavailable", exact=False)
                if (taken.count() > 0 and taken.first.is_visible()) or (
                    unavailable.count() > 0 and unavailable.first.is_visible()
                ):
                    candidate = f"{claimed_username}{random.randint(10, 99)}"
                    continue
                break
            click_text(page, "Save")
            time.sleep(3)
            page.goto("https://x.com/settings/screen_name", wait_until="domcontentloaded", timeout=20000)
            time.sleep(3)
            handle_field = page.locator('input[name="screen_name"]')
            if handle_field.count():
                try:
                    reread = handle_field.first.input_value(timeout=5000)
                    if reread:
                        actual_handle = reread
                except Exception:
                    pass
except Exception as e:
    print(f"handle-claim note: {e}", flush=True)

# Fall back to the profile page's own display of the handle if the settings
# input never read back cleanly, rather than declaring failure on an
# account we know (from claimed_username) was actually created.
if not actual_handle:
    try:
        page.goto("https://x.com/home", wait_until="domcontentloaded", timeout=20000)
        time.sleep(3)
        acct_link = page.locator('[data-testid="SideNav_AccountSwitcher_Button"]')
        if acct_link.count():
            txt = acct_link.first.inner_text(timeout=5000)
            m = re.search(r"@(\w+)", txt)
            if m:
                actual_handle = m.group(1)
    except Exception as e:
        print(f"profile-fallback note: {e}", flush=True)

if not actual_handle:
    actual_handle = claimed_username

print(f"HANDLE_FOUND:{actual_handle}", flush=True)
context.close()

if success and actual_handle:
    write_creds(VAULT_KEY, "x", {
        "X_HANDLE": actual_handle,
        "X_PASSWORD": PASSWORD,
        "X_EMAIL": EMAIL,
        "X_PHONE": phone_local,
    })
    print(f"STATUS creds written to vault, handle={actual_handle}", flush=True)
else:
    print("STATUS SIGNUP DID NOT SUCCEED — no creds written, needs retry/recovery", flush=True)

print("STATUS done", flush=True)
