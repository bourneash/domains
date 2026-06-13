"""Dead-man-switch alerter for per-site ops publishing loops.

Reads fs.ops_board_last_run_age_hours from the facts DB and sends a Resend
email when any tracked site's loop has gone silent past the warning or critical
threshold.  Tracks alert state in data/dms_state.json to suppress repeat
messages until the condition changes.

State machine per site:
  green    → clear saved state, send recovery email if previously alerted
  yellow   → send WARNING if not already at yellow/red
  red      → send CRITICAL if not already at red
  unknown  → site has no last-run.json (no active loop) — skip silently
  stale    → collector itself may be down — treat same as yellow
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger(__name__)

WARN_HOURS = 26    # >1 day without a run → warning
CRIT_HOURS = 72    # >3 days → critical

RESEND_API = "https://api.resend.com/emails"
FROM_ADDR  = "notifications@reviewtattoo.com"
TO_ADDR    = "jessetamburino@hotmail.com"


# ── Helpers ──────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _load_state(state_path: Path) -> dict[str, Any]:
    if state_path.exists():
        try:
            return json.loads(state_path.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_state(state_path: Path, state: dict[str, Any]) -> None:
    state_path.write_text(json.dumps(state, indent=2))


def _send_email(api_key: str, subject: str, body: str) -> bool:
    try:
        r = httpx.post(
            RESEND_API,
            headers={"Authorization": f"Bearer {api_key}"},
            json={"from": FROM_ADDR, "to": [TO_ADDR], "subject": subject, "text": body},
            timeout=10,
        )
        r.raise_for_status()
        log.info("alert sent: %s", subject)
        return True
    except Exception as e:
        log.error("failed to send alert email: %s", e)
        return False


def _current_facts(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    """Return {site: {value, state, verified_at}} for the ops_board fact."""
    rows = conn.execute(
        "SELECT site, value, state, verified_at FROM facts "
        "WHERE key='fs.ops_board_last_run_age_hours'"
    ).fetchall()
    out = {}
    now = datetime.now(timezone.utc)
    for site, val_json, state, verified_at_str in rows:
        verified_at = datetime.fromisoformat(verified_at_str.replace("Z", "+00:00"))
        collector_age_h = (now - verified_at).total_seconds() / 3600
        value = json.loads(val_json) if val_json is not None else None
        # Degrade to stale if collector hasn't refreshed this fact recently
        eff_state = "stale" if collector_age_h > 2 and state == "green" else state
        out[site] = {"value": value, "state": eff_state, "collector_age_h": round(collector_age_h, 1)}
    return out


def _severity(state: str, value: float | None) -> str:
    """Map fact state + raw value to alert severity: 'ok', 'warn', or 'crit'."""
    if state == "unknown":
        return "ok"   # no last-run.json → site has no active loop
    if state in ("yellow", "stale"):
        return "warn"
    if state == "red":
        return "crit"
    if state == "green":
        # Double-check raw value in case state_rule thresholds differ
        if value is not None and value >= CRIT_HOURS:
            return "crit"
        if value is not None and value >= WARN_HOURS:
            return "warn"
    return "ok"


# ── Main entry point ──────────────────────────────────────────────

def run(db_path: Path, state_path: Path, dry_run: bool = False) -> None:
    api_key = os.environ.get("RESEND_API_KEY", "")
    if not api_key and not dry_run:
        log.error("RESEND_API_KEY not set — cannot send alerts")
        return

    conn = sqlite3.connect(str(db_path))
    try:
        facts = _current_facts(conn)
    finally:
        conn.close()

    if not facts:
        log.info("no ops_board facts found — nothing to check")
        return

    prev_state = _load_state(state_path)
    new_state = dict(prev_state)
    sent = 0

    for site, info in sorted(facts.items()):
        sev = _severity(info["state"], info["value"])
        prev = prev_state.get(site, {})
        prev_sev = prev.get("severity", "ok")
        age_str = f"{info['value']:.1f}h" if info["value"] is not None else "unknown"

        if sev == "ok":
            # Recovery: was previously alerting, now healthy
            if prev_sev in ("warn", "crit"):
                subj = f"[dead-man] ✅ RECOVERED: {site} ops loop is healthy again"
                body = (
                    f"Site: {site}\n"
                    f"ops/board/last-run.json age: {age_str}\n"
                    f"Previous alert severity: {prev_sev}\n"
                    f"Checked: {_now_iso()}\n"
                )
                log.info("%s recovered (was %s)", site, prev_sev)
                if not dry_run:
                    _send_email(api_key, subj, body)
                else:
                    print(f"DRY-RUN: {subj}")
                sent += 1
            new_state.pop(site, None)
            continue

        if sev == "warn" and prev_sev in ("warn", "crit"):
            log.debug("%s still %s — suppressing repeat alert", site, sev)
            continue
        if sev == "crit" and prev_sev == "crit":
            log.debug("%s still crit — suppressing repeat alert", site)
            continue

        # New alert or escalation
        if sev == "crit":
            emoji, level = "🔴", "CRITICAL"
        else:
            emoji, level = "⚠️", "WARNING"

        if info["state"] == "stale":
            reason = f"site-tracker filesystem collector hasn't refreshed this fact in {info['collector_age_h']}h — collector may be down"
        else:
            reason = f"ops/board/last-run.json age: {age_str}"

        subj = f"[dead-man] {emoji} {level}: {site} ops loop silent — {age_str}"
        body = (
            f"Site: {site}\n"
            f"Severity: {level}\n"
            f"Status: {reason}\n\n"
            f"The autonomous publishing loop on {site} appears to have stopped.\n"
            f"Check the ops cron container:\n"
            f"  docker compose -f sites/{site}/ops/docker-compose.yml ps\n"
            f"  docker compose -f sites/{site}/ops/docker-compose.yml logs --tail=50\n\n"
            f"Checked: {_now_iso()}\n"
        )
        log.warning("%s %s: %s", level, site, reason)
        if not dry_run:
            _send_email(api_key, subj, body)
        else:
            print(f"DRY-RUN: {subj}\n{body}")
        sent += 1
        new_state[site] = {"severity": sev, "alerted_at": _now_iso()}

    _save_state(state_path, new_state)
    log.info("dead-man-alert done — %d message(s) sent, %d site(s) checked", sent, len(facts))
