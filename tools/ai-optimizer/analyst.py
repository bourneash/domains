#!/usr/bin/env python3
"""ai-optimizer analyst pre-compute — ZERO AI.

Builds the evidence packet the daily analyst session reasons over. Everything
here is deterministic; the Claude session that consumes it spends its turns on
judgement, not on data gathering.

THE POINT OF THIS FILE
----------------------
The failure mode this whole tool exists to prevent is "expensive in the
aggregate window" being mistaken for "broken right now". The fix for that is
NOT to ask the agent nicely to check git — it's to do the check here, in code,
and hand over the answer:

    for every (site, role) candidate, find the commits inside the window that
    touched that role's own files, then compare call volume BEFORE vs AFTER
    each one.

A role whose calls collapse after a mid-window commit has already been fixed.
That single check is what would have caught both false positives in the
2026-08-25 session (0daynews page-designer: 19 calls before the 08-19 cutover,
1 after; newmomshop engineer: 862 before, 7 after). Candidates flagged
`likely_already_fixed` are handed to the session pre-labelled so it stops
rather than files.

Output: one JSON object on stdout.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[2]

# A role is only worth a session's attention above this. Below it, even a
# perfect fix cannot pay for the tokens spent proposing it.
MIN_COST_USD = 3.0

# Files that ARE the role — a commit touching one of these can plausibly have
# changed its cost profile. Checked per candidate, in this order.
def role_paths(role: str):
    return [
        f"ops/roles/{role}.md",
        f"ops/scripts/run-{role}.sh",
        "ops/scripts/run-role.sh",
        "ops/scripts/run-worker.sh",
    ]


def sh(args, cwd=None, timeout=60):
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.stdout.strip() if p.returncode == 0 else ""
    except (subprocess.TimeoutExpired, OSError):
        return ""


def load_ledger(root: Path, since: date, until: date):
    """Every tracked call in the window, per (site, role), with its day."""
    rows = defaultdict(list)
    for site_dir in sorted((root / "sites").glob("*")):
        if not (site_dir / "ops").is_dir():
            continue
        site = site_dir.name
        for fp in sorted((site_dir / "ops" / "logs").glob("token-usage-*.jsonl")):
            m = re.search(r"token-usage-(\d{4}-\d{2}-\d{2})\.jsonl$", fp.name)
            if not m:
                continue
            day = m.group(1)
            if not (since.isoformat() <= day <= until.isoformat()):
                continue
            try:
                lines = fp.read_text(encoding="utf-8", errors="ignore").splitlines()
            except OSError:
                continue
            for line in lines:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                role = d.get("role") or "?"
                cost = d.get("total_cost_usd")
                if cost is None:
                    cost = sum((mu or {}).get("costUSD", 0)
                               for mu in (d.get("model_usage") or {}).values())
                rows[(site, role)].append({
                    "day": day,
                    "cost": float(cost or 0),
                    "is_error": bool(d.get("is_error")),
                    "subtype": d.get("subtype"),
                    "num_turns": d.get("num_turns"),
                    "requested_max_turns": d.get("requested_max_turns"),
                })
    return rows


def commits_in_window(site_dir: Path, paths, since: date, until: date):
    """Commits touching this role's files inside the window, oldest first."""
    out = []
    existing = [p for p in paths if (site_dir / p).exists()]
    if not existing:
        return out
    raw = sh(["git", "log", "--since", since.isoformat(),
              "--until", (until + timedelta(days=1)).isoformat(),
              "--reverse", "--format=%H%x1f%ad%x1f%s", "--date=short",
              "--"] + existing, cwd=site_dir)
    for line in raw.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 3:
            out.append({"sha": parts[0][:8], "date": parts[1], "subject": parts[2]})
    return out


def split_by_date(calls, pivot_day: str):
    before = [c for c in calls if c["day"] < pivot_day]
    after = [c for c in calls if c["day"] >= pivot_day]
    return before, after


def analyse_candidate(root: Path, site: str, role: str, calls, since: date, until: date):
    site_dir = root / "sites" / site
    total_cost = sum(c["cost"] for c in calls)
    errors = [c for c in calls if c["is_error"]]
    max_turns_fails = [c for c in errors if c.get("subtype") == "error_max_turns"]

    commits = commits_in_window(site_dir, role_paths(role), since, until)

    # THE CHECK. For each mid-window commit touching this role, how did call
    # volume and spend change across it? A steep drop means the fix is in.
    deltas = []
    likely_fixed = False
    for c in commits:
        before, after = split_by_date(calls, c["date"])
        pivot = date.fromisoformat(c["date"])
        # Rates are per ELAPSED CALENDAR DAY, never per day-with-calls. Using
        # active days hides the exact thing we are looking for: a role that
        # STOPPED running still has a high calls-per-active-day, so a real fix
        # scores as "no change" (observed on 0daynews page-designer — 81 calls
        # over 9 days before the cutover, 8 over 1 day after, which looked flat
        # per-active-day and was in fact a role being switched off).
        days_before = max((pivot - since).days, 1)
        days_after = max((until - pivot).days + 1, 1)
        rate_before = len(before) / days_before
        rate_after = len(after) / days_after

        if not before:
            deltas.append({**c, "calls_before": 0, "calls_after": len(after),
                           "verdict": "inconclusive (no calls before this commit in window)"})
            continue

        # Zero calls after a commit that touched the role is the STRONGEST
        # already-fixed signal there is, not an inconclusive one.
        if not after and days_after >= 2:
            likely_fixed = True
            deltas.append({
                **c, "calls_before": len(before), "calls_after": 0,
                "calls_per_day_before": round(rate_before, 2), "calls_per_day_after": 0.0,
                "cost_before": round(sum(x["cost"] for x in before), 2), "cost_after": 0.0,
                "verdict": (f"role made ZERO calls in the {days_after}d after this commit "
                            "(was {:.1f}/day) — LIKELY ALREADY FIXED".format(rate_before)),
            })
            continue
        if not after:
            deltas.append({**c, "calls_before": len(before), "calls_after": 0,
                           "verdict": "inconclusive (commit at window edge, <2d after)"})
            continue

        drop = 1 - (rate_after / rate_before) if rate_before else 0
        verdict = "no material change"
        if drop >= 0.7:
            verdict = f"calls/day fell {drop:.0%} after this commit — LIKELY ALREADY FIXED"
            likely_fixed = True
        elif drop <= -0.7:
            verdict = "calls/day rose sharply after this commit"
        deltas.append({
            **c,
            "calls_before": len(before), "calls_after": len(after),
            "calls_per_day_before": round(rate_before, 2),
            "calls_per_day_after": round(rate_after, 2),
            "cost_before": round(sum(x["cost"] for x in before), 2),
            "cost_after": round(sum(x["cost"] for x in after), 2),
            "verdict": verdict,
        })

    # Cheap read of the live dispatch: does anything gate this role before
    # Claude is invoked? Presence of a gate is the single strongest signal
    # that a "runs unconditionally" finding is stale.
    gate_hits = []
    for p in ("ops/scripts/run-role.sh", f"ops/scripts/run-{role}.sh"):
        fp = site_dir / p
        if not fp.exists():
            continue
        try:
            text = fp.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for pat, label in (
            (rf'"\$ROLE"\s*==\s*"{re.escape(role)}"', "has a dedicated dispatch branch"),
            (r"skipped Claude entirely|skipping claude|no Claude session|zero Claude",
             "has a zero-AI skip path"),
            (r"gate", "mentions a gate"),
        ):
            if re.search(pat, text, re.I):
                gate_hits.append({"file": p, "signal": label})

    return {
        "site": site,
        "role": role,
        "calls": len(calls),
        "errors": len(errors),
        "max_turns_failures": len(max_turns_fails),
        "max_turns_wasted_usd": round(sum(c["cost"] for c in max_turns_fails), 2),
        "total_cost_usd": round(total_cost, 2),
        "cost_per_call_usd": round(total_cost / len(calls), 3) if calls else 0,
        "first_day": min(c["day"] for c in calls),
        "last_day": max(c["day"] for c in calls),
        "active_days": len({c["day"] for c in calls}),
        "commits_touching_role_in_window": deltas,
        "likely_already_fixed": likely_fixed,
        "existing_gate_signals": gate_hits,
        "role_file_exists": (site_dir / f"ops/roles/{role}.md").exists(),
        "git_log_recent": [
            l for l in sh(["git", "log", "-5", "--format=%ad %h %s", "--date=short",
                           "--"] + [p for p in role_paths(role) if (site_dir / p).exists()],
                          cwd=site_dir).splitlines()
        ],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--days", type=int, default=7,
                    help="window size; keep it SHORT — a long window is what "
                         "lets a mid-window fix masquerade as a live bug")
    ap.add_argument("--min-cost", type=float, default=MIN_COST_USD)
    ap.add_argument("--top", type=int, default=8, help="max candidates to hand the session")
    args = ap.parse_args()

    until = datetime.now(timezone.utc).date()
    since = until - timedelta(days=args.days - 1)

    ledger = load_ledger(args.root, since, until)
    ranked = sorted(
        ((k, v) for k, v in ledger.items() if sum(c["cost"] for c in v) >= args.min_cost),
        key=lambda kv: -sum(c["cost"] for c in kv[1]),
    )

    candidates = [analyse_candidate(args.root, site, role, calls, since, until)
                  for (site, role), calls in ranked[:args.top]]

    live = [c for c in candidates if not c["likely_already_fixed"]]
    stale = [c for c in candidates if c["likely_already_fixed"]]

    print(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window": {"from": since.isoformat(), "to": until.isoformat(), "days": args.days},
        "fleet_total_cost_usd": round(sum(c["cost"] for v in ledger.values() for c in v), 2),
        "candidates_live": live,
        "candidates_likely_already_fixed": stale,
        "note": (
            "candidates_likely_already_fixed were EXCLUDED by an automatic "
            "before/after check across commits that touched the role inside the "
            "window. Do not file findings for them without contradicting that "
            "evidence explicitly."
        ),
    }, indent=2))


if __name__ == "__main__":
    main()
