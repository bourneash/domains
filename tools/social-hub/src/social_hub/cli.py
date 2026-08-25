"""`social-hub` — the terminal face of the platform.

Everything the UI can do is available here, because the parts of this system
that run unattended (cron, skills, other fleet tools) live on the CLI, not in a
browser. `social-hub tick` is the single entry point cron needs.
"""

from __future__ import annotations

import json as jsonlib

import click
from rich.console import Console
from rich.table import Table

from social_hub import accounts, db, engagement, generator, publisher, queue, sources, worker
from social_hub.config import load_all, load_site_config, managed_sites, site_config_path

console = Console()

STATUS_STYLE = {
    "draft": "yellow",
    "approved": "cyan",
    "scheduled": "cyan",
    "publishing": "magenta",
    "posted": "green",
    "failed": "red",
    "rejected": "dim",
    "cancelled": "dim",
}


def _fmt_status(status: str) -> str:
    return f"[{STATUS_STYLE.get(status, 'white')}]{status}[/]"


def _require_cfg(site: str):
    cfg = load_site_config(site)
    if cfg is None:
        raise click.ClickException(
            f"{site} is not managed by the hub — create {site_config_path(site)}"
        )
    return cfg


@click.group()
@click.option("--db", "db_file", default=None, help="Override the hub database path")
def cli(db_file: str | None):
    """Fleet social media management — queue, schedule, publish, reply."""
    if db_file:
        import os

        os.environ["SOCIAL_HUB_DB"] = db_file


# --------------------------------------------------------------------------
@cli.command()
@click.option("--site", default=None)
@click.option("--json", "as_json", is_flag=True)
def status(site: str | None, as_json: bool):
    """Show queue, channel and schedule state."""
    data = worker.status(site)
    if as_json:
        click.echo(jsonlib.dumps(data, indent=2))
        return
    if not data["sites"]:
        console.print("[dim]No managed sites. Add ops/social/hub.yaml to a site to opt in.[/dim]")
        return
    for name, info in data["sites"].items():
        counts = info["counts"]
        console.print(f"\n[bold]{name}[/bold]")
        summary = "  ".join(f"{_fmt_status(k)} {v}" for k, v in sorted(counts.items())) or "[dim]empty queue[/dim]"
        console.print(f"  queue: {summary}")
        console.print(
            f"  next send: {info['next_send'] or '[dim]nothing scheduled[/dim]'}"
            f"   scheduled(7d): {info['scheduled_7d']}   inbox: {info['inbox_new']} new"
        )
        for chan in info["channels"]:
            mark = "[green]on[/green]" if chan["enabled"] else "[dim]off[/dim]"
            needs = chan.get("needs_creds", True)
            creds = "" if chan["has_creds"] or not needs else " [red](no creds)[/red]"
            who = chan["persona"] or "brand"
            console.print(f"    {mark} {chan['platform']}/{who} {chan['handle']}{creds}")


@cli.command()
def sites():
    """List sites that have opted into the hub."""
    table = Table(title="Managed sites")
    for col in ("Site", "Platforms", "Approval", "Replies", "Slots"):
        table.add_column(col)
    for name, cfg in load_all().items():
        table.add_row(
            name,
            ", ".join(cfg.platforms),
            cfg.approval,
            "on" if cfg.get("reply.enabled", True) else "off",
            ", ".join(cfg.get("cadence.slots") or []),
        )
    console.print(table)
    unmanaged = sorted(set(managed_sites()) - set(load_all()))
    if unmanaged:
        console.print(f"[dim]disabled: {', '.join(unmanaged)}[/dim]")


# --------------------------------------------------------------------------
@cli.group()
def channels():
    """Account/channel inventory."""


@channels.command("sync")
@click.option("--site", default=None)
def channels_sync(site: str | None):
    """Mirror the social registry into the hub."""
    result = accounts.sync_channels([site] if site else None)
    console.print(result)


@channels.command("list")
@click.option("--site", default=None)
def channels_list(site: str | None):
    table = Table(title="Channels")
    for col in ("ID", "Site", "Platform", "Persona", "Handle", "Status", "Enabled", "Creds"):
        table.add_column(col)
    for chan in accounts.list_channels(site=site):
        table.add_row(
            str(chan["id"]), chan["site"], chan["platform"], chan["persona"] or "-",
            chan["handle"] or "-", chan["status"],
            "yes" if chan["enabled"] else "no", "yes" if chan["has_creds"] else "no",
        )
    console.print(table)


@channels.command("verify")
@click.option("--site", default=None)
@click.option("--platform", default=None)
def channels_verify(site: str | None, platform: str | None):
    """Live auth check against each platform."""
    for chan in accounts.list_channels(site=site, platform=platform):
        result = accounts.verify_channel(chan)
        mark = "[green]ok[/green]" if result.get("ok") else f"[red]{result.get('error', 'failed')}[/red]"
        console.print(f"{chan['site']} {chan['platform']}/{chan['persona'] or 'brand'}: {mark}")


@channels.command("enable")
@click.argument("channel_id", type=int)
@click.option("--off", is_flag=True, help="Disable instead of enable")
def channels_enable(channel_id: int, off: bool):
    db.update("channels", channel_id, {"enabled": 0 if off else 1})
    console.print(f"channel {channel_id} {'disabled' if off else 'enabled'}")


# --------------------------------------------------------------------------
@cli.command()
@click.argument("site")
def ingest(site: str):
    """Scan a site's content for new postable items."""
    console.print(sources.ingest(site, _require_cfg(site)))


@cli.command()
@click.argument("site")
@click.option("--limit", default=None, type=int, help="Sources this run (default: the site's max_sources_per_run)")
def generate(site: str, limit: int | None):
    """Draft posts for pending sources."""
    console.print(generator.generate(site, _require_cfg(site), limit=limit))


@cli.command("queue")
@click.option("--site", default=None)
@click.option("--status", "status_filter", default="draft,approved,scheduled", show_default=True)
@click.option("--kind", default=None, type=click.Choice(["post", "reply"]))
@click.option("--limit", default=50, show_default=True)
def queue_cmd(site: str | None, status_filter: str, kind: str | None, limit: int):
    """List queued posts."""
    statuses = [s.strip() for s in status_filter.split(",") if s.strip()] or None
    posts = queue.list_posts(site=site, status=statuses, kind=kind, limit=limit)
    if not posts:
        console.print("[dim]nothing queued[/dim]")
        return
    table = Table(title="Queue")
    for col in ("ID", "Site", "Platform", "Kind", "Status", "When", "Body"):
        table.add_column(col)
    for post in posts:
        table.add_row(
            str(post["id"]), post["site"], post["platform"], post["kind"],
            _fmt_status(post["status"]), (post["scheduled_at"] or "-")[:16],
            post["body"][:70] + ("…" if len(post["body"]) > 70 else ""),
        )
    console.print(table)


@cli.command()
@click.argument("post_id", type=int)
def show(post_id: int):
    """Show one post in full."""
    post = queue.get(post_id)
    if not post:
        raise click.ClickException("not found")
    console.print_json(data=post)


@cli.command()
@click.argument("site")
@click.argument("platform")
@click.option("--body", default="", help="Write it yourself; omit to have the model draft it")
@click.option("--source", "source_id", default=None, help="Draft from this article slug")
@click.option("--schedule", is_flag=True, help="Approve and schedule immediately")
def compose(site: str, platform: str, body: str, source_id: str | None, schedule: bool):
    """Create a one-off post."""
    _require_cfg(site)
    post = generator.compose(site, platform, body=body, source_id=source_id, schedule=schedule)
    console.print(f"post {post['id']} [{post['status']}] — {post['body'][:120]}")


@cli.command()
@click.argument("post_id", type=int)
@click.option("--body", default=None)
@click.option("--at", "scheduled_at", default=None, help="ISO time to send at")
def edit(post_id: int, body: str | None, scheduled_at: str | None):
    """Edit a queued post's copy or send time."""
    post = queue.edit(post_id, body=body, scheduled_at=scheduled_at)
    if not post:
        raise click.ClickException("not found")
    console.print(f"post {post_id} updated — {post['body'][:120]}")


@cli.command()
@click.argument("post_ids", type=int, nargs=-1, required=True)
@click.option("--by", default="cli")
def approve(post_ids: tuple[int, ...], by: str):
    """Approve and schedule posts."""
    for post_id in post_ids:
        post = queue.approve(post_id, by=by)
        if post:
            console.print(f"post {post_id} scheduled for {post['scheduled_at']}")


@cli.command()
@click.argument("post_ids", type=int, nargs=-1, required=True)
@click.option("--reason", default="")
def reject(post_ids: tuple[int, ...], reason: str):
    """Reject drafts."""
    for post_id in post_ids:
        queue.reject(post_id, by="cli", reason=reason)
        console.print(f"post {post_id} rejected")


@cli.command()
@click.option("--post", "post_id", type=int, default=None, help="Publish one post now")
@click.option("--limit", default=25, show_default=True)
def publish(post_id: int | None, limit: int):
    """Publish due posts (or one post immediately)."""
    if post_id:
        db.update("posts", post_id, {"status": "scheduled", "scheduled_at": db.utcnow()})
        console.print(publisher.publish_post(post_id))
        return
    results = publisher.publish_due(limit=limit)
    if not results:
        console.print("[dim]nothing due[/dim]")
    for result in results:
        mark = "[green]sent[/green]" if result.get("ok") else f"[red]{result.get('error')}[/red]"
        console.print(f"post {result['id']}: {mark} {result.get('url', '')}")


# --------------------------------------------------------------------------
@cli.group()
def inbox():
    """Mentions and replies."""


@inbox.command("poll")
@click.option("--site", default=None)
def inbox_poll(site: str | None):
    targets = [site] if site else managed_sites()
    for name in targets:
        console.print(f"{name}: {engagement.poll_site(name)}")


@inbox.command("list")
@click.option("--site", default=None)
@click.option("--status", "status_filter", default="new,drafted", show_default=True)
def inbox_list(site: str | None, status_filter: str):
    statuses = [s.strip() for s in status_filter.split(",")]
    mentions = engagement.list_mentions(site=site, status=statuses, limit=50)
    if not mentions:
        console.print("[dim]inbox empty[/dim]")
        return
    table = Table(title="Inbox")
    for col in ("ID", "Site", "Platform", "From", "Status", "Message"):
        table.add_column(col)
    for mention in mentions:
        table.add_row(
            str(mention["id"]), mention["site"], mention["platform"],
            f"@{mention['author_handle']}", mention["status"],
            mention["text"][:60].replace("\n", " "),
        )
    console.print(table)


@inbox.command("draft")
@click.argument("mention_id", type=int)
def inbox_draft(mention_id: int):
    """Draft a reply to one mention."""
    mention = db.row_to_dict(db.one("SELECT * FROM mentions WHERE id = ?", (mention_id,)))
    if not mention:
        raise click.ClickException("mention not found")
    post_id = engagement.draft_reply_for(mention, _require_cfg(mention["site"]))
    if not post_id:
        console.print("[yellow]declined — nothing drafted[/yellow]")
        return
    console.print(f"reply queued as post {post_id}: {queue.get(post_id)['body'][:120]}")


@inbox.command("ignore")
@click.argument("mention_ids", type=int, nargs=-1, required=True)
def inbox_ignore(mention_ids: tuple[int, ...]):
    for mention_id in mention_ids:
        engagement.set_mention_status(mention_id, "ignored")
        console.print(f"mention {mention_id} ignored")


# --------------------------------------------------------------------------
@cli.command()
@click.option("--site", default=None, help="One site (default: every managed site)")
@click.option("--no-publish", is_flag=True, help="Do everything except sending")
@click.option("--notify/--no-notify", default=False, help="Slack review nudge")
@click.option("--json", "as_json", is_flag=True)
def tick(site: str | None, no_publish: bool, notify: bool, as_json: bool):
    """Run the full pipeline once. This is what cron calls."""
    result = worker.tick(site, publish=not no_publish, notify_review=notify)
    if as_json:
        click.echo(jsonlib.dumps(result, indent=2, default=str))
        return
    for name, stats in result["sites"].items():
        if stats.get("skipped"):
            console.print(f"[dim]{name}: {stats['skipped']}[/dim]")
            continue
        console.print(
            f"[bold]{name}[/bold]: "
            f"sources +{(stats.get('ingest') or {}).get('new', 0)}, "
            f"drafts +{(stats.get('generate') or {}).get('drafted', 0)}, "
            f"mentions +{(stats.get('inbox') or {}).get('new', 0)}, "
            f"replies +{(stats.get('replies') or {}).get('drafted', 0)}, "
            f"published {stats.get('published', 0)}"
            + (f" [red]errors: {stats['errors']}[/red]" if stats.get("errors") else "")
        )


@cli.command()
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=4772, show_default=True)
@click.option("--reload", is_flag=True)
def serve(host: str, port: int, reload: bool):
    """Run the API + web UI."""
    from social_hub.api import serve as _serve

    console.print(f"social-hub on http://{host}:{port}")
    _serve(host=host, port=port, reload=reload)


@cli.command()
def doctor():
    """Check the environment: DB, config, registry, credentials, AI backend."""
    from social_hub import ai
    from social_hub.platforms import platform_names

    console.print(f"db:          {db.db_path()} ({'exists' if db.db_path().exists() else 'will be created'})")
    console.print(f"managed:     {', '.join(managed_sites()) or '[dim]none[/dim]'}")
    console.print(f"registry:    {accounts.REGISTRY_FILE} ({len(accounts.read_registry().get('accounts', []))} accounts)")
    console.print(f"platforms:   {', '.join(platform_names())}")
    console.print(f"ai backend:  {ai.resolve_backend()}")
    problems = 0
    for name in managed_sites():
        cfg = load_site_config(name)
        if not cfg:
            continue
        for platform in cfg.platforms:
            channel = accounts.pick_channel(name, platform)
            if not channel:
                console.print(f"[yellow]  {name}/{platform}: no channel (run `social-hub channels sync`)[/yellow]")
                problems += 1
            elif not channel["enabled"]:
                console.print(f"[yellow]  {name}/{platform}: channel disabled ({channel['status']})[/yellow]")
                problems += 1
    console.print("[green]no problems found[/green]" if not problems else f"[yellow]{problems} issue(s)[/yellow]")


if __name__ == "__main__":  # pragma: no cover
    cli()
