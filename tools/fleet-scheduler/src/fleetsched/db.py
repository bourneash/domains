"""SQLite state store. Single writer (the scheduler process), WAL, FULL sync.

Schema changes go through MIGRATIONS (append-only, applied in order inside a
transaction, version tracked in PRAGMA user_version).
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

MIGRATIONS = [
    # v1
    """
    CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        site TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        tz TEXT NOT NULL DEFAULT 'America/New_York',
        command TEXT NOT NULL,
        class TEXT NOT NULL DEFAULT 'light' CHECK (class IN ('light','heavy')),
        timeout_s INTEGER NOT NULL DEFAULT 600 CHECK (timeout_s BETWEEN 1 AND 86400),
        enabled INTEGER NOT NULL DEFAULT 1,
        jitter_s INTEGER NOT NULL DEFAULT 0 CHECK (jitter_s BETWEEN 0 AND 3600),
        misfire_grace_s INTEGER NOT NULL DEFAULT 120 CHECK (misfire_grace_s BETWEEN 0 AND 86400),
        queue_timeout_s INTEGER NOT NULL DEFAULT 1800 CHECK (queue_timeout_s BETWEEN 1 AND 86400),
        priority INTEGER NOT NULL DEFAULT 0,
        env_json TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'api',
        last_fire_ts INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (site, name)
    );
    CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        job_id INTEGER,
        site TEXT NOT NULL,
        name TEXT NOT NULL,
        class TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'schedule',
        status TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        exit_code INTEGER,
        note TEXT,
        output_tail TEXT
    );
    CREATE INDEX runs_job ON runs (job_id, id DESC);
    CREATE INDEX runs_site ON runs (site, id DESC);
    CREATE INDEX runs_status ON runs (status);
    CREATE INDEX runs_finished ON runs (finished_at);
    CREATE TABLE sites (
        site TEXT PRIMARY KEY,
        adopted INTEGER NOT NULL DEFAULT 0,
        adopted_at INTEGER
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE audit (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        job_id INTEGER,
        detail TEXT
    );
    """,
]

DEFAULT_SETTINGS = {
    "paused": "0",
    "light_cap": "96",
    "heavy_cap": "12",
    "site_heavy_cap": "2",
    "retention_days": "30",
}

JOB_COLS = ("id", "site", "name", "schedule", "tz", "command", "class", "timeout_s",
            "enabled", "jitter_s", "misfire_grace_s", "queue_timeout_s", "priority",
            "env_json", "source", "last_fire_ts", "created_at", "updated_at")


class DB:
    def __init__(self, path: str | os.PathLike):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, isolation_level=None)  # explicit txns
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=FULL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self._migrate()
        for k, v in DEFAULT_SETTINGS.items():
            self.conn.execute("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)", (k, v))

    def _migrate(self) -> None:
        ver = self.conn.execute("PRAGMA user_version").fetchone()[0]
        for i in range(ver, len(MIGRATIONS)):
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                for stmt in filter(str.strip, MIGRATIONS[i].split(";\n")):
                    self.conn.execute(stmt)
                self.conn.execute(f"PRAGMA user_version={i + 1}")
                self.conn.execute("COMMIT")
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def integrity_ok(self) -> bool:
        return self.conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"

    def backup(self, dest: str) -> None:
        tmp = dest + ".tmp"
        if os.path.exists(tmp):
            os.unlink(tmp)
        self.conn.execute("VACUUM INTO ?", (tmp,))
        os.replace(tmp, dest)

    # -- settings ------------------------------------------------------
    def settings(self) -> dict[str, str]:
        return {r["key"]: r["value"] for r in self.conn.execute("SELECT key,value FROM settings")}

    def set_setting(self, key: str, value: str) -> None:
        self.conn.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                          "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    # -- audit ---------------------------------------------------------
    def audit(self, actor: str, action: str, job_id: int | None = None, detail: object = None) -> None:
        self.conn.execute("INSERT INTO audit(ts,actor,action,job_id,detail) VALUES (?,?,?,?,?)",
                          (int(time.time()), actor, action, job_id,
                           json.dumps(detail, sort_keys=True, default=str) if detail is not None else None))

    # -- jobs ----------------------------------------------------------
    def jobs(self, site: str | None = None) -> list[sqlite3.Row]:
        q = "SELECT * FROM jobs"
        args: tuple = ()
        if site:
            q += " WHERE site=?"
            args = (site,)
        return self.conn.execute(q + " ORDER BY site, name", args).fetchall()

    def job(self, job_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()

    def insert_job(self, **f) -> int:
        now = int(time.time())
        f.setdefault("created_at", now)
        f["updated_at"] = now
        cols = ",".join(f)
        cur = self.conn.execute(f"INSERT INTO jobs ({cols}) VALUES ({','.join('?' * len(f))})",
                                tuple(f.values()))
        return cur.lastrowid

    def update_job(self, job_id: int, **f) -> None:
        f["updated_at"] = int(time.time())
        sets = ",".join(f"{k}=?" for k in f)
        self.conn.execute(f"UPDATE jobs SET {sets} WHERE id=?", (*f.values(), job_id))

    def delete_job(self, job_id: int) -> None:
        # Keep run history: runs.job_id is a plain int (no FK) so history outlives the job.
        self.conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))

    # -- sites ---------------------------------------------------------
    def adopted_sites(self) -> set[str]:
        return {r["site"] for r in self.conn.execute("SELECT site FROM sites WHERE adopted=1")}

    def set_adopted(self, site: str, adopted: bool) -> None:
        self.conn.execute(
            "INSERT INTO sites(site,adopted,adopted_at) VALUES(?,?,?) "
            "ON CONFLICT(site) DO UPDATE SET adopted=excluded.adopted, adopted_at=excluded.adopted_at",
            (site, int(adopted), int(time.time()) if adopted else None))

    # -- runs ----------------------------------------------------------
    def insert_run(self, **f) -> int:
        cols = ",".join(f)
        return self.conn.execute(f"INSERT INTO runs ({cols}) VALUES ({','.join('?' * len(f))})",
                                 tuple(f.values())).lastrowid

    def update_run(self, run_id: int, **f) -> None:
        sets = ",".join(f"{k}=?" for k in f)
        self.conn.execute(f"UPDATE runs SET {sets} WHERE id=?", (*f.values(), run_id))

    def run(self, run_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()

    def runs(self, *, site=None, job_id=None, status=None, limit=100) -> list[sqlite3.Row]:
        where, args = [], []
        for col, v in (("site", site), ("job_id", job_id), ("status", status)):
            if v is not None:
                where.append(f"{col}=?")
                args.append(v)
        q = "SELECT id,job_id,site,name,class,trigger,status,scheduled_for,queued_at,started_at,finished_at,exit_code,note FROM runs"
        if where:
            q += " WHERE " + " AND ".join(where)
        return self.conn.execute(q + " ORDER BY id DESC LIMIT ?", (*args, max(1, min(limit, 1000)))).fetchall()

    def last_runs(self) -> dict[int, sqlite3.Row]:
        """Most recent finished-or-running run per job (one indexed lookup each)."""
        out = {}
        for r in self.conn.execute(
            "SELECT r.* FROM runs r JOIN (SELECT job_id, MAX(id) mid FROM runs "
            "WHERE job_id IS NOT NULL AND status NOT IN ('queued','skipped_overlap') GROUP BY job_id) m "
            "ON r.id=m.mid"):
            out[r["job_id"]] = r
        return out

    def reconcile_orphans(self, note: str) -> int:
        """Runs left queued/running by a previous process can never complete."""
        now = int(time.time())
        cur = self.conn.execute(
            "UPDATE runs SET status='lost', finished_at=?, note=? WHERE status IN ('queued','running')",
            (now, note))
        return cur.rowcount

    def prune(self, retention_days: int) -> int:
        now = int(time.time())
        cutoff = now - retention_days * 86400
        # Healthy light probes (watchdog/deployer ticks) are ~10k rows/day and carry no
        # information once they're old; keep failures and heavy runs for the full window.
        n = self.conn.execute(
            "DELETE FROM runs WHERE finished_at IS NOT NULL AND (finished_at < ? OR "
            "(finished_at < ? AND (status='skipped_overlap' OR (status='ok' AND class='light'))))",
            (cutoff, now - 7 * 86400)).rowcount
        self.conn.execute("DELETE FROM audit WHERE ts < ?", (cutoff - 60 * 86400,))
        return n

    def close(self) -> None:
        self.conn.close()
