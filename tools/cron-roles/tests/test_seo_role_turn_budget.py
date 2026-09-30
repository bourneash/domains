#!/usr/bin/env python3
"""Keep installed SEO role guards reachable by their runner turn budgets."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[3]
SAFETY_MARGIN = 5


def main() -> int:
    failures = []
    checked = 0
    for role_path in sorted((ROOT / "sites").glob("*/ops/roles/seo-analyst.md")):
        guard_match = re.search(r"If you reach turn (\d+)", role_path.read_text())
        runner = role_path.parents[1] / "scripts" / "run-role.sh"
        if not guard_match or not runner.is_file():
            continue

        source = runner.read_text()
        branch_match = re.search(
            r"(?ms)^[ \t]*seo-analyst\)(?P<body>.*?)(?=^[ \t]*(?:[A-Za-z0-9_-]+|\*)\)|^[ \t]*esac\b)",
            source,
        )
        if not branch_match:
            continue

        cap_match = re.search(
            r"(?:--max-turns|MAX_TURNS=)[ \t]*(\d+)", branch_match.group("body")
        )
        if not cap_match:
            # Generic runners set a default before their role case and pass
            # the shared variable after the case.
            cap_match = re.search(r"(?m)^MAX_TURNS=(\d+)", source)
        if not cap_match:
            failures.append(f"{role_path.parent.parent.parent.name}: SEO runner cap is not explicit")
            continue

        checked += 1
        guard = int(guard_match.group(1))
        cap = int(cap_match.group(1))
        required = guard + SAFETY_MARGIN
        if cap < required:
            failures.append(
                f"{role_path.parent.parent.parent.name}: cap {cap} < guard {guard} + margin {SAFETY_MARGIN}"
            )

    if failures:
        print("SEO role turn-budget audit failed:", file=sys.stderr)
        print("\n".join(f"- {failure}" for failure in failures), file=sys.stderr)
        return 1
    if checked == 0:
        print("SEO role turn-budget audit found no explicit runners", file=sys.stderr)
        return 1
    print(f"SEO role turn-budget audit passed ({checked} explicit runners checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
