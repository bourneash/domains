"""Regression checks for the content-writer publication boundary."""

import subprocess
import os
import tempfile
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
    assert "--proc /proc" not in text
    assert "--dev /dev" not in text
    assert "/dev/null" in text
    assert "git add -A -- site/ ops/tasks/" not in text
    assert "git clean -fd -- ." not in text
    assert "in-progress task already exists" in text
    assert "refused non-regular selected task" in text
    assert "refused missing or non-regular task" in text

    result = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_offshorehookup_non_content_roles_do_not_require_bubblewrap():
    text = SCRIPT.read_text(encoding="utf-8")
    sandbox_call = 'writer_sandbox_exec /work/.monorepo-tools/scripts/claude-tracked.sh'
    generic_call = '"$CLAUDE_TRACKED" "$prompt"'

    # The dispatch function has one role gate: an SEO/promoter invocation must
    # take the direct tracked-Claude branch even when bwrap is unavailable.
    assert 'if [[ "$ROLE" == "content-writer" ]]; then\n        ' + sandbox_call in text
    assert generic_call in text
    assert text.index(sandbox_call) < text.index(generic_call)
    assert 'CONTENT_WRITER_POLICY=' in text
    assert text.index('CONTENT_WRITER_POLICY=') > text.index('if [[ "$ROLE" == "content-writer" ]]; then')
    assert 'MODEL_ARGS=()' in text
    assert 'MODEL_FLAG=' not in text
    assert 'CLAUDE_TRACKED="${CLAUDE_TRACKED:-' in text
    assert 'CLAUDE_BIN="${CLAUDE_BIN:-claude}"' in text

    result = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_seo_role_runs_with_fake_claude_when_bwrap_is_unavailable():
    """Exercise the real dispatcher without touching the checkout or Claude."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "ops/roles").mkdir(parents=True)
        (root / "ops/scripts").mkdir(parents=True)
        (root / "ops/board").mkdir(parents=True)
        (root / ".monorepo-tools/scripts").mkdir(parents=True)
        (root / ".monorepo-tools/cron-roles").mkdir(parents=True)
        (root / "ops/roles/seo-analyst.md").write_text("Run the SEO analysis.\n")
        (root / ".monorepo-tools/cron-roles/repo-mutation-lock.sh").write_text(
            "repo_mutation_lock_acquire() { return 0; }\n"
            "repo_mutation_lock_release() { :; }\n"
        )
        tracked = root / "fake-claude-tracked.sh"
        tracked.write_text(
            "#!/usr/bin/env bash\n"
            "printf '%s\\n' \"$*\" > \"$RUN_MARKER\"\n"
        )
        tracked.chmod(0o755)
        claude = root / "fake-claude"
        claude.write_text("#!/usr/bin/env bash\necho 'fake claude 0.0'\n")
        claude.chmod(0o755)

        runner = root / "run-role.sh"
        runner.write_text(
            SCRIPT.read_text(encoding="utf-8").replace(
                'REPO_ROOT="/home/jesse/projects/domains/sites/offshorehookup.com"',
                f'REPO_ROOT="{root}"',
            )
        )
        runner.chmod(0o755)
        result = subprocess.run(
            [str(runner), "seo-analyst"],
            env={
                **os.environ,
                "CLAUDE_BIN": str(claude),
                "CLAUDE_TRACKED": str(tracked),
                "HOME": str(root / "home"),
                "RUN_MARKER": str(root / "tracked.args"),
            },
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0, result.stderr + result.stdout
        assert (root / "tracked.args").is_file()
        assert "Run the SEO analysis." in (root / "tracked.args").read_text()


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
