from __future__ import annotations

import csv
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl

import click
from dotenv import load_dotenv

from . import client as cl
from . import parse as parser
from . import profiles as prof

DOMAINS_ENV = Path("/home/jesse/projects/domains/.env")


def _load_env() -> None:
    if DOMAINS_ENV.exists():
        load_dotenv(DOMAINS_ENV)
    load_dotenv()  # also pick up local .env if present


@click.group()
def main() -> None:
    """ed-search — query expireddomains.net with your account."""
    _load_env()


@main.command()
def login() -> None:
    """Log in. If MFA is enabled, prints next step."""
    user, pw = cl.get_credentials()
    click.echo(f"logging in as {user}…")
    try:
        cl.login(user, pw)
        click.echo(f"ok — cookies saved to {cl.COOKIE_FILE}")
    except cl.MFARequired as e:
        click.echo(
            f"MFA required. Check email for the code, then run:\n"
            f"  ed-search verify <code>\n"
            f"(action: {e.action_path})"
        )


@main.command()
@click.argument("code")
def verify(code: str) -> None:
    """Submit the emailed MFA code to finalize login."""
    click.echo("verifying MFA code…")
    cl.verify_mfa(code)
    click.echo(f"ok — cookies saved to {cl.COOKIE_FILE}")


@main.command()
def whoami() -> None:
    """Probe the cached session."""
    c = cl.authed_client()
    if cl.probe(c):
        click.echo("session: OK")
    else:
        click.echo("session: NOT logged in (run `ed-search login`)", err=True)
        sys.exit(1)


@main.command(name="profiles")
def list_profiles_cmd() -> None:
    """List available profile files."""
    names = prof.list_profiles()
    if not names:
        click.echo("(no profiles yet — see profiles/aged-aviation.json)")
        return
    for n in names:
        p = prof.load(n)
        click.echo(f"  {n:<30} {p.description}")


def _ensure_session() -> "object":
    c = cl.authed_client()
    if cl.probe(c):
        return c
    click.echo(
        "session expired or missing. Run:\n"
        "  ed-search login\n"
        "  ed-search verify <emailed code>",
        err=True,
    )
    sys.exit(1)


def _write_csv(rows: list[dict[str, str]], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        out_path.write_text("")
        return
    keys: list[str] = []
    seen: set[str] = set()
    for r in rows:
        for k in r:
            if k not in seen:
                seen.add(k)
                keys.append(k)
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow(r)


@main.command()
@click.argument("profile_name", required=False)
@click.option("--inline", help="Ad-hoc query string instead of a profile, e.g. 'tld=com&minage=10'")
@click.option("--path", default="/domains/", show_default=True, help="Used with --inline")
@click.option("--pages", default=1, show_default=True, type=int, help="How many pages to walk")
@click.option("--sleep", default=2.0, show_default=True, type=float, help="Seconds between page fetches")
@click.option("--out", "out_dir", default="out", show_default=True, type=click.Path(), help="Output directory")
def run(
    profile_name: str | None,
    inline: str | None,
    path: str,
    pages: int,
    sleep: float,
    out_dir: str,
) -> None:
    """Run a saved profile (or --inline query) and write CSV."""
    if not profile_name and not inline:
        raise click.UsageError("Provide a profile name or --inline 'k=v&k2=v2'")

    if profile_name:
        p = prof.load(profile_name)
        params: dict[str, str | int] = dict(p.params)
        list_path = p.path
        label = profile_name
    else:
        params = dict(parse_qsl(inline or ""))
        list_path = path
        label = "inline"

    client = _ensure_session()
    all_rows: list[dict[str, str]] = []
    next_url: str | None = list_path
    next_params: dict[str, str | int] | None = params

    for i in range(pages):
        if next_url is None:
            break
        if next_params:
            r = client.get(next_url, params=next_params)
        else:
            r = client.get(next_url)
        r.raise_for_status()
        rows = parser.parse_results_table(r.text)
        click.echo(f"page {i + 1}: {len(rows)} rows  ({r.url})")
        all_rows.extend(rows)
        nxt = parser.find_pagination_next(r.text)
        if not nxt:
            break
        next_url = nxt
        next_params = None
        if i + 1 < pages:
            time.sleep(sleep)

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = Path(out_dir) / f"{label}-{ts}.csv"
    _write_csv(all_rows, out_path)
    click.echo(f"wrote {len(all_rows)} rows → {out_path}")


if __name__ == "__main__":
    main()
