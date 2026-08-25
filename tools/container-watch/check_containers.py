#!/usr/bin/env python3
"""check_containers.py — host-wide container watchdog. Zero AI.

Why this exists
---------------
The Fleet Dashboard's Containers tab filters to containers whose compose
`working_dir` is inside the domains repo. That is the right scope for the tab
and the wrong scope for a watchdog: on 2026-08-25 an `Exited (255)` container
from a different project sat dead for SIX DAYS and nothing anywhere mentioned
it, because it lived outside the repo (B11). A watchdog that only watches what
it owns cannot tell you about the thing nobody owns.

This looks at every container on the host and reports four states that all
LOOK fine from a distance:

  dead-nonzero      exited with a nonzero code and stayed dead
  should-be-running restart=always/unless-stopped, yet stopped anyway
  crashloop         up right now, but restarted many times — never looks "down"
  unhealthy         running and failing its own healthcheck

Collection is here; the rules are in evaluate.py with no docker dependency, so
they are unit-tested against fixtures rather than against whatever this host
happens to be running.
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "config.json")
sys.path.insert(0, HERE)
from evaluate import evaluate  # noqa: E402


def docker(args, timeout=30):
    try:
        r = subprocess.run(
            ["docker", *args], capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, f"docker {' '.join(args)} failed: {e}"
    if r.returncode != 0:
        return None, (r.stderr or "").strip() or f"docker exited {r.returncode}"
    return r.stdout, None


def collect(attempts=3, backoff=3):
    """Every container on the host, with the fields the rules need.

    Retries before giving up: a `docker restart` of this very container, a
    daemon reload, or a busy host all make a single call fail for a second or
    two. Observed in practice on 2026-08-25 — one transient miss fired a
    "watchdog is BLIND" page. A real outage still fails every attempt.
    """
    last = None
    for i in range(attempts):
        rows, err = _collect_once()
        if err is None:
            return rows, None
        last = err
        if i < attempts - 1:
            time.sleep(backoff)
    return None, f"{last} (after {attempts} attempts)"


def _collect_once():
    out, err = docker(["ps", "-a", "--no-trunc", "--format", "{{.ID}}"])
    if err:
        return None, err
    ids = [x for x in out.split("\n") if x.strip()]
    if not ids:
        return [], None

    # One inspect call for everything — 100 separate calls would be slow enough
    # that a cron run could overlap the next one.
    fmt = (
        "{{.Name}}\x1f{{.State.Running}}\x1f{{.State.ExitCode}}\x1f{{.State.FinishedAt}}"
        "\x1f{{.RestartCount}}\x1f{{.HostConfig.RestartPolicy.Name}}"
        "\x1f{{if .State.Health}}{{.State.Health.Status}}{{else}}{{end}}"
        "\x1f{{.Config.Image}}\x1f{{.State.StartedAt}}"
        '\x1f{{index .Config.Labels "com.docker.compose.project"}}'
        "\x1f{{if .State.Health}}{{if .State.Health.Log}}"
        "{{(index .State.Health.Log 0).Start}}{{end}}{{end}}"
    )
    out, err = docker(["inspect", "--format", fmt, *ids], timeout=90)
    if err:
        return None, err

    rows = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        parts = line.split("\x1f")
        if len(parts) < 11:
            continue
        (name, running, code, finished, restarts, policy, health, image,
         started, project, hsince) = parts[:11]
        try:
            code = int(code)
        except ValueError:
            code = None
        try:
            restarts = int(restarts)
        except ValueError:
            restarts = 0
        rows.append(
            {
                "name": name.lstrip("/"),
                "running": running == "true",
                "exit_code": code,
                "finished_at": finished,
                "restart_count": restarts,
                "restart_policy": policy,
                "health": health or None,
                "health_since": hsince or None,
                "image": image,
                "started_at": started,
                "project": project or None,
            }
        )
    return rows, None


def load_config():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        print(f"config unreadable ({e}) — falling back to defaults", file=sys.stderr)
        return {}


def main():
    as_json = "--json" in sys.argv
    containers, err = collect()
    if err:
        # A watchdog that cannot see is not healthy — say so loudly rather than
        # reporting "no findings", which is what silence would otherwise mean.
        payload = {"ok": False, "error": err, "findings": []}
        print(json.dumps(payload, indent=2) if as_json else f"container-watch ERROR: {err}")
        return 2

    findings = evaluate(containers, load_config(), datetime.now(timezone.utc))
    if as_json:
        print(
            json.dumps(
                {"ok": not findings, "scanned": len(containers), "findings": findings}, indent=2
            )
        )
    elif not findings:
        print(f"{len(containers)} container(s) scanned — nothing wrong")
    else:
        print(f"{len(findings)} finding(s) across {len(containers)} container(s):\n")
        for f in findings:
            proj = f" [{f['project']}]" if f["project"] else " [no compose project]"
            print(f"  {f['severity']:<7} {f['kind']:<18} {f['name']}{proj} — {f['detail']}")
        print("\nSilence one deliberately: add it to ignore in tools/container-watch/config.json")
        print("with a reason (and an optional \"until\" date so the mute expires).")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
