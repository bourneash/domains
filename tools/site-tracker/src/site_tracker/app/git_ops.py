"""Git commit helper for /edit POSTs."""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


def commit_paths(repo_root: Path, paths: list[Path], message: str, *, push: bool) -> None:
    """Stage `paths`, commit, optionally push. Quiet — raises on git failure."""
    for p in paths:
        subprocess.check_call(["git", "add", str(p)], cwd=repo_root)
    subprocess.check_call(["git", "commit", "-m", message], cwd=repo_root)
    if push:
        subprocess.check_call(["git", "push"], cwd=repo_root)


def is_clean(repo_root: Path, paths: list[Path]) -> bool:
    """True if none of `paths` have uncommitted changes (staged or not).

    Used to refuse writing a manual-fact edit on top of an already-dirty
    tree — if the pre-check fails we never get into the "wrote sites.yml
    but couldn't commit" inconsistent state in the first place. If git
    itself can't answer (e.g. not a repo, missing binary) we don't block
    the edit here — commit_paths() will raise its own clear error later.
    """
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain", "--"] + [str(p) for p in paths],
            cwd=repo_root, capture_output=True, text=True,
        )
    except FileNotFoundError:
        return True
    if result.returncode != 0:
        return True
    return result.stdout.strip() == ""
