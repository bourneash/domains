"""Extract brand context from a site's CLAUDE.md and ops/ files."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

DOMAINS_ROOT = Path(__file__).resolve().parents[4]  # tools/social-setup/src/social_setup -> domains/
ENV_PATH = DOMAINS_ROOT / ".env"
SITES_DIR = DOMAINS_ROOT / "sites"


@dataclass
class BrandContext:
    domain: str
    site_root: Path
    name: str  # human-friendly brand name
    description: str  # one-liner
    bio_short: str  # <=160 chars for social bios
    url: str
    category: str = "general"
    avatar_path: Path | None = None
    existing_platforms: list[str] = field(default_factory=list)


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


def site_root(domain: str) -> Path:
    p = SITES_DIR / domain
    if not p.is_dir():
        raise FileNotFoundError(f"Site directory not found: {p}")
    return p


def _extract_description(claude_md: str) -> str:
    """Pull the first real paragraph (non-heading, non-frontmatter, >30 chars)."""
    in_frontmatter = False
    lines = claude_md.split("\n")
    for line in lines:
        stripped = line.strip()
        if stripped == "---":
            in_frontmatter = not in_frontmatter
            continue
        if in_frontmatter:
            continue
        if stripped and not stripped.startswith("#") and len(stripped) > 30:
            cleaned = re.sub(r"\*+", "", stripped).strip()
            if cleaned and not cleaned.startswith("|") and not cleaned.startswith("-"):
                return cleaned[:300]
    return ""


def _derive_brand_name(domain: str, claude_md: str = "") -> str:
    """Extract brand name from CLAUDE.md title line, or infer from domain."""
    if claude_md:
        for line in claude_md.split("\n"):
            stripped = line.strip()
            m = re.match(r"^#\s+(\S+?)(?:\.(?:com|net|org|info|me))?\s*[—–-]", stripped)
            if m:
                raw = m.group(1)
                # Try PascalCase split first
                words = re.findall(r"[A-Z][a-z]+|[a-z]+(?=[A-Z])|[A-Z]+(?=[A-Z][a-z]|\b)", raw)
                if len(words) > 1:
                    return " ".join(w.capitalize() for w in words)
                # All-lowercase compound: split on common word boundaries
                if raw == raw.lower() and len(raw) > 6:
                    return raw.replace("-", " ").replace("_", " ").title()
                return raw if raw[0].isupper() else raw.title()

    name_part = domain.split(".")[0]
    return name_part.replace("-", " ").replace("_", " ").title()


def _find_avatar(site_root: Path) -> Path | None:
    candidates = [
        site_root / "site" / "public" / "favicon.svg",
        site_root / "site" / "public" / "favicon.png",
        site_root / "site" / "public" / "og-image.png",
        site_root / "site" / "public" / "logo.svg",
        site_root / "site" / "public" / "logo.png",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def _detect_category(claude_md: str, domain: str) -> str:
    # Use the "What This Is" section (first ~500 chars) for primary signal
    what_match = re.search(r"##\s*What This Is\s*\n(.*?)(?=\n##|\Z)", claude_md, re.DOTALL)
    intro = (what_match.group(1)[:500] if what_match else claude_md[:500]).lower()

    if any(w in intro for w in ["news brand", "geopolitics", "defense", "editorial", "news operations"]):
        return "news"
    if any(w in intro for w in ["review", "affiliate", "product review"]):
        return "product_review"
    if any(w in intro for w in ["game", "entertainment", "fiction"]):
        return "entertainment"
    return "general"


def _check_existing_platforms(sr: Path) -> list[str]:
    social_dir = sr / "ops" / "social"
    if not social_dir.is_dir():
        return []
    found = []
    for f in social_dir.iterdir():
        if f.name.startswith(".") and f.name.endswith("-creds") and f.stat().st_size > 0:
            platform = f.name[1:].replace("-creds", "")
            found.append(platform)
    return found


def extract_brand(domain: str) -> BrandContext:
    sr = site_root(domain)
    claude_md_path = sr / "CLAUDE.md"
    claude_md = claude_md_path.read_text() if claude_md_path.exists() else ""

    name = _derive_brand_name(domain, claude_md)
    description = _extract_description(claude_md)
    category = _detect_category(claude_md, domain)

    if description:
        # Truncate at first sentence boundary that fits in 160 chars
        sentences = re.split(r"(?<=[.!?])\s+", description)
        bio_short = sentences[0][:160]
        if len(bio_short) < 60 and len(sentences) > 1:
            candidate = f"{sentences[0]} {sentences[1]}"
            if len(candidate) <= 160:
                bio_short = candidate
    else:
        bio_short = f"{name} — {domain}"

    social_role_paths = [
        sr / "ops" / "roles" / "social-media.md",
        sr / "ops" / "roles" / "social.md",
    ]
    for rp in social_role_paths:
        if rp.exists():
            role_text = rp.read_text()
            bio_match = re.search(r"Bio:\s*[`\"'](.+?)[`\"']", role_text)
            if bio_match:
                bio_short = bio_match.group(1)[:160]
            break

    return BrandContext(
        domain=domain,
        site_root=sr,
        name=name,
        description=description,
        bio_short=bio_short,
        url=f"https://{domain}",
        category=category,
        avatar_path=_find_avatar(sr),
        existing_platforms=_check_existing_platforms(sr),
    )


def list_all_domains() -> list[str]:
    if not SITES_DIR.is_dir():
        return []
    return sorted(
        d.name for d in SITES_DIR.iterdir()
        if d.is_dir() and "." in d.name and (d / "CLAUDE.md").exists()
    )
