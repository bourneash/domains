"""Regression checks for the content-writer publication boundary."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "sites/offshorehookup.com/ops/scripts/run-role.sh"
POLICY = ROOT / "tools/cron-roles/content-writer-policy.sh"


def test_offshorehookup_content_writer_scope_allows_hero_prompt_only():
    text = SCRIPT.read_text(encoding="utf-8")
    assert "cron-roles/content-writer-policy.sh" in text
    assert "git worktree add --detach" in text
    assert "push origin HEAD:main" in text
    assert "writer_sandbox_exec" in text
    assert "bwrap" in text
    assert "git add -A -- site/ ops/tasks/" not in text
    assert "git clean -fd -- ." not in text

    result = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_content_writer_policy_is_behavioral_and_task_specific():
    task = "ops/tasks/in-progress/remaining-hero-images.md"

    def allowed(path, selected_task=task):
        return subprocess.run(
            ["bash", str(POLICY), path, selected_task], capture_output=True
        ).returncode == 0

    assert allowed("site/src/content/guides/example.md")
    assert allowed("site/public/images/generated/example.png")
    assert allowed("ops/prompts/hero/prompts.txt")
    assert not allowed("ops/prompts/hero/prompts.txt", "ops/tasks/in-progress/other.md")
    assert not allowed("ops/scripts/run-role.sh")
    assert not allowed("ops/tasks/backlog/other-task.md")
    assert not allowed("site/package.json")
