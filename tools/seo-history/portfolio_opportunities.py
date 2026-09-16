#!/usr/bin/env python3
"""Rank fleet-wide GSC query/page opportunities from data-hub.

The report favors URLs already ranking in positions 5-20, discounts tiny
samples, and highlights low-CTR results. It is read-only.
"""
import argparse
import json
import os
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

API = os.environ.get("DATAHUB_API", "http://127.0.0.1:4760")


def get_json(path, **params):
    query = urllib.parse.urlencode(params)
    with urllib.request.urlopen(f"{API}{path}?{query}" if query else f"{API}{path}", timeout=20) as response:
        return json.loads(response.read())


def aggregate(rows):
    grouped = defaultdict(lambda: {"clicks": 0, "impressions": 0, "weighted_position": 0.0})
    for row in rows:
        impressions = int(row.get("impressions") or 0)
        item = grouped[(row["site"], row["query"], row["page"])]
        item["clicks"] += int(row.get("clicks") or 0)
        item["impressions"] += impressions
        item["weighted_position"] += float(row.get("position") or 0) * impressions

    results = []
    for (site, query, page), values in grouped.items():
        impressions = values["impressions"]
        if not impressions:
            continue
        position = values["weighted_position"] / impressions
        ctr = values["clicks"] / impressions
        results.append({"site": site, "query": query, "page": page, "clicks": values["clicks"],
                        "impressions": impressions, "ctr": ctr, "position": position})
    return results


def opportunity_score(row):
    """Comparable 0-ish score; ranking proximity and CTR gap outweigh raw volume."""
    position = row["position"]
    if position < 5 or position > 20:
        return 0.0
    expected_ctr = 0.10 if position <= 5 else 0.06 if position <= 10 else 0.025
    ctr_gap = max(expected_ctr - row["ctr"], 0.005)
    proximity = (21 - position) / 16
    # Square-root volume keeps one viral query from drowning the portfolio,
    # while still putting a 1,000-impression opportunity ahead of a handful
    # of incidental impressions at a slightly better position.
    return round((row["impressions"] ** 0.5) * proximity * ctr_gap * 100, 2)


def action(row):
    if row["position"] <= 10 and row["ctr"] < 0.01:
        return "rewrite title/meta + sharpen opening answer"
    if row["position"] <= 12:
        return "refresh page + add internal links"
    return "expand intent coverage or create focused page"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=28)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--min-impressions", type=int, default=2)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    since = (datetime.now(timezone.utc) - timedelta(days=args.days)).date().isoformat()
    health = get_json("/metrics/health").get("sites", {})
    rows = []
    for site, state in sorted(health.items()):
        if (state.get("gsc") or {}).get("status") != "ok":
            continue
        rows.extend(get_json("/metrics/gsc-query-pages", site=site, since=since, limit=5000).get("records", []))

    ranked = []
    for row in aggregate(rows):
        if row["impressions"] < args.min_impressions:
            continue
        row["score"] = opportunity_score(row)
        if not row["score"]:
            continue
        row["action"] = action(row)
        ranked.append(row)
    ranked.sort(key=lambda item: (-item["score"], -item["impressions"]))
    ranked = ranked[:args.limit]

    if args.json:
        print(json.dumps(ranked, indent=2))
        return
    print(f"Fleet SEO opportunities — {args.days}d (positions 5-20)\n")
    for row in ranked:
        print(f"{row['score']:>6.2f}  pos {row['position']:>4.1f}  imp {row['impressions']:>5}  "
              f"ctr {row['ctr'] * 100:>5.1f}%  {row['site']}\n"
              f"        {row['query']}\n        {row['page']}\n        → {row['action']}")


if __name__ == "__main__":
    main()
