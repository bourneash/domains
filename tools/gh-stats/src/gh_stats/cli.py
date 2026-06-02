"""gh-stats CLI: snapshot every active repo from site-tracker's sites.yml,
append JSONL + refresh latest.json. Mirrors cf-stats' CLI shape."""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import click
from dotenv import load_dotenv

from . import __version__
from .api import GHClient
from . import collectors as C
from . import registry


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _load_env(env_file: Path | None) -> str:
    if env_file:
        load_dotenv(env_file, override=False)
    else:
        for cand in (Path.cwd() / ".env",
                     Path("/work/.env.shared"),
                     Path("/home/jesse/projects/domains/.env")):
            if cand.exists():
                load_dotenv(cand, override=False)
                break
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        click.echo("ERROR: GITHUB_TOKEN (or GH_TOKEN) required", err=True)
        sys.exit(2)
    return token


def _summary_line(snap: dict) -> str:
    repos = snap.get("repos") or {}
    ok = sum(1 for r in repos.values() if r.get("ok"))
    prs = sum(r.get("open_pr_count", 0) for r in repos.values() if r.get("ok"))
    return (f"[{snap['timestamp']}] gh-stats repos={len(repos)} ok={ok} "
            f"open_prs={prs} {snap['duration_seconds']}s")


@click.group()
@click.version_option(__version__)
def main() -> None:
    """GitHub per-repo snapshot collector."""


@main.command()
@click.option("--out-dir", "out_dir", type=click.Path(path_type=Path), default=Path("out"))
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None)
@click.option("--sites-file", type=click.Path(path_type=Path), default=None,
              help="Override path to site-tracker sites.yml.")
@click.option("--quiet", is_flag=True)
def collect(out_dir: Path, env_file: Path | None, sites_file: Path | None, quiet: bool) -> None:
    """Snapshot all active repos, write JSONL + latest.json, print summary."""
    token = _load_env(env_file)
    out_dir.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    ts = _now_iso()
    sites = registry.load_sites(sites_file)
    snap: dict = {"timestamp": ts, "version": __version__, "repos": {}}
    if not sites:
        snap["note"] = "no sites.yml found or no active repos"

    with GHClient(token) as gh:
        for domain, slug in sites.items():
            snap["repos"][domain] = C.collect_repo(gh, domain, slug)

    snap["duration_seconds"] = round(time.monotonic() - started, 2)

    day = ts[:10]
    with (out_dir / f"gh-stats-{day}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(snap, separators=(",", ":")) + "\n")
    (out_dir / "latest.json").write_text(json.dumps(snap, indent=2) + "\n", encoding="utf-8")

    if not quiet:
        click.echo(_summary_line(snap))


@main.command()
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None)
def verify(env_file: Path | None) -> None:
    """Verify the token works (GET /user). Exit 0 on success."""
    token = _load_env(env_file)
    try:
        with GHClient(token) as gh:
            who = gh.get("/user")
    except Exception as e:
        click.echo(f"FAIL: {e}", err=True)
        sys.exit(1)
    click.echo(f"OK login={who.get('login')}")


if __name__ == "__main__":
    main()
