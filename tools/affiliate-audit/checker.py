"""CloakBrowser-driven per-product landed-page check. Reuses cc_lib.launch()
from tools/creator-connections rather than a second browser driver."""
import random
import sys
import time
from pathlib import Path

_CC_LIB_DIR = Path(__file__).resolve().parents[1] / "creator-connections"

# recheck_product() must NEVER share the main sweep's default cc_lib.PROFILE
# directory: cc_lib.launch() unconditionally pkill -9's any process bound to
# its profile's user-data-dir before launching, to clear stale locks. Two
# browsers on the same profile means a mid-sweep recheck kills the main
# sweep's still-open browser out from under it, which later crashes run.py's
# final ctx.close() with playwright._impl._errors.TargetClosedError. A
# distinct profile dir makes that pkill target unreachable from a recheck.
RECHECK_PROFILE = "/tmp/cloak-driver/recheck-profile"


def _ensure_cc_lib_on_path():
    p = str(_CC_LIB_DIR)
    if p not in sys.path:
        sys.path.insert(0, p)


def launch_browser(profile=None):
    """Thin re-export so run.py only imports from checker, not cc_lib directly.

    profile: optional override passed through to cc_lib.launch(). Left
    unset, cc_lib.launch() uses its own default (the main sweep's shared
    profile) — this preserves existing behavior for run.py's call site.
    """
    _ensure_cc_lib_on_path()
    import cc_lib

    if profile is not None:
        return cc_lib.launch(profile=profile)
    return cc_lib.launch()


_RATING_JS = """
() => {
  const el = document.querySelector('#acrPopover, [data-hook="rating-out-of-text"], .a-icon-alt');
  if (!el) return null;
  const text = el.getAttribute('title') || el.textContent || '';
  const m = text.match(/([\\d.]+)\\s*out of/i);
  return m ? parseFloat(m[1]) : null;
}
"""

_PRIME_JS = """
() => !!document.querySelector('#primeBadge, .a-icon-prime, [aria-label*="Prime" i]')
"""

# Amazon hydrates product pages client-side after domcontentloaded; reading the
# DOM immediately can catch it mid-hydration and misclassify a healthy page as
# OOS/broken. Mirrors the proven cc_lib.pull_product_page_info() settle delay.
SETTLE_DELAY_S = 3


def check_product(page, base_url: str, product: dict, pacing_cfg: dict) -> dict:
    go_url = f"{base_url.rstrip('/')}/go/{product['id']}/"
    evidence = {
        "id": product["id"],
        "go_url": go_url,
        "landed_url": None,
        "redirect_ok": True,
        "body": "",
        "prime": None,
        "rating": None,
        "checked_at": None,
    }
    try:
        page.goto(go_url, wait_until="domcontentloaded", timeout=30000)
    except Exception:
        evidence["redirect_ok"] = False
        return evidence

    time.sleep(SETTLE_DELAY_S)

    evidence["landed_url"] = page.url
    evidence["body"] = page.inner_text("body")
    evidence["rating"] = page.evaluate(_RATING_JS)
    evidence["prime"] = page.evaluate(_PRIME_JS)
    return evidence


def pace(pacing_cfg: dict) -> None:
    lo = pacing_cfg.get("min_delay_s", 12)
    hi = pacing_cfg.get("max_delay_s", 25)
    time.sleep(random.uniform(lo, hi))


def recheck_product(product: dict, base_url: str, pacing_cfg: dict) -> dict:
    """One-shot re-verification in a brand-new browser context. Used when a
    product's first-pass verdict was flagged, to rule out a session-level
    false positive (e.g. Amazon serving a degraded response deep into a long
    sweep) before trusting the result. Always closes its own context, even
    on failure inside check_product. Uses a dedicated RECHECK_PROFILE so its
    launch-time pkill cleanup can never kill the main sweep's browser."""
    ctx, page = launch_browser(profile=RECHECK_PROFILE)
    try:
        return check_product(page, base_url, product, pacing_cfg)
    finally:
        ctx.close()
