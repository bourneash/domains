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

# The fleet's sites use this consent-gated browser event for the meaningful
# commercial action we can observe ourselves: a visitor choosing an affiliate
# destination.  GA4's generic ``conversions`` metric remains zero until every
# property is separately configured in Admin.  Pulling this explicit event by
# name keeps the central dashboard useful and makes the definition consistent
# across the portfolio without weakening consent handling.
CONVERSION_EVENT = "affiliate_click"
EVENT_METRIC_MAP = [("eventCount", "conversions")]

# googleapiclient does not retry requests unless execute() is given a retry
# budget. A one-off upstream 5xx would otherwise leave the daily fleet status
# red for 24 hours even though the property and credentials are healthy.
API_RETRIES = 3


def trailing_window(today: date, days: int = 7) -> tuple[str, str]:
    """(start, end) as ISO date strings. end = yesterday; both APIs finalize
    with a lag, so today's own data is not worth pulling yet."""
    end = today - timedelta(days=1)
    start = today - timedelta(days=days)
    return start.isoformat(), end.isoformat()


def _run_report(client, property_id: str, start: str, end: str,
                dimension_names: list[str], dimension_filter: dict | None = None,
                metric_map: list[tuple[str, str]] | None = None) -> dict:
    metrics = metric_map or METRIC_MAP
    body = {
        "dateRanges": [{"startDate": start, "endDate": end}],
        "dimensions": [{"name": n} for n in dimension_names],
        "metrics": [{"name": n} for n, _ in metrics],
        "returnPropertyQuota": True,
    }
    if dimension_filter:
        body["dimensionFilter"] = dimension_filter
    return client.properties().runReport(
        property=f"properties/{property_id}", body=body
    ).execute(num_retries=API_RETRIES)


def _rows_to_records(response: dict, grain: str, has_dim_key: bool,
                     metric_map: list[tuple[str, str]] | None = None) -> list[dict]:
    metrics = metric_map or METRIC_MAP
    headers = [h["name"] for h in response.get("metricHeaders", [])]
    records = []
    for row in response.get("rows", []):
        dim_values = [d["value"] for d in row.get("dimensionValues", [])]
        raw_date = dim_values[0]  # GA4 returns YYYYMMDD
        iso_date = f"{raw_date[0:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
        dim_key = dim_values[1] if has_dim_key and len(dim_values) > 1 else ""
        metric_values = {h: v["value"] for h, v in zip(headers, row.get("metricValues", []))}
        record = {"date": iso_date, "grain": grain, "dim_key": dim_key}
        for api_name, column in metrics:
            raw = metric_values.get(api_name)
            if raw is None:
                record[column] = None
            elif column in ("engagement_rate", "avg_session_duration"):
                record[column] = float(raw)
            else:
                record[column] = int(float(raw))
        records.append(record)
    return records


def _affiliate_clicks(client, property_id: str, start: str, end: str,
                      dimension_names: list[str], grain: str,
                      has_dim_key: bool) -> tuple[list[dict], dict]:
    response = _run_report(
        client,
        property_id,
        start,
        end,
        dimension_names,
        {
            "filter": {
                "fieldName": "eventName",
                "stringFilter": {
                    "matchType": "EXACT",
                    "value": CONVERSION_EVENT,
                    "caseSensitive": True,
                },
            }
        },
        EVENT_METRIC_MAP,
    )
    return (
        _rows_to_records(response, grain=grain, has_dim_key=has_dim_key,
                         metric_map=EVENT_METRIC_MAP),
        response.get("propertyQuota", {}),
    )


def _merge_conversions(records: list[dict], conversion_rows: list[dict]) -> list[dict]:
    """Replace GA4 key-event counts with explicit affiliate-click counts.

    Keep ordinary traffic rows even when they have no click, and retain a
    click-only row if GA4 reports one without the broader metrics response.
    """
    by_key = {(row["date"], row.get("dim_key", "")): row for row in records}
    for row in records:
        row["conversions"] = 0
    for conversion in conversion_rows:
        key = (conversion["date"], conversion.get("dim_key", ""))
        target = by_key.get(key)
        if target is None:
            target = {"date": key[0], "grain": conversion["grain"], "dim_key": key[1]}
            for _, column in METRIC_MAP:
                target[column] = 0
            records.append(target)
            by_key[key] = target
        target["conversions"] = int(conversion.get("conversions") or 0)
    return records


def fetch_site(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]:
    start, end = trailing_window(today or date.today())
    response = _run_report(client, property_id, start, end, ["date"])
    records = _rows_to_records(response, grain="site", has_dim_key=False)
    clicks, _ = _affiliate_clicks(client, property_id, start, end, ["date"], "site", False)
    return _merge_conversions(records, clicks), response.get("propertyQuota", {})


def fetch_pages(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]:
    start, end = trailing_window(today or date.today())
    response = _run_report(client, property_id, start, end, ["date", "pagePath"])
    records = _rows_to_records(response, grain="page", has_dim_key=True)
    clicks, _ = _affiliate_clicks(
        client, property_id, start, end, ["date", "pagePath"], "page", True)
    return _merge_conversions(records, clicks), response.get("propertyQuota", {})


def fetch_social(client, property_id: str, *, today: date | None = None) -> tuple[list[dict], dict]:
    """Sessions and conversions keyed by Social Hub's ``utm_content`` value."""
    start, end = trailing_window(today or date.today())
    response = _run_report(
        client,
        property_id,
        start,
        end,
        ["date", "sessionManualAdContent"],
        {
            "filter": {
                "fieldName": "sessionManualMedium",
                "stringFilter": {"matchType": "EXACT", "value": "organic_social", "caseSensitive": False},
            }
        },
    )
    return _rows_to_records(response, grain="social", has_dim_key=True), response.get("propertyQuota", {})
