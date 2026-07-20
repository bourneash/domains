"""GA4 Data API fetcher — one site's trailing window, site and page grain."""
from __future__ import annotations

from datetime import date, timedelta

# (GA4 API metric name, our column name) — order defines dimensionValues/metricValues
# index alignment, so records are built by NAME via metricHeaders, never by position,
# in case Google ever reorders a response.
METRIC_MAP = [
    ("sessions", "sessions"),
    ("totalUsers", "users"),
    ("newUsers", "new_users"),
    ("screenPageViews", "views"),
    ("engagedSessions", "engaged_sessions"),
    ("engagementRate", "engagement_rate"),
    ("averageSessionDuration", "avg_session_duration"),
    ("conversions", "conversions"),
]


def trailing_window(today: date, days: int = 7) -> tuple[str, str]:
    """(start, end) as ISO date strings. end = yesterday; both APIs finalize
    with a lag, so today's own data is not worth pulling yet."""
    end = today - timedelta(days=1)
    start = today - timedelta(days=days)
    return start.isoformat(), end.isoformat()


def _run_report(client, property_id: str, start: str, end: str, dimension_names: list[str]) -> dict:
    body = {
        "dateRanges": [{"startDate": start, "endDate": end}],
        "dimensions": [{"name": n} for n in dimension_names],
        "metrics": [{"name": n} for n, _ in METRIC_MAP],
        "returnPropertyQuota": True,
    }
    return client.properties().runReport(property=f"properties/{property_id}", body=body).execute()


def _rows_to_records(response: dict, grain: str, has_dim_key: bool) -> list[dict]:
    headers = [h["name"] for h in response.get("metricHeaders", [])]
    records = []
    for row in response.get("rows", []):
        dim_values = [d["value"] for d in row.get("dimensionValues", [])]
        raw_date = dim_values[0]  # GA4 returns YYYYMMDD
        iso_date = f"{raw_date[0:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
        dim_key = dim_values[1] if has_dim_key and len(dim_values) > 1 else ""
        metric_values = {h: v["value"] for h, v in zip(headers, row.get("metricValues", []))}
        record = {"date": iso_date, "grain": grain, "dim_key": dim_key}
        for api_name, column in METRIC_MAP:
            raw = metric_values.get(api_name)
            if raw is None:
                record[column] = None
            elif column in ("engagement_rate", "avg_session_duration"):
                record[column] = float(raw)
            else:
                record[column] = int(float(raw))
        records.append(record)
    return records


def fetch_site(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]:
    start, end = trailing_window(today or date.today())
    response = _run_report(client, property_id, start, end, ["date"])
    return _rows_to_records(response, grain="site", has_dim_key=False), response.get("propertyQuota", {})


def fetch_pages(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]:
    start, end = trailing_window(today or date.today())
    response = _run_report(client, property_id, start, end, ["date", "pagePath"])
    return _rows_to_records(response, grain="page", has_dim_key=True), response.get("propertyQuota", {})
