from __future__ import annotations
import json
import time
from pathlib import Path

GATE_DIR = Path("/tmp/cloak-gates")
GATE_DIR.mkdir(parents=True, exist_ok=True)

MANUAL_NUMBER = "6107378479"


def manual_gate(gate_name: str, number: str = MANUAL_NUMBER) -> str:
    """Block until Jesse enters the SMS code. Returns the code string."""
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    waiting = GATE_DIR / f"{gate_name}.waiting"
    continue_file = GATE_DIR / f"{gate_name}.continue"

    continue_file.unlink(missing_ok=True)
    waiting.write_text(json.dumps({
        "message": f"SMS verification needed — check {number} for the code",
        "number": number,
        "gate": gate_name,
    }))
    print(f"\n[SMS GATE] Code sent to {number}. Write it to {continue_file} to continue.")

    while True:
        if continue_file.exists():
            code = continue_file.read_text().strip()
            continue_file.unlink(missing_ok=True)
            waiting.unlink(missing_ok=True)
            return code
        time.sleep(1)


def smspool_gate(platform: str, gate_name: str) -> str:
    """SMSPool API — Meta phase only. Requires SMSPOOL_API_KEY env var."""
    raise NotImplementedError("SMSPool integration not yet implemented — Meta phase")
