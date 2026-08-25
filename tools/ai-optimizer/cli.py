#!/usr/bin/env python3
"""ai-optimizer CLI — file / list / decide AI-cost findings.

    python3 tools/ai-optimizer/cli.py list [--status proposed] [--json]
    python3 tools/ai-optimizer/cli.py show <file.md>
    python3 tools/ai-optimizer/cli.py file --json-file finding.json
    python3 tools/ai-optimizer/cli.py file --stdin < finding.json
    python3 tools/ai-optimizer/cli.py move <file.md> --to approved [--note "..."]

`file` is what the daily analyst role calls. It validates the evidence bar
(see lib/ai_optimizer.py's docstring) and refuses anything that looks like a
telemetry-only guess, so a bad finding fails loudly at file-time rather than
becoming a ticket a human has to catch.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import ai_optimizer as q  # noqa: E402


def cmd_list(args):
    rows = q.list_tickets(status=args.status)
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print("(no tickets)")
        return 0
    order = {s: i for i, s in enumerate(q.STATUSES)}
    for r in sorted(rows, key=lambda r: (order.get(r["status"], 9), -(r["measured_cost_usd"] or 0))):
        save = r.get("estimated_savings_usd_per_day")
        scope = r["scope"] if r["scope"] == "fleet" else ",".join(r["sites"] or [])
        print(f"[{r['status']:8s}] {r['file']}")
        print(f"           {r['title']}")
        print(f"           scope={scope} role={r.get('role') or '-'} risk={r.get('risk')} "
              f"measured=${r['measured_cost_usd']} "
              f"est_save={'$'+str(save)+'/day' if save else '-'}")
    return 0


def cmd_show(args):
    for status in q.STATUSES:
        fp = q.status_dir(status) / args.file
        if fp.exists():
            print(fp.read_text(encoding="utf-8"))
            return 0
    print(f"ticket {args.file} not found", file=sys.stderr)
    return 1


def cmd_file(args):
    if args.stdin:
        payload = json.load(sys.stdin)
    elif args.json_file:
        payload = json.loads(Path(args.json_file).read_text(encoding="utf-8"))
    else:
        print("need --stdin or --json-file", file=sys.stderr)
        return 2
    body = payload.pop("body", "")
    try:
        fp, outcome = q.file_ticket(payload, body, force=args.force)
    except q.ValidationError as e:
        print(f"REJECTED — ticket does not meet the evidence bar:\n  {e}", file=sys.stderr)
        return 3
    print(f"{outcome}: {fp}")
    return 0


def cmd_move(args):
    try:
        res = q.move(args.file, args.to, note=args.note, by=args.by, commit=args.commit)
    except (FileNotFoundError, ValueError) as e:
        print(str(e), file=sys.stderr)
        return 1
    print(f"{res['file']}: {res['from']} -> {res['to']}")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    ls = sub.add_parser("list")
    ls.add_argument("--status", choices=q.STATUSES)
    ls.add_argument("--json", action="store_true")
    ls.set_defaults(func=cmd_list)

    sh = sub.add_parser("show")
    sh.add_argument("file")
    sh.set_defaults(func=cmd_show)

    fl = sub.add_parser("file")
    fl.add_argument("--json-file")
    fl.add_argument("--stdin", action="store_true")
    fl.add_argument("--force", action="store_true",
                    help="file even if a matching finding already exists (rarely right)")
    fl.set_defaults(func=cmd_file)

    mv = sub.add_parser("move")
    mv.add_argument("file")
    mv.add_argument("--to", required=True, choices=q.STATUSES)
    mv.add_argument("--note")
    mv.add_argument("--by")
    mv.add_argument("--commit")
    mv.set_defaults(func=cmd_move)

    args = p.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
