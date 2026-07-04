"""
Shared CloakBrowser helpers for Amazon Creator Connections — campaign pull +
content-link submission. One library, used by every domain site's
ops/campaigns/ scripts instead of copy-pasting a fresh CloakBrowser driver
per site.

Requires: cloakbrowser + social_lib (tools/social-setup/src on sys.path).
"""
import json
import time
from pathlib import Path

CREATOR_ID = "amzn1.creator.7b4fea2c-d009-4d2f-86d4-f583a6aa4fd1"  # Synaptic Workshop
PROFILE = "/tmp/cloak-driver/profile"
SCREENSHOTS = "/home/jesse/projects/domains/.cloak-screenshots"

_SOCIAL_SETUP_SRC = "/home/jesse/projects/domains/tools/social-setup/src"


def _ensure_import_path():
    import sys
    if _SOCIAL_SETUP_SRC not in sys.path:
        sys.path.insert(0, _SOCIAL_SETUP_SRC)


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


def launch(profile=PROFILE, viewport=None, headless=False):
    """Launch a VPN-routed, persistent-profile CloakBrowser context. Reuses
    the existing tab if one is open (login usually already in place)."""
    _ensure_import_path()
    from cloakbrowser import launch_persistent_context
    from social_lib.vpn_session import get_proxy_url

    proxy_url = get_proxy_url("us")
    ctx = launch_persistent_context(
        profile,
        headless=headless,
        humanize=True,
        viewport=viewport or {"width": 1200, "height": 900},
        proxy={"server": proxy_url},
    )
    page = ctx.pages[-1] if ctx.pages else ctx.new_page()
    return ctx, page


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
    """Extract {txt, img, href, cid} for every campaign card on a Creator
    Connections list page (Active / New Opportunities / Completed)."""
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
