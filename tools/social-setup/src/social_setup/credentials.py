"""Read / write per-site credential files under ops/social/."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Optional


def cred_dir(site_root: Path) -> Path:
    d = site_root / "ops" / "social"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cred_path(site_root: Path, platform: str) -> Path:
    return cred_dir(site_root) / f".{platform}-creds"


def read_creds(site_root: Path, platform: str) -> Optional[dict[str, str]]:
    p = cred_path(site_root, platform)
    if not p.exists():
        return None
    creds: dict[str, str] = {}
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            creds[key.strip()] = val.strip()
    return creds


def write_creds(site_root: Path, platform: str, creds: dict[str, str]) -> Path:
    p = cred_path(site_root, platform)
    lines = [f"{k}={v}" for k, v in creds.items()]
    p.write_text("\n".join(lines) + "\n")
    os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)  # 600
    return p


def has_creds(site_root: Path, platform: str) -> bool:
    return cred_path(site_root, platform).exists()
