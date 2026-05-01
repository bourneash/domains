"""cf-stats CLI: collect a Cloudflare snapshot, append JSONL, refresh latest.json."""
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
from .api import CFClient
from . import collectors as C


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _load_env(env_file: Path | None) -> tuple[str, str]:
    if env_file:
        load_dotenv(env_file, override=False)
    else:
        for cand in (
            Path.cwd() / ".env",
            Path("/work/.env.shared"),
            Path("/home/jesse/projects/domains/.env"),
        ):
            if cand.exists():
                load_dotenv(cand, override=False)
                break
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        click.echo("ERROR: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required", err=True)
        sys.exit(2)
    return token, account


def _summary_line(snap: dict) -> str:
    def s(key: str, attr: str, default: str = "ERR") -> str:
        v = snap.get(key) or {}
        if not v.get("ok"):
            return default
        return str(v.get(attr, default))

    parts = [
        f"[{snap['timestamp']}] cf-stats",
        f"zones={s('zones', 'count')}",
        f"workers={s('workers', 'count')}",
        f"domains={s('worker_domains', 'count')}",
        f"dns={s('dns', 'total_records')}",
        f"email_on={s('email_routing', 'enabled_count', '?')}",
        f"r2={s('r2', 'count', '-')}",
        f"kv={s('kv', 'count', '-')}",
        f"d1={s('d1', 'count', '-')}",
        f"queues={s('queues', 'count', '-')}",
    ]
    wa = snap.get("workers_analytics_24h") or {}
    if wa.get("ok"):
        t = wa.get("totals", {})
        parts.append(f"req24h={t.get('requests', 0)}")
        parts.append(f"err24h={t.get('errors', 0)}")
    else:
        parts.append("analytics=NO")
    za = snap.get("zone_analytics") or {}
    if za.get("ok"):
        t = za.get("totals", {})
        days = za.get("lookback_days", 7)
        parts.append(f"pv{days}d={t.get('pageViews', 0)}")
        parts.append(f"uniq{days}d={t.get('uniques', 0)}")
        parts.append(f"thr{days}d={t.get('threats', 0)}")
    else:
        parts.append("zoneana=NO")
    rum = snap.get("rum_analytics") or {}
    if rum.get("ok"):
        parts.append(f"rum={rum.get('total_pageloads', 0)}")
    else:
        parts.append("rum=NO")
    parts.append(f"{snap['duration_seconds']}s")
    return " ".join(parts)


@click.group()
@click.version_option(__version__)
def main() -> None:
    """Cloudflare account/usage snapshot collector."""


@main.command()
@click.option("--out-dir", "out_dir", type=click.Path(path_type=Path), default=Path("out"),
              help="Directory to write JSONL + latest.json. Default: ./out")
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None,
              help="Override env file. Default search: ./.env, /work/.env.shared, /home/jesse/projects/domains/.env")
@click.option("--analytics-hours", type=int, default=24, show_default=True,
              help="Window for Workers GraphQL analytics query.")
@click.option("--zone-lookback-days", type=int, default=7, show_default=True,
              help="Days of per-zone HTTP analytics to aggregate (1d granularity).")
@click.option("--quiet", is_flag=True, help="Suppress summary line on stdout.")
def collect(out_dir: Path, env_file: Path | None, analytics_hours: int,
            zone_lookback_days: int, quiet: bool) -> None:
    """Run all collectors, write JSONL + latest.json, print one-line summary."""
    token, account = _load_env(env_file)
    out_dir.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    ts = _now_iso()
    snap: dict = {"timestamp": ts, "account_id": account, "version": __version__}

    with CFClient(token, account) as cf:
        snap["token"] = C.collect_token(cf)
        snap["zones"] = C.collect_zones(cf)
        snap["workers"] = C.collect_workers(cf)
        snap["worker_domains"] = C.collect_worker_domains(cf)
        snap["workers_subdomain"] = C.collect_workers_subdomain(cf)
        snap["dns"] = C.collect_dns(cf, snap["zones"])
        snap["email_routing"] = C.collect_email_routing(cf, snap["zones"])
        snap["kv"] = C.collect_kv(cf)
        snap["r2"] = C.collect_r2(cf)
        snap["d1"] = C.collect_d1(cf)
        snap["queues"] = C.collect_queues(cf)
        snap["workers_analytics_24h"] = C.collect_workers_analytics(cf, hours=analytics_hours)
        snap["zone_analytics"] = C.collect_zone_analytics(cf, snap["zones"], lookback_days=zone_lookback_days)
        snap["rum_analytics"] = C.collect_rum_analytics(cf, hours=zone_lookback_days * 24)

    if isinstance(snap.get("zones"), dict):
        snap["zones"].pop("_zone_index", None)

    snap["duration_seconds"] = round(time.monotonic() - started, 2)

    day = ts[:10]
    jsonl_path = out_dir / f"cf-stats-{day}.jsonl"
    with jsonl_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(snap, separators=(",", ":")) + "\n")
    (out_dir / "latest.json").write_text(json.dumps(snap, indent=2) + "\n", encoding="utf-8")

    if not quiet:
        click.echo(_summary_line(snap))


@main.command()
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None)
def verify(env_file: Path | None) -> None:
    """Verify the token + account ID work. Exit 0 on success."""
    token, account = _load_env(env_file)
    with CFClient(token, account) as cf:
        t = C.collect_token(cf)
    if not t.get("ok"):
        click.echo(f"FAIL: {t.get('error')}", err=True)
        sys.exit(1)
    click.echo(f"OK token={t.get('id')} status={t.get('status')} expires={t.get('expires_on') or 'never'} days={t.get('days_until_expiry', '-')}")


if __name__ == "__main__":
    main()
