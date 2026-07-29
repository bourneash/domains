"""Deterministic verdict for one product's checked evidence. Pure function —
no I/O, no browser — so it's cheap to unit test exhaustively."""

SOFT_404_MARKERS = (
    "sorry! we couldn't find that page",
    "looking for something",
    "dog of the day",
    "404 not found",
)
OOS_MARKER = "currently unavailable"
ANTI_BOT_MARKERS = (
    "captcha",
    "robot check",
    "click the button below to continue shopping",  # Amazon's actual soft
    # bot-check interstitial for a flagged/datacenter IP — confirmed live
    # 2026-07-29 via a VPN-proxied CloakBrowser session; NOT covered by the
    # other two markers (carried over from the old bare-curl role, which
    # apparently never actually hit this page). Without this, a soft-blocked
    # session misreads as "no Prime badge" (prime defaults False on a page
    # with no primeBadge element) and could send a perfectly healthy product
    # to the resolution agent as a false positive.
)

# A genuine Amazon product page body is always much longer than this — a
# short body with none of the markers above is still almost certainly a
# block/error/interstitial page, not real page content worth trusting for
# Prime/rating classification. Mirrors the same threshold already
# established in cc_lib.is_maintenance_or_empty().
_MIN_TRUSTED_BODY_LEN = 200


def classify(evidence: dict, checks_cfg: dict) -> str:
    if not evidence.get("redirect_ok", True):
        return "broken_redirect"

    body = (evidence.get("body") or "").lower()

    if any(m in body for m in ANTI_BOT_MARKERS):
        return "inconclusive"

    if any(m in body for m in SOFT_404_MARKERS):
        return "dead"

    if OOS_MARKER in body:
        return "oos"

    if len(body) < _MIN_TRUSTED_BODY_LEN:
        return "inconclusive"

    status = evidence.get("status")
    if status is not None and status != 200:
        # Amazon-side error (rate-limit, 5xx, etc.) with no soft-404/OOS/anti-bot
        # marker in the body — not our cloak's fault, and not confidently dead
        # either. See state.py's inconclusive_grace_runs for how repeated hits
        # of this eventually escalate to a human instead of being silently
        # accepted forever.
        return "inconclusive"

    if checks_cfg.get("prime_required", True) and evidence.get("prime") is False:
        return "no_prime"

    rating = evidence.get("rating")
    min_rating = checks_cfg.get("min_rating")
    if rating is not None and min_rating is not None and rating < min_rating:
        return "low_rating"

    return "ok"
