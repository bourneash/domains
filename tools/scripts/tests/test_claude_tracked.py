import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[3]
WRAPPER = ROOT / "tools" / "scripts" / "claude-tracked.sh"
BOOTSTRAP = ROOT / "tools" / "scripts" / "ai-usage-bootstrap.sh"


class ClaudeTrackedFailureTests(unittest.TestCase):
    def run_wrapper(self, payload: dict):
        with tempfile.TemporaryDirectory() as td:
            temp = Path(td)
            fake_bin = temp / "bin"
            fake_bin.mkdir()
            calls = temp / "calls"
            fake_claude = fake_bin / "claude"
            fake_claude.write_text(
                textwrap.dedent(
                    """\
                    #!/bin/sh
                    printf x >> "$FAKE_CLAUDE_CALLS"
                    printf '%s\\n' "$FAKE_CLAUDE_PAYLOAD"
                    exit 1
                    """
                )
            )
            fake_claude.chmod(0o755)
            fake_curl = fake_bin / "curl"
            fake_curl.write_text("#!/bin/sh\nexit 0\n")
            fake_curl.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "CRON_SITE": "example.com",
                    "CRON_ROLE": "writer",
                    "REPO_ROOT": str(temp),
                    "FAKE_CLAUDE_CALLS": str(calls),
                    "FAKE_CLAUDE_PAYLOAD": json.dumps(payload),
                    "CLAUDE_TRACKED_RETRY_DELAY_SECONDS": "0",
                }
            )
            result = subprocess.run(
                [str(WRAPPER), "test prompt", "--max-turns", "2", "--model", "claude-sonnet-4-6"],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )
            ledger = next((temp / "ops" / "logs").glob("token-usage-*.jsonl"))
            record = json.loads(ledger.read_text().splitlines()[-1])
            return result, calls.read_text(), record

    def test_usage_exhaustion_is_explained_and_not_retried(self):
        result, calls, record = self.run_wrapper(
            {
                "type": "result",
                "subtype": "success",
                "is_error": True,
                "result": "You're out of extra usage · resets 9pm (America/New_York)",
                "num_turns": 1,
                "total_cost_usd": 0,
                "usage": {},
                "modelUsage": {},
            }
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(calls, "x")
        self.assertIn("shared Claude account is out of usage", result.stderr)
        self.assertEqual(record["failure_class"], "account_usage_exhausted")
        self.assertIn("out of extra usage", record["error_message"])

    def test_authentication_failure_is_explained_and_not_retried(self):
        result, calls, record = self.run_wrapper(
            {
                "type": "result",
                "subtype": "success",
                "is_error": True,
                "result": "Failed to authenticate. API Error: 401 OAuth access token has expired.",
                "num_turns": 1,
                "total_cost_usd": 0,
                "usage": {},
                "modelUsage": {},
            }
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(calls, "x")
        self.assertIn("shared Claude credentials are expired", result.stderr)
        self.assertEqual(record["failure_class"], "authentication_failed")

    def test_bootstrap_recognizes_only_global_outages(self):
        with tempfile.TemporaryDirectory() as td:
            result_file = Path(td) / "result"
            script = f'REPO_ROOT="{ROOT}"; CLAUDE_TRACKED="{WRAPPER}"; source "{BOOTSTRAP}"; claude_tracked_is_global_outage "$1"'

            result_file.write_text("Not logged in · Please run /login")
            known = subprocess.run(["bash", "-c", script, "bash", str(result_file)], check=False)
            self.assertEqual(known.returncode, 0)

            result_file.write_text("A tool failed while editing one article")
            local = subprocess.run(["bash", "-c", script, "bash", str(result_file)], check=False)
            self.assertEqual(local.returncode, 1)


if __name__ == "__main__":
    unittest.main()
