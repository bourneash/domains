"""Bounded queue housekeeping; preserves publication and feedback history."""

from __future__ import annotations

from social_hub import db, publisher, queue
from social_hub.config import load_site_config


def run() -> dict:
    recovered = 0
    media_failed = db.rows_to_dicts(
        db.query(
            "SELECT * FROM posts WHERE status = 'failed' "
            "AND error LIKE '%image required%' ORDER BY id LIMIT 100"
        )
    )
    for post in media_failed:
        cfg = load_site_config(post["site"])
        if not cfg:
            continue
        diagnostics = publisher.media_diagnostics(cfg)
        if not (diagnostics["fallback_available"] or diagnostics["generator_healthy"]):
            continue
        queue.approve(post["id"], by="media-recovery", cfg=cfg)
        db.log_event(
            "media.failure_recovered", site=post["site"], ref_type="post",
            ref_id=post["id"], message="rescheduled after media readiness check",
        )
        recovered += 1

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
            message=(
                f"cancelled {len(stale)} stale console drafts; pruned {len(run_ids)} old runs; "
                f"recovered {recovered} media failures"
            ),
        )
    return {
        "console_cancelled": len(stale),
        "runs_pruned": len(run_ids),
        "media_recovered": recovered,
    }
