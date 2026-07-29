#!/usr/bin/env python3
"""Fleet AI token-usage aggregator.

Reads the per-site ledgers written by `tools/scripts/claude-tracked.sh`
(`ops/logs/token-usage-<UTC date>.jsonl`, one JSON object per `claude -p`
call) and rolls them up into a fleet-wide report: totals by site, by
(site, role), by day, plus a cache-hit ratio and an honest list of which
sites have no ledger data yet (most of the fleet, until each site's
`run-role.sh` is migrated per tools/cron-roles/WIRING.md Step 6.5).

Usage:
    python3 tools/ai-usage/aggregate.py
    python3 tools/ai-usage/aggregate.py --json
    python3 tools/ai-usage/aggregate.py --root /path/to/domains --json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[2]

NUMERIC_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


def _empty_totals() -> dict:
    return {
        "calls": 0,
        "errors": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "total_cost_usd": 0.0,
    }


def _add(totals: dict, record: dict) -> None:
    totals["calls"] += 1
    if record.get("is_error"):
        totals["errors"] += 1
    for field in NUMERIC_FIELDS:
        totals[field] += record.get(field) or 0
    totals["total_cost_usd"] += record.get("total_cost_usd") or 0.0


def _cache_hit_ratio(totals: dict) -> float | None:
    denom = totals["input_tokens"] + totals["cache_read_input_tokens"]
    if denom == 0:
        return None
    return round(totals["cache_read_input_tokens"] / denom, 4)


def read_ledger_records(ledger: Path) -> list[dict]:
    records = []
    for line in ledger.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def collect(root: Path = DEFAULT_ROOT) -> dict:
    sites_dir = root / "sites"
    by_site: dict[str, dict] = {}
    by_site_role: dict[tuple[str, str], dict] = {}
    by_day: dict[str, dict] = {}
    instrumented_sites: set[str] = set()
    all_sites: list[str] = []

    if sites_dir.is_dir():
        all_sites = sorted(p.name for p in sites_dir.iterdir() if p.is_dir())

    for site_name in all_sites:
        log_dir = sites_dir / site_name / "ops" / "logs"
        if not log_dir.is_dir():
            continue
        for ledger in sorted(log_dir.glob("token-usage-*.jsonl")):
            day = ledger.stem.removeprefix("token-usage-")
            for record in read_ledger_records(ledger):
                site = record.get("site") or site_name
                role = record.get("role") or "unknown"
                instrumented_sites.add(site)

                _add(by_site.setdefault(site, _empty_totals()), record)
                _add(by_site_role.setdefault((site, role), _empty_totals()), record)
                _add(by_day.setdefault(day, _empty_totals()), record)

    site_rows = []
    for site, totals in sorted(by_site.items()):
        row = {"site": site, **totals, "cache_hit_ratio": _cache_hit_ratio(totals)}
        site_rows.append(row)

    role_rows = []
    for (site, role), totals in sorted(by_site_role.items()):
        row = {"site": site, "role": role, **totals, "cache_hit_ratio": _cache_hit_ratio(totals)}
        role_rows.append(row)

    day_rows = []
    for day, totals in sorted(by_day.items()):
        row = {"day": day, **totals, "cache_hit_ratio": _cache_hit_ratio(totals)}
        day_rows.append(row)

    fleet_totals = _empty_totals()
    for totals in by_site.values():
        for field in (*NUMERIC_FIELDS, "calls", "errors"):
            fleet_totals[field] += totals[field]
        fleet_totals["total_cost_usd"] += totals["total_cost_usd"]

    uninstrumented_sites = sorted(set(all_sites) - instrumented_sites)

    return {
        "summary": {
            **fleet_totals,
            "cache_hit_ratio": _cache_hit_ratio(fleet_totals),
            "sites_total": len(all_sites),
            "sites_instrumented": len(instrumented_sites),
            "sites_uninstrumented": uninstrumented_sites,
        },
        "by_site": site_rows,
        "by_site_role": role_rows,
        "by_day": day_rows,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args(argv)
    report = collect(args.root.resolve())

    if args.json:
        print(json.dumps(report, indent=2))
        return

    summary = report["summary"]
    print(f"Sites instrumented: {summary['sites_instrumented']}/{summary['sites_total']}")
    print(f"Total calls: {summary['calls']} ({summary['errors']} errors)")
    print(f"Total cost (USD): {summary['total_cost_usd']:.2f}")
    print(f"Input tokens: {summary['input_tokens']:,}  Output tokens: {summary['output_tokens']:,}")
    print(f"Cache read: {summary['cache_read_input_tokens']:,}  "
          f"Cache write: {summary['cache_creation_input_tokens']:,}  "
          f"Cache hit ratio: {summary['cache_hit_ratio']}")
    if summary["sites_uninstrumented"]:
        print(f"\nNot yet instrumented ({len(summary['sites_uninstrumented'])}): "
              + ", ".join(summary["sites_uninstrumented"]))
    print("\n| Site | Role | Calls | Errors | In | Out | Cache R | Cache W | Cost USD | Cache hit |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for row in report["by_site_role"]:
        print(f"| {row['site']} | {row['role']} | {row['calls']} | {row['errors']} | "
              f"{row['input_tokens']:,} | {row['output_tokens']:,} | "
              f"{row['cache_read_input_tokens']:,} | {row['cache_creation_input_tokens']:,} | "
              f"{row['total_cost_usd']:.4f} | {row['cache_hit_ratio']} |")


if __name__ == "__main__":
    main()
