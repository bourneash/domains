#!/usr/bin/env python3
"""Silent health watchdog for the controller and Social Hub pipeline."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ.get("FLEET_DOMAINS_ROOT", "/home/jesse/projects/domains"))
sys.path.insert(0, str(ROOT / "tools" / "social-hub" / "src"))
from social_hub import db, oversight  # noqa: E402


def findings() -> list[str]:
    state = oversight.status()
    out = []
    last = state.get("last_run") or {}
    stamp = last.get("finished_at") or last.get("started_at")
    if not stamp:
        out.append("controller has never checked the queue")
    else:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds()
        if age > 35 * 60:
            out.append(f"controller last check is {int(age // 60)} minutes old")
    if last and last.get("ok") == 0:
        out.append(f"last controller run failed: {last.get('error') or 'unknown error'}")
    if int(state.get("pending") or 0) and state.get("oldest_pending"):
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(state["oldest_pending"])).total_seconds()
        if age > 2 * 3600:
            out.append(f"{state['pending']} public drafts pending; oldest is {int(age // 3600)}h old")
    if int(state.get("needs_rewrite") or 0) >= 25:
        out.append(f"rewrite backlog is {state['needs_rewrite']} posts")
    recent_stage_errors = db.one(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'tick.stage_error' "
        "AND julianday(ts) >= julianday('now', '-35 minutes')"
    )
    if recent_stage_errors and recent_stage_errors["n"]:
        out.append(f"{recent_stage_errors['n']} Social Hub stage error(s) in the last 35 minutes")
    return out


def notify(messages: list[str]) -> bool:
    digest = hashlib.sha256("\n".join(messages).encode()).hexdigest()
    if db.get_setting("social_monitor:last_alert") == digest:
        return False
    token = os.environ.get("SLACK_BOT_TOKEN")
    channel = os.environ.get("SLACK_CHANNEL_DOMAIN_OPS") or os.environ.get("SLACK_CHANNEL_GENERAL")
    if not token or not channel or os.environ.get("SOCIAL_HUB_NO_SLACK"):
        print("social-monitor: " + "; ".join(messages), file=sys.stderr)
        return False
    body = json.dumps({"channel": channel, "text": ":rotating_light: Social automation\n• " + "\n• ".join(messages)}).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage", data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            ok = bool(json.loads(response.read()).get("ok"))
    except Exception:
        ok = False
    if ok:
        db.set_setting("social_monitor:last_alert", digest)
    return ok


def main() -> int:
    problems = findings()
    if not problems:
        db.set_setting("social_monitor:last_alert", "")
        return 0
    notify(problems)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
