# tools/personas/src/personas/cli.py
from __future__ import annotations

import os
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from personas.email_provisioner import provision_email
from personas.face import fetch_face
from personas.generator import generate_persona
from personas.store import (
    Persona,
    list_personas,
    load_persona,
    make_handle,
    persona_dir,
    save_persona,
)

console = Console()

DOMAINS_ROOT = os.environ.get("DOMAINS_ROOT", "/home/jesse/projects/domains")


def _domain_to_brand(domain: str) -> str:
    """'america-strikes.com' → 'America Strikes'"""
    name_part = domain.rsplit(".", 1)[0]  # strip TLD
    words = name_part.replace("_", "-").split("-")
    return " ".join(w.title() for w in words if w)


@click.group()
def cli():
    """Fictional staff persona manager."""


@cli.command()
@click.option("--site", required=True, help="Domain, e.g. americastrikes.com")
@click.option("--count", default=1, show_default=True, help="Number of personas to create")
@click.option("--role", default="staff writer", show_default=True, help="Job role")
def create(site: str, count: int, role: str):
    """Generate fictional personas for a site."""
    brand = _domain_to_brand(site)

    for i in range(count):
        console.print(f"\n[bold]Generating persona {i + 1}/{count} for {site}...[/bold]")

        persona = generate_persona(role=role, site=brand, domain=site)
        console.print(f"  Name: {persona.name}  Handle: {persona.handle}")

        # Fetch AI face
        avatar_rel = f"ops/personas/avatars/{persona.handle}.jpg"
        avatar_abs = Path(DOMAINS_ROOT) / "sites" / site / avatar_rel
        try:
            fetch_face(avatar_abs)
            console.print("  [green]✓[/green] Face saved")
        except Exception as e:
            console.print(f"  [yellow]⚠[/yellow] Face fetch failed: {e}")
            avatar_rel = ""

        # Provision email alias
        try:
            email = provision_email(persona.name, site)
            console.print(f"  [green]✓[/green] Email alias: {email}")
        except Exception as e:
            handle_clean = persona.handle.replace("-", ".")
            email = f"{handle_clean}@{site}"
            console.print(f"  [yellow]⚠[/yellow] Email alias failed (using local only): {e}")

        # Update persona with email + avatar, then save
        persona = replace(persona, email=email, avatar_path=avatar_rel)
        path = save_persona(site, persona)
        console.print(f"  [green]✓[/green] Saved to {path}")


@cli.command("list")
@click.option("--site", required=True, help="Domain, e.g. americastrikes.com")
def list_cmd(site: str):
    """List personas for a site."""
    personas = list_personas(site)
    if not personas:
        console.print(f"No personas for {site}")
        return
    table = Table(title=f"Personas — {site}")
    table.add_column("Handle")
    table.add_column("Name")
    table.add_column("Role")
    table.add_column("Email")
    table.add_column("Platforms")
    for p in personas:
        platforms = (
            ", ".join(k for k, v in p.platforms.items() if v == "provisioned") or "none"
        )
        table.add_row(p.handle, p.name, p.role, p.email, platforms)
    console.print(table)


@cli.command()
@click.argument("handle")
@click.option("--site", required=True, help="Domain, e.g. americastrikes.com")
def show(handle: str, site: str):
    """Show details for a single persona."""
    try:
        p = load_persona(site, handle)
    except FileNotFoundError:
        console.print(f"[red]Persona '{handle}' not found for {site}[/red]")
        raise SystemExit(1)

    console.print(f"\n[bold]{p.name}[/bold] ({p.handle})")
    console.print(f"  Role   : {p.role}")
    console.print(f"  Email  : {p.email}")
    console.print(f"  DOB    : {p.dob}")
    console.print(f"  Bio    : {p.bio}")
    console.print(f"  Avatar : {p.avatar_path or '(none)'}")
    console.print(f"  Created: {p.created}")
    if p.employment_history:
        console.print("  Employment:")
        for entry in p.employment_history:
            console.print(f"    {entry.get('years', '?')}  {entry.get('company', '?')} — {entry.get('role', '?')}")
    if p.platforms:
        console.print(f"  Platforms: {', '.join(p.platforms.keys())}")


@cli.command()
@click.option("--all", "all_sites", is_flag=True, help="Show all sites with personas")
def status(all_sites: bool):
    """Show persona status across all sites."""
    sites_dir = Path(DOMAINS_ROOT) / "sites"
    if not sites_dir.exists():
        console.print("No sites directory found.")
        return
    sites = [d.name for d in sorted(sites_dir.iterdir()) if d.is_dir()] if all_sites else []
    found = False
    for site in sites:
        personas = list_personas(site)
        if personas:
            found = True
            console.print(f"[bold]{site}[/bold]: {len(personas)} persona(s)")
            for p in personas:
                console.print(f"  {p.handle} ({p.role})")
    if not found and all_sites:
        console.print("No personas found across any site.")
