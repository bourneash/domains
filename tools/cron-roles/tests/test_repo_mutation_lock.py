#!/usr/bin/env python3
"""Cross-process regression tests for the shared site mutation lock."""

import subprocess
import tempfile
import unittest
from pathlib import Path


HELPER = Path(__file__).parents[1] / "repo-mutation-lock.sh"


class RepoMutationLockTest(unittest.TestCase):
    def test_second_process_is_excluded_until_owner_releases(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "ops/.locks").mkdir(parents=True)
            holder = subprocess.Popen(
                [
                    "bash",
                    "-c",
                    '. "$1"; repo_mutation_lock_acquire "$2" holder 0; '
                    'printf ready; sleep 2; repo_mutation_lock_release',
                    "bash",
                    str(HELPER),
                    str(repo),
                ],
                stdout=subprocess.PIPE,
                text=True,
            )
            self.assertEqual(holder.stdout.read(5), "ready")
            holder.stdout.close()
            blocked = subprocess.run(
                [
                    "bash",
                    "-c",
                    '. "$1"; ! repo_mutation_lock_acquire "$2" contender 0',
                    "bash",
                    str(HELPER),
                    str(repo),
                ],
                check=False,
            )
            self.assertEqual(blocked.returncode, 0)
            holder.wait(timeout=5)
            acquired = subprocess.run(
                [
                    "bash",
                    "-c",
                    '. "$1"; repo_mutation_lock_acquire "$2" next 0; '
                    "repo_mutation_lock_release",
                    "bash",
                    str(HELPER),
                    str(repo),
                ],
                check=False,
            )
            self.assertEqual(acquired.returncode, 0)


if __name__ == "__main__":
    unittest.main()
