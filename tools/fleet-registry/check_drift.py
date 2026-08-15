#!/usr/bin/env python3
"""Fleet registry drift check — registry/fleet.yaml vs. the world, both ways.

Replaces check-index-drift.sh, which only compared three lists and only in one
direction (that one-way check is why 25 sites were missing from sites.yml
without anyone noticing).

Checks, in severity order:

  ERROR   a sites/ directory with no registry entry        (onboarding forgot the registry)
  ERROR   a registry entry with no sites/ directory        (removed site, stale entry)
  ERROR   derived fields stale vs. disk (worker, caps)     (rebuild needed)
  WARN    a live site absent from a fleet-wide roster      (invisible to that tool)
  WARN    a live site with no smoke.yaml / Slack channel   (unmonitored)

Usage:
    check_drift.py            # human report, exit 1 on any ERROR
    check_drift.py --strict   # exit 1 on WARN too
    check_drift.py --json     # machine-readable, for the watchdog role
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_registry as B  # noqa: E402
import fleet_registry as R  # noqa: E402

FLEET_WIDE = [
    ("site-tracker/sites.yml", "tracker"),
    ("data-hub/sites-analytics.yaml", "analytics"),
    ("DOMAINS_INDEX.md", "index"),
    ("social registry", "social"),
]


def check() -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    derived, disk, src = B.build()
    try:
        registry = R.load(fresh=True)
    except FileNotFoundError:
        return (["registry/fleet.yaml missing — run: python3 tools/fleet-registry/build_registry.py --write"], [])

    on_disk = set(derived)
    registered = set(registry)

    for domain in sorted(on_disk - registered):
        errors.append(f"{domain}: sites/ directory exists but has NO registry entry")
    for domain in sorted(registered - on_disk):
        errors.append(f"{domain}: registry entry has NO sites/ directory")

    for domain in sorted(on_disk & registered):
        want, have = derived[domain], registry[domain]
        if want.get("worker") and want["worker"] != have.get("worker"):
            errors.append(
                f"{domain}: worker name stale in registry "
                f"({have.get('worker')!r} != wrangler {want['worker']!r}) — rebuild"
            )
        if have.get("capabilities_override"):
            continue  # human overrode capability detection on purpose
        if set(want.get("capabilities", [])) != set(have.get("capabilities", [])):
            added = sorted(set(want.get("capabilities", [])) - set(have.get("capabilities", [])))
            removed = sorted(set(have.get("capabilities", [])) - set(want.get("capabilities", [])))
            errors.append(
                f"{domain}: capabilities stale in registry (+{added or '-'} / -{removed or '-'}) — rebuild"
            )

    live = [d for d, e in registry.items() if e.get("status") == "live" and d in on_disk]
    for label, key in FLEET_WIDE:
        missing = sorted(set(live) - set(src[key]))
        for domain in missing:
            warnings.append(f"{domain}: live but missing from {label}")
    for domain in sorted(live):
        entry = registry[domain]
        caps = entry.get("capabilities_override") or entry.get("capabilities") or []
        if "smoke" not in caps:
            warnings.append(f"{domain}: live with no ops/smoke.yaml — invisible to fleet-smoke")
        if not entry.get("slack_channel_env"):
            warnings.append(f"{domain}: live with no Slack channel wired")

    return errors, warnings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--strict", action="store_true", help="fail on warnings too")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args()

    errors, warnings = check()

    if args.as_json:
        print(json.dumps({"errors": errors, "warnings": warnings}, indent=2))
    else:
        print("=== fleet registry drift ===")
        for line in errors:
            print(f"  ERROR  {line}")
        for line in warnings:
            print(f"  WARN   {line}")
        if not errors and not warnings:
            print("  clean — registry, filesystem and rosters agree")
        else:
            print(f"\n{len(errors)} error(s), {len(warnings)} warning(s)")
            if errors:
                print("Fix: python3 tools/fleet-registry/build_registry.py --write  (then review the diff)")

    if errors:
        return 1
    return 1 if (args.strict and warnings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
