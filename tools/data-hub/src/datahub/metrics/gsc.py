"""Search Console fetcher — one site's trailing window, site and query grain."""
from __future__ import annotations

from datetime import date, timedelta

ROW_LIMIT = 25000  # per-day-per-grain cap; later rows silently dropped rather than
                    # falling back to a coarser grain (see plan's Global Constraints)


def trailing_window(today: date, days: int = 7) -> tuple[str, str]:
    end = today - timedelta(days=1)
    start = today - timedelta(days=days)
    return start.isoformat(), end.isoformat()


def _query(client, site_url: str, start: str, end: str, dimensions: list[str]) -> dict:
    body = {"startDate": start, "endDate": end, "dimensions": dimensions, "rowLimit": ROW_LIMIT}
    return client.searchanalytics().query(siteUrl=site_url, body=body).execute()


def _rows_to_records(response: dict, grain: str, has_dim_key: bool) -> list[dict]:
    records = []
    for row in response.get("rows") or []:
        keys = row.get("keys", [])
        dim_key = keys[1] if has_dim_key and len(keys) > 1 else ""
        records.append({
            "date": keys[0], "grain": grain, "dim_key": dim_key,
            "clicks": row.get("clicks"), "impressions": row.get("impressions"),
            "ctr": row.get("ctr"), "position": row.get("position"),
        })
    return records


def fetch_site(client, gsc_property: str, *, today: date | None = None) -> list[dict]:
    start, end = trailing_window(today or date.today())
    response = _query(client, gsc_property, start, end, ["date"])
    return _rows_to_records(response, grain="site", has_dim_key=False)


def fetch_queries(client, gsc_property: str, *, today: date | None = None) -> list[dict]:
    start, end = trailing_window(today or date.today())
    response = _query(client, gsc_property, start, end, ["date", "query"])
    return _rows_to_records(response, grain="query", has_dim_key=True)
