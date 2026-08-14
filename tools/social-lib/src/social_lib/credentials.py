"""Domain-keyed credential access. Vault-backed (see vault_store.py) —
these thin wrappers keep the (domain, platform) call signature every
consumer already uses (social-setup, social-poster, personas)."""

from __future__ import annotations
from pathlib import Path
import os

from . import vault_store


def site_root(domain: str) -> Path:
    base = os.environ.get("DOMAINS_ROOT", "/home/jesse/projects/domains")
    return Path(base) / "sites" / domain


def write_creds(domain: str, platform: str, data: dict) -> None:
    vault_store.write_creds(domain, platform, data)


def read_creds(domain: str, platform: str) -> dict:
    return vault_store.read_creds(domain, platform)


def has_creds(domain: str, platform: str) -> bool:
    return vault_store.has_creds(domain, platform)


def write_stub(domain: str, platform: str) -> None:
    vault_store.write_stub(domain, platform)
