"""Regression checks for the generic Claude branch in site role dispatchers."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_blackmarket_generic_dispatch_is_outside_social_poster_branch():
    script = ROOT / "sites/blackmarketapparel.com/ops/scripts/run-role.sh"
    text = script.read_text(encoding="utf-8")
    social = text.index('elif [[ "$ROLE" == "social-poster" ]]')
    generic = text.index("else", social)
    budgets = text.index('case "$ROLE" in', generic)
    assert social < generic < budgets

    result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
