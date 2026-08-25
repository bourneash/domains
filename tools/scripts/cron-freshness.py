#!/usr/bin/env python3
"""Tier-2 scheduler-freshness detector for the fleet's site cron containers.

Tier 1 is the per-container Docker healthcheck (`grep -qx supercronic
/proc/1/comm`, see any site's docker-compose.yml). It answers exactly one
question — is supercronic still PID 1 — and it answers it for ~8ms of CPU every
120s. What it structurally CANNOT see is a supercronic that is alive but no
longer firing anything: a wedged scheduler, a job holding a lock forever, a
crontab that parsed to zero jobs. That is the 2026-05-17 failure mode (site
schedulers silently dead for 9 days), and it is the expensive one.

Detecting it means reasoning about each site's schedule and reading its logs.
Doing that per-container would mean 26 heavyweight probes; doing it here means
ONE host-side process for the whole fleet, on a 30-minute cron. That split —
cheap liveness in the container, expensive freshness on the host — is the
budget rule this file exists to honour. See tools/fleet-images/README.md.

The alert threshold is derived per site, never hardcoded: we parse the crontab
that site is ACTUALLY running (resolved from the live container's bind mount,
not an assumed filename — broadwayshowgirls mounts `ops/docker/crontab` with no
suffix), walk the union of its jobs minute-by-minute over the next 8 days (8, to
catch weekly schedules), and take the longest legitimate silence. A site whose
only job is `35 6 * * 1` must not be called stale on Tuesday afternoon.

Output is one finding per line on stdout, empty when the fleet is healthy —
the caller (cron-freshness-cron.sh) owns Slack, logging, and cooldown. A
COVERAGE line goes to stderr on every run: exit 0 alone cannot distinguish
"asserted every site" from "asserted nothing because every container was too
young to judge", and an unfalsifiable green is the exact defect this tier was
built to replace.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from datetime import datetime, timedelta

DOMAINS_ROOT = os.environ.get("FLEET_DOMAINS_ROOT", "/home/jesse/projects/domains")
SITES_DIR = os.path.join(DOMAINS_ROOT, "sites")

# Extra slack on top of 2x the longest legitimate gap. A job that fires every
# 15 min gives a 30m+15m = 45m window; jitter, a slow role run, and a restart
# all fit inside that without crying wolf.
GRACE_SEC = int(os.environ.get("CRON_FRESHNESS_GRACE_SEC", "900"))

# How far ahead to simulate when measuring the longest gap. Must exceed a week
# or weekly-only schedules measure as "never fires".
HORIZON_DAYS = 8

# Restart count at which a container that is perpetually too young to assert
# against is treated as flapping rather than merely fresh. One or two restarts
# are ordinary (an image roll, a deliberate recreate).
FLAP_RESTARTS = int(os.environ.get("CRON_FRESHNESS_FLAP_RESTARTS", "3"))

# supercronic's own structured output. `msg=starting` is emitted for every job
# it dispatches; its presence is the proof the scheduler is still firing.
# Matching job output instead would be wrong — a site can legitimately have a
# silent job, but it cannot have a silent supercronic.
FIRED_RE = re.compile(r"level=info msg=starting")

FIELD_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]


def parse_field(spec: str, lo: int, hi: int) -> set[int] | None:
    """Expand one cron field to the set of values it matches.

    Returns None if the field is unparseable — the caller treats an
    unparseable job as "can't reason about this site" rather than guessing a
    threshold, because a wrong threshold here means either a false alert every
    30 minutes or silence during a real outage.
    """
    out: set[int] = set()
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, _, step_s = part.partition("/")
            if not step_s.isdigit() or int(step_s) < 1:
                return None
            step = int(step_s)
        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part:
            a, _, b = part.partition("-")
            if not (a.isdigit() and b.isdigit()):
                return None
            start, end = int(a), int(b)
        elif part.isdigit():
            start = end = int(part)
        else:
            return None
        if start < lo or end > hi or start > end:
            return None
        out.update(range(start, end + 1, step))
    return out or None


def parse_line(line: str):
    """Return (minutes, hours, doms, months, dows) for one crontab line, or None.

    Skips comments, blanks, and `KEY=value` environment lines (every site's
    crontab.docker opens with COMPOSE_PROJECT_NAME=...).
    """
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", line):
        return None
    fields = line.split(None, 5)
    if len(fields) < 6:
        return None
    sets = []
    for spec, (lo, hi) in zip(fields[:5], FIELD_RANGES):
        got = parse_field(spec, lo, hi)
        if got is None:
            return None
        sets.append(got)
    # dow 7 == Sunday == 0, as every cron implementation accepts.
    if 7 in sets[4]:
        sets[4] = (sets[4] - {7}) | {0}
    # Remember whether dom/dow were restricted — cron ORs them when both are.
    return tuple(sets) + (fields[2].strip() != "*", fields[4].strip() != "*")


def max_gap_sec(path: str) -> tuple[int | None, int, int]:
    """Longest silence the union of this crontab's jobs permits, in seconds.

    Returns (gap_or_None, jobs_parsed, jobs_skipped). None means nothing in
    this crontab fires within the horizon, so freshness is not assertable.
    """
    jobs, skipped = [], 0
    try:
        with open(path) as fh:
            for line in fh:
                parsed = parse_line(line)
                if parsed is None:
                    if line.strip() and not line.strip().startswith("#") \
                            and not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", line.strip()):
                        skipped += 1
                    continue
                jobs.append(parsed)
    except OSError:
        return None, 0, 0
    if not jobs:
        return None, 0, skipped

    now = datetime.now().replace(second=0, microsecond=0)
    end = now + timedelta(days=HORIZON_DAYS)
    fires = []
    t = now
    step = timedelta(minutes=1)
    while t < end:
        m, h, dom, mon, dow = t.minute, t.hour, t.day, t.month, t.weekday()
        # datetime.weekday() is Mon=0; cron is Sun=0.
        cron_dow = (dow + 1) % 7
        for mins, hrs, doms, mons, dows, dom_r, dow_r in jobs:
            if m not in mins or h not in hrs or mon not in mons:
                continue
            if dom_r and dow_r:
                if dom not in doms and cron_dow not in dows:
                    continue
            elif dom not in doms or cron_dow not in dows:
                continue
            fires.append(t)
            break
        t += step

    if not fires:
        return None, len(jobs), skipped
    # Gap from now to the first fire counts too: a site that just started and
    # whose next job is 6 days out must not be judged against a 15m window.
    gaps = [(fires[0] - now).total_seconds()]
    gaps += [(b - a).total_seconds() for a, b in zip(fires, fires[1:])]
    return int(max(gaps)), len(jobs), skipped


def docker(*args: str, merge_stderr: bool = False) -> str:
    """Run a docker command and return its output.

    merge_stderr matters for `docker logs` and only there: supercronic writes
    its own structured lines (`level=info msg=starting`) to STDERR, not stdout.
    Reading stdout alone made every site in the fleet look wedged on the first
    run of this script — 26/26 false positives, which is exactly the kind of
    alert that gets a watchdog muted permanently.
    """
    try:
        proc = subprocess.run(
            ("docker",) + args,
            capture_output=True,
            text=True,
            timeout=60,
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return (proc.stdout + proc.stderr).strip() if merge_stderr else proc.stdout.strip()


def container_name(compose_path: str) -> str | None:
    try:
        with open(compose_path) as fh:
            for line in fh:
                m = re.match(r"\s*container_name:\s*(\S+-cron)\s*$", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return None


def crontab_path(base_dir: str, name: str) -> str | None:
    """Resolve the crontab this container is ACTUALLY running.

    Read from the live container's bind mounts, not from a assumed filename.
    The conventional source is ops/docker/crontab.docker, but broadwayshowgirls
    mounts `ops/docker/crontab` (no suffix) to the same destination — and it is
    healthy, scheduling 18 jobs. Hardcoding the source path made this detector
    silently skip that site: it dropped out of `eligible` entirely and the run
    still reported clean. Silently narrowing coverage is the same failure class
    as an unfailable probe, so resolve what the daemon actually applied.
    """
    fmt = '{{range .Mounts}}{{if eq .Destination "/etc/crontab.docker"}}{{.Source}}{{end}}{{end}}'
    src = docker("inspect", "-f", fmt, name)
    if src and os.path.isfile(src):
        return src
    fallback = os.path.join(base_dir, "ops", "docker", "crontab.docker")
    return fallback if os.path.isfile(fallback) else None


def uptime_sec(name: str) -> int | None:
    started = docker("inspect", "-f", "{{.State.StartedAt}}", name)
    if not started:
        return None
    started = re.sub(r"\.\d+", "", started)
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            dt = datetime.strptime(started, fmt)
            break
        except ValueError:
            continue
    else:
        return None
    if dt.tzinfo is None:
        return int((datetime.utcnow() - dt).total_seconds())
    return int((datetime.now(dt.tzinfo) - dt).total_seconds())


def assess(label: str, base_dir: str, name: str) -> tuple[list[str], int, int]:
    """Assess one scheduler container. Returns (findings, asserted, skipped_young).

    Deliberately generic over which container it is looking at, so the
    fleet-cron self-check reuses this exact window math rather than growing a
    second, subtly-different implementation of it.
    """
    findings: list[str] = []

    state = docker("inspect", "-f", "{{.State.Status}}", name)
    if not state:
        return [f"{label}: cron container `{name}` does not exist"], 0, 0
    if state != "running":
        return [f"{label}: cron container `{name}` is {state}, not running"], 0, 0

    crontab = crontab_path(base_dir, name)
    if crontab is None:
        return [
            f"{label}: cannot resolve the crontab `{name}` is running "
            f"(no /etc/crontab.docker bind mount, no crontab.docker on disk) "
            f"— freshness cannot be asserted"
        ], 0, 0

    gap, njobs, unparseable = max_gap_sec(crontab)
    if unparseable:
        findings.append(
            f"{label}: {unparseable} unparseable line(s) in {os.path.basename(crontab)} — "
            f"freshness window derived from the {njobs} that did parse"
        )
    if gap is None:
        if njobs == 0:
            findings.append(f"{label}: {os.path.basename(crontab)} schedules zero jobs")
        else:
            findings.append(
                f"{label}: none of {njobs} job(s) fire within {HORIZON_DAYS}d — "
                f"schedule is effectively dead"
            )
        return findings, 0, 0

    window = gap * 2 + GRACE_SEC
    up = uptime_sec(name)
    if up is not None and up < window:
        # Not enough history to judge; a freshly restarted container has
        # legitimately not fired anything yet. Counted, not silent — see the
        # COVERAGE line the caller prints.
        #
        # ...unless it is FLAPPING. A container that keeps restarting is never
        # up long enough to assert against, so it would sit in this branch
        # forever and the sweep would report a clean run having checked
        # nothing. That is the same unfalsifiable-green defect as the
        # `pgrep -f` probe this tier replaced, so it gets caught rather than
        # counted. One restart is normal (a roll, a deliberate recreate);
        # repeated ones with no stable window are not.
        restarts = docker("inspect", "-f", "{{.RestartCount}}", name)
        if restarts.isdigit() and int(restarts) >= FLAP_RESTARTS:
            findings.append(
                f"{label}: `{name}` has restarted {restarts}x and is still "
                f"younger than its {window // 60}m freshness window — "
                f"flapping, so freshness has never been asserted"
            )
        return findings, 0, 1

    logs = docker("logs", f"--since={window}s", name, merge_stderr=True)
    if not FIRED_RE.search(logs):
        findings.append(
            f"{label}: `{name}` up but supercronic fired NOTHING in "
            f"{window // 60}m (longest legitimate gap {gap // 60}m, "
            f"{njobs} job(s)) — scheduler wedged"
        )
    return findings, 1, 0


def main() -> int:
    only_fleet_cron = "--fleet-cron" in sys.argv[1:]
    findings = []
    asserted = skipped_young = eligible = 0

    if only_fleet_cron:
        # The scheduler-of-schedulers. This mode exists to be run from the HOST
        # crontab, never from fleet-cron itself: a wedged fleet-cron is exactly
        # the thing that would fail to run the sweep that would report it, so
        # self-checking here would be circular by construction.
        eligible = 1
        findings, asserted, skipped_young = assess(
            "fleet-cron", os.path.join(DOMAINS_ROOT, "tools", "fleet-cron"), "fleet-cron"
        )
    else:
        try:
            sites = sorted(os.listdir(SITES_DIR))
        except OSError as exc:
            print(f"FATAL cannot read {SITES_DIR}: {exc}")
            return 2

        for site in sites:
            site_dir = os.path.join(SITES_DIR, site)
            compose = os.path.join(site_dir, "docker-compose.yml")
            # A site with no compose file, or one that declares no cron
            # service, is a scaffold — silence is correct for those. Anything
            # that DOES declare a scheduler is eligible, and from there an
            # unresolvable site is a finding rather than a quiet skip.
            if not os.path.isfile(compose):
                continue
            name = container_name(compose)
            if not name:
                continue
            eligible += 1
            f, a, s = assess(site, site_dir, name)
            findings.extend(f)
            asserted += a
            skipped_young += s

    for f in findings:
        print(f)
    # Coverage goes to stderr so it never contaminates the findings contract on
    # stdout. Without it, exit 0 means both "asserted all 26 sites" and
    # "asserted nothing because every container was too young" — indistinguishable
    # to the caller, which is exactly the kind of green this tier exists to stop
    # trusting. The wrapper logs this line on every run, healthy or not.
    print(
        f"COVERAGE asserted={asserted} skipped_young={skipped_young} "
        f"eligible={eligible}",
        file=sys.stderr,
    )
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
