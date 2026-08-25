#!/usr/bin/env python3
"""Pure evaluation core for the host-wide container watchdog.

Deliberately has NO docker dependency: it takes already-collected container
records and returns findings. That keeps every rule unit-testable against
fixtures instead of against whatever happens to be running on this host — the
mistake that let an `Exited (255)` container sit unnoticed for six days was a
detector nobody could test.
"""
from datetime import datetime, timedelta, timezone

# A container that is SUPPOSED to stay up. `no` means a one-shot run, and an
# exited one-shot is normal, not a finding.
PERSISTENT_POLICIES = {"always", "unless-stopped", "on-failure"}

# Exit codes that mean "something asked it to stop", not "it failed".
# 143 = 128+SIGTERM, exactly what `docker stop` / `compose down` produces.
# 137 (128+SIGKILL) is deliberately NOT here: it is also what the OOM killer
# leaves behind, and silencing it would hide a container dying of memory.
DEFAULT_BENIGN_EXIT_CODES = (0, 143)


def _parse_time(value):
    if not value:
        return None
    try:
        # docker emits RFC3339 with nanoseconds, which fromisoformat rejects
        # on older Pythons; trim to microseconds.
        v = value.replace("Z", "+00:00")
        if "." in v:
            head, rest = v.split(".", 1)
            frac, _, tail = rest.partition("+")
            v = f"{head}.{frac[:6]}+{tail}" if tail else f"{head}.{frac[:6]}"
        dt = datetime.fromisoformat(v)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _ignored(c, cfg, now):
    """An exclusion applies only if it has a reason, and only until it expires."""
    ign = cfg.get("ignore", {})
    for key, value in (
        ("names", c.get("name")),
        ("projects", c.get("project")),
        ("images", c.get("image")),
    ):
        entry = ign.get(key, {}).get(value)
        if entry is None:
            continue
        if isinstance(entry, str):
            return True  # bare string == the reason
        until = _parse_time(entry.get("until"))
        if until and now > until:
            continue  # expired: stop hiding it
        return True
    return False


def evaluate(containers, cfg, now=None):
    now = now or datetime.now(timezone.utc)
    th = cfg.get("thresholds", {})
    dead_after = timedelta(hours=th.get("dead_after_hours", 6))
    unhealthy_after = timedelta(minutes=th.get("unhealthy_after_minutes", 30))
    restart_warn = th.get("restart_count_warn", 5)
    # RestartCount is CUMULATIVE over the container's whole life, so "14
    # restarts" on something that has been up for six days is history, not a
    # loop. A real crashloop is high restart count AND a recent start.
    crashloop_window = timedelta(minutes=th.get("crashloop_window_minutes", 60))
    benign = set(th.get("benign_exit_codes", DEFAULT_BENIGN_EXIT_CODES))

    findings = []
    for c in containers:
        if _ignored(c, cfg, now):
            continue
        name = c.get("name")
        policy = (c.get("restart_policy") or "no").lower()
        running = bool(c.get("running"))
        exit_code = c.get("exit_code")
        finished = _parse_time(c.get("finished_at"))
        age = (now - finished) if finished else None

        # 1. Dead with a nonzero exit code, long enough that it is not a blip.
        #    This is the B11 case and it is checked for EVERY container on the
        #    host, not just ones whose compose project lives in this repo.
        if not running and exit_code is not None and exit_code not in benign and age and age >= dead_after:
            findings.append(
                {
                    "kind": "dead-nonzero",
                    "name": name,
                    "project": c.get("project"),
                    "detail": f"exited {exit_code}, dead for {int(age.total_seconds() // 3600)}h",
                    "severity": "high" if policy in PERSISTENT_POLICIES else "medium",
                }
            )
            continue

        # 2. Stopped despite a restart policy that says it should be up. Docker
        #    gives up after enough failures, so a clean exit code here is still
        #    a container that is silently NOT running.
        if not running and policy in PERSISTENT_POLICIES and age and age >= dead_after:
            findings.append(
                {
                    "kind": "should-be-running",
                    "name": name,
                    "project": c.get("project"),
                    "detail": f"restart={policy} but stopped for {int(age.total_seconds() // 3600)}h",
                    "severity": "high",
                }
            )
            continue

        # 3. Crash-looping: up right now, but docker has restarted it a lot.
        #    A container that dies and comes back forever never looks "down".
        rc = c.get("restart_count") or 0
        started = _parse_time(c.get("started_at"))
        recently_started = started is not None and (now - started) <= crashloop_window
        if rc >= restart_warn and running and recently_started:
            findings.append(
                {
                    "kind": "crashloop",
                    "name": name,
                    "project": c.get("project"),
                    "detail": f"{rc} restarts, last started {int((now - started).total_seconds() // 60)}m ago",
                    "severity": "high",
                }
            )

        # 4. Failing its own healthcheck. Worth checking separately from
        #    "running", because an unhealthy container still reports as up.
        if running and (c.get("health") or "").lower() == "unhealthy":
            since = _parse_time(c.get("health_since"))
            if not since or (now - since) >= unhealthy_after:
                findings.append(
                    {
                        "kind": "unhealthy",
                        "name": name,
                        "project": c.get("project"),
                        "detail": "healthcheck failing",
                        "severity": "high",
                    }
                )

    order = {"high": 0, "medium": 1, "low": 2}
    findings.sort(key=lambda f: (order.get(f["severity"], 9), f["name"] or ""))
    return findings
