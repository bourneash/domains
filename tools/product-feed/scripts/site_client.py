#!/usr/bin/env python3
"""Small dependency-free client used by product-feed consumer sites."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


API = os.environ.get("PRODUCTFEED_API", "http://product-feed-api:4761").rstrip("/")


def request(path: str, *, body: dict | None = None) -> dict:
    payload = json.dumps(body if body is not None else {}).encode("utf-8")
    req = urllib.request.Request(
        f"{API}{path}",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def site_path(site: str, suffix: str) -> str:
    return f"/subscriptions/{urllib.parse.quote(site)}/products/{suffix}"


def candidate_from_product(site: str, product: dict) -> dict:
    rating = product.get("rating")
    reviews = product.get("review_count")
    return {
        "asin": product["asin"],
        "product_url": product["amazon_url"],
        "title": product["title"],
        "price": product.get("price"),
        "rating_raw": f"{rating} out of 5 stars" if rating is not None else None,
        "review_text": f"({reviews:,})" if reviews is not None else None,
        "search_card_rating": rating,
        "search_card_reviews": reviews,
        "image_path": None,
        "image_source_url": product.get("image_url"),
        "source_tags": product.get("tags") or [],
        "source_query": product.get("source_query"),
        "sourced_at": product.get("last_verified_at"),
        "feed_claimed_at": datetime.now(timezone.utc).isoformat(),
        "feed_product": True,
        "feed_site": site,
    }


def claim(args) -> int:
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    excluded = set()
    if args.exclude_asins_file:
        excluded = set(
            re.findall(r"\basin:\s*['\"]([A-Z0-9]{10})['\"]", Path(args.exclude_asins_file).read_text())
        )
    written = 0
    attempts = 0
    while written < args.count and attempts < args.count + len(excluded) + 20:
        attempts += 1
        result = request(site_path(args.site, "next-review"))
        product = result.get("item")
        if product is None:
            break
        if product["asin"] in excluded:
            request(site_path(args.site, f"{urllib.parse.quote(product['asin'])}/published"))
            print(f"[feed] {product['asin']} already exists on {args.site}; marked published")
            continue
        candidate = candidate_from_product(args.site, product)
        path = output_dir / f"feed-{product['asin']}.json"
        path.write_text(json.dumps(candidate, indent=2) + "\n")
        print(f"[feed] candidate written: {path}")
        written += 1
    print(f"[feed] claimed {written} verified product(s) for {args.site}")
    return 0


def decide(args) -> int:
    candidate = json.loads(Path(args.candidate).read_text())
    decision = json.loads(Path(args.decision).read_text())
    asin = candidate["asin"]
    encoded_asin = urllib.parse.quote(asin)
    if decision.get("fits"):
        result = request(
            site_path(args.site, f"{encoded_asin}/queue"), body={"decision": decision}
        )
    else:
        result = request(
            site_path(args.site, f"{encoded_asin}/reject"),
            body={"reason": decision.get("reason") or "site rejected product"},
        )
    print(f"[feed] {asin} -> {result['status']} for {args.site}")
    return 0


def release_review(args) -> int:
    candidate = json.loads(Path(args.candidate).read_text())
    asin = urllib.parse.quote(candidate["asin"])
    result = request(site_path(args.site, f"{asin}/review-release"))
    print(f"[feed] {candidate['asin']} -> {result['status']} for {args.site}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    claim_parser = sub.add_parser("claim")
    claim_parser.add_argument("--site", required=True)
    claim_parser.add_argument("--count", type=int, required=True)
    claim_parser.add_argument("--output-dir", required=True)
    claim_parser.add_argument("--exclude-asins-file")
    claim_parser.set_defaults(func=claim)

    decide_parser = sub.add_parser("decide")
    decide_parser.add_argument("--site", required=True)
    decide_parser.add_argument("--candidate", required=True)
    decide_parser.add_argument("--decision", required=True)
    decide_parser.set_defaults(func=decide)

    release_parser = sub.add_parser("release-review")
    release_parser.add_argument("--site", required=True)
    release_parser.add_argument("--candidate", required=True)
    release_parser.set_defaults(func=release_review)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except Exception as exc:
        print(f"[feed] request failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
