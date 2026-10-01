"""Regression coverage for Great American Lakes cross-role task routing."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SITE = ROOT / "sites/greatamericanlakes.com"
TASK_BUDGET_PATH = ROOT / "tools/task-budget/turn_budget.py"
SPEC = spec_from_file_location("turn_budget", TASK_BUDGET_PATH)
turn_budget = module_from_spec(SPEC)
SPEC.loader.exec_module(turn_budget)


class GreatAmericanLakesRoleRoutingTests(unittest.TestCase):
    def test_writer_role_is_installed_and_scheduled(self):
        self.assertTrue((SITE / "ops/roles/content-writer.md").is_file())
        cron = (SITE / "ops/docker/crontab.docker").read_text()
        self.assertRegex(cron, r"(?m)^0 7 \* \* 6\s+bash ops/scripts/run-worker\.sh content-writer$")

    def test_engineer_guidance_keeps_other_installed_roles_in_backlog(self):
        role = (SITE / "ops/roles/engineer.md").read_text()
        runner = (SITE / "ops/scripts/run-engineer.sh").read_text()
        queue_check = (SITE / "ops/scripts/engineer-check.sh").read_text()
        role_runner = (SITE / "ops/scripts/run-role.sh").read_text()
        self.assertIn("leave tasks assigned to an installed role there", role)
        self.assertIn("leave those tasks there for their assigned runner", runner)
        self.assertNotIn("No other roles are installed on this site yet", role)
        self.assertIn("assigned_role: *engineer", queue_check)
        self.assertIn("next-task content-writer", role_runner)

    def test_each_role_selects_only_its_own_backlog_tasks(self):
        with tempfile.TemporaryDirectory() as temp:
            backlog = Path(temp) / "backlog"
            backlog.mkdir()
            (backlog / "writer.md").write_text(
                "---\nassigned_role: content-writer\npriority: 1\ncreated: 2026-01-01\n"
                "type: content\nestimated_turns: 10\n---\n"
            )
            (backlog / "engineer.md").write_text(
                "---\nassigned_role: engineer\npriority: 1\ncreated: 2026-01-01\n"
                "type: engineering\nestimated_turns: 10\n---\n"
            )

            writer_task = turn_budget.pick_next_task(str(backlog), "content-writer")
            engineer_task = turn_budget.pick_next_task(str(backlog), "engineer")
            self.assertEqual(Path(writer_task[3]).name, "writer.md")
            self.assertEqual(Path(engineer_task[3]).name, "engineer.md")


if __name__ == "__main__":
    unittest.main()
