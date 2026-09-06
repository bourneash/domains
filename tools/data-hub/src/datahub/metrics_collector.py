"""Daily per-site GA4 + Search Console pull. Separate cadence from collector.py's
RSS/dataset cycle — see crontab.docker. Every site is isolated: one dead property
or a 403 must not skip the rest of the fleet (mirrors collector.py's per-source
isolation, keyed by source_id="ga4:<site>" / "gsc:<site>" in the same egress_log /
sources_state tables collector.py already writes to)."""
from __future__ import annotations

from . import store
from .config import AnalyticsSite
from .metrics import ga4, gsc


def _pull_ga4(conn, site: str, cfg: AnalyticsSite, client) -> str:
    site_records, quota = ga4.fetch_site(client, cfg.ga4_property_id)
    page_records, _ = ga4.fetch_pages(client, cfg.ga4_property_id)
    social_records, _ = ga4.fetch_social(client, cfg.ga4_property_id)
    n = store.upsert_ga4_metrics(conn, site, site_records + page_records + social_records)
    quota_note = f"quota:{quota}" if quota else ""
    store.record_egress(conn, source_id=f"ga4:{site}", target_host="analyticsdata.googleapis.com",
                        policy="direct", exit_node="direct", exit_ip=None,
                        status="ok", item_count=n, note=quota_note)
    store.set_source_state(conn, source_id=f"ga4:{site}", status="ok")
    return "ok"


def _pull_gsc(conn, site: str, cfg: AnalyticsSite, client) -> str:
    site_records = gsc.fetch_site(client, cfg.gsc_property)
    query_records = gsc.fetch_queries(client, cfg.gsc_property)
    page_records = gsc.fetch_pages(client, cfg.gsc_property)
    query_page_records = gsc.fetch_query_pages(client, cfg.gsc_property)
    n = store.upsert_gsc_metrics(conn, site, site_records + query_records + page_records)
    n += store.upsert_gsc_query_page_metrics(conn, site, query_page_records)
    store.record_egress(conn, source_id=f"gsc:{site}", target_host="searchconsole.googleapis.com",
                        policy="direct", exit_node="direct", exit_ip=None,
                        status="ok", item_count=n)
    store.set_source_state(conn, source_id=f"gsc:{site}", status="ok")
    return "ok"


def run_metrics_cycle(conn, sites: dict[str, AnalyticsSite], *, ga4_client, gsc_client) -> dict:
    summary = {"sites": len(sites), "ga4_ok": 0, "gsc_ok": 0, "errors": 0}
    for site, cfg in sites.items():
        try:
            _pull_ga4(conn, site, cfg, ga4_client)
            summary["ga4_ok"] += 1
        except Exception as exc:
            store.set_source_state(conn, source_id=f"ga4:{site}", status="error", error=str(exc))
            store.record_egress(conn, source_id=f"ga4:{site}", target_host="analyticsdata.googleapis.com",
                                policy="direct", exit_node="direct", exit_ip=None,
                                status="error", note=str(exc)[:200])
            summary["errors"] += 1

        try:
            _pull_gsc(conn, site, cfg, gsc_client)
            summary["gsc_ok"] += 1
        except Exception as exc:
            store.set_source_state(conn, source_id=f"gsc:{site}", status="error", error=str(exc))
            store.record_egress(conn, source_id=f"gsc:{site}", target_host="searchconsole.googleapis.com",
                                policy="direct", exit_node="direct", exit_ip=None,
                                status="error", note=str(exc)[:200])
            summary["errors"] += 1

    return summary
