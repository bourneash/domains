#!/usr/bin/env python3
"""Regression tests for the principal-engineer incident scanner."""

import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCAN = Path(__file__).parents[1] / "archetypes/principal-engineer/scripts/principal-engineer-scan.py.tmpl"


class PrincipalEngineerScanAuthTest(unittest.TestCase):
    def run_scan(self, records, incidents=None, cursor=None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "ops/scripts/principal-engineer-scan.py"
            script.parent.mkdir(parents=True)
            script.write_text(SCAN.read_text())
            log_dir = root / "ops/logs"
            log_dir.mkdir(parents=True)
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            with (log_dir / f"slack-{today}.jsonl").open("w") as fh:
                for record in records:
                    fh.write(json.dumps(record) + "\n")
            if incidents:
                incident_dir = root / "ops/health/principal-incidents"
                incident_dir.mkdir(parents=True)
                for fp, record in incidents.items():
                    (incident_dir / f"{fp}.json").write_text(json.dumps(record))
            if cursor:
                lock_dir = root / "ops/.locks"
                lock_dir.mkdir(parents=True)
                (lock_dir / "principal-engineer-cursor.json").write_text(
                    json.dumps({"last_ts": cursor})
                )
            result = subprocess.run(
                ["python3", str(script)], text=True, capture_output=True, check=True,
                env={**os.environ},
            )
            return json.loads(result.stdout)

    def test_auth_failure_and_companion_alert_do_not_dispatch(self):
        records = [
            {
                "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "channel": "domain-example-com",
                "severity": "error",
                "text": ":x: example.com guide-writer failed writing a guide (exit=1)",
            },
            {
                "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "channel": "domain-example-com",
                "severity": "error",
                "text": (
                    ":x: example.com `guide-writer` failed (exit=1) "
                    "class=authentication_failed; the fleet auth monitor owns "
                    "the outage/recovery alert (role=guide-writer)"
                ),
            },
        ]
        self.assertEqual(self.run_scan(records), {"action": "none"})

    def test_unrelated_failure_still_dispatches(self):
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        result = self.run_scan([{
            "ts": now,
            "channel": "domain-example-com",
            "severity": "error",
            "text": ":x: example.com deployer failed smoke checks (exit=1)",
        }])
        self.assertEqual(result["action"], "act")
        self.assertIn("deployer failed", result["text"])

    def test_open_incident_retries_without_a_new_slack_line(self):
        now = datetime.now(timezone.utc)
        old = (now - timedelta(minutes=21)).strftime("%Y-%m-%dT%H:%M:%SZ")
        cursor = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        result = self.run_scan(
            [],
            incidents={
                "abc123": {
                    "fingerprint": "abc123",
                    "status": "open",
                    "attempts": 1,
                    "last_dispatched": old,
                    "last_text": "writer failed after reaching its turn cap",
                    "occurrences": 1,
                    "channel": "domain-example-com",
                }
            },
            cursor=cursor,
        )
        self.assertEqual(result["action"], "act")
        self.assertEqual(result["fp"], "abc123")
        self.assertEqual(result["attempt"], 2)

    def test_open_incident_waits_for_cooldown(self):
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(minutes=19)).strftime("%Y-%m-%dT%H:%M:%SZ")
        cursor = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        result = self.run_scan(
            [],
            incidents={
                "abc123": {
                    "fingerprint": "abc123",
                    "status": "open",
                    "attempts": 1,
                    "last_dispatched": recent,
                    "last_text": "writer failed after reaching its turn cap",
                    "occurrences": 1,
                }
            },
            cursor=cursor,
        )
        self.assertEqual(result, {"action": "none"})


if __name__ == "__main__":
    unittest.main()
