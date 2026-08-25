#!/usr/bin/env python3
"""Fleet local-data retention sweep — bound growth WITHOUT losing history.

WHY THIS EXISTS
Two data classes on this host grew with no retention step of any kind:

  1. tools/cf-stats/out — 112 daily JSONL files, 423 MB, ~5 MB/day and rising.
     This is the ONLY historical record of Cloudflare traffic for the fleet;
     nothing backs it up (see the backup/DR gap in the 2026-08-25 findings).
     tools/gh-stats/out is the same shape, 11 MB.
  2. sites/*/ops/logs — 74,185 files / 160 MB of content but 283 MB on disk.
     Measure that gap before "fixing" it: the mean file is 2.2 KB and NOTHING
     in there exceeds 2 MB, so this is a FILE-COUNT problem, not a byte
     problem. ~120 MB of it is 4K-block and inode overhead on tens of
     thousands of tiny per-run role transcripts. A byte-threshold rule (the
     obvious first instinct, and what the finding proposed) would match zero
     files and reclaim nothing.

DELETION IS NOT THE ANSWER FOR EITHER, so this script does not delete.
cf-stats is unbacked-up history; the role logs are the audit trail for
autonomous publishing runs and get read during incidents. Both compress
extremely well (JSONL and plain-text logs, ~10-15x), so compression buys
essentially all of the space back while keeping every byte recoverable.

WHAT IT TOUCHES
  cf-stats/out, gh-stats/out : gzip `<tool>-YYYY-MM-DD.jsonl` older than
                               RETAIN_DAYS, in place, one file -> one .gz.
                               Today's file and latest.json are never touched.
  sites/*/ops/logs           : .log / .txt / .png older than RETAIN_DAYS get
                               rolled into one tar.gz PER SITE PER DAY at
                               ops/logs/archive/<YYYY-MM>/<site>-logs-<date>.tar.gz.
                               Day-bucketing is deliberate: every file sharing
                               an mtime date ages out on the same run, so each
                               bucket is written exactly once and the job is
                               idempotent with no archive-merging problem.
                               ~19k files collapse to ~1 archive per site-day.

WHAT IT NEVER TOUCHES — and why
  *.jsonl under ops/logs : LEDGERS, not logs. tools/ai-usage/aggregate.py
                           globs `token-usage-*.jsonl` and
                           tools/engineer-fleet/engineer-status.py reads
                           `engineer-heartbeat-*.jsonl`. Archiving them would
                           silently truncate fleet AI-cost history. 8.3 MB
                           total — not worth the risk for the space.
  *.json / *.md / .gitkeep : role state files (engineer-render-last.json) and
                           checked-in scaffolding.
  anything under archive/ : already handled; never re-archived.
  the current day's files : never in range by construction (RETAIN_DAYS >= 1).

Every compression is VERIFIED before the original is removed — the .gz is
decompressed and byte-compared, the tar is reopened and its member list
counted. A verification failure leaves the original in place and reports.

Report on stdout, one `SUMMARY ...` line on stderr (same split as
cron-freshness.py). Exit 0 = ran, 2 = could not run.

Usage:
  prune-fleet-data.py --dry-run            # report only, touch nothing
  prune-fleet-data.py --dry-run -v         # ...listing every file it would move
  prune-fleet-data.py                      # the cron default
  prune-fleet-data.py --retain-days 60
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import re
import shutil
import sys
import tarfile
import time
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

ROOT = Path(os.environ.get("FLEET_DOMAINS_ROOT", "/home/jesse/projects/domains"))
RETAIN_DAYS_DEFAULT = int(os.environ.get("FLEET_PRUNE_RETAIN_DAYS", "30"))

# <tool>-YYYY-MM-DD.jsonl — the date comes from the NAME, not the mtime. A
# stray `touch` or a filesystem copy resets mtime; the name is what the writer
# committed to and what cf-grafana's ingester globs.
STATS_RE = re.compile(r"^[a-z0-9-]+-(\d{4})-(\d{2})-(\d{2})\.jsonl$")
STATS_DIRS = ["tools/cf-stats/out", "tools/gh-stats/out"]

# Role run transcripts and render-failure screenshots. See the module docstring
# for why .jsonl/.json are deliberately absent.
LOG_SUFFIXES = {".log", ".txt", ".png"}


def human(n: int) -> str:
    for unit, mult in (("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)):
        if n >= mult:
            return f"{n / mult:.1f} {unit}"
    return f"{n} B"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def gzip_verified(src: Path, dst: Path) -> None:
    """Compress src -> dst, prove the round-trip, then remove src.

    Writes to a temp path first so an interrupted run can never leave a
    truncated .gz sitting next to a deleted original.
    """
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    want = sha256(src)
    try:
        with src.open("rb") as fin, gzip.open(tmp, "wb", compresslevel=9) as fout:
            shutil.copyfileobj(fin, fout, 1 << 20)
        h = hashlib.sha256()
        with gzip.open(tmp, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != want:
            raise ValueError("round-trip hash mismatch")
        os.replace(tmp, dst)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    src.unlink()


def sweep_stats_dir(rel: str, cutoff: date, dry: bool, verbose: bool,
                    report: list[str]) -> tuple[int, int]:
    d = ROOT / rel
    if not d.is_dir():
        return 0, 0
    n = saved = 0
    for path in sorted(d.glob("*.jsonl")):
        m = STATS_RE.match(path.name)
        if not m:
            continue
        if date(int(m[1]), int(m[2]), int(m[3])) > cutoff:
            continue
        gz = path.with_suffix(".jsonl.gz")
        if gz.exists():
            # Both present means a previous run died between writing the .gz
            # and unlinking the source. Ambiguous, so report rather than guess
            # which one is authoritative.
            report.append(f"  SKIP {rel}/{path.name} — {gz.name} already exists (resolve by hand)")
            continue
        before = path.stat().st_size
        if dry:
            if verbose:
                report.append(f"  [dry-run] gzip {rel}/{path.name} ({human(before)})")
            n += 1
            saved += int(before * 0.92)  # observed JSONL ratio, dry-run estimate only
            continue
        try:
            gzip_verified(path, gz)
        except Exception as exc:
            report.append(f"  ERROR {rel}/{path.name}: {exc}")
            continue
        after = gz.stat().st_size
        n += 1
        saved += before - after
    if n:
        report.append(f"  {rel}: {n} file(s), {human(saved)} reclaimed")
    return n, saved


def sweep_site_logs(cutoff_ts: float, dry: bool, verbose: bool,
                    report: list[str]) -> tuple[int, int]:
    sites = ROOT / "sites"
    if not sites.is_dir():
        return 0, 0
    total_files = total_saved = 0
    for site in sorted(p for p in sites.iterdir() if p.is_dir()):
        logs = site / "ops" / "logs"
        if not logs.is_dir():
            continue
        archive_root = logs / "archive"
        buckets: dict[str, list[Path]] = defaultdict(list)
        for path in logs.iterdir():
            if not path.is_file() or path.suffix not in LOG_SUFFIXES:
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            if st.st_mtime >= cutoff_ts:
                continue
            buckets[datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d")].append(path)
        if not buckets:
            continue
        site_files = site_saved = 0
        for day, files in sorted(buckets.items()):
            raw = sum(f.stat().st_size for f in files)
            target = archive_root / day[:7] / f"{site.name}-logs-{day}.tar.gz"
            if dry:
                if verbose:
                    report.append(
                        f"  [dry-run] archive {site.name} {day}: {len(files)} file(s), "
                        f"{human(raw)} -> {target.relative_to(ROOT)}"
                    )
                site_files += len(files)
                site_saved += raw
                continue
            if target.exists():
                # Same partial-run case as the .gz above: the archive landed but
                # the originals were not removed. Park the leftovers beside it
                # instead of clobbering a verified archive.
                i = 2
                while target.with_name(f"{target.name.removesuffix('.tar.gz')}.r{i}.tar.gz").exists():
                    i += 1
                target = target.with_name(f"{target.name.removesuffix('.tar.gz')}.r{i}.tar.gz")
                report.append(f"  NOTE {site.name} {day}: archive existed, writing {target.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(target.name + ".tmp")
            try:
                with tarfile.open(tmp, "w:gz", compresslevel=9) as tar:
                    for f in files:
                        tar.add(f, arcname=f.name)
                # Reopen and count: proves the archive is readable and complete
                # before anything is deleted.
                with tarfile.open(tmp, "r:gz") as tar:
                    got = sum(1 for m in tar if m.isfile())
                if got != len(files):
                    raise ValueError(f"member count {got} != {len(files)}")
                os.replace(tmp, target)
            except Exception as exc:
                tmp.unlink(missing_ok=True)
                report.append(f"  ERROR {site.name} {day}: {exc}")
                continue
            for f in files:
                f.unlink(missing_ok=True)
            site_files += len(files)
            site_saved += raw - target.stat().st_size
        if site_files:
            report.append(
                f"  sites/{site.name}/ops/logs: {site_files} file(s) archived, "
                f"{human(site_saved)} reclaimed"
            )
            total_files += site_files
            total_saved += site_saved
    return total_files, total_saved


def main() -> int:
    ap = argparse.ArgumentParser(description="Fleet local-data retention sweep")
    ap.add_argument("--dry-run", action="store_true", help="report only, touch nothing")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="list every file/bucket, not just the per-target totals")
    ap.add_argument("--retain-days", type=int, default=RETAIN_DAYS_DEFAULT,
                    help=f"leave anything newer than this untouched (default {RETAIN_DAYS_DEFAULT})")
    args = ap.parse_args()

    if args.retain_days < 1:
        print("--retain-days must be >= 1", file=sys.stderr)
        return 2
    if not ROOT.is_dir():
        print(f"domains root not found: {ROOT}", file=sys.stderr)
        return 2

    now = time.time()
    cutoff_ts = now - args.retain_days * 86400
    cutoff_day = datetime.fromtimestamp(cutoff_ts).date()

    report: list[str] = []

    report.append(f"stats ledgers (gzip, older than {args.retain_days}d):")
    s_files = s_saved = 0
    for rel in STATS_DIRS:
        n, saved = sweep_stats_dir(rel, cutoff_day, args.dry_run, args.verbose, report)
        s_files += n
        s_saved += saved
    if not s_files:
        report.append("  nothing in range")

    report.append(f"site role logs (tar.gz per site-day, older than {args.retain_days}d):")
    l_files, l_saved = sweep_site_logs(cutoff_ts, args.dry_run, args.verbose, report)
    if not l_files:
        report.append("  nothing in range")

    errors = sum(1 for line in report if line.lstrip().startswith("ERROR"))
    print("\n".join(report))
    print(
        f"SUMMARY stats_files={s_files} stats_bytes={s_saved} "
        f"log_files={l_files} log_bytes={l_saved} "
        f"total_bytes={s_saved + l_saved} errors={errors} dry_run={int(args.dry_run)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
