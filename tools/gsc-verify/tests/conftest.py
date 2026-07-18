"""Make the sibling google-auth package importable without a global editable install.

cli.py does `from google_auth_fleet import clients`, but google_auth_fleet lives in
a sibling tool (tools/google-auth/src) that this package does not depend on via
pip. Prepend that path onto sys.path, derived relative to this file, so the suite
is hermetic on any checkout (no reliance on a pyenv editable install pointing at
a particular worktree).
"""
from __future__ import annotations

import sys
from pathlib import Path

_GOOGLE_AUTH_SRC = (
    Path(__file__).resolve().parents[2] / "google-auth" / "src"
)
if _GOOGLE_AUTH_SRC.is_dir():
    sys.path.insert(0, str(_GOOGLE_AUTH_SRC))
