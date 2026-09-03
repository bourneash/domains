#!/usr/bin/env python3
"""task-budget — reusable turn-budget derivation for writer-type cron roles
across the fleet, plus a read-only, zero-token fleet audit.

Root cause this exists for: writer roles (content-writer, news-writer, etc.)
historically got a flat --max-turns for every run regardless of what the next
backlog task actually needs. An under-scoped task can silently burn the whole
flat budget with nothing committed (reviewtattoo.com, 2026-07-18: one task ate
all 40 turns; 0daynews.com's news-writer has hit this 90+ times in its logs).
This derives the budget from the task's own `estimated_turns` instead.

Two modes:

  runtime  — invoked from inside a site's worker container by run-role.sh,
             cwd == the site's repo root (/work). Reads ops/tasks/backlog/*.md,
             picks the task the role would pick (lowest priority, then oldest
             created, assigned_role == role, not blocked_on), and prints ONE
             integer: min(hard_cap, max(floor, estimated_turns + buffer + 1)).
             Falls back to --fallback on any missing/unparseable data — never
             blocks a run.

  audit    — invoked on the host against the whole fleet (read-only, no
             container needed). For every site under <fleet-root>/sites/*:
               - parses ops/scripts/run-role.sh for each role's configured
                 static MAX_TURNS
               - computes what the dynamic budget would be right now
               - flags backlog tasks whose assigned_role has no matching file
                 in that site's ops/roles/ (the "dead role" rot that buried a
                 live $4,861 Amazon Creator Connections task on reviewtattoo.com
                 for a month)
             Prints a table, or --json for the fleet-dashboard server to
             render (same pattern as tools/engineer-fleet/engineer-status.py).

Nothing here ever writes. Pure read + stdout.

Deliberately zero third-party dependencies (stdlib only) — this runs inside
each site's worker container via a read-only bind mount, and most of those
containers do NOT have PyYAML installed (only 0daynews.com's does). Task
frontmatter across the fleet is flat `key: value` pairs (no nesting, no
lists) so a hand-rolled parser is sufficient and avoids that landmine.
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys

DEFAULT_HARD_CAP = 40
DEFAULT_FLOOR = 10
# Claude reports the turn that discovers the cap as cap+1 (for example,
# `21/20`). Keep that bookkeeping turn out of the task estimate's usable
# budget so a task sized at 12 with the default buffer gets 21 turns, not 20.
DEFAULT_BUFFER = 8
CAP_REPORTING_MARGIN = 1

# 2026-08-23 token-usage audit: a completed 0daynews.com task
# (2026-08-20-cve-2026-19490-*, estimated_turns: 10) never got moved from
# in-progress/ to done/. pick_next_task() always checks in-progress FIRST,
# so that one task — sitting there for free, doing nothing — kept winning
# the task-pick on every single news-writer run for 3 days, capping the
# real per-run budget at 18 turns (10 + buffer) regardless of what the
# writer actually needed. Directly caused a run to die at turn 19/18 with
# nothing shipped ($0.81, error_max_turns). in-progress/ is meant to hold a
# task an agent is actively mid-work on — it doesn't have a self-cleaning
# mechanism, so nothing ever notices when one just gets forgotten there.
# STALE_IN_PROGRESS_DAYS is deliberately generous: a task genuinely being
# iterated on across several runs is normal; one untouched for this long is
# a smell worth a human glance, not proof of a bug.
STALE_IN_PROGRESS_DAYS = 3


def _parse_frontmatter(fm_text):
    """Minimal flat `key: value` frontmatter parser — stdlib only, no PyYAML.
    Strips surrounding quotes; leaves everything else as a string (callers
    coerce to int where needed)."""
    data = {}
    for line in fm_text.splitlines():
        line = line.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        data[key] = val
    return data


def _load_task(path):
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except Exception:
        return None
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    data = _parse_frontmatter(parts[1])
    return data if data else None


def _scan_dir(task_dir, role, skip_types=frozenset()):
    candidates = []
    for path in glob.glob(os.path.join(task_dir, "*.md")):
        data = _load_task(path)
        if not data:
            continue
        if data.get("assigned_role") != role:
            continue
        if data.get("blocked_on"):
            continue
        if data.get("type") in skip_types:
            continue
        priority = data.get("priority", 5)
        try:
            priority = int(priority)
        except (TypeError, ValueError):
            priority = 5
        created = str(data.get("created", "9999-99-99"))
        candidates.append((priority, created, data, path))
    candidates.sort(key=lambda c: (c[0], c[1]))
    return candidates


def pick_next_task(backlog_dir, role, skip_types=frozenset()):
    """Same selection rule content-writer.md (and its siblings) describe:
    lowest priority number first, tie-broken by oldest `created` date.

    Checks `ops/tasks/in-progress/` FIRST, sibling of backlog_dir. A task
    left in-progress means a prior run picked it up and didn't finish (hit
    its turn budget, crashed, etc.) — the role prompt tells the agent to
    keep working the backlog/in-progress board, so in practice the agent
    resumes that stuck task rather than abandoning it for a fresh backlog
    pick. Before this, the budget was computed from whatever unrelated task
    topped the backlog, completely decoupled from the task actually being
    worked (2026-08-15 incident on reviewtattoo.com: writer was resuming a
    4-file style-page batch estimated at 20 turns, but the budget was
    calculated from a different, unrelated backlog task estimated at 15
    turns — a 23-turn budget for 20-turns-worth-of-work-already-partially-
    spent, hit the ceiling mid-file with nothing committed for that file).

    `skip_types` (2026-08-23): excludes tasks of the given `type`(s)
    entirely. Built for `type: ops` "awareness" tasks (no deliverable file,
    a standing note the agent should keep in mind across many runs — e.g.
    "route more stories to persona X until the byline split rebalances") —
    their estimated_turns reflects reading the note, not doing a session's
    worth of real work, so using one to size a budget produces a session
    that's guaranteed too tight. Observed live on 0daynews.com 2026-08-23:
    an ops task (estimated_turns: 3) was about to become the top pick right
    after an unrelated stale-task fix, which would have computed an
    11-turn budget — tighter than the 18-turn budget that had JUST caused a
    real error_max_turns failure the same day.
    """
    in_progress_dir = os.path.join(os.path.dirname(os.path.normpath(backlog_dir)), "in-progress")
    if os.path.isdir(in_progress_dir):
        in_progress = _scan_dir(in_progress_dir, role, skip_types)
        if in_progress:
            return in_progress[0]
    candidates = _scan_dir(backlog_dir, role, skip_types)
    if not candidates:
        return None
    return candidates[0]


def compute_budget(estimated_turns, hard_cap, floor, buffer_):
    try:
        est = int(estimated_turns)
    except (TypeError, ValueError):
        return None
    if est <= 0:
        return None
    return min(hard_cap, max(floor, est + buffer_ + CAP_REPORTING_MARGIN))


def cmd_runtime(args):
    task = pick_next_task(args.backlog_dir, args.role, skip_types={"ops"})
    if not task:
        print(args.fallback)
        return
    _, _, data, _ = task
    budget = compute_budget(
        data.get("estimated_turns"), args.hard_cap, args.floor, args.buffer
    )
    print(budget if budget is not None else args.fallback)


def cmd_next_task(args):
    """Print the selected task path for a caller that wants to preload it."""
    task = pick_next_task(args.backlog_dir, args.role, skip_types={"ops"})
    if task:
        print(task[3])


# ---------------------------------------------------------------------------
# Audit mode
# ---------------------------------------------------------------------------

# Matches `<role>)  MAX_TURNS=<n>` or `<role>)   MAX_TURNS=<n>; ...` style
# case-statement lines. Tolerant of the several dialects seen across the fleet
# (semicolon-separated extra fields, comments, varying whitespace).
MAX_TURNS_RE = re.compile(
    r'^\s*([a-zA-Z0-9_,\-\s"|*]+)\)\s*MAX_TURNS="?\$\{?MAX_TURNS:?-?(\d+)\}?"?|'
    r'^\s*([a-zA-Z0-9_,\-\s"|*]+)\)\s*MAX_TURNS=(\d+)',
    re.MULTILINE,
)


def parse_static_turns(run_role_path):
    """Best-effort scrape of each role's configured static MAX_TURNS out of a
    site's run-role.sh case statement. Returns {role: int}. Intentionally
    tolerant — this is an audit signal, not a source of truth."""
    try:
        text = open(run_role_path, encoding="utf-8").read()
    except Exception:
        return {}
    out = {}
    for m in re.finditer(r'^\s*([a-zA-Z0-9_,"|*\-]+)\)\s*(.*MAX_TURNS[=:].*)$', text, re.MULTILINE):
        label, rest = m.group(1), m.group(2)
        num = re.search(r"MAX_TURNS=\"?\$?\{?MAX_TURNS:?-?(\d+)", rest) or re.search(r"MAX_TURNS=(\d+)", rest)
        if not num:
            continue
        turns = int(num.group(1))
        for role in re.split(r"[|,]", label):
            role = role.strip().strip('"').strip("*")
            if role and role != "*":
                out[role] = turns
    return out


def site_roles(site_dir):
    roles_dir = os.path.join(site_dir, "ops", "roles")
    if not os.path.isdir(roles_dir):
        return set()
    return {
        os.path.splitext(f)[0]
        for f in os.listdir(roles_dir)
        if f.endswith(".md")
    }


def find_wrapper_scripts(site_dir, real_roles):
    """Some sites dispatch a role to a dedicated ops/scripts/run-<role>.sh
    instead of the inline case statement in run-role.sh (e.g. 0daynews.com's
    news-writer -> run-news-writer.sh). Their MAX_TURNS lives in that wrapper,
    not in run-role.sh, and run-role.sh's own case-statement entry for that
    role (if any) is a dead fallback path only used if the wrapper is
    missing. Returns {role: (wrapper_path, turns_found)}."""
    scripts_dir = os.path.join(site_dir, "ops", "scripts")
    out = {}
    if not os.path.isdir(scripts_dir):
        return out
    for role in real_roles:
        candidate = os.path.join(scripts_dir, f"run-{role}.sh")
        if not os.path.isfile(candidate):
            continue
        try:
            text = open(candidate, encoding="utf-8").read()
        except Exception:
            continue
        m = re.search(r"^\s*MAX_TURNS=(\d+)", text, re.MULTILINE)
        out[role] = (candidate, int(m.group(1)) if m else None)
    return out


def _find_stale_in_progress(site_dir, stale_days):
    """Any ops/tasks/in-progress/*.md whose `created` date is more than
    `stale_days` old. Age is a proxy for 'is anyone actually iterating on
    this', not proof of staleness — a task can legitimately sit while its
    role works other priorities first. Flag it, don't auto-close it: only a
    human (or an engineer-role task) should judge whether the work is
    actually done vs. genuinely still in flight."""
    in_progress_dir = os.path.join(site_dir, "ops", "tasks", "in-progress")
    if not os.path.isdir(in_progress_dir):
        return []
    today = datetime.date.today()
    stale = []
    for path in glob.glob(os.path.join(in_progress_dir, "*.md")):
        data = _load_task(path)
        if not data:
            continue
        created = data.get("created")
        try:
            created_date = datetime.date.fromisoformat(str(created))
        except (TypeError, ValueError):
            continue
        age_days = (today - created_date).days
        if age_days > stale_days:
            stale.append({
                "file": os.path.basename(path),
                "title": data.get("title"),
                "assigned_role": data.get("assigned_role"),
                "priority": data.get("priority"),
                "created": created,
                "age_days": age_days,
            })
    stale.sort(key=lambda t: -t["age_days"])
    return stale


def audit_site(site_dir, hard_cap, floor, buffer_, stale_days=STALE_IN_PROGRESS_DAYS):
    slug = os.path.basename(site_dir.rstrip("/"))
    backlog_dir = os.path.join(site_dir, "ops", "tasks", "backlog")
    run_role_path = os.path.join(site_dir, "ops", "scripts", "run-role.sh")

    real_roles = site_roles(site_dir)
    static_turns = parse_static_turns(run_role_path)
    wrappers = find_wrapper_scripts(site_dir, real_roles)
    for role, (path, turns) in wrappers.items():
        if turns is not None:
            static_turns[role] = turns

    roles_in_backlog = set()
    dead_role_tasks = []
    if os.path.isdir(backlog_dir):
        for path in glob.glob(os.path.join(backlog_dir, "*.md")):
            data = _load_task(path)
            if not data:
                continue
            ar = data.get("assigned_role")
            if not ar:
                continue
            roles_in_backlog.add(ar)
            if real_roles and ar not in real_roles:
                dead_role_tasks.append({"file": os.path.basename(path), "assigned_role": ar})

    role_rows = []
    for role in sorted(roles_in_backlog | (real_roles & set(static_turns))):
        task = pick_next_task(backlog_dir, role, skip_types={"ops"}) if os.path.isdir(backlog_dir) else None
        computed = None
        next_task_title = None
        if task:
            _, _, data, path = task
            computed = compute_budget(data.get("estimated_turns"), hard_cap, floor, buffer_)
            next_task_title = data.get("title") or os.path.basename(path)
        role_rows.append({
            "role": role,
            "role_installed": role in real_roles,
            "static_max_turns": static_turns.get(role),
            "computed_max_turns": computed,
            "next_task": next_task_title,
            "dispatch": "wrapper" if role in wrappers else "run-role.sh",
            "wrapper_script": wrappers[role][0] if role in wrappers else None,
        })

    return {
        "site": slug,
        "roles": role_rows,
        "dead_role_tasks": dead_role_tasks,
        "stale_in_progress_tasks": _find_stale_in_progress(site_dir, stale_days),
        "run_role_sh_present": os.path.isfile(run_role_path),
    }


def cmd_audit(args):
    sites_dir = os.path.join(args.fleet_root, "sites")
    results = []
    for name in sorted(os.listdir(sites_dir)):
        site_dir = os.path.join(sites_dir, name)
        if not os.path.isdir(os.path.join(site_dir, "ops")):
            continue
        if name.startswith("DISABLED-"):
            continue
        results.append(audit_site(site_dir, args.hard_cap, args.floor, args.buffer, args.stale_days))

    if args.json:
        print(json.dumps(results, indent=2))
        return

    for site in results:
        if not site["roles"] and not site["dead_role_tasks"] and not site["stale_in_progress_tasks"]:
            continue
        print(f"== {site['site']} ==")
        for r in site["roles"]:
            flag = ""
            if r["static_max_turns"] is not None and r["computed_max_turns"] is not None:
                if abs(r["static_max_turns"] - r["computed_max_turns"]) >= 10:
                    flag = "  <-- static vs computed drift"
            installed = "" if r["role_installed"] else "  [NOT INSTALLED — dead role]"
            wrapper = f"  [wrapper: {r['wrapper_script']}]" if r["dispatch"] == "wrapper" else ""
            print(
                f"  {r['role']:<20} static={r['static_max_turns']!s:<5} "
                f"computed={r['computed_max_turns']!s:<5} "
                f"next='{r['next_task']}'{installed}{flag}{wrapper}"
            )
        for d in site["dead_role_tasks"]:
            print(f"  DEAD ROLE TASK: {d['file']} -> assigned_role={d['assigned_role']} (no such role installed)")
        for s in site["stale_in_progress_tasks"]:
            print(
                f"  STALE IN-PROGRESS ({s['age_days']}d): {s['file']} "
                f"-> assigned_role={s['assigned_role']} priority={s['priority']} "
                f"'{s['title']}' — verify this isn't already done; it wins task-pick "
                f"and sets the turn budget on every run for its role until moved to done/"
            )
        print()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="mode", required=True)

    rt = sub.add_parser("runtime", help="print one integer --max-turns for ROLE, cwd=site repo root")
    rt.add_argument("role")
    rt.add_argument("--backlog-dir", default="ops/tasks/backlog")
    rt.add_argument("--hard-cap", type=int, default=DEFAULT_HARD_CAP)
    rt.add_argument("--floor", type=int, default=DEFAULT_FLOOR)
    rt.add_argument("--buffer", type=int, default=DEFAULT_BUFFER)
    rt.add_argument("--fallback", type=int, default=DEFAULT_HARD_CAP)
    rt.set_defaults(func=cmd_runtime)

    nt = sub.add_parser("next-task", help="print the selected task path")
    nt.add_argument("role")
    nt.add_argument("--backlog-dir", default="ops/tasks/backlog")
    nt.set_defaults(func=cmd_next_task)

    au = sub.add_parser("audit", help="fleet-wide read-only audit, run on the host")
    au.add_argument("--fleet-root", default=os.path.expanduser("~/projects/domains"))
    au.add_argument("--hard-cap", type=int, default=DEFAULT_HARD_CAP)
    au.add_argument("--floor", type=int, default=DEFAULT_FLOOR)
    au.add_argument("--buffer", type=int, default=DEFAULT_BUFFER)
    au.add_argument("--stale-days", type=int, default=STALE_IN_PROGRESS_DAYS,
                     help="flag in-progress tasks older than this (see module docstring)")
    au.add_argument("--json", action="store_true")
    au.set_defaults(func=cmd_audit)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
