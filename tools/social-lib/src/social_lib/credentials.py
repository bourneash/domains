from __future__ import annotations
import os
from pathlib import Path


def site_root(domain: str) -> Path:
    base = os.environ.get("DOMAINS_ROOT", "/home/jesse/projects/domains")
    return Path(base) / "sites" / domain


def cred_path(domain: str, platform: str) -> Path:
    return site_root(domain) / "ops" / "social" / f".{platform}-creds"


def write_creds(domain: str, platform: str, data: dict) -> None:
    path = cred_path(domain, platform)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(f"{k}={v}" for k, v in data.items()) + "\n")
    path.chmod(0o600)


def read_creds(domain: str, platform: str) -> dict:
    path = cred_path(domain, platform)
    if not path.exists():
        return {}
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        result[k.strip()] = v.strip()
    return result


def has_creds(domain: str, platform: str) -> bool:
    path = cred_path(domain, platform)
    return path.exists() and path.stat().st_size > 0


def write_stub(domain: str, platform: str) -> None:
    path = cred_path(domain, platform)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("# deferred\n")
        path.chmod(0o600)
