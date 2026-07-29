"""
Shared CloakBrowser helpers for Amazon Creator Connections — campaign pull +
content-link submission. One library, used by every domain site's
ops/campaigns/ scripts instead of copy-pasting a fresh CloakBrowser driver
per site.

Requires: cloakbrowser (pip) + social_lib (tools/social-lib, importable via
pip install -e on the host, or via sys.path fallback below in a container
where only tools/ is bind-mounted read-only, e.g. at .monorepo-tools/).
"""
import glob
import json
import os
import subprocess
import time
from pathlib import Path

CREATOR_ID = "amzn1.creator.7b4fea2c-d009-4d2f-86d4-f583a6aa4fd1"  # Synaptic Workshop
PROFILE = "/tmp/cloak-driver/profile"
SCREENSHOTS = os.environ.get("CLOAK_SCREENSHOTS_DIR", "/home/jesse/projects/domains/.cloak-screenshots")

# Resolved relative to this file's own location, NOT a hardcoded host path —
# this file lives at tools/creator-connections/cc_lib.py, so parents[1] is
# tools/. That's correct whether "tools/" is the real domains/tools directory
# (host) or a read-only bind mount of it at .monorepo-tools/ inside a
# container (same relative shape either way). Previously hardcoded to
# tools/social-setup/src (wrong package entirely — social_lib actually lives
# in tools/social-lib/src) which was a silent no-op on the host only because
# social_lib was ALSO a real pip-installed package there.
_SOCIAL_LIB_SRC = str(Path(__file__).resolve().parents[1] / "social-lib" / "src")


def _ensure_import_path():
    import sys
    if _SOCIAL_LIB_SRC not in sys.path:
        sys.path.insert(0, _SOCIAL_LIB_SRC)


def list_url(creator_id=CREATOR_ID, status="active", type_="affiliate-plus", keyword=""):
    # Omitting &status entirely (not status=) is what selects the "New
    # Opportunities" tab — that's the URL's default state, there is no
    # explicit status value for it.
    status_param = f"&status={status}" if status else ""
    return (
        "https://affiliate-program.amazon.com/p/connect/requests"
        f"?creatorId={creator_id}{status_param}&type={type_}&sortBy=alphabetical&keyword={keyword}"
    )


def detail_url(ad_id, campaign_id, creator_id=CREATOR_ID):
    return (
        "https://affiliate-program.amazon.com/p/connect/request"
        f"?creatorId={creator_id}&adId=amzn1.campaign.{ad_id}&campaignId=amzn1.campaign.{campaign_id}"
    )


def cleanup_stale_profile(profile=PROFILE):
    """Kill any leftover Chromium process bound to this profile and remove
    its Singleton lock files. CloakBrowser launches get flaky after heavy
    churn in one session (many launch/close cycles) — a stale process or
    lock file left behind by an interrupted run makes the NEXT launch hang
    or fail silently with no useful error. Safe to call unconditionally
    before every launch, not just reactively after a failure — matches the
    submission-flakiness gotcha in the domains-amazon-creator-connections
    skill, now applied proactively instead of only after something breaks."""
    try:
        subprocess.run(
            ["pkill", "-9", "-f", f"user-data-dir={profile}"],
            check=False,
            capture_output=True,
        )
    except Exception:
        pass
    time.sleep(0.5)
    for lock in glob.glob(f"{profile}/Singleton*"):
        try:
            Path(lock).unlink()
        except Exception:
            pass


def launch(profile=PROFILE, viewport=None, headless=False, retries=1):
    """Launch a VPN-routed, persistent-profile CloakBrowser context. Reuses
    the existing tab if one is open (login usually already in place).
    Cleans up any stale profile lock before launching, and retries once
    (with another cleanup pass) if the launch itself throws — this is what
    a run getting silently killed mid-session with no diagnostic output
    turned out to need."""
    _ensure_import_path()
    from cloakbrowser import launch_persistent_context
    from social_lib.vpn_session import get_proxy_url

    cleanup_stale_profile(profile)
    proxy_url = get_proxy_url("us")

    attempt = 0
    while True:
        try:
            ctx = launch_persistent_context(
                profile,
                headless=headless,
                humanize=True,
                viewport=viewport or {"width": 1200, "height": 900},
                proxy={"server": proxy_url},
            )
            page = ctx.pages[-1] if ctx.pages else ctx.new_page()
            return ctx, page
        except Exception:
            if attempt >= retries:
                raise
            attempt += 1
            cleanup_stale_profile(profile)
            time.sleep(2)


def handle_login_if_needed(page, list_page_url, wait_rounds=60, wait_secs=5):
    """After loading a page, check for the sign-in redirect and pause for a
    human to log in in the visible window. Returns once past sign-in."""
    if "signin" in page.url.lower() or "/ap/" in page.url:
        print("LOGIN_NEEDED — log in as Jesse Tamburino in the visible window; waiting...")
        for _ in range(wait_rounds):
            time.sleep(wait_secs)
            if "signin" not in page.url.lower() and "/ap/" not in page.url:
                break
        page.goto(list_page_url, wait_until="domcontentloaded", timeout=70000)
        time.sleep(5)


def extract_campaign_cards(page):
    """Extract {txt, img, href, cid} for every campaign card CURRENTLY
    RENDERED on a Creator Connections list page. The list is
    react-virtualized (`.ReactVirtualized__Grid__RequestList`) — only rows
    scrolled into view exist in the DOM, so a single call to this only sees
    a window of the real total. For the full list, use
    extract_all_campaign_cards() instead, which scrolls the virtualized
    container to harvest every row."""
    return page.evaluate(
        r"""
        () => {
          const out = [];
          [...document.querySelectorAll('a')]
            .filter(a => /View details/i.test(a.textContent))
            .forEach(a => {
              let c = a;
              for (let i = 0; i < 6; i++) {
                if (c.parentElement) c = c.parentElement;
                if (c.querySelector && c.querySelector('img[src*="/images/I/"]')) break;
              }
              const img = c.querySelector('img[src*="/images/I/"]');
              const m = a.href.match(/campaignId=amzn1\.campaign\.([^&]+)/);
              const adM = a.href.match(/adId=amzn1\.campaign\.([^&]+)/);
              out.push({
                txt: c.innerText,
                img: img && img.src,
                href: a.href,
                cid: m && m[1],
                adId: adM && adM[1],
              });
            });
          return out;
        }
        """
    )


def extract_all_campaign_cards(page, max_scrolls=150, step=450, settle=0.6, stall_limit=3):
    """Scroll the virtualized campaign-list container end to end, harvesting
    every unique campaign card by cid. Plain page/window scrolling (or a
    fixed-height `mouse.wheel`) does NOT reach rows outside the virtualization
    window — this was a real gap found the hard way: a page that reported
    "End of list" right after 30 rendered cards actually had 65+ campaigns
    once the inner grid was scrolled properly."""
    all_cards = {}

    def harvest():
        new = 0
        for c in extract_campaign_cards(page):
            if c["cid"] and c["cid"] not in all_cards:
                all_cards[c["cid"]] = c
                new += 1
        return new

    harvest()
    stall = 0
    for _ in range(max_scrolls):
        scrolled = page.evaluate(
            """
            (step) => {
              const el = document.querySelector('.ReactVirtualized__Grid__RequestList');
              if (!el) return null;
              el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
              return {after: el.scrollTop, max: el.scrollHeight - el.clientHeight};
            }
            """,
            step,
        )
        time.sleep(settle)
        if harvest():
            stall = 0
        else:
            stall += 1
        if scrolled is None:
            break  # no virtualized container on this page (e.g. empty list) — plain harvest stands
        if scrolled["after"] >= scrolled["max"] - 2 and stall >= stall_limit:
            break

    return list(all_cards.values())


def open_detail_resilient(page, ad_id, campaign_id, creator_id=CREATOR_ID, attempts=3):
    """Deep-linking cold into a campaign detail page can leave the SPA
    unhydrated (near-empty body). Retry with a longer settle each time."""
    url = detail_url(ad_id, campaign_id, creator_id)
    body = ""
    for attempt in range(attempts):
        page.goto(url, wait_until="domcontentloaded", timeout=70000)
        time.sleep(6 + attempt * 3)
        body = page.inner_text("body")
        if len(body) > 200:
            return body
    return body


def pull_product_page_info(page, dp_link):
    """Visit a /dp/<ASIN> product page and pull title/price/rating/reviewCount/image."""
    page.goto(dp_link, wait_until="domcontentloaded", timeout=30000)
    time.sleep(3)
    return page.evaluate(
        """
        () => {
          const title = document.getElementById('productTitle')?.innerText?.trim() || null;
          const priceWhole = document.querySelector('.a-price .a-price-whole')?.innerText;
          const priceFrac = document.querySelector('.a-price .a-price-fraction')?.innerText;
          const price = priceWhole ? `$${priceWhole}${priceFrac || ''}`.replace(/\\.$/, '') : null;
          const ratingEl = document.querySelector('#acrPopover, [data-hook="rating-out-of-text"], .a-icon-alt');
          const rating = ratingEl ? (ratingEl.getAttribute('title') || ratingEl.textContent) : null;
          const countEl = document.getElementById('acrCustomerReviewText');
          const reviewCount = countEl ? countEl.innerText : null;
          const img = document.getElementById('landingImage')?.src || null;
          return {title, price, rating, reviewCount, img};
        }
        """
    )


def is_maintenance_or_empty(body):
    return (
        "Temporarily Unavailable" in body
        or "currently unavailable" in body
        or len(body) < 200
    )


# ---- Content-link submission ----------------------------------------------

def dropdown_is_open(page):
    return page.evaluate("() => document.querySelectorAll('[role=option]').length") > 0


def open_content_type_dropdown(page, timeout=12000):
    """Open the 'Select a content type' combobox. Some campaign pages
    (observed on a 48-variation evergreen campaign) don't respond to a
    humanized pointer click — fall back to a raw JS .click() on the button,
    which reliably opens it."""
    try:
        page.get_by_role("button", name="Select a content type").first.click(timeout=timeout)
    except Exception:
        pass
    time.sleep(1.5)
    if dropdown_is_open(page):
        return True

    page.evaluate(
        """
        () => {
          const btn = [...document.querySelectorAll('button')]
            .find(b => b.textContent.trim().includes('Select a content type'));
          if (btn) btn.click();
        }
        """
    )
    time.sleep(1.5)
    return dropdown_is_open(page)


def select_content_type_option(page, label="Article or blog post", timeout=8000):
    try:
        page.get_by_role("option", name=label).first.click(timeout=timeout)
        return True
    except Exception:
        pass
    try:
        page.get_by_text(label, exact=True).first.click(timeout=timeout)
        return True
    except Exception:
        pass
    return page.evaluate(
        """
        (labelText) => {
          const opts = [...document.querySelectorAll('[role=option], li, .a-dropdown-item')];
          const opt = opts.find(o => o.textContent.trim() === labelText);
          if (!opt) return false;
          opt.click();
          return true;
        }
        """,
        label,
    )


def set_content_type(page, label="Article or blog post"):
    for _ in range(10):
        if page.query_selector("#contentInput"):
            break
        time.sleep(2)
    if not open_content_type_dropdown(page):
        raise RuntimeError("content-type dropdown never opened")
    if not select_content_type_option(page, label):
        raise RuntimeError(f"could not select content-type option {label!r}")


def submit_content_link(page, content_url, content_type="Article or blog post", screenshot_path=None):
    """Fill + submit the content-link form on an already-open campaign detail
    page. Returns True if the link is confirmed stored (appears with a
    Delete control)."""
    set_content_type(page, content_type)
    time.sleep(1)
    page.fill("#contentInput", content_url)
    time.sleep(1)
    page.get_by_text("Submit", exact=True).first.click(timeout=10000)
    time.sleep(4)
    if screenshot_path:
        page.screenshot(path=screenshot_path)
    body = page.inner_text("body")
    return content_url in body and "Delete" in body


def link_already_stored(body, content_url):
    return content_url in body and "Delete" in body


# ---- Manifest I/O -----------------------------------------------------------

def load_manifest(path):
    return json.loads(Path(path).read_text())


def save_manifest(path, data):
    Path(path).write_text(json.dumps(data, indent=2) + "\n")


def dump_json(path, data):
    """Always write large payloads to a file before printing anything about
    them — printing big JSON through a piped command (e.g. `| tail`) can hit
    BlockingIOError and lose the data with nothing recoverable."""
    Path(path).write_text(json.dumps(data, indent=2))
