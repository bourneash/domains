#!/usr/bin/env python3
"""engineer-status — dynamic, read-only audit of the Engineer cron role across
every site under sites/. Answers "what engineer does each site have (if any),
is it aligned, and what is it seeing right now?" — without spending any tokens.

Usage:
    python3 tools/engineer-fleet/engineer-status.py            # table
    python3 tools/engineer-fleet/engineer-status.py --json     # machine-readable
    python3 tools/engineer-fleet/engineer-status.py --drift    # only misaligned/legacy/missing

Reads, per site:
  - ops/roles/engineer.md            → engineer installed?
  - ops/scripts/run-engineer.sh      → bash archetype? lock + pulse + daily features
  - ops/docker/crontab[.docker]      → cron schedule (engineer line)
  - ops/.locks/engineer-status.json  → latest liveness pulse (status/render/cf/queue/issues + age)
  - ops/tasks/backlog/*              → queued `assigned_role: engineer` tasks
  - ops/.engineer-disabled / -paused → kill-switch / monitor-only flags
  - `docker ps`                      → is the <slug>-cron container up?

Nothing here writes or commits. It's the liveness source of truth (Slack green is
once/day) — see reference_engineer_pulse_monitoring.
"""
import json, os, re, subprocess, sys, time
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]          # tools/engineer-fleet/ -> repo root
SITES = ROOT / "sites"
NOW = time.time()
PULSE_FRESH_SECS = 35 * 60                            # a tick is every 30 min; >35 min = stale/wedged


def sh(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return ""


def running_cron_containers():
    out = sh("docker", "ps", "--format", "{{.Names}}")
    return {n.strip() for n in out.splitlines() if n.strip()}


def read(p):
    try:
        return p.read_text(errors="replace")
    except Exception:
        return ""


def first_crontab(site_dir):
    for name in ("crontab.docker", "crontab"):
        p = site_dir / "ops" / "docker" / name
        if p.exists():
            return p
    return None


def engineer_cron_line(crontab_path):
    if not crontab_path:
        return None
    for ln in read(crontab_path).splitlines():
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        if re.search(r"run-worker\.sh\s+engineer|run-role\.sh\s+engineer", s):
            # schedule = first 5 fields
            return " ".join(s.split()[:5])
    return None


def age_str(secs):
    if secs is None:
        return "—"
    secs = int(secs)
    if secs < 90:
        return f"{secs}s"
    if secs < 5400:
        return f"{secs // 60}m"
    if secs < 172800:
        return f"{secs // 3600}h"
    return f"{secs // 86400}d"


def audit_site(site_dir):
    slug = site_dir.name
    ops = site_dir / "ops"
    role = ops / "roles" / "engineer.md"
    runner = ops / "scripts" / "run-engineer.sh"
    r = {"site": slug, "engineer": role.exists() or runner.exists(),
         "bash": runner.exists(), "lock": False, "pulse": False, "daily": False,
         "cron": None, "crontab_file": None, "status": None, "pulse_age": None,
         "render": None, "cf": None, "queue": 0, "issues": None,
         "flags": [], "cron_up": None, "tier": "—"}
    if not r["engineer"]:
        r["tier"] = "none"
        return r

    src = read(runner)
    r["lock"] = "acquire_work_lock" in src
    r["pulse"] = "heartbeat_touch" in src
    r["daily"] = ":-86400" in src

    ct = first_crontab(site_dir)
    r["crontab_file"] = ct.name if ct else None
    r["cron"] = engineer_cron_line(ct)

    # latest pulse
    pulse = ops / ".locks" / "engineer-status.json"
    if pulse.exists():
        try:
            d = json.loads(read(pulse))
            r["status"] = d.get("status")
            r["render"] = f'{d.get("render_pass",0)}/{d.get("render_pass",0)+d.get("render_fail",0)}'
            r["cf"] = d.get("cf_ok")
            r["issues"] = d.get("issues")
            ts = d.get("ts")
            if ts:
                t = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
                r["pulse_age"] = NOW - t
        except Exception:
            r["pulse_age"] = NOW - pulse.stat().st_mtime

    # queued engineer tasks (assigned_role: engineer), excluding HOLD-prefixed
    backlog = ops / "tasks" / "backlog"
    q = 0
    if backlog.is_dir():
        for f in backlog.glob("*"):
            if re.match(r"(?i)hold[-_]", f.name):
                continue
            if re.search(r"assigned_role:\s*engineer", read(f)):
                q += 1
    r["queue"] = q

    if (ops / ".engineer-disabled").exists():
        r["flags"].append("DISABLED")
    if (ops / ".engineer-paused").exists():
        r["flags"].append("paused")

    # tier / alignment
    if not r["bash"]:
        r["tier"] = "LEGACY"          # role.md but no bash runner = old generic engineer
    elif r["lock"] and r["pulse"] and r["daily"]:
        r["tier"] = "aligned"
    else:
        r["tier"] = "PARTIAL"         # bash runner missing one of the new features
    return r


def history_rows(days):
    """Compute the success+fail pulse-log summary (ops/logs/engineer-heartbeat-<date>.jsonl)
    over the last `days` days — one dict per site that has logs."""
    EXPECTED_PER_DAY = 48                      # twice-hourly cadence
    out = []
    for d in sorted(p for p in SITES.iterdir() if p.is_dir() and not p.name.startswith("DISABLED-")):
        logs = sorted((d / "ops" / "logs").glob("engineer-heartbeat-*.jsonl")) if (d / "ops" / "logs").is_dir() else []
        logs = logs[-days:]
        if not logs:
            continue
        recs = []
        for lf in logs:
            for ln in read(lf).splitlines():
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    recs.append(json.loads(ln))
                except Exception:
                    pass
        n = len(recs)
        g = sum(1 for r in recs if r.get("status") == "green")
        w = sum(1 for r in recs if r.get("status") == "work")
        i = sum(1 for r in recs if r.get("status") == "issue")
        cfx = sum(1 for r in recs if r.get("cf_ok") == 0)
        last_fail = None
        for r in reversed(recs):
            if r.get("status") != "green" or r.get("cf_ok") == 0:
                last_fail = f'{r.get("status")}{"/cf-down" if r.get("cf_ok")==0 else ""} @ {r.get("ts","?")}'
                break
        cover = int(round(100 * n / (EXPECTED_PER_DAY * len(logs)))) if logs else 0
        # compact spark series (green=ok, anything else=bad) for the UI
        spark = [1 if (r.get("status") == "green" and r.get("cf_ok") != 0) else 0 for r in recs][-60:]
        # Health timeline: bucket pulses into real 30-min slots and walk the most
        # recent TIMELINE_SLOTS of them so the UI can show, in true time order,
        # which runs were ok (2), had an issue/cf-down (1), or were missed (0 — no
        # pulse in that slot, i.e. the cron didn't fire). The trailing in-progress
        # slot is dropped so a not-yet-due run doesn't read as missed.
        SLOT = 1800
        TIMELINE_SLOTS = 48
        slot_code = {}
        for r in recs:
            try:
                t = datetime.fromisoformat(str(r.get("ts", "")).replace("Z", "+00:00"))
            except Exception:
                continue
            b = int(t.timestamp() // SLOT)
            ok = r.get("status") in ("green", "work") and r.get("cf_ok") != 0
            slot_code[b] = min(slot_code.get(b, 2 if ok else 1), 2 if ok else 1)
        now_b = int(NOW // SLOT)
        timeline = [slot_code.get(b, 0) for b in range(now_b - TIMELINE_SLOTS, now_b)]
        out.append({"site": d.name, "ticks": n, "green": g, "work": w, "issue": i,
                    "cf_fail": cfx, "days": len(logs), "coverage": cover,
                    "last_failure": last_fail, "spark": spark, "timeline": timeline})
    return out


def history(days):
    """Print the success+fail pulse-log summary over the last `days` days."""
    hdr = (f'{"SITE":22} {"TICKS":6} {"green":6} {"work":5} {"issue":5} '
           f'{"cf✗":4} {"cover%":7} {"LAST FAILURE (status @ utc)"}')
    print(f"— engineer pulse history, last {days}d (success+fail log) —")
    print(hdr); print("-" * len(hdr))
    rows = history_rows(days)
    for r in rows:
        cflag = "!" if r["coverage"] < 70 else ""   # < 70% coverage → engineer is missing runs (wedged cron?)
        print(f'{r["site"]:22} {r["ticks"]:<6} {r["green"]:<6} {r["work"]:<5} {r["issue"]:<5} '
              f'{r["cf_fail"]:<4} {str(r["coverage"])+"%"+cflag:7} {r["last_failure"] or "—"}')
    if not rows:
        print("(no pulse logs yet — sites populate engineer-heartbeat-<date>.jsonl as they fire)")
    print("cover% = pulses seen / expected (48/day); '!' < 70% → engineer is missing scheduled runs.")


def main():
    args = set(sys.argv[1:])
    if "--history" in args:
        # optional integer day count, default 1
        days = next((int(a) for a in sys.argv[1:] if a.isdigit()), 1)
        if "--json" in args:
            print(json.dumps(history_rows(days), indent=2))
        else:
            history(days)
        return
    cron_up = running_cron_containers()
    rows = []
    for d in sorted(p for p in SITES.iterdir() if p.is_dir() and not p.name.startswith("DISABLED-")):
        row = audit_site(d)
        # cron container presence (best-effort name match)
        base = d.name.replace(".", "-")
        row["cron_up"] = any(c.startswith(base + "-cron") or c == base + "-cron"
                             or c.startswith(d.name.split(".")[0] + "-cron") for c in cron_up)
        rows.append(row)

    eng = [r for r in rows if r["engineer"]]
    if "--json" in args:
        print(json.dumps(rows, indent=2))
        return

    if "--drift" in args:
        rows = [r for r in rows if r["engineer"] and r["tier"] != "aligned"]
        if not rows:
            print("✓ No drift — every site with an engineer is on the aligned bash archetype.")
            return

    # table
    hdr = f'{"SITE":22} {"TIER":8} {"FEATURES":10} {"CRON":14} {"PULSE":7} {"AGE":5} {"RND":6} {"CF":3} {"Q":2} {"FLAGS"}'
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        if not r["engineer"]:
            print(f'{r["site"]:22} {"none":8} {"—":10} {"—":14} {"—":7} {"—":5} {"—":6} {"—":3} {"—":2}')
            continue
        feat = ("L" if r["lock"] else "·") + ("P" if r["pulse"] else "·") + ("D" if r["daily"] else "·")
        feat = f"[{feat}]"
        pulse = r["status"] or "—"
        fresh = ""
        if r["pulse_age"] is not None and r["pulse_age"] > PULSE_FRESH_SECS:
            fresh = "!"                # stale pulse — engineer may be wedged
        flags = ",".join(r["flags"])
        if not r["cron_up"]:
            flags = ("no-cron-container " + flags).strip()
        cf = "—" if r["cf"] is None else ("ok" if r["cf"] else "DOWN")
        print(f'{r["site"]:22} {r["tier"]:8} {feat:10} {str(r["cron"] or "—"):14} '
              f'{pulse:7} {age_str(r["pulse_age"])+fresh:5} {str(r["render"] or "—"):6} '
              f'{cf:3} {r["queue"]:<2} {flags}')

    # summary
    print("-" * len(hdr))
    tiers = {}
    for r in eng:
        tiers[r["tier"]] = tiers.get(r["tier"], 0) + 1
    total_sites = len(rows) if "--drift" not in args else "?"
    stale = [r["site"] for r in eng if r["pulse_age"] and r["pulse_age"] > PULSE_FRESH_SECS]
    print(f'{len(eng)} engineers — ' + ", ".join(f"{k}={v}" for k, v in sorted(tiers.items())))
    print("FEATURES key: L=work-lock  P=liveness-pulse  D=daily-Slack-summary   "
          "AGE '!'=pulse older than 35m (possibly wedged)")
    if stale:
        print("⚠ stale pulse (or never fired since patch): " + ", ".join(stale))


if __name__ == "__main__":
    main()
