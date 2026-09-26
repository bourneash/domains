"""End-to-end fixture coverage for the disposable writer transaction."""

import subprocess
from pathlib import Path


def git(*args: str, cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def test_disposable_worktree_keeps_source_clean_and_pushes_detached_head(tmp_path: Path):
    source = tmp_path / "source"
    source.mkdir()
    git("init", "-q", cwd=source)
    git("config", "user.name", "test", cwd=source)
    git("config", "user.email", "test@example.com", cwd=source)
    (source / "content.md").write_text("before\n", encoding="utf-8")
    git("add", ".", cwd=source)
    git("commit", "-qm", "seed", cwd=source)

    remote = tmp_path / "remote.git"
    git("init", "--bare", "-q", str(remote), cwd=tmp_path)
    git("remote", "add", "origin", str(remote), cwd=source)
    git("push", "-q", "-u", "origin", "HEAD:main", cwd=source)

    worktree = tmp_path / "worktree"
    git("worktree", "add", "--detach", str(worktree), "HEAD", cwd=source)
    (worktree / "content.md").write_text("after\n", encoding="utf-8")
    git("add", "content.md", cwd=worktree)
    git("commit", "-qm", "content", cwd=worktree)
    git("push", "-q", "origin", "HEAD:main", cwd=worktree)

    assert (source / "content.md").read_text(encoding="utf-8") == "before\n"
    assert git("status", "--porcelain", cwd=source) == ""
    assert git("show", "HEAD:content.md", cwd=source) == "before"
    remote_content = subprocess.run(
        ["git", "--git-dir", str(remote), "show", "refs/heads/main:content.md"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert remote_content == "after"
    git("worktree", "remove", "--force", str(worktree), cwd=source)
    assert not worktree.exists()
