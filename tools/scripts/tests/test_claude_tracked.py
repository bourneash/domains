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
                    # These tests exercise result classification only. Never
                    # contend on the developer's real shared auth mutex.
                    "CLAUDE_AUTH_LOCK": "none",
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

    def test_revoked_authentication_failure_is_explained_and_not_retried(self):
        result, calls, record = self.run_wrapper(
            {
                "type": "result",
                "subtype": "success",
                "is_error": True,
                "result": "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
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


class AuthRefreshMutexTests(unittest.TestCase):
    """The 2026-09-01 outage, reproduced and fixed, end to end.

    Every worker container bind-mounts the SAME ~/.claude/.credentials.json
    read-write. The CLI reads it at startup and, near expiry, refreshes -- and a
    successful refresh ROTATES the refresh token. If two processes read the file
    before either has rotated, the second presents a token the server has already
    retired; that is refresh-token reuse, and the server answers by revoking the
    whole family. On 2026-09-01 12:00 UTC, 22 co-firing promoters plus 2
    unrelated roles all died on "401 OAuth access token has been revoked".

    The fake `claude` below models exactly that server behaviour: read the
    stored token, pause for the handshake, then rotate -- and fail hard if the
    token it presents has already been retired. The assertion that matters is
    the control: WITHOUT the mutex this must still break, or the test is
    proving nothing.
    """

    N = 8

    def _burst(self, temp: Path, lock_setting: str):
        creds = temp / "credentials.json"
        server = temp / "server"      # the server's view of the live token
        trace = temp / "trace"
        fake_bin = temp / "bin"
        fake_bin.mkdir(exist_ok=True)
        (fake_bin / "curl").write_text("#!/bin/sh\nexit 0\n")
        (fake_bin / "curl").chmod(0o755)

        fake_claude = fake_bin / "claude"
        fake_claude.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env bash
                mine=$(cat "$ROT_CREDS")
                sleep "${ROT_HANDSHAKE:-2}"
                if [[ "$mine" != "$(cat "$ROT_SERVER")" ]]; then
                  echo "REUSE" >> "$ROT_TRACE"
                  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 401 OAuth access token has been revoked.","num_turns":0,"duration_ms":1,"session_id":"x","total_cost_usd":0,"modelUsage":{}}'
                  exit 1
                fi
                new="rt-$RANDOM-$$"
                echo "$new" > "$ROT_SERVER"
                echo "$new" > "$ROT_CREDS"
                echo "OK" >> "$ROT_TRACE"
                echo '{"type":"result","subtype":"success","is_error":false,"result":"OK","num_turns":1,"duration_ms":1,"session_id":"x","total_cost_usd":0.01,"modelUsage":{}}'
                """
            )
        )
        fake_claude.chmod(0o755)

        creds.write_text("rt-0\n")
        server.write_text("rt-0\n")
        trace.write_text("")

        env = os.environ.copy()
        env.update({
            "PATH": f"{fake_bin}:{env['PATH']}",
            "CRON_SITE": "rot.test", "CRON_ROLE": "promoter",
            "REPO_ROOT": str(temp),
            "ROT_CREDS": str(creds), "ROT_SERVER": str(server),
            "ROT_TRACE": str(trace), "ROT_HANDSHAKE": "1",
            "CLAUDE_AUTH_LOCK": lock_setting,
            "CLAUDE_AUTH_WINDOW": "3", "CLAUDE_AUTH_LOCK_WAIT": "120",
            "CLAUDE_TRACKED_RETRY_DELAY_SECONDS": "0",
        })
        procs = [
            subprocess.Popen(
                [str(WRAPPER), "go", "--max-turns", "1", "--model", "claude-sonnet-4-6"],
                text=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=env,
            )
            for _ in range(self.N)
        ]
        for p in procs:
            p.wait()
        body = trace.read_text().split()
        return body.count("OK"), body.count("REUSE")

    def test_control_without_mutex_still_revokes(self):
        """Guard on the guard: the harness must reproduce the original bug."""
        with tempfile.TemporaryDirectory() as td:
            ok, revoked = self._burst(Path(td), "none")
        self.assertGreater(
            revoked, 0,
            "control failed to reproduce refresh-token reuse -- the mutex test below proves nothing",
        )

    def test_mutex_serialises_refresh_so_no_token_is_reused(self):
        with tempfile.TemporaryDirectory() as td:
            temp = Path(td)
            ok, revoked = self._burst(temp, str(temp / "auth.lock"))
        self.assertEqual(revoked, 0, "a concurrent burst reused a rotated refresh token")
        self.assertEqual(ok, self.N, "every call in the burst should have refreshed cleanly")
