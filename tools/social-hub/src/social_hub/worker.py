"""The tick — one idempotent pass over the whole pipeline.

    sync channels -> ingest sources -> draft posts -> poll inbox
                  -> draft replies -> publish everything due -> notify

Designed to be run from cron every 5-15 minutes and to be safe if two runs
overlap: publishing claims rows, ingestion is keyed, drafting checks for an
existing draft. A tick that dies halfway leaves no half-state behind, and the
next one picks up where it stopped.

Each stage is wrapped: one site's broken content directory or dead API cannot
stop the other sites in the same tick from publishing. Stage failures are
recorded on the run row and in the event log.
"""

from __future__ import annotations

import json
import os
import time
import traceback

from social_hub import (
    accounts,
    db,
    engagement,
    generator,
    metrics,
    notify,
    publisher,
    queue,
    sources,
)
from social_hub.config import SiteConfig, load_all, load_site_config

UI_URL = "http://127.0.0.1:4772/"


def _start_run(kind: str, site: str | None) -> int:
    return db.insert("runs", {"kind": kind, "site": site, "started_at": db.utcnow()})


def _finish_run(run_id: int, ok: bool, stats: dict, error: str = "") -> None:
    db.update(
        "runs",
        run_id,
        {
            "finished_at": db.utcnow(),
            "ok": 1 if ok else 0,
            "stats": json.dumps(stats),
            "error": error[:1000] or None,
        },
    )


def _stage(stats: dict, site: str, name: str, fn, *args, **kwargs):
    """Run one stage, recording either its result or its failure. A stage that
    throws is contained here: the rest of the tick still runs."""
    try:
        result = fn(*args, **kwargs)
        stats[name] = result
        return result
    except Exception as exc:
        stats.setdefault("errors", {})[name] = f"{type(exc).__name__}: {exc}"
        db.log_event(
            "tick.stage_error",
            site=site,
            message=f"{name}: {exc}",
            data={"trace": traceback.format_exc()[-1500:]},
        )
        return None


def tick_site(site: str, cfg: SiteConfig | None = None, *, publish: bool = True) -> dict:
    cfg = cfg or load_site_config(site)
    if cfg is None or not cfg.enabled:
        return {"site": site, "skipped": "not managed"}

    run_id = _start_run("tick", site)
    stats: dict = {"site": site}
    try:
        _stage(stats, site, "channels", accounts.sync_channels, [site])
        _stage(stats, site, "local_channels", accounts.ensure_config_channels, site, cfg.platforms)
        _stage(stats, site, "ingest", sources.ingest, site, cfg)
        _stage(stats, site, "generate", generator.generate, site, cfg)
        _stage(stats, site, "inbox", engagement.poll_site, site, cfg)
        _stage(stats, site, "replies", engagement.draft_replies, site, cfg)
        _stage(stats, site, "metrics", metrics.refresh_site, site)
        if publish:
            due = [p for p in publisher.publish_due(limit=25) if p]
            stats["published"] = sum(1 for r in due if r.get("ok"))
            stats["publish_failures"] = sum(1 for r in due if not r.get("ok") and not r.get("skipped"))
        _finish_run(run_id, "errors" not in stats, stats)
    except Exception as exc:  # pragma: no cover - belt and braces
        _finish_run(run_id, False, stats, str(exc))
        raise
    return stats


#: Wall-clock budget for a fleet-wide tick, in seconds. At two dozen managed
#: sites a full pass takes longer than the gap between cron runs, so a tick
#: covers as many sites as it can and the next one continues where this one
#: stopped (see _tick_order). Better a rolling sweep than overlapping runs
#: piling up on the same first few sites.
TICK_BUDGET_SECONDS = int(os.environ.get("SOCIAL_HUB_TICK_BUDGET", "600"))


def _tick_order(configs: dict) -> list[str]:
    """Least-recently-ticked first, so a budget-limited sweep is fair."""
    last: dict[str, str] = {}
    for row in db.query(
        "SELECT site, MAX(started_at) AS last FROM runs WHERE kind = 'tick' "
        "AND site IS NOT NULL GROUP BY site"
    ):
        last[row["site"]] = row["last"] or ""
    return sorted(configs, key=lambda name: last.get(name, ""))


def tick(site: str | None = None, *, publish: bool = True, notify_review: bool = False) -> dict:
    """Run a tick for one site, or a fair budgeted sweep of every managed site."""
    if site:
        configs = {site: load_site_config(site) or SiteConfig(site, {})}
    else:
        configs = load_all()

    out: dict = {"sites": {}, "at": db.utcnow()}
    started = time.monotonic()
    for name in _tick_order(configs):
        # Always run at least one site: a sweep that returns having done
        # nothing is worse than one that runs slightly over budget.
        if out["sites"] and not site and time.monotonic() - started > TICK_BUDGET_SECONDS:
            out["deferred"] = [n for n in _tick_order(configs) if n not in out["sites"]]
            db.log_event(
                "tick.budget",
                message=f"stopped after {len(out['sites'])} site(s); "
                f"{len(out['deferred'])} deferred to the next run",
            )
            break
        out["sites"][name] = tick_site(name, configs[name], publish=publish)
        if notify_review:
            _maybe_notify(name)
    return out


def _maybe_notify(site: str) -> None:
    drafts = len(queue.list_posts(site=site, status="draft", kind="post", limit=100))
    replies = len(queue.list_posts(site=site, status="draft", kind="reply", limit=100))
    if drafts or replies:
        notify.notify_needs_review(site, drafts, replies, f"{UI_URL}#queue?site={site}")


def _needs_creds(platform: str) -> bool:
    from social_hub.platforms import adapter_class

    try:
        return bool(adapter_class(platform).required_creds)
    except KeyError:
        return True


def status(site: str | None = None) -> dict:
    """A compact health/state summary — what the CLI and the dashboard show."""
    from social_hub import scheduler

    sites = [site] if site else list(load_all())
    out = {"sites": {}, "generated_at": db.utcnow()}
    for name in sites:
        upcoming = scheduler.upcoming(name, days=7, limit=100)
        out["sites"][name] = {
            "counts": queue.counts_by_status(name),
            "channels": [
                {
                    "platform": c["platform"],
                    "persona": c["persona"],
                    "handle": c["handle"],
                    "enabled": bool(c["enabled"]),
                    "status": c["status"],
                    "has_creds": bool(c["has_creds"]),
                    # Platforms like `console` need no secret at all, so a
                    # bare has_creds=false would read as broken when it isn't.
                    "needs_creds": _needs_creds(c["platform"]),
                }
                for c in accounts.list_channels(site=name)
            ],
            "inbox_new": len(engagement.list_mentions(site=name, status="new", limit=200)),
            "next_send": upcoming[0]["scheduled_at"] if upcoming else None,
            "scheduled_7d": len(upcoming),
        }
    last = db.rows_to_dicts(db.query("SELECT * FROM runs ORDER BY id DESC LIMIT 5"))
    out["recent_runs"] = last
    return out
