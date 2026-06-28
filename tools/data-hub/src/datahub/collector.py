from urllib.parse import urlparse
from . import store
from . import fetch_rss as fr
from . import datasets as ds_pkg
from .vpn import plan_fetch
from .config import Source, Settings


def _host(url: str | None) -> str:
    try:
        return urlparse(url or "").hostname or ""
    except Exception:
        return ""


def run_cycle(conn, sources: list[Source], settings: Settings, *,
              control_client=None, rss_client=None) -> dict:
    summary = {"fetched": 0, "new_items": 0, "new_datasets": 0, "skipped": 0, "errors": 0}

    for source in sources:
        target = _host(source.url) or (source.fetcher or "")

        # Per-source kill-switch: skip disabled sources entirely. No fetch is
        # attempted, so nothing goes over any outbound connection — we record
        # only the source state (so /health + /sources show it as intentionally
        # "disabled", not a recurring error), and write no egress row.
        if not source.enabled:
            store.set_source_state(conn, source_id=source.id,
                                   status="disabled", error="disabled", stale=True)
            summary["skipped"] += 1
            continue

        plan = None  # may stay None if plan_fetch raises
        try:
            plan = plan_fetch(source, settings, client=control_client)

            if not plan.allowed:
                store.set_source_state(conn, source_id=source.id,
                                       status=f"skipped-{plan.reason}", error=plan.reason, stale=True)
                store.record_egress(conn, source_id=source.id, target_host=target,
                                    policy=source.policy, exit_node=plan.exit_node,
                                    exit_ip=plan.exit_ip, status="skipped", note=plan.reason)
                summary["skipped"] += 1
                continue

            if source.type == "dataset":
                try:
                    fetcher = ds_pkg.FETCHERS.get(source.fetcher)
                    if fetcher is None:
                        raise ValueError(f"unknown dataset fetcher: {source.fetcher}")
                    records = fetcher(source, proxy=plan.proxy, settings=settings, client=rss_client)
                except ds_pkg.DatasetUnavailable as ux:
                    store.set_source_state(conn, source_id=source.id,
                                           status=f"skipped-{ux.reason}", error=ux.reason, stale=True)
                    store.record_egress(conn, source_id=source.id, target_host=target,
                                        policy=source.policy, exit_node=plan.exit_node,
                                        exit_ip=plan.exit_ip, status="skipped", note=ux.reason)
                    summary["skipped"] += 1
                    continue
                new = store.upsert_datasets(conn, source.id, source.dataset_key, source.tags, records)
                store.set_source_state(conn, source_id=source.id, status="ok", stale=False)
                store.record_egress(conn, source_id=source.id, target_host=target,
                                    policy=source.policy, exit_node=plan.exit_node,
                                    exit_ip=plan.exit_ip, status="ok", item_count=new)
                summary["fetched"] += 1
                summary["new_datasets"] += new
                continue

            items = fr.fetch_rss(source, proxy=plan.proxy, client=rss_client)
            new = store.upsert_items(conn, items)
            store.set_source_state(conn, source_id=source.id, status="ok", stale=False)
            store.record_egress(conn, source_id=source.id, target_host=target,
                                policy=source.policy, exit_node=plan.exit_node,
                                exit_ip=plan.exit_ip, status="ok", item_count=new)
            summary["fetched"] += 1
            summary["new_items"] += new
        except Exception as exc:  # per-source isolation — catches plan_fetch failures too
            exit_node = plan.exit_node if plan else ""
            exit_ip = plan.exit_ip if plan else None
            store.set_source_state(conn, source_id=source.id, status="error",
                                   error=str(exc), stale=False)
            store.record_egress(conn, source_id=source.id, target_host=target,
                                policy=source.policy, exit_node=exit_node,
                                exit_ip=exit_ip, status="error", note=str(exc)[:200])
            summary["errors"] += 1

    return summary
