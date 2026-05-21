"""Regenerate the human-readable DOMAINS_INDEX.md from sites.yml."""
from __future__ import annotations

from pathlib import Path

from site_tracker import registry


def render(sites_yml: Path, out: Path) -> None:
    reg = registry.load(sites_yml)
    lines = ["# Domains Index", ""]

    lines.append("## Active sites (built / operating)")
    lines.append("")
    lines.append("| Domain | TLDR |")
    lines.append("|--------|------|")
    for name, cfg in sorted(reg.sites.items()):
        if not cfg.get("active"):
            continue
        tldr = (cfg.get("manual", {}) or {}).get("tldr") or ""
        if isinstance(tldr, dict):
            tldr = tldr.get("value", "")
        lines.append(f"| {name} | {tldr} |")

    lines.append("")
    lines.append("## Parked / empty (registered, no site yet)")
    lines.append("")
    lines.append("| Domain | TLDR |")
    lines.append("|--------|------|")
    for name, cfg in sorted(reg.sites.items()):
        if cfg.get("active"):
            continue
        tldr = (cfg.get("manual", {}) or {}).get("tldr") or ""
        if isinstance(tldr, dict):
            tldr = tldr.get("value", "")
        lines.append(f"| {name} | {tldr} |")

    lines.append("")
    out.write_text("\n".join(lines))
