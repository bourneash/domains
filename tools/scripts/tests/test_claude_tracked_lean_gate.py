"""Regression tests for the 2026-09-20 claude-tracked.sh additions: lean CLI flags,
promoter backlog gate, and the error_max_turns worktree snapshot."""
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

WRAPPER = Path(__file__).resolve().parents[3] / "tools" / "scripts" / "claude-tracked.sh"


def run(role, files=0, posted=(), skills=False, env_extra=None, subtype="success", stamp_age_days=None):
    with tempfile.TemporaryDirectory() as td:
        t = Path(td)
        (t / "bin").mkdir()
        (t / "ops" / "logs").mkdir(parents=True)
        (t / "ops" / "social" / "spotlight").mkdir(parents=True)
        subprocess.run(["git", "-C", str(t), "init", "-q"], check=True)
        for i in range(files):
            (t / "ops" / "social" / "spotlight" / f"f{i}.md").write_text("x")
        if posted:
            (t / "ops" / "social" / "post-log.jsonl").write_text(
                "".join(json.dumps({"article_slug": s}) + "\n" for s in posted))
        if skills:
            (t / ".claude" / "skills" / "v").mkdir(parents=True)
            (t / ".claude" / "skills" / "v" / "SKILL.md").write_text("x")
        if stamp_age_days is not None:
            (t / "ops" / ".locks").mkdir(parents=True)
            stamp = t / "ops" / ".locks" / "promoter-last-run"
            stamp.write_text("")
            old = stamp.stat().st_mtime - stamp_age_days * 86400
            os.utime(stamp, (old, old))
        fake = t / "bin" / "claude"
        fake.write_text(textwrap.dedent("""\
            #!/bin/sh
            printf '{"type":"result","subtype":"%s","is_error":%s,"num_turns":3,"session_id":"s1","result":"ARGV: %s","total_cost_usd":0.1,"usage":{},"modelUsage":{}}\\n' "$FAKE_SUBTYPE" "$FAKE_ERR" "$*"
            [ "$FAKE_ERR" = true ] && exit 1
            exit 0
            """))
        fake.chmod(0o755)
        curl = t / "bin" / "curl"
        curl.write_text("#!/bin/sh\nexit 0\n")
        curl.chmod(0o755)
        env = os.environ.copy()
        env.update({"PATH": f"{t/'bin'}:{env['PATH']}", "CRON_SITE": "x.test", "CRON_ROLE": role,
                    "REPO_ROOT": str(t), "CLAUDE_AUTH_LOCK": "none",
                    "FAKE_SUBTYPE": subtype, "FAKE_ERR": "true" if subtype != "success" else "false"})
        env.pop("CLAUDE_LEAN", None)
        env.pop("CLAUDE_LEAN_ROLES", None)
        env.update(env_extra or {})
        r = subprocess.run([str(WRAPPER), "hi", "--max-turns", "5", "--model", "claude-haiku-4-5-20251001"],
                           text=True, capture_output=True, env=env, check=False, cwd=t)
        snaps = list((t / "ops" / "logs").glob("max-turns-worktree-*.jsonl"))
        snap = json.loads(snaps[0].read_text().splitlines()[-1]) if snaps else None
        return r, snap


class LeanFlagTests(unittest.TestCase):
    def test_listed_role_gets_lean_flags(self):
        r, _ = run("content-writer")
        self.assertIn("--disable-slash-commands", r.stdout)
        self.assertIn("--strict-mcp-config", r.stdout)

    def test_unlisted_role_does_not(self):
        r, _ = run("engineer")
        self.assertNotIn("--disable-slash-commands", r.stdout)

    def test_project_skills_site_is_excluded(self):
        r, _ = run("promoter", skills=True)
        self.assertNotIn("--disable-slash-commands", r.stdout)

    def test_opt_out_and_opt_in(self):
        r, _ = run("promoter", env_extra={"CLAUDE_LEAN": "0"})
        self.assertNotIn("--disable-slash-commands", r.stdout)
        r, _ = run("engineer", env_extra={"CLAUDE_LEAN": "1"})
        self.assertIn("--disable-slash-commands", r.stdout)


class PromoterBacklogGateTests(unittest.TestCase):
    def test_gate_skips_at_threshold_and_starts_clock(self):
        r, _ = run("promoter", files=9)
        self.assertNotIn("ARGV", r.stdout)
        self.assertIn("backlog gate", r.stderr)

    def test_below_threshold_runs(self):
        r, _ = run("promoter", files=9, posted=[f"f{i}" for i in range(4)], stamp_age_days=1)
        self.assertIn("ARGV", r.stdout)

    def test_forced_run_after_14_days(self):
        r, _ = run("promoter", files=9, stamp_age_days=15)
        self.assertIn("ARGV", r.stdout)

    def test_other_roles_ignore_gate(self):
        r, _ = run("content-writer", files=20)
        self.assertIn("ARGV", r.stdout)


class MaxTurnsSnapshotTests(unittest.TestCase):
    def test_snapshot_written_on_error_max_turns(self):
        r, snap = run("content-writer", subtype="error_max_turns")
        self.assertIsNotNone(snap)
        self.assertEqual(snap["session_id"], "s1")
        self.assertIn("dirty_count", snap)

    def test_no_snapshot_on_success(self):
        _, snap = run("content-writer")
        self.assertIsNone(snap)


if __name__ == "__main__":
    unittest.main()
