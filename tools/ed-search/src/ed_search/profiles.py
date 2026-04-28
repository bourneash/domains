from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

PROFILES_DIR = Path(__file__).resolve().parents[2] / "profiles"


@dataclass
class Profile:
    name: str
    path: str  # e.g. "/domains/" or "/deleteddomains/"
    params: dict[str, str | int]
    description: str = ""


def list_profiles() -> list[str]:
    if not PROFILES_DIR.exists():
        return []
    return sorted(p.stem for p in PROFILES_DIR.glob("*.json"))


def load(name: str) -> Profile:
    path = PROFILES_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(f"Profile not found: {path}")
    data = json.loads(path.read_text())
    return Profile(
        name=name,
        path=data.get("path", "/domains/"),
        params=data.get("params", {}),
        description=data.get("description", ""),
    )
