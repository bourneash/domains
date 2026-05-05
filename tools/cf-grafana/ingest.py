#!/usr/bin/env python3
"""Ingest cf-stats JSONL snapshots into SQLite for Grafana.

Run any time you want fresh data:
    python ingest.py

Reads:  ../cf-stats/out/cf-stats-*.jsonl
Writes: data/cf-stats.db  (mounted read-only into Grafana)
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

OUT_DIR = Path(os.environ.get("CF_STATS_OUT", Path(__file__).parent.parent / "cf-stats" / "out"))
DB_PATH = Path(os.environ.get("CF_STATS_DB",  Path(__file__).parent / "data" / "cf-stats.db"))


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


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init(conn)

    total = 0
    for path in sorted(OUT_DIR.glob("cf-stats-*.jsonl")):
        n = 0
        with open(path) as f:
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

    conn.commit()
    conn.close()
    print(f"\nDone: {total} snapshots ingested → {DB_PATH}")


if __name__ == "__main__":
    main()
