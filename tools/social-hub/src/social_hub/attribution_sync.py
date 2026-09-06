"""Import GA4 organic-social outcomes already collected by Data Hub."""

from __future__ import annotations

import os
import re

from social_hub import db

POST_KEY = re.compile(r"^hub-(\d+)$")


def refresh_site(site: str, days: int = 30) -> dict:
    base = os.environ.get("DATAHUB_API", "").rstrip("/")
    if not base:
        return {"updated": 0, "skipped": "DATAHUB_API not configured"}
    try:
        import httpx

        response = httpx.get(
            f"{base}/metrics/ga4",
            params={"site": site, "grain": "social", "limit": 5000},
            timeout=15,
        )
        response.raise_for_status()
        records = response.json().get("records") or []
    except Exception as exc:
        db.log_event("attribution.error", site=site, message=str(exc)[:300])
        return {"updated": 0, "error": str(exc)[:300]}

    totals: dict[int, dict[str, int]] = {}
    for row in records:
        match = POST_KEY.match(str(row.get("dim_key") or ""))
        if not match:
            continue
        post_id = int(match.group(1))
        bucket = totals.setdefault(post_id, {"clicks": 0, "conversions": 0})
        # GA4 sessions are the closest durable click/visit measure available
        # from the fleet collector; keep the stored field named clicks for a
        # common cross-platform dashboard vocabulary.
        bucket["clicks"] += int(row.get("sessions") or 0)
        bucket["conversions"] += int(row.get("conversions") or 0)
    updated = 0
    for post_id, values in totals.items():
        post = db.one("SELECT id FROM posts WHERE id = ? AND site = ?", (post_id, site))
        if post:
            db.update("posts", post_id, values)
            updated += 1
    if updated:
        db.log_event("attribution.refreshed", site=site, message=f"updated {updated} post outcome(s)")
    return {"updated": updated, "records": len(records)}
