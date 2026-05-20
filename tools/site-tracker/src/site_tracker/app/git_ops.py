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
