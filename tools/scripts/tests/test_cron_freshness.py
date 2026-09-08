import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "cron-freshness.py"
SPEC = importlib.util.spec_from_file_location("cron_freshness", SCRIPT)
cron_freshness = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(cron_freshness)


class IntentionalDisableTests(unittest.TestCase):
    def make_crontab(self, text):
        tmp = tempfile.NamedTemporaryFile(mode="w", delete=False)
        self.addCleanup(Path(tmp.name).unlink, missing_ok=True)
        tmp.write(text)
        tmp.close()
        return tmp.name

    def assess(self, crontab):
        def fake_docker(*args, **_kwargs):
            if args[:3] == ("inspect", "-f", "{{.State.Status}}"):
                return "running"
            return ""

        with mock.patch.object(cron_freshness, "docker", side_effect=fake_docker), \
                mock.patch.object(cron_freshness, "crontab_path", return_value=crontab):
            return cron_freshness.assess("example.com", "/unused", "example-cron")

    def test_explicitly_disabled_zero_job_schedule_is_healthy_and_counted(self):
        path = self.make_crontab(
            "# fleet-cron: disabled pre-launch\n"
            "# */5 * * * * bash ops/scripts/run-worker.sh engineer\n"
        )
        self.assertEqual(self.assess(path), ([], 0, 0, 1))

    def test_zero_job_schedule_without_marker_remains_a_finding(self):
        path = self.make_crontab("# all jobs are commented out\n")
        findings, asserted, skipped, disabled = self.assess(path)
        self.assertEqual(asserted, 0)
        self.assertEqual(skipped, 0)
        self.assertEqual(disabled, 0)
        self.assertEqual(len(findings), 1)
        self.assertTrue(findings[0].startswith("example.com: tmp"))
        self.assertTrue(findings[0].endswith(" schedules zero jobs"))

    def test_marker_does_not_suppress_an_active_schedule(self):
        path = self.make_crontab(
            "# fleet-cron: disabled stale marker\n"
            "* * * * * bash ops/scripts/run-worker.sh engineer\n"
        )
        self.assertTrue(cron_freshness.intentionally_disabled(path))
        gap, jobs, skipped = cron_freshness.max_gap_sec(path)
        self.assertEqual((gap, jobs, skipped), (60, 1, 0))


if __name__ == "__main__":
    unittest.main()
