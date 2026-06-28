# tools/social-poster/src/social_poster/cli.py
from __future__ import annotations

import click
from rich.console import Console
from rich.table import Table

from social_poster.poster import post_domain
from social_poster.post_log import recent_posts

console = Console()


@click.group()
def cli():
    """Social media poster — post site articles to all platforms."""


@cli.command()
@click.argument("domain")
@click.option("--platforms", default=None, help="Comma-separated list, e.g. x,bluesky,reddit")
@click.option("--dry-run", is_flag=True, help="Show what would be posted without posting")
def post(domain: str, platforms: str | None, dry_run: bool):
    """Post latest article(s) from DOMAIN to social platforms."""
    platform_list = [p.strip() for p in platforms.split(",")] if platforms else None

    if dry_run:
        from social_poster.content_loader import load_latest_articles

        articles = load_latest_articles(domain, limit=3)
        console.print(f"[bold]Dry run for {domain}[/bold]")
        if not articles:
            console.print("  [dim]No articles found.[/dim]")
            return
        for a in articles:
            console.print(f"  {a.slug}: {a.title}")
        return

    results = post_domain(domain, platforms=platform_list)
    if not results:
        console.print(f"[dim]No results for {domain}.[/dim]")
        return

    table = Table(title=f"Post results — {domain}")
    table.add_column("Platform")
    table.add_column("Article")
    table.add_column("Result")
    table.add_column("URL / Note")

    status_fmt = {
        "posted": "[green]posted[/green]",
        "skipped": "[dim]skipped[/dim]",
        "error": "[red]error[/red]",
    }
    for r in results:
        status = status_fmt.get(r["result"], r["result"])
        note = r.get("url") or r.get("error") or r.get("reason") or ""
        table.add_row(r["platform"], r["slug"], status, note)

    console.print(table)


@cli.command()
@click.argument("domain")
@click.option("--limit", default=20, show_default=True, help="Number of recent entries to show")
def status(domain: str, limit: int):
    """Show recent post log for DOMAIN."""
    posts = recent_posts(domain, limit=limit)
    if not posts:
        console.print("No posts logged yet.")
        return

    table = Table(title=f"Post log — {domain}")
    table.add_column("Platform")
    table.add_column("Slug")
    table.add_column("Posted At")

    for p in posts:
        slug = p.get("article_slug") or p.get("slug") or ""
        posted_at = (p.get("posted_at") or "")[:19]
        table.add_row(p.get("platform", ""), slug, posted_at)

    console.print(table)
