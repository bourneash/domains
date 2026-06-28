# tools/personas/src/personas/store.py
from __future__ import annotations
import os
import re
import unicodedata
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any
import yaml
from social_lib.credentials import site_root as _site_root


@dataclass
class Persona:
    name: str
    handle: str
    role: str
    email: str
    dob: str
    bio: str
    employment_history: list[dict]
    avatar_path: str
    platforms: dict
    created: str


def make_handle(name: str) -> str:
    normalized = unicodedata.normalize("NFD", name)
    ascii_name = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9\s-]", "", ascii_name).strip().lower()
    return re.sub(r"[\s]+", "-", slug)


def persona_dir(domain: str) -> Path:
    return _site_root(domain) / "ops" / "personas"


def save_persona(domain: str, persona: Persona) -> Path:
    d = persona_dir(domain)
    d.mkdir(parents=True, exist_ok=True)
    (d / "avatars").mkdir(exist_ok=True)
    path = d / f"{persona.handle}.yaml"
    path.write_text(yaml.dump(asdict(persona), default_flow_style=False, allow_unicode=True))
    return path


def load_persona(domain: str, handle: str) -> Persona:
    path = persona_dir(domain) / f"{handle}.yaml"
    data = yaml.safe_load(path.read_text())
    return Persona(**data)


def list_personas(domain: str) -> list[Persona]:
    d = persona_dir(domain)
    if not d.exists():
        return []
    return [load_persona(domain, p.stem) for p in sorted(d.glob("*.yaml"))]
