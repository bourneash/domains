"""Deterministic verdict for one product's checked evidence. Pure function —
no I/O, no browser — so it's cheap to unit test exhaustively."""

SOFT_404_MARKERS = (
    "sorry! we couldn't find that page",
    "looking for something",
    "dog of the day",
    "404 not found",
)
OOS_MARKER = "currently unavailable"
ANTI_BOT_MARKERS = ("captcha", "robot check")


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
