"""ASIN harvesting, catalog collection, and snapshot summary for amz-stats.

Each public function is designed to be called from the CLI entry point (cli.py).
collect_catalog never raises — errors per batch are recorded in the return dict.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

from .api import AMZClient, AMZError

log = logging.getLogger(__name__)

_ASIN_RE = re.compile(r"asin:\s+['\"]([A-Z0-9]{10})['\"]")


# ---------------------------------------------------------------------------
# ASIN Harvesting
# ---------------------------------------------------------------------------

def harvest_asins(domains_root: Path) -> dict[str, list[str]]:
    """Scan every sites/<domain>/site/src/lib/affiliate.ts and collect ASINs.

    Returns ``{site_name: [asin, ...]}`` — only sites with at least one ASIN.
    Sites with no affiliate.ts file are silently skipped.
    Within a single file, duplicate ASINs are deduplicated while preserving
    first-occurrence order.
    """
    result: dict[str, list[str]] = {}

    for ts_file in sorted(domains_root.glob("sites/*/site/src/lib/affiliate.ts")):
        # site_name is the component at index -5:
        # <domains_root>/sites/<site_name>/site/src/lib/affiliate.ts
        site_name = ts_file.parts[-5]
        try:
            text = ts_file.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("harvest_asins: could not read %s: %s", ts_file, exc)
            continue

        seen: set[str] = set()
        asins: list[str] = []
        for asin in _ASIN_RE.findall(text):
            if asin not in seen:
                seen.add(asin)
                asins.append(asin)

        if asins:
            result[site_name] = asins

    return result


# ---------------------------------------------------------------------------
# Catalog Collection
# ---------------------------------------------------------------------------

def _safe_get(obj: dict | None, *keys: str):
    """Nested dict traversal that returns None on any missing key or None value."""
    cur = obj
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _parse_item(item: dict) -> dict:
    """Extract the canonical fields from a single API item dict."""
    offers_v2 = item.get("offersV2")
    if offers_v2 is None:
        availability = "UNKNOWN"
        price = None
    else:
        listings = offers_v2.get("listings") or []
        if listings:
            availability = "IN_STOCK"
            price = _safe_get(listings[0], "price", "displayAmount")
        else:
            availability = "OOS"
            price = None

    return {
        "title": _safe_get(item, "itemInfo", "title", "displayValue"),
        "brand": _safe_get(item, "itemInfo", "byLineInfo", "brand", "displayValue"),
        "price": price,
        "availability": availability,
        "rating": _safe_get(item, "customerReviews", "starRating", "value"),
        "review_count": _safe_get(item, "customerReviews", "count"),
        "image_url": _safe_get(item, "images", "primary", "medium", "url"),
        "detail_page_url": item.get("detailPageURL"),
        "parent_asin": item.get("parentASIN"),
    }


def collect_catalog(
    client: AMZClient,
    asins_by_site: dict[str, list[str]],
    batch_size: int = 10,
) -> dict:
    """Call the Amazon Creators API for every unique ASIN across all sites.

    Returns::

        {
            "ok": True,
            "asins": {asin: {title, brand, price, availability, ...}},
            "errors": [asin, ...],   # ASINs from batches that raised AMZError
            "batch_count": int,
        }
    """
    # Deduplicate while preserving a stable order (first-seen across sites).
    seen: set[str] = set()
    unique_asins: list[str] = []
    for site_asins in asins_by_site.values():
        for a in site_asins:
            if a not in seen:
                seen.add(a)
                unique_asins.append(a)

    parsed: dict[str, dict] = {}
    errors: list[str] = []
    batch_count = 0

    for i in range(0, len(unique_asins), batch_size):
        batch = unique_asins[i: i + batch_size]
        batch_count += 1
        try:
            response = client.get_items(batch)
            items = (response.get("itemsResult") or {}).get("items") or []
            for item in items:
                asin = item.get("asin")
                if asin:
                    parsed[asin] = _parse_item(item)
        except AMZError as exc:
            log.error("collect_catalog: batch %d failed (%s); marking %d ASINs as errors",
                      batch_count, exc, len(batch))
            errors.extend(batch)

    return {
        "ok": True,
        "asins": parsed,
        "errors": errors,
        "batch_count": batch_count,
    }


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def build_summary(
    asins_by_site: dict[str, list[str]],
    catalog: dict,
) -> dict:
    """Summarise catalog data per-site and across the fleet.

    Returns::

        {
            "per_site": {
                site_name: {
                    "asin_count": int,
                    "oos_count": int,
                    "delisted_count": int,
                    "unknown_count": int,
                    "missing_count": int,
                    "asins": [str],
                }
            },
            "totals": {
                "site_count": int,
                "asin_count": int,
                "unique_asin_count": int,
                "oos_count": int,
                "delisted_count": int,
                "unknown_count": int,
                "missing_count": int,
                "error_count": int,
            },
        }

    - delisted: ASIN appears in ``asins_by_site`` values AND in ``catalog["errors"]``
    - oos: availability == "OOS"
    - unknown: availability == "UNKNOWN"
    - missing: ASIN appears in ``asins_by_site`` values but in neither ``catalog["asins"]`` nor ``catalog["errors"]``
    """
    catalog_items: dict[str, dict] = catalog.get("asins") or {}
    error_set: set[str] = set(catalog.get("errors") or [])

    per_site: dict[str, dict] = {}

    total_asin_count = 0    # sum of per-site counts (double-counts shared ASINs)
    total_oos = 0
    total_delisted = 0
    total_unknown = 0
    total_missing = 0
    all_unique: set[str] = set()

    for site, site_asins in asins_by_site.items():
        oos_count = 0
        delisted_count = 0
        unknown_count = 0
        missing_count = 0

        for asin in site_asins:
            all_unique.add(asin)
            if asin in error_set:
                delisted_count += 1
            elif asin in catalog_items:
                avail = catalog_items[asin].get("availability")
                if avail == "OOS":
                    oos_count += 1
                elif avail == "UNKNOWN":
                    unknown_count += 1
            else:
                missing_count += 1

        per_site[site] = {
            "asin_count": len(site_asins),
            "oos_count": oos_count,
            "delisted_count": delisted_count,
            "unknown_count": unknown_count,
            "missing_count": missing_count,
            "asins": list(site_asins),
        }

        total_asin_count += len(site_asins)
        total_oos += oos_count
        total_delisted += delisted_count
        total_unknown += unknown_count
        total_missing += missing_count

    return {
        "per_site": per_site,
        "totals": {
            "site_count": len(asins_by_site),
            "asin_count": total_asin_count,
            "unique_asin_count": len(all_unique),
            "oos_count": total_oos,
            "delisted_count": total_delisted,
            "unknown_count": total_unknown,
            "missing_count": total_missing,
            "error_count": len(error_set),
        },
    }
