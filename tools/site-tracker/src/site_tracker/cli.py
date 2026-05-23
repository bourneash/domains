"""site-tracker CLI: collect, collect-all, init-db, serve, render-domains-index."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import click
from dotenv import load_dotenv

from site_tracker import store, registry
from site_tracker.collectors import (
    cloudflare,
    filesystem,
    github,
    http_scrape,
    recipes,
    search_consoles,
)

COLLECTORS = {
    "filesystem":      filesystem,
    "http_scrape":     http_scrape,
    "cloudflare":      cloudflare,
    "github":          github,
    "recipes":         recipes,
    "search_consoles": search_consoles,
}


def _load_env() -> None:
    for cand in (
        Path.cwd() / ".env",
        Path("/work/.env.shared"),
        Path("/home/jesse/projects/domains/.env"),
    ):
        if cand.exists():
            load_dotenv(cand, override=False)
            return


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )


@click.group()
@click.option("-v", "--verbose", is_flag=True)
def main(verbose: bool) -> None:
    _setup_logging(verbose)
    _load_env()


def _resolve_paths(data_dir: Path | None, sites_yml: Path | None) -> tuple[Path, Path]:
    here = Path.cwd()
    sites = sites_yml or (here / "sites.yml")
    data = data_dir or (here / "data")
    return sites, data


@main.command("init-db")
@click.option("--data-dir", type=click.Path(path_type=Path), default=None)
def init_db(data_dir: Path | None) -> None:
    _, data = _resolve_paths(data_dir, None)
    data.mkdir(parents=True, exist_ok=True)
    store.init_db(data / "facts.db")
    click.echo(f"initialized {data / 'facts.db'}")


def _run_collector(name: str, reg: registry.Registry, db_path: Path) -> int:
    mod = COLLECTORS.get(name)
    if mod is None:
        click.echo(f"unknown collector: {name}", err=True)
        return 2
    store.init_db(db_path)
    conn = store.connect(db_path)
    try:
        click.echo(f"[{name}] start")
        mod.run(reg, conn)
        click.echo(f"[{name}] done")
        return 0
    except Exception as e:
        click.echo(f"[{name}] FAILED: {e}", err=True)
        return 1
    finally:
        conn.close()


@main.command()
@click.argument("name")
@click.option("--data-dir", type=click.Path(path_type=Path), default=None)
@click.option("--sites-yml", type=click.Path(path_type=Path), default=None)
def collect(name: str, data_dir: Path | None, sites_yml: Path | None) -> None:
    sites_path, data = _resolve_paths(data_dir, sites_yml)
    reg = registry.load(sites_path)
    rc = _run_collector(name, reg, data / "facts.db")
    sys.exit(rc)


@main.command("collect-all")
@click.option("--data-dir", type=click.Path(path_type=Path), default=None)
@click.option("--sites-yml", type=click.Path(path_type=Path), default=None)
def collect_all(data_dir: Path | None, sites_yml: Path | None) -> None:
    sites_path, data = _resolve_paths(data_dir, sites_yml)
    reg = registry.load(sites_path)
    overall = 0
    for name in COLLECTORS:
        rc = _run_collector(name, reg, data / "facts.db")
        overall = max(overall, rc)
    sys.exit(overall)


@main.command()
@click.option("--host", default="0.0.0.0")
@click.option("--port", default=4742, type=int)
def serve(host: str, port: int) -> None:
    """Start the FastAPI app."""
    import uvicorn
    uvicorn.run("site_tracker.app.main:app", host=host, port=port, log_level="info")


@main.command("render-domains-index")
@click.option("--sites-yml", type=click.Path(path_type=Path), default=None)
@click.option("--out", type=click.Path(path_type=Path), default=Path("DOMAINS_INDEX.md"))
def render_domains_index(sites_yml: Path | None, out: Path) -> None:
    from site_tracker.scripts import render_domains_index as r
    r.render(sites_yml or Path.cwd() / "sites.yml", out)
    click.echo(f"wrote {out}")


if __name__ == "__main__":
    main()
