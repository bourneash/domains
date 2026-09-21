import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from fleetsched import mirror  # noqa: E402

BASE = """# header comment: 0 7 * * 6 bash ops/scripts/not-a-job.sh
COMPOSE_PROJECT_NAME=a-ops

*/15 * * * *  bash ops/scripts/run-deployer.sh
0 7 * * 6      bash ops/scripts/run-worker.sh content-writer   
# 30 5 * * *  bash ops/scripts/parked.sh
"""


def job(sched, cmd, en=1):
    return {"schedule": sched, "command": cmd, "enabled": en}


class Mirror(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.p = Path(self.d) / "crontab.docker"
        self.p.write_text(BASE)
        os.chmod(self.p, 0o644)

    def test_schedule_change_patches_only_that_line(self):
        old = job("0 7 * * 6", "bash ops/scripts/run-worker.sh content-writer")
        self.assertIsNone(mirror.sync(self.p, old, {**old, "schedule": "5 8 * * 1"}))
        out = self.p.read_text().splitlines()
        self.assertIn("5 8 * * 1      bash ops/scripts/run-worker.sh content-writer", out)  # spacing kept
        self.assertEqual(out[0], BASE.splitlines()[0])   # prose comment untouched
        self.assertEqual(out[3], BASE.splitlines()[3])   # other job untouched
        self.assertEqual(oct(self.p.stat().st_mode & 0o777), "0o644")

    def test_disable_comments_and_enable_uncomments(self):
        old = job("*/15 * * * *", "bash ops/scripts/run-deployer.sh")
        self.assertIsNone(mirror.sync(self.p, old, {**old, "enabled": 0}))
        self.assertIn("# */15 * * * *  bash ops/scripts/run-deployer.sh", self.p.read_text().splitlines())
        off = {**old, "enabled": 0}
        self.assertIsNone(mirror.sync(self.p, off, {**old, "enabled": 1}))
        self.assertIn("*/15 * * * *  bash ops/scripts/run-deployer.sh", self.p.read_text().splitlines())

    def test_prose_comment_is_never_matched(self):
        w = mirror.sync(self.p, job("0 7 * * 6", "bash ops/scripts/not-a-job.sh"), job("1 1 * * *", "bash ops/scripts/not-a-job.sh"))
        self.assertIn("no line matching", w)

    def test_append_and_delete(self):
        self.assertIsNone(mirror.sync(self.p, None, job("9 9 * * *", "bash ops/scripts/new.sh")))
        self.assertTrue(self.p.read_text().endswith("9 9 * * *  bash ops/scripts/new.sh\n"))
        self.assertIsNone(mirror.sync(self.p, job("9 9 * * *", "bash ops/scripts/new.sh"), None))
        self.assertTrue(self.p.read_text().endswith("# 9 9 * * *  bash ops/scripts/new.sh\n"))

    def test_missing_file_and_none_path_are_soft(self):
        self.assertIsNone(mirror.sync(None, None, job("* * * * *", "x")))
        self.assertIn("cannot read", mirror.sync(Path(self.d) / "nope", job("* * * * *", "x"), job("* * * * *", "y")))

    def test_no_temp_files_left_behind(self):
        old = job("*/15 * * * *", "bash ops/scripts/run-deployer.sh")
        mirror.sync(self.p, old, {**old, "schedule": "*/20 * * * *"})
        self.assertEqual(sorted(x.name for x in Path(self.d).iterdir()), ["crontab.docker"])

    def test_check_detects_missing_and_wrong_enabled_state(self):
        missing = job("1 1 * * *", "bash ops/scripts/missing.sh")
        self.assertIn("missing", mirror.check(self.p, [missing])[0])
        disabled = job("*/15 * * * *", "bash ops/scripts/run-deployer.sh", 0)
        self.assertIn("active", mirror.check(self.p, [disabled])[0])
        enabled = job("0 7 * * 6", "bash ops/scripts/run-worker.sh content-writer", 1)
        self.assertEqual(mirror.check(self.p, [enabled]), [])


if __name__ == "__main__":
    unittest.main()
