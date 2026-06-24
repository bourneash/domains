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
from .earnings import SessionExpiredError, scrape_earnings, save_session
from .store import write_snapshot


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
@click.option("--domains-root", "domains_root", type=click.Path(path_type=Path), default=Path("/work/domains"),
              help="Root of the domains project (contains sites/). Default: /work/domains")
@click.option("--quiet", is_flag=True, help="Suppress summary line on stdout.")
def collect(out_dir: Path, env_file: Path | None, domains_root: Path, quiet: bool) -> None:
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


def _row_date(row: dict) -> str:
    """Return the date string from a row, handling both 'date' and 'report_date' keys."""
    return row.get("date") or row.get("report_date") or ""


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
    """Download daily earnings from Associates Central and write JSONL + latest.json."""
    if session_file is None:
        session_file = out_dir / ".session.json"

    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        rows = scrape_earnings(session_file, days)
    except SessionExpiredError:
        click.echo("Session missing or expired. Run: amz-stats save-session", err=True)
        sys.exit(3)

    # Group rows by month; merge by date to avoid duplicates on re-runs
    by_month: dict[str, list[dict]] = {}
    for row in rows:
        date_val = _row_date(row)
        if len(date_val) >= 7:
            month_key = date_val[:7]  # YYYY-MM
        else:
            month_key = "unknown"
        by_month.setdefault(month_key, []).append(row)

    for month_key, month_rows in by_month.items():
        jsonl_path = out_dir / f"earnings-{month_key}.jsonl"
        # Read existing rows keyed by date, overlay new rows (new data wins), write back
        existing: dict[str, dict] = {}
        if jsonl_path.exists():
            for line in jsonl_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    existing[_row_date(row)] = row
        for row in month_rows:
            existing[_row_date(row)] = row
        with jsonl_path.open("w", encoding="utf-8") as fh:
            for row in sorted(existing.values(), key=_row_date):
                fh.write(json.dumps(row, separators=(",", ":")) + "\n")

    # Overwrite latest.json with full result list
    latest_path = out_dir / "earnings-latest.json"
    latest_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")

    # Compute totals for summary line
    total_clicks = sum(int(r.get("clicks", 0) or 0) for r in rows)
    total_orders = sum(int(r.get("ordered_items", 0) or 0) for r in rows)
    total_earnings = sum(float(r.get("commission_income", 0) or 0) for r in rows)

    ts = _now_iso()
    line = (
        f"[{ts}] amz-earnings"
        f" days={days}"
        f" clicks={total_clicks}"
        f" orders={total_orders}"
        f" earnings=${total_earnings:.2f}"
    )

    if not quiet:
        click.echo(line)


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
