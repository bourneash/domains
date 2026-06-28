"""CLI entry point for social-setup."""

from __future__ import annotations

import json
import sys
import traceback

import click
from rich.console import Console
from rich.table import Table

from .config import BrandContext, extract_brand, list_all_domains
from .credentials import has_creds
from .email import ensure_social_alias
from .exceptions import PlatformDeferred
from .platforms import ALL_PLATFORMS

console = Console()

PLATFORM_ORDER = ["bluesky", "reddit", "pinterest", "x", "instagram", "tiktok", "linkedin", "facebook"]


def _resolve_platforms(platforms_str: str | None) -> list[str]:
    if not platforms_str:
        return PLATFORM_ORDER
    requested = [p.strip().lower() for p in platforms_str.split(",")]
    unknown = [p for p in requested if p not in ALL_PLATFORMS]
    if unknown:
        console.print(f"[red]Unknown platforms: {', '.join(unknown)}[/red]")
        console.print(f"Available: {', '.join(ALL_PLATFORMS.keys())}")
        sys.exit(1)
    return requested


def _provision_platform(name: str, brand: BrandContext, force: bool = False, include_meta: bool = False) -> str:
    """Provision a single platform. Returns status string."""
    cls = ALL_PLATFORMS[name]

    # New-style platforms (BasePlatform subclass with provision(domain, brand, page))
    # have no signup() method and are constructed with no arguments.
    if hasattr(cls, 'provision') and not hasattr(cls, 'signup'):
        return _provision_new_style(name, cls, brand, force=force, include_meta=include_meta)

    # Old-style platforms (PlatformProvisioner subclass with signup(page))
    provisioner = cls(brand)

    if provisioner.already_provisioned() and not force:
        console.print(f"  [dim]{provisioner.display_name}: already provisioned, skipping (use --force to redo)[/dim]")
        provisioner.log_result("exists")
        return "exists"

    context = None
    page = None

    try:
        # Skip Meta platforms unless --include-meta is set
        if name in ("facebook", "instagram") and not include_meta:
            raise PlatformDeferred(
                f"{name.capitalize()} provisioning deferred — run with --include-meta when ready"
            )

        console.print(f"\n[bold]{'=' * 50}[/bold]")
        console.print(f"[bold]{provisioner.display_name}[/bold] — {brand.domain}")
        console.print(f"[bold]{'=' * 50}[/bold]")

        # Step 1: Signup
        if provisioner.needs_browser:
            from .browser import launch_browser
            context, page = launch_browser(brand.domain, name)

        creds = provisioner.signup(page)

        # Step 2: Configure profile
        provisioner.configure_profile(page)

        # Step 3: Get API keys (if supported)
        api_creds = provisioner.get_api_keys(page)
        if api_creds:
            creds.update(api_creds)

        # Step 4: Save credentials
        cred_path = provisioner.save_creds(creds)
        username = creds.get(f"{name.upper()}_USERNAME",
                            creds.get(f"{name.upper()}_HANDLE",
                            creds.get(f"{provisioner.display_name.upper().split()[0]}_USERNAME", "")))

        has_api = any(k for k in creds if "API" in k or "TOKEN" in k or "SECRET" in k or "JWT" in k)
        provisioner.log_result("created", username=username, api_keys=has_api)

        console.print(f"\n  [green]✓ {provisioner.display_name} — created[/green]")
        console.print(f"    Credentials saved to: {cred_path}")
        return "created"

    except PlatformDeferred as e:
        console.print(f"  [yellow]⏸ {name}: {e}[/yellow]")
        return "skipped"

    except RuntimeError as e:
        msg = str(e)
        if "skipped" in msg.lower():
            provisioner.log_result("skipped", error=msg)
            console.print(f"  [yellow]⏸ {provisioner.display_name} — skipped[/yellow]")
            return "skipped"
        provisioner.log_result("failed", error=msg)
        console.print(f"  [red]✗ {provisioner.display_name} — failed: {msg}[/red]")
        return "failed"

    except Exception as e:
        provisioner.log_result("failed", error=str(e))
        console.print(f"  [red]✗ {provisioner.display_name} — error: {e}[/red]")
        traceback.print_exc()
        return "failed"

    finally:
        if context:
            try:
                context.close()
            except Exception:
                pass


def _provision_new_style(name: str, cls, brand: BrandContext, force: bool = False, include_meta: bool = False) -> str:
    """Dispatch for new-style BasePlatform subclasses (provision(domain, brand, page))."""
    from .credentials import has_creds

    display_name = getattr(cls, 'display_name', name.capitalize())

    if not force and has_creds(brand.site_root, name):
        console.print(f"  [dim]{display_name}: already provisioned, skipping (use --force to redo)[/dim]")
        return "exists"

    context = None
    page = None

    try:
        if name in ("facebook", "instagram") and not include_meta:
            raise PlatformDeferred(
                f"{name.capitalize()} provisioning deferred — run with --include-meta when ready"
            )

        console.print(f"\n[bold]{'=' * 50}[/bold]")
        console.print(f"[bold]{display_name}[/bold] — {brand.domain}")
        console.print(f"[bold]{'=' * 50}[/bold]")

        from .browser import launch_browser
        context, page = launch_browser(brand.domain, name)

        platform = cls()
        result = platform.provision(brand.domain, brand, page)

        console.print(f"\n  [green]✓ {display_name} — created[/green]")
        return "created"

    except PlatformDeferred as e:
        console.print(f"  [yellow]⏸ {name}: {e}[/yellow]")
        return "skipped"

    except RuntimeError as e:
        msg = str(e)
        if "skipped" in msg.lower():
            console.print(f"  [yellow]⏸ {display_name} — skipped[/yellow]")
            return "skipped"
        console.print(f"  [red]✗ {display_name} — failed: {msg}[/red]")
        return "failed"

    except Exception as e:
        console.print(f"  [red]✗ {display_name} — error: {e}[/red]")
        traceback.print_exc()
        return "failed"

    finally:
        if context:
            try:
                context.close()
            except Exception:
                pass


@click.group()
def main():
    """Social media account provisioner for domain portfolio."""


@main.command()
@click.argument("domain")
@click.option("--platforms", "-p", default=None, help="Comma-separated platform list (default: all)")
@click.option("--force", is_flag=True, help="Re-provision even if credentials exist")
@click.option("--resume", is_flag=True, help="Resume from last state (skip completed)")
@click.option("--include-meta", is_flag=True, default=False, help="Include Facebook and Instagram (requires SMSPool creds)")
def provision(domain: str, platforms: str | None, force: bool, resume: bool, include_meta: bool):
    """Create and configure social media accounts for DOMAIN."""

    console.print(f"\n[bold]Social Media Setup — {domain}[/bold]\n")

    # Extract brand context
    try:
        brand = extract_brand(domain)
    except FileNotFoundError as e:
        console.print(f"[red]{e}[/red]")
        sys.exit(1)

    console.print(f"  Brand: {brand.name}")
    console.print(f"  Bio: {brand.bio_short[:80]}...")
    console.print(f"  Category: {brand.category}")
    console.print(f"  URL: {brand.url}")
    if brand.avatar_path:
        console.print(f"  Avatar: {brand.avatar_path}")
    console.print()

    # Ensure social@ email alias
    console.print("[bold]Step 1: Email alias[/bold]")
    created, msg = ensure_social_alias(domain)
    if created:
        console.print(f"  [green]✓ {msg}[/green]")
    else:
        console.print(f"  [dim]{msg}[/dim]")

    # Resolve platforms
    platform_list = _resolve_platforms(platforms)
    console.print(f"\n[bold]Step 2: Provision {len(platform_list)} platforms[/bold]")
    console.print(f"  Order: {' → '.join(platform_list)}")
    console.print(f"  (easiest-first: Bluesky/Reddit → browser-heavy: X/Instagram/TikTok/Facebook)\n")

    # Check for resume state
    if resume:
        log_path = brand.site_root / "ops" / "social" / "setup-log.json"
        if log_path.exists():
            log_data = json.loads(log_path.read_text())
            done = [
                p for p, info in log_data.get("platforms", {}).items()
                if info.get("status") == "created"
            ]
            if done:
                console.print(f"  [dim]Resuming — skipping already created: {', '.join(done)}[/dim]")
                platform_list = [p for p in platform_list if p not in done]

    # Provision each platform
    results: dict[str, str] = {}
    for name in platform_list:
        results[name] = _provision_platform(name, brand, force=force, include_meta=include_meta)

    # Summary
    console.print(f"\n[bold]{'=' * 50}[/bold]")
    console.print(f"[bold]Summary — {domain}[/bold]")
    console.print(f"[bold]{'=' * 50}[/bold]")

    table = Table()
    table.add_column("Platform", style="bold")
    table.add_column("Status")
    table.add_column("Details")

    status_styles = {
        "created": "[green]✓ created[/green]",
        "exists": "[dim]already exists[/dim]",
        "skipped": "[yellow]⏸ skipped[/yellow]",
        "failed": "[red]✗ failed[/red]",
    }

    for name in PLATFORM_ORDER:
        if name in results:
            status = results[name]
            cls = ALL_PLATFORMS[name]
            table.add_row(
                cls.display_name if hasattr(cls, 'display_name') else name,
                status_styles.get(status, status),
                f"creds: ops/social/.{name}-creds" if status == "created" else "",
            )

    console.print(table)


@main.command()
@click.argument("domain", required=False)
@click.option("--all", "show_all", is_flag=True, help="Show status for all domains")
def status(domain: str | None, show_all: bool):
    """Check social media account status for DOMAIN (or --all)."""

    if show_all:
        domains = list_all_domains()
    elif domain:
        domains = [domain]
    else:
        console.print("[red]Provide a domain or use --all[/red]")
        sys.exit(1)

    table = Table(title="Social Media Account Status")
    table.add_column("Domain", style="bold")
    for name in PLATFORM_ORDER:
        table.add_column(ALL_PLATFORMS[name].display_name if hasattr(ALL_PLATFORMS[name], 'display_name') else name)

    for d in domains:
        try:
            brand = extract_brand(d)
        except FileNotFoundError:
            continue

        row = [d]
        for name in PLATFORM_ORDER:
            if has_creds(brand.site_root, name):
                # Check setup log for details
                log_path = brand.site_root / "ops" / "social" / "setup-log.json"
                if log_path.exists():
                    log_data = json.loads(log_path.read_text())
                    info = log_data.get("platforms", {}).get(name, {})
                    username = info.get("username", "")
                    if username:
                        row.append(f"[green]✓[/green] {username}")
                    else:
                        row.append("[green]✓[/green]")
                else:
                    row.append("[green]✓[/green]")
            else:
                row.append("[dim]—[/dim]")
        table.add_row(*row)

    console.print(table)


if __name__ == "__main__":
    main()
