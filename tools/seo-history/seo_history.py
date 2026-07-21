#!/usr/bin/env python3
"""Pull a site's GA4/GSC history from data-hub and surface trends + opportunities.

Usage:
    python3 tools/seo-history/seo_history.py <site> [--days 90] [--json]

<site> is the bare host (e.g. americastrikes.com), matching how data-hub keys
captures. Queries /metrics/summary at three windows (7/28/{days}) for trend,
/metrics/top for top GA4 pages and GSC queries, and /metrics/gsc at
grain=query to find opportunity-zone queries (position 5-20). Read-only —
this never files tasks or writes anything; it's for ad-hoc human digging,
not the automated seo-analyst cron (tools/cron-roles/archetypes/seo-analyst/).
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("DATAHUB_API", "http://127.0.0.1:4760")


def _get(path, **params):
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{API}{path}?{qs}" if qs else f"{API}{path}"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"ERROR {e.code} on {url}: {e.read().decode()[:300]}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"ERROR reaching data-hub at {API}: {e.reason}", file=sys.stderr)
        print("Is it running? cd tools/data-hub && docker compose ps", file=sys.stderr)
        sys.exit(1)


def _pct(cur, prev):
    if prev in (None, 0):
        return None
    return round((cur - prev) / prev * 100, 1)


def _fmt_delta(cur, prev):
    p = _pct(cur, prev)
    if p is None:
        return ""
    sign = "+" if p >= 0 else ""
    return f" ({sign}{p}% vs prior window)"


def gather(site, days):
    health = _get("/metrics/health").get("sites", {}).get(site)
    windows = {}
    for label, w in (("7d", 7), ("28d", 28), (f"{days}d", days)):
        windows[label] = _get("/metrics/summary", site=site, window=w)

    # Week-over-week: this week's 7d window vs the prior 7 days (14d - 7d).
    w14 = _get("/metrics/summary", site=site, window=14)
    prior_week = {}
    cur = windows["7d"]
    if w14.get("has_data") and cur.get("has_data"):
        for key in ("sessions", "users", "conversions", "clicks", "impressions"):
            if key in w14 and key in cur:
                prior_week[key] = w14[key] - cur[key]

    top_pages = _get("/metrics/top", site=site, source="ga4", metric="sessions", window=days, limit=10)
    top_queries = _get("/metrics/top", site=site, source="gsc", metric="clicks", window=days, limit=10)

    gsc_rows = _get("/metrics/gsc", site=site, grain="query",
                     since=_since(days), limit=5000).get("records", [])
    opportunity = _opportunity_zone(gsc_rows)

    return {
        "site": site,
        "health": health,
        "windows": windows,
        "prior_week": prior_week,
        "top_pages": top_pages.get("top", []),
        "top_queries": top_queries.get("top", []),
        "opportunity_zone": opportunity,
    }


def _since(days):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


def _opportunity_zone(gsc_rows):
    """Aggregate query rows, weight position by impressions, keep those in 5-20."""
    agg = {}
    for r in gsc_rows:
        q = r["dim_key"]
        a = agg.setdefault(q, {"clicks": 0, "impressions": 0, "pos_weighted": 0.0})
        impr = r.get("impressions") or 0
        a["clicks"] += r.get("clicks") or 0
        a["impressions"] += impr
        if r.get("position") is not None:
            a["pos_weighted"] += r["position"] * impr
    out = []
    for q, a in agg.items():
        if a["impressions"] == 0:
            continue
        avg_pos = a["pos_weighted"] / a["impressions"]
        if 5 <= avg_pos <= 20:
            out.append({"query": q, "avg_position": round(avg_pos, 1),
                        "clicks": a["clicks"], "impressions": a["impressions"]})
    out.sort(key=lambda x: x["impressions"], reverse=True)
    return out[:20]


def render_text(data, days):
    site = data["site"]
    h = data["health"] or {}
    print(f"=== SEO/Analytics history: {site} ===\n")

    ga4_state = (h.get("ga4") or {})
    gsc_state = (h.get("gsc") or {})
    print(f"GA4 collection:  {ga4_state.get('status', 'unknown')}  last_fetch={ga4_state.get('last_fetch_at', 'n/a')}")
    print(f"GSC collection:  {gsc_state.get('status', 'unknown')}  last_fetch={gsc_state.get('last_fetch_at', 'n/a')}")
    if h.get("consent_gated"):
        print("NOTE: consent_gated=true — GA4 traffic undercounts pre-consent visitors.")
    print()

    print("--- Traffic windows ---")
    for label in ("7d", "28d", f"{days}d"):
        w = data["windows"][label]
        if not w.get("has_data"):
            print(f"  {label}: no data")
            continue
        parts = []
        for key in ("sessions", "users", "conversions", "clicks", "impressions"):
            if key in w:
                parts.append(f"{key}={w[key]}")
        print(f"  {label}: " + ", ".join(parts) if parts else f"  {label}: (empty)")
    print()

    pw = data["prior_week"]
    cur = data["windows"]["7d"]
    if pw and cur.get("has_data"):
        print("--- This week vs prior week ---")
        for key in ("sessions", "users", "conversions", "clicks", "impressions"):
            if key in cur and key in pw:
                print(f"  {key}: {cur[key]}{_fmt_delta(cur[key], pw[key])}")
        print()

    print(f"--- Top pages by sessions (last {days}d) ---")
    if not data["top_pages"]:
        print("  (no GA4 page data)")
    for row in data["top_pages"]:
        print(f"  {row['sessions']:>6}  {row['dim_key']}")
    print()

    print(f"--- Top queries by clicks (last {days}d) ---")
    if not data["top_queries"]:
        print("  (no GSC query data)")
    for row in data["top_queries"]:
        print(f"  {row['clicks']:>6}  {row['dim_key']}")
    print()

    print(f"--- Opportunity-zone queries (avg position 5-20, last {days}d) ---")
    if not data["opportunity_zone"]:
        print("  (none found — either no GSC data, or nothing in the 5-20 band)")
    for row in data["opportunity_zone"]:
        print(f"  pos {row['avg_position']:>5}  impr={row['impressions']:>6}  clicks={row['clicks']:>4}  {row['query']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("site", help="bare host, e.g. americastrikes.com")
    ap.add_argument("--days", type=int, default=90, help="lookback window for top/opportunity queries (default 90)")
    ap.add_argument("--json", action="store_true", help="emit raw JSON instead of the text report")
    args = ap.parse_args()

    data = gather(args.site, args.days)
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        render_text(data, args.days)


if __name__ == "__main__":
    main()
