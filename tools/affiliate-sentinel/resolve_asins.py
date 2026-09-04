#!/usr/bin/env python3
"""Resolve a site's product `searchQuery` fields to real, verified ASINs.

Generic across sites, callable with `--site-root sites/<domain>`. This used to
be a per-site script (sites/greatamericanlakes.com/ops/scripts/resolve-asins.py)
that parsed the shared root `.env` directly to get AMAZON_CREATORS_KEY_ID /
KEY_SECRET / AMAZON_ASSOCIATES_STORE_ID. Those four keys are in env-broker's
`never_grant` list — no site container may ever hold them — and env-broker's
`--check` flagged that site FORBIDDEN for referencing them from inside its own
ops/ tree, regardless of how carefully the script behaved. This tool lives
under tools/, which env-broker scopes separately (see policy.yaml `tools:
amz-stats`), so credential handling now sits where the policy already expects
Amazon secrets to live, and a site's ops/ tree no longer needs to name them.

A product catalog ships with no ASINs on purpose: an invented one is worse
than useless, and `amazon()` falls back to a tagged search URL, which is a
legitimate affiliate link. This turns those fallbacks into direct product
links using the Amazon Creators API's `searchItems` — the same endpoint
sentinel.py/heal.py use to source replacements.

Only writes an ASIN the API actually returned for that query — never a guess.
Anything it cannot resolve keeps the search fallback and is reported, so the
"needs verification" set stays visible instead of silently looking finished.

Usage:
  python3 tools/affiliate-sentinel/resolve_asins.py --site-root sites/greatamericanlakes.com [--dry-run] [--limit N]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
DOMAINS = TOOL_DIR.parents[1]

import amz  # noqa: E402 — tools/affiliate-sentinel/amz.py, holds the credential path

ASIN_RE = re.compile(r"^B[A-Z0-9]{9}$")


def field(text: str, key: str) -> str | None:
    m = re.search(rf"^{key}:\s*(.*)$", text, re.M)
    return m.group(1).strip().strip("\"'") if m else None


def best_item(items: list[dict], brand: str) -> dict | None:
    """Prefer a hit whose brand matches ours; otherwise take the first result.

    Amazon's relevance ordering is good, but the top hit for a generic query is
    often an accessory or a competitor. A brand match is the cheapest signal
    that we linked the thing we actually wrote about.
    """
    if not items:
        return None
    b = brand.lower().split()[0] if brand else ""
    if b:
        for it in items:
            info = (it.get("itemInfo") or {}).get("byLineInfo") or {}
            cand = ((info.get("brand") or {}).get("displayValue") or "").lower()
            title = (((it.get("itemInfo") or {}).get("title") or {}).get("displayValue") or "").lower()
            if b in cand or b in title:
                return it
    return items[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site-root", required=True, type=Path, help="e.g. sites/greatamericanlakes.com")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    site_root = args.site_root.resolve()
    products_dir = site_root / "site" / "src" / "content" / "products"
    if not products_dir.is_dir():
        print(f"no products dir at {products_dir}", file=sys.stderr)
        return 1

    amz.load_env(site_root, DOMAINS)
    try:
        cl_ctx = amz.client(amz.token_cache_path())
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    files = sorted(products_dir.glob("*.md"))
    resolved, skipped, failed = 0, 0, []

    with cl_ctx as client:
        for f in files:
            if args.limit and resolved >= args.limit:
                break
            text = f.read_text()
            if field(text, "asin"):
                skipped += 1
                continue
            query = field(text, "searchQuery")
            brand = field(text, "brand") or ""
            if not query:
                failed.append((f.name, "no searchQuery"))
                continue
            try:
                res = client.search_items(query, item_count=5)
            except Exception as exc:  # noqa: BLE001 — report, never abort the batch
                failed.append((f.name, f"api: {exc}"))
                continue

            items = ((res or {}).get("searchResult") or {}).get("items") or []
            item = best_item(items, brand)
            asin = (item or {}).get("asin") or ""
            if not ASIN_RE.match(asin):
                failed.append((f.name, f"no usable ASIN for {query!r}"))
                continue

            title = (((item.get("itemInfo") or {}).get("title") or {}).get("displayValue") or "")[:70]
            print(f"  {f.stem} -> {asin}  {title}")
            resolved += 1
            if not args.dry_run:
                f.write_text(text.replace("\nsearchQuery:", f'\nasin: "{asin}"\nsearchQuery:', 1))

    print(f"\nresolved {resolved}, already had {skipped}, unresolved {len(failed)}")
    for name, why in failed:
        print(f"  ! {name}: {why}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
