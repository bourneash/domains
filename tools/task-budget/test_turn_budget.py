#!/usr/bin/env python3
"""Regression tests for task-budget's runtime sizing."""
import unittest
import tempfile
from pathlib import Path

from turn_budget import audit_site, compute_budget


class ComputeBudgetTests(unittest.TestCase):
    def test_reserves_cap_reporting_turn(self):
        self.assertEqual(compute_budget(12, 40, 10, 8), 21)

    def test_hard_cap_still_wins(self):
        self.assertEqual(compute_budget(40, 40, 10, 8), 40)

    def test_floor_still_applies(self):
        self.assertEqual(compute_budget(1, 40, 10, 8), 10)


class NextTaskTests(unittest.TestCase):
    def test_next_task_prefers_in_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backlog = root / "backlog"
            in_progress = root / "in-progress"
            backlog.mkdir()
            in_progress.mkdir()
            (backlog / "new.md").write_text(
                "---\nassigned_role: content\npriority: 1\nestimated_turns: 12\n---\n"
            )
            resumed = in_progress / "resumed.md"
            resumed.write_text(
                "---\nassigned_role: content\npriority: 5\nestimated_turns: 12\n---\n"
            )
            # Validate the same selector used by the CLI without spawning a
            # subprocess or depending on stdout capture here.
            from turn_budget import pick_next_task
            self.assertEqual(pick_next_task(str(backlog), "content")[3], str(resumed))

    def test_equal_priority_uses_oldest_created_then_claimed_task_sets_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backlog = root / "backlog"
            in_progress = root / "in-progress"
            backlog.mkdir()
            in_progress.mkdir()
            newer = backlog / "newer-small.md"
            newer.write_text(
                "---\nassigned_role: content-writer\npriority: 3\n"
                "created: 2026-07-01\nestimated_turns: 5\n---\n"
            )
            older = backlog / "older-large.md"
            older.write_text(
                "---\nassigned_role: content-writer\npriority: 3\n"
                "created: 2026-06-01\nestimated_turns: 12\n---\n"
            )
            from turn_budget import pick_next_task
            selected = Path(pick_next_task(str(backlog), "content-writer")[3])
            self.assertEqual(selected, older)
            claimed = in_progress / selected.name
            selected.rename(claimed)
            _, _, data, selected_again = pick_next_task(str(backlog), "content-writer")
            self.assertEqual(Path(selected_again), claimed)
            self.assertEqual(compute_budget(data["estimated_turns"], 40, 10, 10), 23)


class AuditTests(unittest.TestCase):
    def test_audit_reuses_task_rows_without_changing_selection_or_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp) / "example.test"
            roles = site / "ops" / "roles"
            scripts = site / "ops" / "scripts"
            backlog = site / "ops" / "tasks" / "backlog"
            in_progress = site / "ops" / "tasks" / "in-progress"
            for directory in (roles, scripts, backlog, in_progress):
                directory.mkdir(parents=True, exist_ok=True)
            (roles / "writer.md").write_text("role\n")
            (scripts / "run-role.sh").write_text('writer) MAX_TURNS=30 ;;\n')
            (backlog / "backlog.md").write_text(
                "---\nassigned_role: writer\npriority: 1\nestimated_turns: 2\n"
                "title: Backlog\n---\n"
            )
            (backlog / "dead-role.md").write_text(
                "---\nassigned_role: removed-writer\npriority: 1\n---\n"
            )
            (in_progress / "resume.md").write_text(
                "---\nassigned_role: writer\npriority: 5\nestimated_turns: 12\n"
                "created: 2020-01-01\ntitle: Resume\n---\n"
            )

            report = audit_site(str(site), 40, 10, 8, stale_days=0)
            writer = next(row for row in report["roles"] if row["role"] == "writer")
            self.assertEqual(writer["next_task"], "Resume")
            self.assertEqual(writer["computed_max_turns"], 21)
            self.assertEqual(report["dead_role_tasks"][0]["assigned_role"], "removed-writer")
            self.assertEqual(report["stale_in_progress_tasks"][0]["file"], "resume.md")


if __name__ == "__main__":
    unittest.main()
