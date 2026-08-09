#!/usr/bin/env python3
"""lint-sweep.py — fleet-wide prettier parse/format sweep. Zero AI.

Why this exists
---------------
`tools/git-hooks/pre-commit` formats staged .ts/.tsx/.js/.astro files with the
shared prettier, but it pipes through xargs and never checks the exit code. A
file prettier cannot *parse* therefore fails silently: the commit succeeds, the
file is never formatted, and nothing tells anyone. reviewtattoo.com carried 4
such files for months (2026-08-09) before one was noticed by accident.

This sweep is the detector the hook isn't. It runs the same prettier the hook
runs, over the same file types, across every site, and splits the result into
two very different signals:

  parse error  — prettier could not parse the file at all. This is the rot
                 signal: the hook is silently skipping it, and it will never be
                 formatted until a human (or an AI role) fixes the source.
  drift        — parses fine, just isn't formatted. Cosmetic; the next commit
                 that stages it will fix it automatically.

No AI runs here, ever. Detection is a subprocess and some string parsing. AI is
only involved if you opt into --file-tasks, which files an engineering task on
the affected site's board for that site's existing engineer role to pick up.

Usage
-----
    python3 tools/lint-fleet/lint-sweep.py                 # table
    python3 tools/lint-fleet/lint-sweep.py --json          # machine-readable
    python3 tools/lint-fleet/lint-sweep.py --site reviewtattoo.com
    python3 tools/lint-fleet/lint-sweep.py --fail-on-new   # cron/CI gate
    python3 tools/lint-fleet/lint-sweep.py --file-tasks    # escalate to AI roles

Every run writes reports/latest.json and appends reports/history.jsonl, so
"what's new since last time" is computed from real history, not guessed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[2]
REPORT_DIR = Path(__file__).resolve().parent / "reports"
LATEST = REPORT_DIR / "latest.json"
HISTORY = REPORT_DIR / "history.jsonl"

# Must stay in lockstep with tools/git-hooks/pre-commit's file filter and the
# root package.json format:check glob — this sweep is only meaningful if it
# checks exactly what the hook would have formatted.
EXTS = ("ts", "tsx", "js", "astro")
GLOB_TMPL = "sites/{site}/site/src/**/*.{{{exts}}}"

ANSI = re.compile(r"\x1b\[[0-9;]*m")
# `[error] sites/x.com/site/src/foo.astro: SyntaxError: Unexpected token (10:7)`
ERROR_LINE = re.compile(r"^\[error\] (sites/[^\s:]+\.(?:ts|tsx|js|astro)): (.+)$")
# `[warn] sites/x.com/site/src/foo.astro`
WARN_LINE = re.compile(r"^\[warn\] (sites/[^\s:]+\.(?:ts|tsx|js|astro))$")

STATUS_ORDER = {"broken": 0, "drift": 1, "clean": 2, "empty": 3}


def prettier_bin(root: Path) -> Path:
    return root / "node_modules" / ".bin" / "prettier"


def eligible_sites(root: Path) -> list[str]:
    """Sites with a site/src tree that could contain prettier-eligible files."""
    sites_dir = root / "sites"
    if not sites_dir.is_dir():
        return []
    out = []
    for entry in sorted(sites_dir.iterdir()):
        if entry.is_dir() and (entry / "site" / "src").is_dir():
            out.append(entry.name)
    return out


def count_files(root: Path, site: str) -> int:
    src = root / "sites" / site / "site" / "src"
    return sum(1 for p in src.rglob("*") if p.is_file() and p.suffix.lstrip(".") in EXTS)


def run_prettier(root: Path, sites: list[str], timeout: int) -> tuple[str, int]:
    """One prettier invocation over every site. Returns (output, exit_code).

    A single invocation rather than one-per-site: prettier reports every file it
    can't parse and keeps going, so batching loses no information and roughly
    halves wall clock (~25s fleet-wide vs ~60s spawning 25 processes).
    """
    binary = prettier_bin(root)
    if not binary.exists():
        raise SystemExit(
            f"prettier not found at {binary} — run 'npm install' in {root}"
        )
    globs = [GLOB_TMPL.format(site=s, exts=",".join(EXTS)) for s in sites]
    proc = subprocess.run(
        [str(binary), "--check", "--no-color", *globs],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return (proc.stdout or "") + (proc.stderr or ""), proc.returncode


def parse_output(output: str) -> tuple[dict[str, list[dict]], dict[str, list[str]]]:
    """Split prettier's report into per-site parse errors and per-site drift."""
    errors: dict[str, list[dict]] = {}
    warns: dict[str, list[str]] = {}
    for raw in output.splitlines():
        line = ANSI.sub("", raw).rstrip()
        m = ERROR_LINE.match(line)
        if m:
            path, message = m.group(1), m.group(2).strip()
            site = path.split("/")[1]
            # Continuation lines of a code frame also start with [error]; they
            # never match the path regex, so anything landing here is a real
            # first-line diagnostic.
            errors.setdefault(site, []).append(
                {"file": relative_to_site(path), "message": message}
            )
            continue
        m = WARN_LINE.match(line)
        if m:
            path = m.group(1)
            warns.setdefault(path.split("/")[1], []).append(relative_to_site(path))
    return errors, warns


def relative_to_site(path: str) -> str:
    """`sites/x.com/site/src/a.astro` -> `site/src/a.astro`."""
    parts = path.split("/")
    return "/".join(parts[2:]) if len(parts) > 2 else path


def load_previous() -> dict:
    try:
        return json.loads(LATEST.read_text())
    except Exception:
        return {}


def diff_against(previous: dict, sites: list[dict]) -> tuple[list[dict], list[dict]]:
    """New and resolved parse errors, keyed on (site, file).

    Scoped to the sites actually re-checked in this run — otherwise a
    single-site rescan would report every OTHER site's parse errors as
    "resolved" purely because this run didn't look at them.
    """
    scanned = {s["site"] for s in sites}

    def keyset(report_sites):
        return {
            (s["site"], e["file"])
            for s in report_sites
            if s["site"] in scanned
            for e in s.get("parse_errors", [])
        }

    before = keyset(previous.get("sites", []))
    after = keyset(sites)
    new = [{"site": s, "file": f} for (s, f) in sorted(after - before)]
    resolved = [{"site": s, "file": f} for (s, f) in sorted(before - after)]
    # A first-ever run has no baseline; everything would read as "new" and spam
    # the first alert. Treat it as a baseline instead.
    if not previous:
        new = []
    return new, resolved


def build_report(root: Path, only_site: str | None, timeout: int) -> dict:
    sites = eligible_sites(root)
    if only_site:
        if only_site not in sites:
            raise SystemExit(f"unknown or source-less site: {only_site}")
        sites = [only_site]

    started = time.time()
    output, exit_code = run_prettier(root, sites, timeout)
    duration_ms = int((time.time() - started) * 1000)
    errors, warns = parse_output(output)

    rows = []
    for site in sites:
        parse_errors = errors.get(site, [])
        unformatted = warns.get(site, [])
        checked = count_files(root, site)
        if checked == 0:
            status = "empty"
        elif parse_errors:
            status = "broken"
        elif unformatted:
            status = "drift"
        else:
            status = "clean"
        rows.append(
            {
                "site": site,
                "status": status,
                "files_checked": checked,
                "parse_errors": parse_errors,
                "unformatted": unformatted,
            }
        )

    rows.sort(key=lambda r: (STATUS_ORDER[r["status"]], -len(r["parse_errors"]), r["site"]))
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": duration_ms,
        "prettier_exit_code": exit_code,
        "scope": only_site or "fleet",
        "summary": {
            "sites": len(rows),
            "broken": sum(1 for r in rows if r["status"] == "broken"),
            "drift": sum(1 for r in rows if r["status"] == "drift"),
            "clean": sum(1 for r in rows if r["status"] == "clean"),
            "parse_errors": sum(len(r["parse_errors"]) for r in rows),
            "unformatted": sum(len(r["unformatted"]) for r in rows),
            "files_checked": sum(r["files_checked"] for r in rows),
        },
        "sites": rows,
    }
    return report


def persist(report: dict, previous: dict) -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    # A single-site rescan must not clobber the fleet baseline that "what's new"
    # is computed from — merge it into the previous fleet report instead.
    if report["scope"] != "fleet" and previous.get("sites"):
        merged = dict(previous)
        by_site = {s["site"]: s for s in previous["sites"]}
        for row in report["sites"]:
            by_site[row["site"]] = row
        merged["sites"] = sorted(
            by_site.values(),
            key=lambda r: (STATUS_ORDER[r["status"]], -len(r["parse_errors"]), r["site"]),
        )
        merged["generated_at"] = report["generated_at"]
        merged["partial_rescan"] = report["scope"]
        merged["summary"] = {
            "sites": len(merged["sites"]),
            "broken": sum(1 for r in merged["sites"] if r["status"] == "broken"),
            "drift": sum(1 for r in merged["sites"] if r["status"] == "drift"),
            "clean": sum(1 for r in merged["sites"] if r["status"] == "clean"),
            "parse_errors": sum(len(r["parse_errors"]) for r in merged["sites"]),
            "unformatted": sum(len(r["unformatted"]) for r in merged["sites"]),
            "files_checked": sum(r["files_checked"] for r in merged["sites"]),
        }
        LATEST.write_text(json.dumps(merged, indent=2))
    else:
        LATEST.write_text(json.dumps(report, indent=2))

    with HISTORY.open("a") as fh:
        fh.write(
            json.dumps(
                {
                    "at": report["generated_at"],
                    "scope": report["scope"],
                    **report["summary"],
                }
            )
            + "\n"
        )


TASK_TMPL = """---
title: "Fix prettier parse errors in {count} file(s)"
priority: 3
type: engineering
estimated_turns: 8
created: {date}
assigned_role: engineer
source: tools/lint-fleet/lint-sweep.py
---
The shared pre-commit prettier hook cannot parse these files, so it silently
skips them and they are never formatted. Fix the source so prettier parses them
-- do not add them to a .prettierignore.

{files}

Known causes and their fixes (see reviewtattoo.com commit d1c52c0 for worked
examples of all three):

- `<!-- HTML comment -->` inside a template expression (`{{items.map(...)}}` or
  `{{cond && (...)}}`): not valid as a JSX child. Convert to `{{/* ... */}}`.
  Comments in the plain top-level template are fine as-is.
- A raw `<svg>`/`<`-bearing data URI inside an attribute value: hoist it to a
  percent-encoded const in the frontmatter and reference it with `style={{...}}`.
- A `<script>` with a real JS body inside a template expression: move the body
  to a sibling `.js` file, import it with `?raw`, and render via `set:html`.

Verify with:
    /home/jesse/projects/domains/node_modules/.bin/prettier --check 'site/src/**/*.{{ts,tsx,js,astro}}'
then build the site and confirm the rendered output is unchanged before pushing.
"""


def file_tasks(root: Path, report: dict) -> list[str]:
    """Escalate parse errors to each site's own engineer role via its task board.

    This is the only path in this tool that leads to an AI invocation, and it is
    deliberately indirect: we write a task file, the site's existing engineer
    picks it up on its own schedule. Idempotent — one open task per site.
    """
    written = []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for row in report["sites"]:
        if not row["parse_errors"]:
            continue
        board = root / "sites" / row["site"] / "ops" / "tasks"
        if not (board / "backlog").is_dir():
            continue
        name = "lint-parse-errors.md"
        # Already queued or already being worked — don't stack duplicates.
        if any((board / d / name).exists() for d in ("backlog", "in-progress")):
            continue
        files = "\n".join(
            f"- `{e['file']}` — {e['message']}" for e in row["parse_errors"]
        )
        (board / "backlog" / name).write_text(
            TASK_TMPL.format(count=len(row["parse_errors"]), date=today, files=files)
        )
        written.append(f"{row['site']}/ops/tasks/backlog/{name}")
    return written


def print_table(report: dict, new: list[dict], resolved: list[dict]) -> None:
    s = report["summary"]
    print(
        f"Fleet lint sweep — {s['sites']} sites, {s['files_checked']} files, "
        f"{report['duration_ms'] / 1000:.1f}s"
    )
    print(
        f"  broken {s['broken']}   drift {s['drift']}   clean {s['clean']}   "
        f"parse errors {s['parse_errors']}   unformatted {s['unformatted']}"
    )
    print()
    print(f"{'SITE':<28} {'STATUS':<8} {'PARSE':>5} {'DRIFT':>6} {'FILES':>6}")
    for row in report["sites"]:
        if row["status"] in ("clean", "empty"):
            continue
        print(
            f"{row['site']:<28} {row['status']:<8} {len(row['parse_errors']):>5} "
            f"{len(row['unformatted']):>6} {row['files_checked']:>6}"
        )
    broken = [r for r in report["sites"] if r["parse_errors"]]
    if broken:
        print("\nParse errors (prettier is silently skipping these):")
        for row in broken:
            for err in row["parse_errors"]:
                print(f"  {row['site']}/{err['file']}")
                print(f"      {err['message']}")
    if new:
        print(f"\nNEW since last sweep ({len(new)}):")
        for item in new:
            print(f"  {item['site']}/{item['file']}")
    if resolved:
        print(f"\nResolved since last sweep ({len(resolved)}):")
        for item in resolved:
            print(f"  {item['site']}/{item['file']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=str(DEFAULT_ROOT))
    ap.add_argument("--site", default=None, help="rescan a single site")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument(
        "--no-write", action="store_true", help="do not update reports/ on disk"
    )
    ap.add_argument(
        "--file-tasks",
        action="store_true",
        help="queue an engineering task on each affected site's board",
    )
    ap.add_argument(
        "--fail-on-new",
        action="store_true",
        help="exit 1 if a parse error appeared since the last sweep",
    )
    ap.add_argument(
        "--fail-on-parse",
        action="store_true",
        help="exit 1 if any parse error exists at all",
    )
    args = ap.parse_args()

    root = Path(args.root).resolve()
    previous = load_previous()
    report = build_report(root, args.site, args.timeout)
    new, resolved = diff_against(previous, report["sites"])
    report["new_parse_errors"] = new
    report["resolved_parse_errors"] = resolved

    if args.file_tasks:
        report["tasks_filed"] = file_tasks(root, report)

    if not args.no_write:
        persist(report, previous)

    if args.json:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print_table(report, new, resolved)
        if report.get("tasks_filed"):
            print(f"\nTasks filed ({len(report['tasks_filed'])}):")
            for path in report["tasks_filed"]:
                print(f"  {path}")

    if args.fail_on_new and new:
        return 1
    if args.fail_on_parse and report["summary"]["parse_errors"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
