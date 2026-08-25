"""Slack reporting. Always posts — including on a clean run.

A sentinel that only speaks up when something is wrong is indistinguishable
from a sentinel that has silently stopped running, and the fleet has already
been burned by exactly that (a week-long outage where every AI cron role was
dead and nothing said so). One line a day per site is the cost of knowing the
check is alive.

The emoji is the whole message for most readers, so there are exactly four and
no ambiguous "informational" bucket.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

CLEAN = ("✅", "good")
WARN = ("⚠️", "warning")
DEAD = ("🚨", "danger")
HEALED = ("🔧", "#4a90d9")


def post(site_root: Path, channel: str, text: str, color: str) -> bool:
    script = site_root / "ops" / "scripts" / "notify-slack.sh"
    if not script.is_file():
        return False
    try:
        subprocess.run(
            ["bash", str(script), channel, text, color],
            cwd=str(site_root),
            check=False,
            timeout=60,
            capture_output=True,
        )
    except subprocess.TimeoutExpired:
        return False
    return True


def link(url: str, label: str) -> str:
    """Slack mrkdwn link — never paste a bare URL, it renders as noise."""
    return f"<{url}|{label}>"
