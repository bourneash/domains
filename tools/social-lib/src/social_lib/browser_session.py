# tools/social-lib/src/social_lib/browser_session.py
from __future__ import annotations
import json
import time
from pathlib import Path
from .vpn_session import get_proxy_url

GATE_DIR = Path("/tmp/cloak-gates")
SCREENSHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")


def cloak_args(region: str = "us") -> list[str]:
    """CLI args to inject VPN proxy into a CloakBrowser launch."""
    return [f"--proxy-server={get_proxy_url(region)}"]


def gate_wait(gate_name: str, message: str) -> None:
    """Block until orchestrator writes <gate_name>.continue file."""
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    waiting = GATE_DIR / f"{gate_name}.waiting"
    continue_file = GATE_DIR / f"{gate_name}.continue"
    skip_file = GATE_DIR / f"{gate_name}.skip"

    continue_file.unlink(missing_ok=True)
    skip_file.unlink(missing_ok=True)
    waiting.write_text(json.dumps({"message": message, "gate": gate_name}))
    print(f"\n[GATE] {message}\n[GATE] Write to {continue_file} to continue.")

    while True:
        if continue_file.exists() or skip_file.exists():
            for f in (continue_file, skip_file, waiting):
                f.unlink(missing_ok=True)
            return
        time.sleep(1)


def gate_continue(gate_name: str, code: str = "") -> None:
    """Signal a waiting gate to continue (used by orchestrator)."""
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    (GATE_DIR / f"{gate_name}.continue").write_text(code)
