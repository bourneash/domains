"""Vault-backed credential access for social-setup. Keeps the site_root-based
signature the platform provisioners already use; delegates to social_lib's
Vaultwarden-backed store (domain = site_root.name)."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from social_lib import vault_store


def cred_dir(site_root: Path) -> Path:
    # Kept for callers that still expect a filesystem path back (e.g. logging);
    # no creds are written here anymore, everything goes to the vault.
    d = site_root / "ops" / "social"
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_creds(site_root: Path, platform: str) -> Optional[dict[str, str]]:
    data = vault_store.read_creds(site_root.name, platform)
    return data or None


def write_creds(site_root: Path, platform: str, creds: dict[str, str]) -> str:
    vault_store.write_creds(site_root.name, platform, creds)
    return f"vault:{site_root.name}/{platform}"


def has_creds(site_root: Path, platform: str) -> bool:
    return vault_store.has_creds(site_root.name, platform)
