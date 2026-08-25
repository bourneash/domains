#!/usr/bin/env python3
"""Ingest cf-stats JSONL snapshots into SQLite for Grafana.

Run any time you want fresh data:
    python ingest.py

Reads:  ../cf-stats/out/cf-stats-*.jsonl  (and the .gz the retention sweep leaves
        behind — tools/scripts/prune-fleet-data.py compresses ledgers older
        than 30 days in place, so an ingester that only globs *.jsonl would
        silently lose every month but the current one)
Writes: data/cf-stats.db  (mounted read-only into Grafana)
"""
from __future__ import annotations

import gzip
import json
import os
import sqlite3
import sys
from pathlib import Path

OUT_DIR = Path(os.environ.get("CF_STATS_OUT", Path(__file__).parent.parent / "cf-stats" / "out"))
DB_PATH = Path(os.environ.get("CF_STATS_DB",  Path(__file__).parent / "data" / "cf-stats.db"))
GH_STATS_OUT = Path(os.environ.get("GH_STATS_OUT", Path(__file__).parent.parent / "gh-stats" / "out"))


def ledgers(directory: Path, stem: str) -> list[Path]:
    """Every daily ledger for `stem`, plain or gzipped, in date order.

    The retention sweep compresses in place, so a given day exists as exactly
    one of `<stem>-<date>.jsonl` or `<stem>-<date>.jsonl.gz`. Sorting on the
    name with `.gz` stripped keeps mixed old/new directories in true date
    order rather than clustering all the .gz files after the plain ones.
    """
    found = list(directory.glob(f"{stem}-*.jsonl")) + list(directory.glob(f"{stem}-*.jsonl.gz"))
    return sorted(found, key=lambda p: p.name.removesuffix(".gz"))


def open_ledger(path: Path):
    """Text handle for a ledger, transparently decompressing a .gz."""
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, encoding="utf-8")


def init(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS portfolio (
            ts          TEXT PRIMARY KEY,
            pv_7d       INTEGER DEFAULT 0,
            req_7d      INTEGER DEFAULT 0,
            uniq_7d     INTEGER DEFAULT 0,
            bytes_7d    INTEGER DEFAULT 0,
            threats_7d  INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS zones (
            ts          TEXT    NOT NULL,
            zone        TEXT    NOT NULL,
            pv_7d       INTEGER DEFAULT 0,
            req_7d      INTEGER DEFAULT 0,
            uniq_7d     INTEGER DEFAULT 0,
            bytes_7d    INTEGER DEFAULT 0,
            threats_7d  INTEGER DEFAULT 0,
            PRIMARY KEY (ts, zone)
        );
        CREATE TABLE IF NOT EXISTS rum (
            ts           TEXT    NOT NULL,
            site         TEXT    NOT NULL,
            pageloads_7d INTEGER DEFAULT 0,
            PRIMARY KEY (ts, site)
        );
        CREATE TABLE IF NOT EXISTS workers (
            ts          TEXT    NOT NULL,
            script      TEXT    NOT NULL,
            req_24h     INTEGER DEFAULT 0,
            errors_24h  INTEGER DEFAULT 0,
            PRIMARY KEY (ts, script)
        );
        CREATE INDEX IF NOT EXISTS idx_zones_ts   ON zones(ts);
        CREATE INDEX IF NOT EXISTS idx_zones_zone ON zones(zone);
        CREATE INDEX IF NOT EXISTS idx_rum_ts     ON rum(ts);
        CREATE INDEX IF NOT EXISTS idx_workers_ts ON workers(ts);
        CREATE TABLE IF NOT EXISTS deployments (
            worker       TEXT NOT NULL,
            created_on   TEXT NOT NULL,
            source       TEXT,
            version_id   TEXT,
            triggered_by TEXT,
            author       TEXT,
            PRIMARY KEY (worker, created_on)
        );
        CREATE TABLE IF NOT EXISTS zone_worker (
            zone   TEXT PRIMARY KEY,
            worker TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_deploy_created ON deployments(created_on);
        CREATE TABLE IF NOT EXISTS gh_repos (
            ts               TEXT NOT NULL,
            site             TEXT NOT NULL,
            slug             TEXT,
            default_branch   TEXT,
            branch_count     INTEGER DEFAULT 0,
            branches         TEXT,
            last_commit_sha  TEXT,
            last_commit_date TEXT,
            last_commit_msg  TEXT,
            open_pr_count    INTEGER DEFAULT 0,
            PRIMARY KEY (ts, site)
        );
        CREATE TABLE IF NOT EXISTS gh_prs (
            ts     TEXT NOT NULL,
            site   TEXT NOT NULL,
            number INTEGER NOT NULL,
            title  TEXT,
            head   TEXT,
            PRIMARY KEY (ts, site, number)
        );
        CREATE INDEX IF NOT EXISTS idx_gh_repos_ts ON gh_repos(ts);
        CREATE INDEX IF NOT EXISTS idx_gh_prs_ts   ON gh_prs(ts);
    """)
    conn.commit()


def ingest_snapshot(conn: sqlite3.Connection, snap: dict) -> None:
    ts = snap.get("timestamp", "")
    if not ts:
        return

    za = snap.get("zone_analytics") or {}
    t = za.get("totals") or {}
    conn.execute(
        "INSERT OR REPLACE INTO portfolio VALUES (?,?,?,?,?,?)",
        (ts, t.get("pageViews", 0), t.get("requests", 0),
         t.get("uniques", 0), t.get("bytes", 0), t.get("threats", 0)),
    )

    for zone, zdata in (za.get("per_zone") or {}).items():
        zt = zdata.get("totals") or {}
        conn.execute(
            "INSERT OR REPLACE INTO zones VALUES (?,?,?,?,?,?,?)",
            (ts, zone, zt.get("pageViews", 0), zt.get("requests", 0),
             zt.get("uniques", 0), zt.get("bytes", 0), zt.get("threats", 0)),
        )

    rum = snap.get("rum_analytics") or {}
    for site, sdata in (rum.get("per_site") or {}).items():
        pls = sum(r["count"] for r in sdata.get("by_referer", []))
        conn.execute(
            "INSERT OR REPLACE INTO rum VALUES (?,?,?)",
            (ts, site, pls),
        )

    wa = snap.get("workers_analytics_24h") or {}
    for script, ws in (wa.get("per_script") or {}).items():
        conn.execute(
            "INSERT OR REPLACE INTO workers VALUES (?,?,?,?)",
            (ts, script, ws.get("requests", 0), ws.get("errors", 0)),
        )

    dep = snap.get("deployments") or {}
    for worker, rows in (dep.get("per_worker") or {}).items():
        for d in rows:
            created = d.get("created_on")
            if not created:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO deployments VALUES (?,?,?,?,?,?)",
                (worker, created, d.get("source"), d.get("version_id"),
                 d.get("triggered_by"), d.get("author")),
            )

    wd = snap.get("worker_domains") or {}
    for d in (wd.get("domains") or []):
        zone = d.get("zone_name")
        worker = d.get("service")
        if zone and worker:
            conn.execute(
                "INSERT OR REPLACE INTO zone_worker VALUES (?,?)", (zone, worker))


def ingest_gh_snapshot(conn: sqlite3.Connection, snap: dict) -> None:
    ts = snap.get("timestamp", "")
    if not ts:
        return
    for site, r in (snap.get("repos") or {}).items():
        if not r.get("ok"):
            continue
        lc = r.get("last_main_commit") or {}
        conn.execute(
            "INSERT OR REPLACE INTO gh_repos VALUES (?,?,?,?,?,?,?,?,?,?)",
            (ts, site, r.get("slug"), r.get("default_branch"),
             r.get("branch_count", 0), json.dumps(r.get("branches") or []),
             lc.get("sha"), lc.get("date"), lc.get("message"),
             r.get("open_pr_count", 0)),
        )
        for pr in (r.get("open_prs") or []):
            if pr.get("number") is None:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO gh_prs VALUES (?,?,?,?,?)",
                (ts, site, pr.get("number"), pr.get("title"), pr.get("head")),
            )


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init(conn)

    total = 0
    for path in ledgers(OUT_DIR, "cf-stats"):
        n = 0
        with open_ledger(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ingest_snapshot(conn, json.loads(line))
                    n += 1
                except Exception as e:
                    print(f"  warn {path.name}: {e}", file=sys.stderr)
        print(f"  {path.name}: {n} snapshots")
        total += n

    gh_total = 0
    for path in ledgers(GH_STATS_OUT, "gh-stats"):
        n = 0
        with open_ledger(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ingest_gh_snapshot(conn, json.loads(line))
                    n += 1
                except Exception as e:
                    print(f"  warn {path.name}: {e}", file=sys.stderr)
        print(f"  {path.name}: {n} gh snapshots")
        gh_total += n
    print(f"  gh-stats: {gh_total} snapshots")

    conn.commit()
    conn.close()
    print(f"\nDone: {total} snapshots ingested → {DB_PATH}")


if __name__ == "__main__":
    main()
