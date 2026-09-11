#!/usr/bin/env python3
"""Regression tests for principal-engineer fleet-auth outage filtering."""

import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


SCAN = Path(__file__).parents[1] / "archetypes/principal-engineer/scripts/principal-engineer-scan.py.tmpl"


class PrincipalEngineerScanAuthTest(unittest.TestCase):
    def run_scan(self, records):
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


if __name__ == "__main__":
    unittest.main()
