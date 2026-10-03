"""Read the central delivery owner before admitting scheduled site work."""
from pathlib import Path
import sqlite3


def central_owner(root: Path, site: str) -> str | None:
    candidates = [root / "tools/fleet-dashboard/data/fleet-events.sqlite",
                  root / "sites" / site / ".monorepo-tools/fleet-dashboard/data/fleet-events.sqlite"]
    dbpath = next((p for p in candidates if p.is_file()), None)
    if dbpath is None:
        return None
    try:
        with sqlite3.connect(dbpath.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.25) as db:
            row = db.execute("""
                SELECT q.request_id FROM change_requests q
                LEFT JOIN improvement_runs r ON r.run_id = q.run_id
                WHERE q.site = ? AND q.delivery_mode != 'report_only' AND (
                  q.status IN ('claimed','running','reviewing','review','delivery_pending')
                  OR (q.status = 'committed' AND r.state IN ('building','review'))
                ) LIMIT 1
            """, (site,)).fetchone()
            return f"central delivery owns site: {row[0]}" if row else None
    except sqlite3.Error as error:
        # An unreadable existing ownership database cannot authorize competing work.
        return f"central delivery ownership unavailable: {type(error).__name__}"
