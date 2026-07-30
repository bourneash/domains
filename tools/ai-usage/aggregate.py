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
import re
from datetime import date
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[2]

NUMERIC_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)

DIRECT_CLAUDE_CALL = re.compile(r"\btimeout\b.*\bclaude\s+-p\b")
PYTHON_CLAUDE_CALL = re.compile(r"[\[\(]\s*['\"]claude['\"]\s*,\s*['\"]-p['\"]")


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


def wiring_status(site_dir: Path) -> str:
    """Classify all executable AI call sites, not only run-role.sh.

    Bash-driven roles commonly call Claude from an engineer, watchdog, or
    writer helper.  Checking only the dispatcher made the old dashboard claim
    that a site was wired while its actual AI calls were invisible.
    """
    scripts_dir = site_dir / "ops" / "scripts"
    if not scripts_dir.is_dir():
        return "no_ai_role"

    tracked = 0
    untracked = 0
    for script in scripts_dir.rglob("*.sh"):
        for line in script.read_text(encoding="utf-8", errors="ignore").splitlines():
            stripped = line.lstrip()
            if not stripped or stripped.startswith("#"):
                continue
            if DIRECT_CLAUDE_CALL.search(line) or PYTHON_CLAUDE_CALL.search(line):
                untracked += 1
            if '"$CLAUDE_TRACKED"' in line or "${CLAUDE_TRACKED}" in line:
                tracked += 1

    if untracked:
        return "not_wired"
    if tracked:
        return "wired_awaiting_first_run"
    return "no_ai_role"


def coverage_row(site_dir: Path, has_ledger: bool) -> dict:
    status = wiring_status(site_dir)
    return {
        "site": site_dir.name,
        "status": "reporting" if has_ledger else status,
        "has_ledger": has_ledger,
    }


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


def collect(root: Path = DEFAULT_ROOT, start_day: str | None = None,
            end_day: str | None = None) -> dict:
    """Build a report, optionally limited to inclusive UTC ledger dates."""
    if start_day and end_day and start_day > end_day:
        raise ValueError("start_day must not be after end_day")
    sites_dir = root / "sites"
    by_site: dict[str, dict] = {}
    by_site_role: dict[tuple[str, str], dict] = {}
    by_day: dict[str, dict] = {}
    by_day_site_role: dict[tuple[str, str, str], dict] = {}
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
            if start_day and day < start_day:
                continue
            if end_day and day > end_day:
                continue
            for record in read_ledger_records(ledger):
                site = record.get("site") or site_name
                role = record.get("role") or "unknown"
                instrumented_sites.add(site)

                _add(by_site.setdefault(site, _empty_totals()), record)
                _add(by_site_role.setdefault((site, role), _empty_totals()), record)
                _add(by_day.setdefault(day, _empty_totals()), record)
                _add(by_day_site_role.setdefault((day, site, role), _empty_totals()), record)

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

    day_site_role_rows = []
    for (day, site, role), totals in sorted(by_day_site_role.items()):
        day_site_role_rows.append({
            "day": day, "site": site, "role": role, **totals,
            "cache_hit_ratio": _cache_hit_ratio(totals),
        })

    fleet_totals = _empty_totals()
    for totals in by_site.values():
        for field in (*NUMERIC_FIELDS, "calls", "errors"):
            fleet_totals[field] += totals[field]
        fleet_totals["total_cost_usd"] += totals["total_cost_usd"]

    uninstrumented_sites = sorted(set(all_sites) - instrumented_sites)
    wired_awaiting_first_run = []
    not_wired = []
    no_ai_role = []
    for site_name in uninstrumented_sites:
        status = wiring_status(sites_dir / site_name)
        if status == "wired_awaiting_first_run":
            wired_awaiting_first_run.append(site_name)
        elif status == "not_wired":
            not_wired.append(site_name)
        else:
            no_ai_role.append(site_name)

    coverage = [coverage_row(sites_dir / site_name, site_name in instrumented_sites)
                for site_name in all_sites]

    return {
        "summary": {
            **fleet_totals,
            "cache_hit_ratio": _cache_hit_ratio(fleet_totals),
            "sites_total": len(all_sites),
            "sites_instrumented": len(instrumented_sites),
            "sites_uninstrumented": uninstrumented_sites,
            "sites_wired_awaiting_first_run": wired_awaiting_first_run,
            "sites_not_wired": not_wired,
            "sites_no_ai_role": no_ai_role,
            "coverage_complete": not not_wired,
        },
        "by_site": site_rows,
        "by_site_role": role_rows,
        "by_day": day_rows,
        "by_day_site_role": day_site_role_rows,
        "filters": {"from": start_day, "to": end_day},
        "coverage": coverage,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--from", dest="start_day", type=date.fromisoformat,
                        help="inclusive UTC ledger date (YYYY-MM-DD)")
    parser.add_argument("--to", dest="end_day", type=date.fromisoformat,
                        help="inclusive UTC ledger date (YYYY-MM-DD)")
    args = parser.parse_args(argv)
    start_day = args.start_day.isoformat() if args.start_day else None
    end_day = args.end_day.isoformat() if args.end_day else None
    if start_day and end_day and start_day > end_day:
        parser.error("--from must not be after --to")
    report = collect(args.root.resolve(), start_day, end_day)

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
    if summary["sites_wired_awaiting_first_run"]:
        print(f"\nWired, awaiting first cron fire ({len(summary['sites_wired_awaiting_first_run'])}): "
              + ", ".join(summary["sites_wired_awaiting_first_run"]))
    if summary["sites_not_wired"]:
        print(f"\nHas AI calls but NOT wired to claude-tracked.sh yet ({len(summary['sites_not_wired'])}): "
              + ", ".join(summary["sites_not_wired"]))
    if summary["sites_no_ai_role"]:
        print(f"\nNo AI cron role at all ({len(summary['sites_no_ai_role'])}): "
              + ", ".join(summary["sites_no_ai_role"]))
    print("\n| Site | Role | Calls | Errors | In | Out | Cache R | Cache W | Cost USD | Cache hit |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for row in report["by_site_role"]:
        print(f"| {row['site']} | {row['role']} | {row['calls']} | {row['errors']} | "
              f"{row['input_tokens']:,} | {row['output_tokens']:,} | "
              f"{row['cache_read_input_tokens']:,} | {row['cache_creation_input_tokens']:,} | "
              f"{row['total_cost_usd']:.4f} | {row['cache_hit_ratio']} |")


if __name__ == "__main__":
    main()
