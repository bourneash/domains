"""Bounded queue housekeeping; preserves publication and feedback history."""

from __future__ import annotations

from social_hub import db, queue


def run() -> dict:
    # Console is a disposable local preview sink. Cancel stale drafts instead
    # of deleting them so the audit trail remains intact.
    stale = db.rows_to_dicts(
        db.query(
            "SELECT * FROM posts WHERE platform = 'console' AND status = 'draft' "
            "AND created_at < datetime('now', '-7 days') LIMIT 500"
        )
    )
    for post in stale:
        queue.cancel(post["id"], by="retention")

    # Operational run rows are not editorial history. Keep a generous window
    # and delete in bounded batches so maintenance never monopolizes SQLite.
    run_ids = [
        row["id"] for row in db.query(
            "SELECT id FROM runs WHERE started_at < datetime('now', '-120 days') ORDER BY id LIMIT 2000"
        )
    ]
    if run_ids:
        marks = ",".join("?" for _ in run_ids)
        db.execute(f"DELETE FROM runs WHERE id IN ({marks})", tuple(run_ids))
    if stale or run_ids:
        db.log_event(
            "maintenance.completed",
            message=f"cancelled {len(stale)} stale console drafts; pruned {len(run_ids)} old runs",
        )
    return {"console_cancelled": len(stale), "runs_pruned": len(run_ids)}
