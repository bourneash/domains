"""Write-through of scheduler edits into the legacy crontab.docker (source-of-record mirror).

The dashboard's role matrix / expected-run math and the rollback path both still read
crontab.docker. Whenever the scheduler changes a job's schedule, enabled flag or command it
patches the ONE matching line in place (comments and layout untouched); disabling comments
the line out with `# `, which is the same convention the dashboard's cron editor uses.
Best-effort: a failure is reported as a warning, never blocks the scheduler DB change.
"""
from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path


_LINE = re.compile(r"^\s*(#\s*)?((?:\S+\s+){4}\S+)(\s+)(.*\S)\s*$")


def _split(line: str):
    """-> (commented, schedule, sep, command) for a cron-shaped line, else None."""
    m = _LINE.match(line)
    if not m:
        return None
    return bool(m.group(1)), " ".join(m.group(2).split()), m.group(3), m.group(4)


def _write_atomic(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".crontab-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.chmod(tmp, path.stat().st_mode & 0o777)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def sync(path: Path | None, old: dict | None, new: dict | None) -> str | None:
    """Apply old->new for one job. old=None: append new. new=None: comment out old.
    Returns a warning string, or None on success / nothing to do."""
    if path is None:
        return None
    try:
        text = path.read_text()
    except OSError as e:
        return f"crontab mirror skipped: cannot read {path.name}: {e}"
    lines = text.splitlines(keepends=True)
    if old is None:
        row = f"{new['schedule']}  {new['command']}\n"
        if not new["enabled"]:
            row = "# " + row
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append(row)
    else:
        idx = None
        for i, l in enumerate(lines):
            sp = _split(l)
            if sp and sp[1] == old["schedule"] and sp[3] == old["command"]:
                idx = i
                break
        if idx is None:
            return f"crontab mirror: no line matching '{old['schedule']} {old['command'][:50]}' in {path.name}"
        _, _, sep, _ = _split(lines[idx])
        tgt = new if new is not None else {**old, "enabled": 0}
        row = f"{tgt['schedule']}{sep}{tgt['command']}\n"
        lines[idx] = row if tgt["enabled"] else "# " + row
    try:
        _write_atomic(path, "".join(lines))
    except OSError as e:
        return f"crontab mirror failed: {e}"
    return None


def check(path: Path | None, jobs) -> list[str]:
    """Return drift findings for DB jobs whose legacy crontab is expected to mirror them.

    The database remains authoritative.  This deliberately checks only exact job lines and
    does not flag extra lines: imported legacy entries and fleet-specific comments are valid
    and should not be removed by an audit.
    """
    if path is None:
        return []
    try:
        lines = path.read_text().splitlines()
    except OSError as exc:
        return [f"cannot read {path}: {exc}"]
    parsed = [_split(line) for line in lines]
    findings = []
    for job in jobs:
        matches = [sp for sp in parsed if sp and sp[1] == job["schedule"] and sp[3] == job["command"]]
        if not matches:
            findings.append(f"job {job.get('site', '?')}/{job.get('name', '?')} is missing from {path.name}")
            continue
        enabled = bool(job["enabled"])
        if enabled and not any(not sp[0] for sp in matches):
            findings.append(f"job {job.get('site', '?')}/{job.get('name', '?')} is commented in {path.name}")
        elif not enabled and not any(sp[0] for sp in matches):
            findings.append(f"disabled job {job.get('site', '?')}/{job.get('name', '?')} is active in {path.name}")
    return findings
