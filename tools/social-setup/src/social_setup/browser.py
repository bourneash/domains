"""CloakBrowser wrapper: launch, persistent profiles, human-gate pauses."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING

from rich.console import Console
from rich.panel import Panel

if TYPE_CHECKING:
    pass

PROFILES_DIR = Path(__file__).resolve().parents[2] / "profiles"
console = Console()


def profile_dir(domain: str, platform: str) -> str:
    d = PROFILES_DIR / domain / platform
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def launch_browser(domain: str, platform: str, proxy: str | None = None):
    """Launch CloakBrowser with persistent profile. Returns (browser, context, page).

    `proxy` is an HTTP proxy URL (e.g. "http://127.0.0.1:8183" for the
    rotating VPN exit in tools/vpn-proxy — see
    [[reference_vpn_rotating_proxy]]). Opt-in per caller, not a default,
    since not every platform's automation wants its egress routed through
    the VPN proxy.
    """
    try:
        from cloakbrowser import launch_persistent_context
    except ImportError:
        console.print(
            "[red]cloakbrowser not installed. Run: pip install cloakbrowser[/red]"
        )
        sys.exit(1)

    pdir = profile_dir(domain, platform)
    context = launch_persistent_context(
        pdir,
        headless=False,
        humanize=True,
        proxy=proxy,
    )
    page = context.new_page()
    return context, page


def human_gate(platform: str, reason: str) -> bool:
    """Pause and ask the user to complete a step in the browser window.

    Returns True if user confirms completion, False if they want to skip.
    """
    console.print()
    console.print(
        Panel(
            f"[bold yellow]{platform}[/bold yellow] requires manual action:\n\n"
            f"  {reason}\n\n"
            "Complete the step in the browser window.\n"
            "Press [bold]Enter[/bold] when done, or type [bold]skip[/bold] to skip this platform.",
            title="Manual Step Required",
            border_style="yellow",
        )
    )
    response = input("> ").strip().lower()
    return response != "skip"


def human_gate_input(platform: str, prompt: str) -> str | None:
    """Pause and ask the user to provide a value (e.g., verification code).

    Returns the input string, or None if user types 'skip'.
    """
    console.print()
    console.print(
        Panel(
            f"[bold yellow]{platform}[/bold yellow] needs input:\n\n"
            f"  {prompt}\n\n"
            "Type the value, or type [bold]skip[/bold] to skip.",
            title="Input Required",
            border_style="yellow",
        )
    )
    response = input("> ").strip()
    if response.lower() == "skip":
        return None
    return response
