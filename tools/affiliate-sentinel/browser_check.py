"""Browser-based ASIN liveness fallback for when the Creators API itself is
unavailable (see `project_amazon_creators_api_403_2026-09-01` memory: this
403 flaps for the whole fleet's shared credentials and is expected to,
indefinitely — not a bug to chase).

`amz.confirm_dead` already has an API-free liveness signal (a raw `httpx.get`
against the product page), but it only ever runs on ASINs the API already
reported SUSPECT_MISSING. When the API is down entirely, no ASIN reaches
that state — `sentinel.py` resets `health` to `{}` and moves on. For a site
whose only other check is a `/go/` cloak, that is fine: the cloak check still
runs. For a site with no cloak at all (amputeenews links straight to Amazon
by design), an API outage then means the sentinel verifies literally nothing
and reports the site UNMONITORED, even though the products underneath are
almost certainly fine.

This closes that gap with the same signal `amz.confirm_dead` uses (a real
product page renders vs. a soft-404), but through a real rendered browser
context via `cc_lib` instead of a bare HTTP client — the same substitution
`heal.py` already makes for rating/review scraping, because a raw fetch is
far more likely to hit Amazon's bot wall than a real browser. It is
deliberately the fallback of the fallback: reached only when there is no API
signal left to confirm at all.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Must NOT be cc_lib's default profile dir: launch() pkill -9's anything bound
# to the profile it is opening, so sharing one would let this fallback kill
# another tool's browser mid-flight. Same profile heal.py uses — this and a
# heal never run concurrently within one sentinel invocation.
_SENTINEL_PROFILE = "/tmp/cloak-driver/sentinel-profile"

_DEAD_RE = re.compile(
    r"Sorry[!,]? [Ww]e couldn.t find that page|Page Not Found|Looking for something\?",
)
_BOTWALL_RE = re.compile(r"captcha|enter the characters you see", re.I)


def _cc_lib():
    for p in (
        Path(__file__).resolve().parents[1] / "creator-connections",
        Path("/work/.monorepo-tools/creator-connections"),
    ):
        if p.is_dir() and str(p) not in sys.path:
            sys.path.insert(0, str(p))
    try:
        import cc_lib  # noqa: F401
    except ImportError:
        return None
    return cc_lib


def check_alive(asin: str, log=lambda *_: None) -> bool | None:
    """Render `/dp/<asin>` and classify it.

    Returns True (product page rendered, alive), False (soft-404 markers
    present, confirmed dead), or None (bot wall, timeout, or a page shape we
    don't recognise — inconclusive, never acted on).
    """
    cc_lib = _cc_lib()
    if cc_lib is None:
        log("browser-check: cc_lib unavailable — cannot fall back")
        return None

    ctx = None
    try:
        # launch() returns (ctx, page) — not a single context.
        ctx, page = cc_lib.launch(profile=_SENTINEL_PROFILE, headless=True)
        page.goto(f"https://www.amazon.com/dp/{asin}", timeout=45000)
        has_title = page.evaluate("() => !!document.querySelector('#productTitle')")
        body_text = page.evaluate(
            "() => document.body ? document.body.innerText.slice(0, 2000) : ''"
        )
    except Exception as exc:
        log(f"browser-check: {asin} failed ({type(exc).__name__}) — inconclusive")
        return None
    finally:
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass

    if has_title:
        return True
    text = body_text or ""
    if _DEAD_RE.search(text):
        return False
    if _BOTWALL_RE.search(text):
        log(f"browser-check: {asin} hit a bot wall — inconclusive")
        return None
    log(f"browser-check: {asin} unrecognized page shape — inconclusive")
    return None
