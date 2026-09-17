"""amz-stats CLI: harvest ASINs from affiliate.ts files, collect catalog, write snapshot."""
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
from .api import AMZClient
from .collectors import harvest_asins, collect_catalog, build_summary
from .earnings import (
    BlockedError,
    ScrapeStructureError,
    SessionExpiredError,
    pull_earnings,
    scrape_earnings,
    save_session,
)
from .store import write_snapshot
from . import taskfiler


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _resolve_env_vars() -> tuple[str, str, str, str | None]:
    key_id = os.environ.get("AMAZON_CREATORS_KEY_ID")
    key_secret = os.environ.get("AMAZON_CREATORS_KEY_SECRET")
    store_id = os.environ.get("AMAZON_ASSOCIATES_STORE_ID")
    application_id = os.environ.get("AMAZON_CREATORS_APPLICATION_ID")
    missing = [n for n, v in [
        ("AMAZON_CREATORS_KEY_ID", key_id),
        ("AMAZON_CREATORS_KEY_SECRET", key_secret),
        ("AMAZON_ASSOCIATES_STORE_ID", store_id),
    ] if not v]
    if missing:
        click.echo(f"ERROR: missing required env vars: {', '.join(missing)}", err=True)
        sys.exit(2)
    return key_id, key_secret, store_id, application_id  # type: ignore[return-value]


def _load_env(env_file: Path | None) -> tuple[str, str, str, str | None]:
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
@click.option("--domains-root", "domains_root", type=click.Path(path_type=Path),
              default=lambda: Path(os.environ.get("HOME", "/home/jesse")) / "projects" / "domains",
              help="Root of the domains project (contains sites/). Default: $HOME/projects/domains "
                   "(mounted read-write so taskfiler can commit/push dead-ASIN tasks).")
@click.option("--quiet", is_flag=True, help="Suppress summary line on stdout.")
@click.option("--no-file-tasks", is_flag=True,
              help="Skip auto-filing backlog tasks for confirmed-dead ASINs.")
@click.option("--no-push", is_flag=True,
              help="File/commit tasks locally but don't git push (implies task filing still runs).")
def collect(
    out_dir: Path,
    env_file: Path | None,
    domains_root: Path,
    quiet: bool,
    no_file_tasks: bool,
    no_push: bool,
) -> None:
    """Harvest ASINs, collect catalog from Amazon API, write JSONL + latest.json."""
    key_id, key_secret, store_id, application_id = _load_env(env_file)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_file = out_dir / ".token_cache.json"

    started = time.monotonic()
    ts = _now_iso()

    # harvest_asins globs domains_root/sites/*/site/src/lib/affiliate.ts
    asins_by_site = harvest_asins(domains_root)

    with AMZClient(key_id, key_secret, store_id, cache_file, application_id=application_id) as client:
        catalog = collect_catalog(client, asins_by_site)

    summary = build_summary(asins_by_site, catalog)
    elapsed = round(time.monotonic() - started, 2)

    filed_tasks: list[str] = []
    if not no_file_tasks:
        state_path = out_dir / "asin_state.json"
        today = ts[:10]
        try:
            filed_tasks = taskfiler.process(
                domains_root, asins_by_site, catalog, today, state_path, push=not no_push
            )
        except Exception as exc:  # noqa: BLE001 — task filing must never crash the collect run
            click.echo(f"taskfiler: unexpected error, skipping this run: {exc}", err=True)
        for t in filed_tasks:
            click.echo(f"filed task: {t}")

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
    key_id, key_secret, store_id, application_id = _load_env(env_file)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_file = out_dir / ".token_cache.json"
    try:
        with AMZClient(key_id, key_secret, store_id, cache_file, application_id=application_id) as client:
            token_prefix = client.ping()
        click.echo(f"OK token={token_prefix}... store={store_id}")
    except Exception as exc:
        click.echo(f"FAIL: {exc}", err=True)
        sys.exit(1)


def _num(value) -> float:
    """Coerce a report cell to a float. Associates Central prints '-' for
    zero/no-data cells (see a real export's 'aliencouncil-20' row: clicks=10
    but items_ordered='-', not 0) — treat that as 0, don't let int()/float()
    raise on it."""
    if value in (None, "-", ""):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _write_earnings(rows: list[dict], out_dir: Path, days: int, quiet: bool) -> None:
    """Write a timestamped snapshot + refresh latest.json, print summary.

    The "Tracking ID" commission report (see earnings.py) has NO per-day date
    column — it's one row per site (tracking ID) aggregated over the whole
    selected window, not a daily series. So this is a dated snapshot store
    (out/earnings-pull-<UTC timestamp>.jsonl), not a per-date merge — there's
    no natural key to merge different pulls' rows by other than "which pull".
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = _now_iso()
    snapshot_path = out_dir / f"earnings-pull-{ts.replace(':', '').replace('-', '')}.jsonl"
    with snapshot_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, separators=(",", ":")) + "\n")

    # Overwrite latest.json with full result list
    latest_path = out_dir / "earnings-latest.json"
    latest_path.write_text(json.dumps({"pulled_at": ts, "days": days, "rows": rows}, indent=2),
                            encoding="utf-8")

    # Compute totals for summary line. Real CSV headers (verified against a
    # live export): clicks, items_ordered, total_earnings — not the
    # ordered_items/commission_income names this used to assume.
    total_clicks = sum(_num(r.get("clicks")) for r in rows)
    total_orders = sum(_num(r.get("items_ordered")) for r in rows)
    total_earnings = sum(_num(r.get("total_earnings")) for r in rows)

    line = (
        f"[{ts}] amz-earnings"
        f" days={days}"
        f" clicks={int(total_clicks)}"
        f" orders={int(total_orders)}"
        f" earnings=${total_earnings:.2f}"
    )

    if not quiet:
        click.echo(line)


@main.command("scrape-earnings")
@click.option("--out-dir", "out_dir", type=click.Path(path_type=Path), default=Path("out"),
              help="Directory to write earnings JSONL + latest.json. Default: ./out")
@click.option("--session-file", "session_file", type=click.Path(path_type=Path), default=None,
              help="Path to Playwright session file. Default: <out-dir>/.session.json")
@click.option("--days", default=30, show_default=True,
              help="Number of days to fetch (ending today).")
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None,
              help="Override env file.")
@click.option("--quiet", is_flag=True, help="Suppress summary line on stdout.")
def scrape_earnings_cmd(
    out_dir: Path,
    session_file: Path | None,
    days: int,
    env_file: Path | None,
    quiet: bool,
) -> None:
    """Download daily earnings from Associates Central using a saved session.

    Opportunistic — only succeeds if the saved session is still inside
    Associates Central's ~1h auth-freshness window. For a reliable pull, use
    `amz-stats pull-earnings` instead (logs in and scrapes in one go).
    """
    if session_file is None:
        session_file = out_dir / ".session.json"

    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        rows = scrape_earnings(session_file, days)
    except SessionExpiredError:
        click.echo("Session missing or expired (or outside the ~1h auth-freshness "
                    "window). Run: amz-stats pull-earnings", err=True)
        sys.exit(3)
    except BlockedError as e:
        click.echo(f"BLOCKED: {e}", err=True)
        sys.exit(4)
    except ScrapeStructureError as e:
        click.echo(f"SCRAPE STRUCTURE ERROR: {e}", err=True)
        sys.exit(5)

    _write_earnings(rows, out_dir, days, quiet)


@main.command("pull-earnings")
@click.option("--out-dir", "out_dir", type=click.Path(path_type=Path), default=Path("out"),
              help="Directory to write earnings JSONL + latest.json. Default: ./out")
@click.option("--session-file", "session_file", type=click.Path(path_type=Path), default=None,
              help="Path to save the Playwright session file. Default: <out-dir>/.session.json")
@click.option("--days", default=30, show_default=True,
              help="Number of days to fetch (ending today).")
@click.option("--quiet", is_flag=True, help="Suppress summary line on stdout.")
def pull_earnings_cmd(
    out_dir: Path,
    session_file: Path | None,
    days: int,
    quiet: bool,
) -> None:
    """Interactive login + earnings pull in one command (requires a display).

    This is the reliable path — Associates Central requires a login within
    roughly the last hour to view Reports, so login and scrape happen
    back-to-back in the same browser session. Run this yourself whenever you
    want current numbers; it isn't meant to run unattended in cron. It also
    saves a session file afterward that `scrape-earnings` can opportunistically
    reuse for up to about an hour.
    """
    if session_file is None:
        session_file = out_dir / ".session.json"

    try:
        rows = pull_earnings(session_file, days)
    except BlockedError as e:
        click.echo(f"BLOCKED: {e}", err=True)
        sys.exit(4)
    except ScrapeStructureError as e:
        click.echo(f"SCRAPE STRUCTURE ERROR: {e}", err=True)
        sys.exit(5)

    _write_earnings(rows, out_dir, days, quiet)


@main.command("save-session")
@click.option("--session-file", "session_file", type=click.Path(path_type=Path),
              default=Path("out/.session.json"),
              help="Path to save the Playwright session file. Default: out/.session.json")
def save_session_cmd(session_file: Path) -> None:
    """Save an Associates Central login session for use by scrape-earnings.

    Run this once interactively to authenticate. Requires a display.
    Use: docker compose exec -it collector amz-stats save-session
    """
    save_session(session_file)


if __name__ == "__main__":
    main()
