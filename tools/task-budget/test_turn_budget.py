#!/usr/bin/env python3
"""Regression tests for task-budget's runtime sizing."""
import unittest
import tempfile
from pathlib import Path

from turn_budget import compute_budget


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


if __name__ == "__main__":
    unittest.main()
