"""amz-stats CLI: harvest ASINs from affiliate.ts files, collect catalog, write snapshot."""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import click
from dotenv import load_dotenv

from . import __version__
from .api import AMZClient
from .collectors import harvest_asins, collect_catalog, build_summary
from .store import write_snapshot


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _resolve_env_vars() -> tuple[str, str, str]:
    key_id = os.environ.get("AMAZON_CREATORS_KEY_ID")
    key_secret = os.environ.get("AMAZON_CREATORS_KEY_SECRET")
    store_id = os.environ.get("AMAZON_ASSOCIATES_STORE_ID")
    missing = [n for n, v in [
        ("AMAZON_CREATORS_KEY_ID", key_id),
        ("AMAZON_CREATORS_KEY_SECRET", key_secret),
        ("AMAZON_ASSOCIATES_STORE_ID", store_id),
    ] if not v]
    if missing:
        click.echo(f"ERROR: missing required env vars: {', '.join(missing)}", err=True)
        sys.exit(2)
    return key_id, key_secret, store_id  # type: ignore[return-value]


def _load_env(env_file: Path | None) -> tuple[str, str, str]:
    if env_file:
        load_dotenv(env_file, override=True)
        return _resolve_env_vars()
    for cand in (
        Path.cwd() / ".env",
        Path("/work/.env.shared"),
        Path("/home/jesse/projects/domains/.env"),
    ):
        if cand.exists():
            load_dotenv(cand, override=False)
    # No break — load all that exist; first-set wins via override=False
    return _resolve_env_vars()


@click.group()
@click.version_option(__version__)
def main() -> None:
    """Amazon affiliate catalog snapshot collector."""


@main.command()
@click.option("--out-dir", "out_dir", type=click.Path(path_type=Path), default=Path("out"),
              help="Directory to write JSONL + latest.json. Default: ./out")
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None,
              help="Override env file. Default search: ./.env, /work/.env.shared, /home/jesse/projects/domains/.env")
@click.option("--domains-root", "domains_root", type=click.Path(path_type=Path), default=Path("/work/domains"),
              help="Root of the domains project (contains sites/). Default: /work/domains")
@click.option("--quiet", is_flag=True, help="Suppress summary line on stdout.")
def collect(out_dir: Path, env_file: Path | None, domains_root: Path, quiet: bool) -> None:
    """Harvest ASINs, collect catalog from Amazon API, write JSONL + latest.json."""
    key_id, key_secret, store_id = _load_env(env_file)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_file = out_dir / ".token_cache.json"

    started = time.monotonic()
    ts = _now_iso()

    # harvest_asins globs domains_root/sites/*/site/src/lib/affiliate.ts
    asins_by_site = harvest_asins(domains_root)

    with AMZClient(key_id, key_secret, store_id, cache_file) as client:
        catalog = collect_catalog(client, asins_by_site)

    summary = build_summary(asins_by_site, catalog)
    elapsed = round(time.monotonic() - started, 2)

    snap = {
        "timestamp": ts,
        "store_id": store_id,
        "version": __version__,
        "catalog": catalog,
        "summary": summary,
        "duration_seconds": elapsed,
    }

    write_snapshot(snap, out_dir)

    totals = summary.get("totals", {})
    line = (
        f"[{ts}] amz-stats"
        f" sites={totals.get('site_count', 0)}"
        f" unique_asins={totals.get('unique_asin_count', 0)}"
        f" oos={totals.get('oos_count', 0)}"
        f" delisted={totals.get('delisted_count', 0)}"
        f" missing={totals.get('missing_count', 0)}"
        f" errors={totals.get('error_count', 0)}"
        f" {elapsed}s"
    )

    if not quiet:
        click.echo(line)


@main.command()
@click.option("--out-dir", "out_dir", type=click.Path(path_type=Path), default=Path("out"),
              help="Directory containing the token cache. Default: ./out")
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None)
def verify(out_dir: Path, env_file: Path | None) -> None:
    """Verify the API credentials work. Exit 0 on success."""
    key_id, key_secret, store_id = _load_env(env_file)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_file = out_dir / ".token_cache.json"
    try:
        with AMZClient(key_id, key_secret, store_id, cache_file) as client:
            token_prefix = client.ping()
        click.echo(f"OK token={token_prefix}... store={store_id}")
    except Exception as exc:
        click.echo(f"FAIL: {exc}", err=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
