"""Abstract base for platform provisioners."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path

from rich.console import Console

from ..config import BrandContext
from ..credentials import has_creds, write_creds
from ..passwords import generate as gen_password
from social_lib.totp import generate_secret
from social_lib.credentials import read_creds, write_creds as lib_write_creds

console = Console()


class BasePlatform:
    """Lightweight base with shared utilities that don't require a BrandContext."""

    def generate_and_store_totp(self, domain: str, platform_name: str) -> str:
        """Generate a TOTP secret, append it to the existing cred file, and return the secret."""
        secret = generate_secret()
        existing = read_creds(domain, platform_name)
        existing["TOTP_SECRET"] = secret
        lib_write_creds(domain, platform_name, existing)
        return secret


class PlatformProvisioner(BasePlatform, ABC):
    """Base class for social media platform account provisioners."""

    name: str  # e.g. "x", "instagram"
    display_name: str  # e.g. "X (Twitter)", "Instagram"
    needs_browser: bool = True

    def __init__(self, brand: BrandContext):
        self.brand = brand
        self.password = gen_password()
        self.email = f"social@{brand.domain}"

    @abstractmethod
    def signup(self, page) -> dict:
        """Create the account. Returns creds dict or raises."""

    @abstractmethod
    def configure_profile(self, page) -> None:
        """Set bio, avatar, header, URL, etc."""

    def get_api_keys(self, page) -> dict | None:
        """Navigate to dev portal and capture API keys. Override per platform."""
        return None

    def already_provisioned(self) -> bool:
        return has_creds(self.brand.site_root, self.name)

    def derive_username(self) -> str:
        name = self.brand.domain.split(".")[0]
        cleaned = name.replace("-", "").replace("_", "")
        return cleaned.capitalize()

    def save_creds(self, creds: dict) -> Path:
        return write_creds(self.brand.site_root, self.name, creds)

    def log_result(self, status: str, username: str = "", api_keys: bool = False, error: str = ""):
        log_path = self.brand.site_root / "ops" / "social" / "setup-log.json"
        log_data = {}
        if log_path.exists():
            try:
                log_data = json.loads(log_path.read_text())
            except json.JSONDecodeError:
                pass

        if "domain" not in log_data:
            log_data["domain"] = self.brand.domain
            log_data["email"] = self.email

        platforms = log_data.setdefault("platforms", {})
        entry = {
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if username:
            entry["username"] = username
        if api_keys:
            entry["api_keys"] = True
        if error:
            entry["error"] = error
        entry["cred_file"] = f"ops/social/.{self.name}-creds"
        platforms[self.name] = entry

        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(json.dumps(log_data, indent=2) + "\n")
